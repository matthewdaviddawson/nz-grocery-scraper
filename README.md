# NZ Grocery Price Scraper

Collects shelf prices once a day from the New Zealand supermarkets that publish prices online and pushes them to your app.

| Chain | Stores | Source | Notes |
|---|---|---|---|
| Woolworths (ex-Countdown) | 1 (online default store) | JSON API | Includes **barcodes**. Pricing is largely national. |
| New World | ~149 | JSON API (guest token) | Per-store prices, Clubcard prices, multi-buys |
| PAK'nSAVE | ~58 | JSON API (guest token) | Per-store prices, specials, multi-buys |
| FreshChoice | ~76 | Store web pages | Per-store prices, specials |
| SuperValue | 1+ | Store web pages | Same platform as FreshChoice |

Not covered: **The Warehouse** (blocks automated access with a bot challenge), **Four Square** (no online prices), **Costco** (membership site), and independents such as Farro and Moore Wilson's.

Tested 28 Sep 2026. A New World or PAK'nSAVE store takes about 1 minute, and Woolworths about 2 minutes for ~17,600 products. Small FreshChoice stores take about 1 minute with 100% of products. The largest FreshChoice/SuperValue stores take up to ~9 minutes and reach about 95–98%, because their website only lists 2,400 products per listing. **A run across every store takes about 1½–2 hours** and produces about 2.5 million price rows. A store that returns no products is reported as failed.

## Requirements

Node.js 20 or newer. No npm packages are needed.

## Quick start

```bash
node src/index.js --max-stores 1 --max-pages 2 --csv
```

This scrapes a little from one store per chain and writes files to `output/<date>/`:

- `prices-<chain>.ndjson.gz`: one JSON price record per line
- `prices-<chain>.csv`: the same data, only with `--csv`
- `summary.json`: counts, failures and timings

Full run (every store, every chain):

```bash
node src/index.js
```

## Options

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `--chains a,b` | `CHAINS` | all | `woolworths,new_world,paknsave,freshchoice,supervalue` |
| `--stores x,y` | `NEW_WORLD_STORES`, `PAKNSAVE_STORES`, `FRESHCHOICE_STORES`, `SUPERVALUE_STORES` | all | Store id or part of the name, e.g. `Albany,Wairau Road`. The flag applies to every chain; the env vars apply to one chain each |
| `--max-stores n` | `MAX_STORES` | 0 (all) | Limit stores per chain (testing) |
| `--max-pages n` | `MAX_PAGES` | 0 (all) | Limit pages per category (testing; turns off change detection) |
| `--csv` | `OUTPUT_CSV=1` | off | Also write CSV |
| `--no-ingest` | | | Ignore `INGEST_URL` |
| `--full-refresh` | `FULL_REFRESH=1` | off | Push every price instead of only changes |
| | `INGEST_URL` | | Your app's ingest endpoint |
| | `INGEST_SECRET` | | Shared secret sent as `Authorization: Bearer …` |
| | `INGEST_BATCH_SIZE` | 500 | Rows per POST |
| | `CHANGES_ONLY` | true | Only push changed prices (needs `state/`) |
| | `FULL_REFRESH_DAY` | 0 (Sun) | NZ weekday on which everything is re-sent to self-heal |
| | `STORE_CONCURRENCY` | 3 | Stores scraped in parallel per chain |
| | `REQUEST_GAP_MS` | 150 | Minimum gap between requests to one website |
| | `OUTPUT_DIR` / `STATE_DIR` | `output` / `state` | Where files go |

## Price record

| Field | Example | Meaning |
|---|---|---|
| `chain` | `paknsave` | `woolworths`, `new_world`, `paknsave`, `freshchoice`, `supervalue` |
| `store_id` | `5f16…096b` | Chain's store id (`online` for Woolworths) |
| `product_id` | `5019876-EA-000` | Chain's product id, stable across that chain's stores for Woolworths/Foodstuffs |
| `name`, `brand` | `Smooth Peanut Butter`, `Pic's` | |
| `size_text` | `380g` / `per kg` | As shown by the store |
| `size_value`, `size_unit` | `380`, `g` | Normalised to `g`, `ml` or `ea` |
| `sold_by` | `each` / `kg` | For `kg`, prices are per kilogram |
| `barcode` | `9415022020768` | Woolworths only |
| `category` | `Pantry > Jams, Honey & Spreads` | |
| `price` | `3.49` | What anyone pays for one unit (specials included, no loyalty card) |
| `regular_price` | `6.99` | Normal non-promo price |
| `member_price` | `7.89` | Price with Clubcard / Everyday Rewards, if lower |
| `multibuy_qty`, `multibuy_total` | `3`, `5.00` | e.g. "3 for $5" |
| `on_special` | `true` | |
| `promo_label` | `3 for $5.00` | Human-readable deal text |
| `unit_price`, `unit_price_measure` | `0.92`, `100g` | Comparison price |
| `in_stock` | `true` / `null` | Woolworths only; `null` means unknown |
| `image_url`, `product_url` | | |
| `match_key` | `pic s|butter peanut smooth|380g` | Loose key for grouping the same product across chains (see below) |
| `scraped_at` | ISO timestamp | |

### Matching products across chains

Only Woolworths exposes barcodes, so cross-chain matching uses `match_key`, built from brand + sorted name words + normalised size. It catches many identical products (for example `bluebird|chips originals potato ready salted|150g` at both New World and PAK'nSAVE, which share product ids anyway). It will miss some matches where chains name things differently. For a comparison app, a good approach is to match automatically on `match_key`, then review or fix the popular items by hand in a mapping table.

## Pushing to your app (ingest)

When `INGEST_URL` is set, the scraper POSTs JSON batches to it:

```json
{
  "runId": "2026-09-28T14-00-00-000Z-ab12cd34",
  "chain": "paknsave",
  "kind": "prices",
  "scrapedAt": "2026-09-28T14:05:12.345Z",
  "items": [ { …price record… } ]
}
```

`kind` is one of these:

- `stores`: `items` are store records (`chain, store_id, name, region, address, latitude, longitude, url`), sent first
- `prices`: `items` are price records (only new or changed ones, unless it's a full refresh)
- `removed`: `items` are `{store_id, product_id}` that were listed yesterday but are gone today
- `run_complete`: `items` is empty; `stats` holds counts, failed stores and `full_refresh`

Failed POSTs are retried 4 times. If any batch still fails, the scraper does **not** advance its snapshot, so the next run resends everything that changed. Your endpoint must therefore be **idempotent**, meaning safe to receive the same row twice.

`tools/mock-ingest.js` is a stand-in endpoint for local testing:

```bash
node tools/mock-ingest.js
```

Then, in a second terminal (PowerShell):

```powershell
$env:INGEST_URL='http://localhost:8787/api/ingest/prices'; $env:INGEST_SECRET='test'; node src/index.js --max-stores 1
```

See **MANUS_INTEGRATION.md** for connecting it to the Manus app.

## Scheduling

`.github/workflows/daily-scrape.yml` runs it daily at 2–3am NZ time on GitHub Actions. Setup steps are in MANUS_INTEGRATION.md.

**Running it on your own Windows PC instead** (the PC must be on at the scheduled time):

```powershell
schtasks /Create /TN "NZ Grocery Scraper" /SC DAILY /ST 03:00 /TR "cmd /c cd /d C:\path\to\nz-grocery-scraper && set INGEST_URL=https://your-app/api/ingest/prices&& set INGEST_SECRET=your-secret&& node src\index.js >> scrape.log 2>&1"
```

## Maintenance

These are unofficial website APIs. They work today but can change without notice. When a chain changes something, that chain's run fails loudly (non-zero exit, GitHub emails you), while the other chains keep working. The places to fix are isolated:

- `src/scrapers/woolworths.js`
- `src/scrapers/foodstuffs.js` (New World + PAK'nSAVE)
- `src/scrapers/freshchoice.js` (FreshChoice + SuperValue; HTML parsing, the most fragile)

## Being a good citizen

- It only reads publicly visible prices, uses a guest session, never logs in, and waits between requests (`REQUEST_GAP_MS`).
- It runs once a day at night.
- Check each retailer's website terms before relying on this commercially. The retailers could block automated access at any time.
