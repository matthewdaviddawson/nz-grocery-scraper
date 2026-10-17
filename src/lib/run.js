// Collects scraper output: writes files, works out what changed since the last
// run, and pushes batches to the app's ingest endpoint.

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { http, mapLimit } from './http.js';
import { PRICE_FIELDS } from './normalize.js';

const NZ_TZ = 'Pacific/Auckland';
const nzDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: NZ_TZ }).format(d);
const nzWeekday = (d) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: NZ_TZ, weekday: 'short' }).format(d),
  );
const clock = () => new Date().toISOString().slice(11, 19);

// Fields that make a price row "changed" (everything except the timestamp).
const HASH_FIELDS = PRICE_FIELDS.filter((f) => f !== 'scraped_at' && f !== 'match_key');
const rowHash = (r) =>
  createHash('md5')
    .update(JSON.stringify(HASH_FIELDS.map((f) => r[f])))
    .digest('base64')
    .slice(0, 12);

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

class LineWriter {
  constructor(path, gzip) {
    this.file = createWriteStream(path);
    this.stream = gzip ? createGzip() : this.file;
    if (gzip) this.stream.pipe(this.file);
  }
  async write(line) {
    if (!this.stream.write(line + '\n')) await once(this.stream, 'drain');
  }
  async close() {
    this.stream.end();
    await once(this.file, 'close');
  }
}

class Ingest {
  constructor(config, runId) {
    this.url = config.ingestUrl;
    this.secret = config.ingestSecret;
    this.batchSize = config.ingestBatchSize;
    this.runId = runId;
    this.errors = 0;
    this.sent = 0;
  }

  /** Returns the number of batches that failed. */
  async send(kind, chain, items = [], extra = {}) {
    let failed = 0;
    const batches = [];
    for (let i = 0; i < Math.max(items.length, 1); i += this.batchSize) batches.push(items.slice(i, i + this.batchSize));
    for (const batch of batches) {
      if (!batch.length && kind !== 'run_complete') continue;
      try {
        await http(this.url, {
          method: 'POST',
          json: false,
          paced: false,
          timeoutMs: 120_000,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
          body: JSON.stringify({
            runId: this.runId,
            chain,
            kind,
            scrapedAt: new Date().toISOString(),
            ...extra,
            items: batch,
          }),
        });
        this.sent += batch.length;
      } catch (err) {
        this.errors++;
        failed++;
        console.error(`[${clock()}] [ingest] ${kind}/${chain} batch of ${batch.length} failed: ${err.message}`);
      }
    }
    return failed;
  }
}

export class Run {
  constructor(config) {
    this.config = config;
    this.runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.startedAt = new Date();
    this.date = nzDate(this.startedAt);
    this.outDir = join(config.outputDir, this.date);
    this.ingest = config.ingestUrl ? new Ingest(config, this.runId) : null;
    // Change detection only makes sense when pushing to an app, and only for complete scrapes.
    this.diffEnabled = Boolean(this.ingest && config.changesOnly && !config.maxPages);
    this.fullRefresh = config.fullRefresh || nzWeekday(this.startedAt) === config.fullRefreshDay;
  }

  async open() {
    await mkdir(this.outDir, { recursive: true });
    if (this.diffEnabled) await mkdir(this.config.stateDir, { recursive: true });
    console.log(
      `[${clock()}] run ${this.runId} → ${this.outDir}` +
        (this.ingest ? ` | ingest on (${this.diffEnabled && !this.fullRefresh ? 'changes only' : 'full'})` : ' | ingest off'),
    );
  }

  chain(scraper) {
    return new ChainRun(this, scraper);
  }

  async finish(results) {
    const summary = {
      runId: this.runId,
      date: this.date,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      fullRefresh: this.fullRefresh,
      ingestEnabled: Boolean(this.ingest),
      ingestErrors: this.ingest?.errors ?? 0,
      chains: results,
    };
    await writeFile(join(this.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`[${clock()}] done in ${Math.round((Date.now() - this.startedAt) / 60000)} min`);
    for (const r of results) {
      console.log(
        `  ${r.chain.padEnd(12)} ${r.ok ? 'OK  ' : 'FAIL'} stores ${r.stores_ok}/${r.stores_total}` +
          `  products ${r.products}  changed ${r.changed}  removed ${r.removed}${r.error ? `  (${r.error})` : ''}`,
      );
    }
    return summary;
  }
}

/** The `ctx` object each scraper receives. */
class ChainRun {
  constructor(run, scraper) {
    this.run = run;
    this.config = run.config;
    this.chain = scraper.id;
    this.maxPages = this.config.maxPages;
    this.stats = {
      chain: this.chain,
      ok: true,
      stores_total: 0,
      stores_ok: 0,
      stores_failed: [],
      products: 0,
      changed: 0,
      removed: 0,
      error: null,
    };
    this.stores = [];
    this.storesOk = new Set();
    this.current = new Map();
    this.previous = null;
    this.pending = [];
    this.flushing = Promise.resolve();
    this.ingestErrors = 0;
    this.snapshotPath = join(this.config.stateDir, `snapshot-${this.chain}.json.gz`);
  }

  log(msg) {
    console.log(`[${clock()}] [${this.chain}] ${msg}`);
  }

  async open() {
    const dir = this.run.outDir;
    this.ndjson = new LineWriter(join(dir, `prices-${this.chain}.ndjson.gz`), true);
    if (this.config.csv) {
      this.csv = new LineWriter(join(dir, `prices-${this.chain}.csv`), false);
      await this.csv.write(PRICE_FIELDS.join(','));
    }
    if (this.run.diffEnabled) {
      try {
        const data = JSON.parse(gunzipSync(await readFile(this.snapshotPath)).toString());
        this.previous = new Map(data.entries);
        this.log(`loaded previous snapshot (${this.previous.size} prices)`);
      } catch {
        this.log('no previous snapshot — sending every price this run');
      }
    }
  }

  selectStores(all) {
    const filters = (this.config.storeFilters[this.chain] ?? []).map((f) => f.toLowerCase());
    let chosen =
      !filters.length || filters.includes('all')
        ? all
        : all.filter((s) =>
            filters.some((f) => s.store_id.toLowerCase() === f || s.name.toLowerCase().includes(f)),
          );
    if (this.config.maxStores) chosen = chosen.slice(0, this.config.maxStores);
    this.log(`${chosen.length} of ${all.length} stores selected`);
    return chosen;
  }

  async addStores(stores) {
    for (const s of stores) s.chain = this.chain;
    this.stores.push(...stores);
    this.stats.stores_total += stores.length;
    if (this.run.ingest) this.ingestErrors += await this.run.ingest.send('stores', this.chain, stores);
  }

  forEachStore(stores, fn) {
    return mapLimit(stores, this.config.storeConcurrency, fn);
  }

  async scrapeStore(store, fn) {
    const started = Date.now();
    const scrapedAt = new Date().toISOString();
    let count = 0;
    const emit = async (records) => {
      for (const r of records) {
        r.chain = this.chain;
        r.store_id = store.store_id;
        r.scraped_at = scrapedAt;
        await this.ndjson.write(JSON.stringify(r));
        if (this.csv) await this.csv.write(PRICE_FIELDS.map((f) => csvCell(r[f])).join(','));
        count++;
        if (this.run.ingest) this.track(r);
      }
      if (this.pending.length >= this.config.ingestBatchSize) await this.flush();
    };
    try {
      await fn(emit);
      // An empty store almost always means the website changed, not that it sells nothing.
      if (count === 0 && !this.maxPages) throw new Error('no products found (website layout may have changed)');
      this.storesOk.add(store.store_id);
      this.stats.stores_ok++;
      const idx = `${this.stats.stores_ok + this.stats.stores_failed.length}/${this.stats.stores_total}`;
      this.log(`(${idx}) ${store.name}: ${count} products in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (err) {
      this.stats.stores_failed.push({ store_id: store.store_id, name: store.name, error: err.message });
      this.log(`store FAILED ${store.name}: ${err.message}`);
    }
    this.stats.products += count;
  }

  track(r) {
    const key = `${r.store_id}|${r.product_id}`;
    const hash = rowHash(r);
    const unchanged = this.current.has(key) || (!this.run.fullRefresh && this.previous?.get(key) === hash);
    this.current.set(key, hash);
    if (!unchanged) {
      this.pending.push(r);
      this.stats.changed++;
    }
  }

  flush() {
    const batch = this.pending.splice(0);
    if (!batch.length || !this.run.ingest) return this.flushing;
    this.flushing = this.flushing.then(async () => {
      this.ingestErrors += await this.run.ingest.send('prices', this.chain, batch);
    });
    return this.flushing;
  }

  async finish(error) {
    if (error) {
      this.stats.error = error.message;
      this.stats.ok = false;
    }
    if (this.stats.stores_total && this.stats.stores_failed.length > this.stats.stores_total * 0.2) this.stats.ok = false;
    if (this.stats.stores_total && this.stats.stores_ok === 0) this.stats.ok = false;

    await this.flush();
    await this.flushing;
    await this.ndjson.close();
    if (this.csv) await this.csv.close();

    const ingest = this.run.ingest;
    if (ingest) {
      // Products that disappeared from a store that scraped successfully.
      const removed = [];
      if (this.previous && this.run.diffEnabled) {
        for (const key of this.previous.keys()) {
          const cut = key.indexOf('|');
          const storeId = key.slice(0, cut);
          if (this.storesOk.has(storeId) && !this.current.has(key)) {
            removed.push({ store_id: storeId, product_id: key.slice(cut + 1) });
          }
        }
      }
      this.stats.removed = removed.length;
      this.ingestErrors += await ingest.send('removed', this.chain, removed);
      this.ingestErrors += await ingest.send('run_complete', this.chain, [], {
        stats: {
          ...this.stats,
          stores_ok_ids: [...this.storesOk],
          full_refresh: this.run.fullRefresh || !this.previous,
        },
      });

      // Only advance the snapshot if the app received everything, otherwise
      // tomorrow's run would skip rows the app never got.
      if (this.run.diffEnabled && this.ingestErrors === 0) {
        const next = new Map(this.current);
        for (const [key, hash] of this.previous ?? []) {
          if (!this.storesOk.has(key.slice(0, key.indexOf('|')))) next.set(key, hash);
        }
        const tmp = `${this.snapshotPath}.tmp`;
        await writeFile(tmp, gzipSync(JSON.stringify({ version: 1, entries: [...next] })));
        await rename(tmp, this.snapshotPath);
      } else if (this.run.diffEnabled) {
        this.log('ingest had errors — snapshot NOT updated; next run will resend');
      }
      if (this.ingestErrors) this.stats.ok = false;
    }
    return this.stats;
  }
}
