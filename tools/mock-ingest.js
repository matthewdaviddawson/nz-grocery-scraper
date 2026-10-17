// A stand-in for your app's ingest endpoint, for testing the scraper locally.
//   INGEST_SECRET=test node tools/mock-ingest.js
// then in another terminal:
//   INGEST_URL=http://localhost:8787/api/ingest/prices INGEST_SECRET=test node src/index.js --max-stores 1

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.INGEST_SECRET || 'test';
const KINDS = new Set(['stores', 'prices', 'removed', 'run_complete']);
const totals = {};

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(totals, null, 2));
  }
  if (req.headers.authorization !== `Bearer ${SECRET}`) {
    res.writeHead(401);
    return res.end('unauthorized');
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400);
      return res.end('bad json');
    }
    const { runId, chain, kind, items } = payload;
    if (!runId || !chain || !KINDS.has(kind) || !Array.isArray(items)) {
      res.writeHead(400);
      return res.end('bad payload');
    }
    const key = `${chain}/${kind}`;
    totals[key] = (totals[key] ?? 0) + items.length;
    const extra = kind === 'run_complete' ? ` stats=${JSON.stringify({ ...payload.stats, stores_ok_ids: undefined })}` : '';
    console.log(`${new Date().toISOString().slice(11, 19)} ${key.padEnd(24)} +${items.length} (total ${totals[key]})${extra}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, received: items.length }));
  });
}).listen(PORT, () => console.log(`mock ingest listening on http://localhost:${PORT}/api/ingest/prices`));
