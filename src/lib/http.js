// Small fetch wrapper: per-host pacing, timeouts and retries with backoff.

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const USER_AGENT = process.env.SCRAPER_USER_AGENT || DEFAULT_UA;

let minGapMs = 150;
const nextSlot = new Map();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimum gap between two requests to the same host (politeness). */
export function setRequestGap(ms) {
  minGapMs = ms;
}

async function pace(host) {
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + minGapMs);
  if (slot > now) await sleep(slot - now);
}

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? `: ${body}` : ''}`);
    this.status = status;
    this.url = url;
  }
}

const backoffMs = (attempt) => 1000 * 2 ** attempt + Math.random() * 500;

/**
 * Fetch a URL and return parsed JSON (default) or text.
 * Retries network errors, 429 and 5xx responses.
 */
export async function http(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    json = true,
    retries = 4,
    timeoutMs = 30_000,
    paced = true,
  } = options;
  const host = new URL(url).host;

  for (let attempt = 0; ; attempt++) {
    if (paced) await pace(host);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-NZ,en;q=0.9', ...headers },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) return json ? res.json() : res.text();

    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new HttpError(res.status, url, text.slice(0, 300));
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
  }
}

/** Run fn over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
