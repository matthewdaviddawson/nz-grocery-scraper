#!/usr/bin/env node
// NZ supermarket price scraper — entry point. Run once a day.

import { HELP, loadConfig } from './config.js';
import { setRequestGap } from './lib/http.js';
import { Run } from './lib/run.js';
import woolworths from './scrapers/woolworths.js';
import { newWorld, paknsave } from './scrapers/foodstuffs.js';
import { freshChoice, superValue } from './scrapers/freshchoice.js';

const SCRAPERS = [woolworths, newWorld, paknsave, freshChoice, superValue];

async function main() {
  const config = loadConfig(process.argv.slice(2));
  if (config.help) {
    console.log(HELP);
    return;
  }
  setRequestGap(config.requestGapMs);

  const run = new Run(config);
  await run.open();

  // Chains hit different websites, so they run in parallel.
  const selected = SCRAPERS.filter((s) => config.chains.includes(s.id));
  const results = await Promise.all(
    selected.map(async (scraper) => {
      const ctx = run.chain(scraper);
      await ctx.open();
      let error = null;
      try {
        await scraper.run(ctx);
      } catch (err) {
        error = err;
        ctx.log(`FAILED: ${err.stack ?? err}`);
      }
      return ctx.finish(error);
    }),
  );

  await run.finish(results);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
