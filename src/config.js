// Settings come from environment variables; CLI flags override them.

export const ALL_CHAINS = ['woolworths', 'new_world', 'paknsave', 'freshchoice', 'supervalue'];

const HELP = `
Usage: node src/index.js [options]

  --chains <list>        Comma list of chains (default: all)
                         ${ALL_CHAINS.join(', ')}
  --stores <list>        Only stores whose id or name contains one of these
                         (applies to every chain; default: all stores)
  --max-stores <n>       Stop after n stores per chain (testing)
  --max-pages <n>        Only fetch n pages per category/sort (testing)
  --no-ingest            Don't POST to INGEST_URL even if it is set
  --full-refresh         Send every price to the ingest endpoint, not just changes
  --csv                  Also write CSV files next to the NDJSON output
  --help                 Show this help

Environment variables: see README.md.
`;

const envList = (v) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const envInt = (v, fallback) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const envBool = (v, fallback) => (v == null || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));

export function loadConfig(argv, env = process.env) {
  const config = {
    chains: envList(env.CHAINS).length ? envList(env.CHAINS) : [...ALL_CHAINS],
    storeFilters: Object.fromEntries(ALL_CHAINS.map((c) => [c, envList(env[`${c.toUpperCase()}_STORES`])])),
    maxStores: envInt(env.MAX_STORES, 0),
    maxPages: envInt(env.MAX_PAGES, 0),
    storeConcurrency: envInt(env.STORE_CONCURRENCY, 3),
    requestGapMs: envInt(env.REQUEST_GAP_MS, 150),
    outputDir: env.OUTPUT_DIR || 'output',
    stateDir: env.STATE_DIR || 'state',
    csv: envBool(env.OUTPUT_CSV, false),
    ingestUrl: env.INGEST_URL || '',
    ingestSecret: env.INGEST_SECRET || '',
    ingestBatchSize: envInt(env.INGEST_BATCH_SIZE, 500),
    changesOnly: envBool(env.CHANGES_ONLY, true),
    // NZ weekday (0 = Sunday) on which every price is re-sent to self-heal the app database.
    fullRefreshDay: envInt(env.FULL_REFRESH_DAY, 0),
    fullRefresh: envBool(env.FULL_REFRESH, false),
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--chains':
        config.chains = envList(value());
        break;
      case '--stores': {
        const list = envList(value());
        for (const c of ALL_CHAINS) config.storeFilters[c] = list;
        break;
      }
      case '--max-stores':
        config.maxStores = envInt(value(), 0);
        break;
      case '--max-pages':
        config.maxPages = envInt(value(), 0);
        break;
      case '--no-ingest':
        config.ingestUrl = '';
        break;
      case '--full-refresh':
        config.fullRefresh = true;
        break;
      case '--csv':
        config.csv = true;
        break;
      case '--help':
      case '-h':
        config.help = true;
        break;
      default:
        throw new Error(`Unknown option ${flag}\n${HELP}`);
    }
  }

  const unknown = config.chains.filter((c) => !ALL_CHAINS.includes(c));
  if (unknown.length) throw new Error(`Unknown chain(s): ${unknown.join(', ')}. Valid: ${ALL_CHAINS.join(', ')}`);
  if (config.ingestUrl && !config.ingestSecret) throw new Error('INGEST_URL is set but INGEST_SECRET is empty');

  return config;
}

export { HELP };
