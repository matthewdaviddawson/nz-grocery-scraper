// FreshChoice + SuperValue (Woolworths-owned franchise stores). Each store has
// its own online shop at <store>.store.freshchoice.co.nz / .supervalue.co.nz.
// There is no JSON API, so product tiles are parsed from the search pages.
// Stores without online ordering ("Shop in-store") list the same products as a
// compact list instead of tiles; stores with no shop at all are skipped.

import { http, HttpError } from '../lib/http.js';
import { decodeHtml, money, priceRecord, storeRecord } from '../lib/normalize.js';
import { StoreSkipped } from '../lib/run.js';

const DIRECTORY_URL = 'https://store.freshchoice.co.nz/';
const PAGE_SIZE = 48;
const MAX_PAGES = 50; // a listing stops returning results after page 50 (2,400 products)
// "*" lists the whole catalogue (an empty search returns nothing at stores with online ordering).
const ALL_PRODUCTS = '/search?q=%2A';
// After name order from both ends and each top-level category, these reach what's left
// in very large stores. Passes stop as soon as every listed product has been collected.
const EXTRA_SORTS = ['price', 'price_descending', 'unit_price', 'top_products', 'discount_percent', 'discount_cents'];

const first = (html, re) => {
  const m = html.match(re);
  return m ? decodeHtml(m[1]) : null;
};

async function loadDirectory() {
  const html = await http(DIRECTORY_URL, { json: false });
  const cards = html.split(/<div class="StoreCard[\s"]/).slice(1);
  const stores = [];
  const seen = new Set();
  for (const card of cards) {
    const m = card.match(/https?:\/\/([a-z0-9-]+)\.store\.(freshchoice|supervalue)\.co\.nz/);
    if (!m || seen.has(m[0])) continue; // stores without an online shop have no link
    seen.add(m[0]);
    const [, sub, brand] = m;
    const name = (first(card, /StoreCard__Name">([^<]+)/) ?? sub).replace(/\s*\((FreshChoice|SuperValue)\)\s*$/i, '');
    const mapQuery = card.match(/maps\.google\.com\?q=([^"#]+)/);
    stores.push({
      brand,
      record: storeRecord({
        store_id: sub,
        name: `${brand === 'supervalue' ? 'SuperValue' : 'FreshChoice'} ${name}`,
        address: mapQuery ? decodeURIComponent(mapQuery[1].replace(/\+/g, ' ')) : null,
        url: `https://${sub}.store.${brand}.co.nz`,
      }),
    });
  }
  return stores;
}

/** Brand + category per tile, from the analytics block embedded in the page. */
function parseDataLayer(html) {
  const m = html.match(/window\.gtmDataLayer\s*=\s*(\[.*?\]);\s*\n/s);
  if (!m) return [];
  try {
    const layer = JSON.parse(m[1]);
    return layer.find((e) => e.event === 'view_item_list')?.ecommerce?.items ?? [];
  } catch {
    return [];
  }
}

const simplify = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The analytics list is usually in tile order, but fall back to a name match. */
function findAnalytics(analytics, i, name) {
  const key = simplify(name).slice(0, 16);
  if (!key) return null;
  if (simplify(analytics[i]?.item_name).includes(key)) return analytics[i];
  return analytics.find((a) => simplify(a.item_name).includes(key)) ?? null;
}

/** Product records from a search page, in whichever layout the store uses. */
export function parseTiles(html, baseUrl) {
  return html.includes('class="TalkerGrid__Item"') ? parseGrid(html, baseUrl) : parseLines(html, baseUrl);
}

/**
 * The compact list used by "Shop in-store" stores. Each line has the price, unit
 * price and, for specials, a "Save $x" label (the normal price is price + saving).
 */
export function parseLines(html, baseUrl) {
  const analytics = parseDataLayer(html);
  const chunks = html.split(/<div class="line mfl-line-compact[\s"]/).slice(1);
  const lines = [];
  chunks.forEach((chunk, i) => {
    const id = first(chunk, /id="line_([0-9a-f]+)"/);
    const name = first(chunk, /talker__product-name">([^<]+)/);
    const priceMatch = chunk.match(/item-per-unit-cost[^>]*>\s*\$([\d.,]+)\s*([^<]*)</);
    const sell = money(priceMatch?.[1]);
    if (!id || !name || sell == null) return;

    const units = decodeHtml(priceMatch[2] ?? '');
    const soldByKg = /kg/i.test(units);
    const savingMatch = chunk.match(/saving-amount">\s*Save(?:&nbsp;|\s)*(?:\$([\d.,]+)|(\d+)\s*c)/i);
    const saving = savingMatch ? (savingMatch[1] ? money(savingMatch[1]) : money(Number(savingMatch[2]) / 100)) : null;
    const savingText = first(chunk, /saving-amount">([\s\S]*?)<\/span>/);
    const unitMatch = chunk.match(/comparison_price[^>]*>\s*\(?\s*\$([\d.,]+)\s*(?:per\s*)?([^)<]*)/i);

    const info = findAnalytics(analytics, i, name);
    const category = info
      ? [info.item_category, info.item_category2, info.item_category3].filter(Boolean).join(' > ') || null
      : null;

    lines.push(
      priceRecord({
        product_id: id,
        name,
        brand: info?.item_brand?.trim() || null,
        size_text: soldByKg ? 'per kg' : first(chunk, /class="weak size">([^<]+)/),
        sold_by: soldByKg ? 'kg' : 'each',
        category,
        price: sell,
        regular_price: saving ? money(sell + saving) : sell,
        on_special: Boolean(saving) || /item-per-unit-cost[^"]*\bspecial\b/.test(chunk),
        promo_label: savingText,
        unit_price: unitMatch ? money(unitMatch[1]) : soldByKg ? sell : null,
        unit_price_measure: unitMatch ? decodeHtml(unitMatch[2]) || null : soldByKg ? '1kg' : null,
        image_url: first(chunk, /<img[^>]+src="([^"]+)"/),
        product_url: (() => {
          const href = first(chunk, /href="(\/lines\/[^"]+)"/);
          return href ? baseUrl + href : null;
        })(),
      }),
    );
  });
  return lines;
}

/** True when a store's website has a shop (its page title starts "Shop Online at" or "Shop in-store at"). */
async function hasShop(storeUrl) {
  const home = await http(`${storeUrl}/`, { json: false });
  return /<title>[^<]*\bShop\b/i.test(home);
}

function parseGrid(html, baseUrl) {
  const analytics = parseDataLayer(html);
  const chunks = html.split('class="TalkerGrid__Item"').slice(1);
  const tiles = [];
  chunks.forEach((chunk, i) => {
    const id = first(chunk, /id="line_([0-9a-f]+)"/);
    const name = first(chunk, /talker__product-name">([^<]+)/);
    const sell = money(first(chunk, /price__sell[^>]*>\s*\$([\d.,]+)/));
    if (!id || !name || sell == null) return;

    const was = money(first(chunk, /talker__prices__was[^>]*>\s*was\s*\$([\d.,]+)/i));
    const units = first(chunk, /price__units[^>]*>([^<]+)</) ?? '';
    const unitText = first(chunk, /talker__prices__comparison[^>]*>([^<]+)</);
    const unitMatch = unitText?.match(/\$([\d.,]+)\s*(?:per\s*)?(.*)/i);
    const sticker = first(chunk, /talker__sticker__label">([\s\S]*?)<\/span>\s*<\/span>/);
    const stickerText = sticker ? decodeHtml(sticker.replace(/<[^>]+>/g, ' ')) : null;
    const multi = stickerText?.match(/(\d+)\s*for\s*\$([\d.]+)/i);
    const soldByKg = /kg/i.test(units);

    const info = findAnalytics(analytics, i, name);
    const category = info
      ? [info.item_category, info.item_category2, info.item_category3].filter(Boolean).join(' > ') || null
      : null;

    tiles.push(
      priceRecord({
        product_id: id,
        name,
        brand: info?.item_brand?.trim() || null,
        size_text: soldByKg ? 'per kg' : first(chunk, /talker__name__size">([^<]+)/),
        sold_by: soldByKg ? 'kg' : 'each',
        category,
        price: sell,
        regular_price: was ?? sell,
        multibuy_qty: multi ? Number(multi[1]) : null,
        multibuy_total: multi ? money(multi[2]) : null,
        on_special: /\bspecial\b/.test(chunk.slice(0, 400)),
        promo_label: stickerText,
        unit_price: unitMatch ? money(unitMatch[1]) : soldByKg ? sell : null,
        unit_price_measure: unitMatch ? unitMatch[2].trim() || null : soldByKg ? '1kg' : null,
        in_stock: /out.of.stock/i.test(chunk.slice(0, 600)) ? false : null,
        image_url: first(chunk, /<img[^>]+src="([^"]+)"/),
        product_url: (() => {
          const href = first(chunk, /href="(\/lines\/[^"]+)"/);
          return href ? baseUrl + href : null;
        })(),
      }),
    );
  });
  return tiles;
}

const totalResults = (html) => Number((html.match(/([\d,]+)\s*results/i)?.[1] ?? '0').replace(/,/g, ''));

function createScraper(brand, id, name) {
  return {
    id,
    name,

    async run(ctx) {
      const directory = (await loadDirectory()).filter((s) => s.brand === brand).map((s) => s.record);
      const stores = ctx.selectStores(directory);
      await ctx.addStores(stores);

      await ctx.forEachStore(stores, (store) =>
        ctx.scrapeStore(store, async (emit) => {
          const seen = new Set();
          let total = Infinity;
          const complete = () => seen.size >= total;
          let firstRequest = true;

          /** Fetches a listing page. A store whose site has no shop at all is skipped, not failed. */
          const fetchPage = async (url) => {
            const isFirst = firstRequest;
            firstRequest = false;
            try {
              return await http(url, { json: false });
            } catch (err) {
              if (isFirst && err instanceof HttpError && err.status === 404 && !(await hasShop(store.url))) {
                throw new StoreSkipped('no online shop on its website (store information page only)');
              }
              throw err;
            }
          };

          /** Pages through one listing; returns how many products it holds. */
          const crawl = async (path, sort) => {
            let listed = 0;
            for (let page = 1; page <= MAX_PAGES && !complete(); page++) {
              if (ctx.maxPages && page > ctx.maxPages) break;
              const join = path.includes('?') ? '&' : '?';
              const html = await fetchPage(`${store.url}${path}${join}sort_by=${sort}&page=${page}`);
              if (page === 1) listed = totalResults(html);
              const tiles = parseTiles(html, store.url);
              const fresh = tiles.filter((t) => !seen.has(t.product_id));
              fresh.forEach((t) => seen.add(t.product_id));
              await emit(fresh);
              if (tiles.length < PAGE_SIZE) break;
            }
            return listed;
          };
          const bothEnds = async (path) => {
            const listed = await crawl(path, 'name');
            // The reverse order only adds anything when the listing is longer than one pass reaches.
            if (listed > MAX_PAGES * PAGE_SIZE && !ctx.maxPages) await crawl(path, 'name_descending');
            return listed;
          };

          total = (await bothEnds(ALL_PRODUCTS)) || Infinity;
          if (!complete() && !ctx.maxPages) {
            const home = await http(`${store.url}/`, { json: false });
            const categories = [...new Set(home.match(/\/category\/[a-z0-9-]+/g) ?? [])];
            for (const category of categories) {
              if (complete()) break;
              try {
                await bothEnds(category);
              } catch (err) {
                // Menus can link categories a branch doesn't stock; skip those.
                if (!(err instanceof HttpError && err.status === 404)) throw err;
              }
            }
            for (const sort of EXTRA_SORTS) if (!complete()) await crawl(ALL_PRODUCTS, sort);
          }
          if (Number.isFinite(total) && seen.size < total && !ctx.maxPages) {
            ctx.log(`warning: ${store.name} collected ${seen.size} of ${total} listed products`);
          }
        }),
      );
    },
  };
}

export const freshChoice = createScraper('freshchoice', 'freshchoice', 'FreshChoice');
export const superValue = createScraper('supervalue', 'supervalue', 'SuperValue');
