// Foodstuffs (New World + PAK'nSAVE) — the JSON API behind newworld.co.nz and
// paknsave.co.nz. Uses an anonymous guest token. Prices are per store.

import { http, HttpError } from '../lib/http.js';
import { cents, priceRecord, storeRecord } from '../lib/normalize.js';

const HITS_PER_PAGE = 50; // API maximum
const MAX_RESULTS = 1000; // Algolia returns at most 1000 hits per query
const CATEGORY_LEVELS = ['category0NI', 'category1NI', 'category2NI'];
const SKIP_TOP_CATEGORIES = new Set(['Featured']); // virtual category that duplicates others

function mapProduct(p, site) {
  const base = cents(p.singlePrice?.price);
  const promo = p.promotions?.find((x) => x.bestPromotion) ?? p.promotions?.[0];
  let price = base;
  let memberPrice = null;
  let multibuyQty = null;
  let multibuyTotal = null;
  let unit = p.singlePrice?.comparativePrice;
  let label = null;

  if (promo?.rewardType === 'NEW_PRICE' && promo.rewardValue != null) {
    const value = cents(promo.rewardValue);
    const card = Boolean(promo.cardDependencyFlag);
    if ((promo.threshold ?? 1) > 1) {
      // e.g. threshold 2, rewardValue 700 => "2 for $7.00"
      multibuyQty = promo.threshold;
      multibuyTotal = value;
      label = `${promo.threshold} for $${value.toFixed(2)}${card ? ' (Clubcard)' : ''}`;
    } else if (card) {
      memberPrice = value;
      label = 'Clubcard price';
    } else {
      price = value;
      if (promo.comparativePrice) unit = promo.comparativePrice;
      label = 'Special';
    }
  }

  const soldByKg = /^kg$/i.test(p.displayName ?? '') || p.saleType === 'WEIGHT';
  const cat = p.categoryTrees?.[0];
  const productSlug = p.productId.toLowerCase().replace(/-/g, '_');
  const imageId = p.productId.split('-')[0];

  return priceRecord({
    product_id: p.productId,
    name: p.name,
    brand: p.brand ?? null,
    size_text: soldByKg ? 'per kg' : p.displayName,
    sold_by: soldByKg ? 'kg' : 'each',
    category: cat ? [cat.level0, cat.level1, cat.level2].filter(Boolean).join(' > ') : null,
    price,
    regular_price: base,
    member_price: memberPrice,
    multibuy_qty: multibuyQty,
    multibuy_total: multibuyTotal,
    promo_label: label,
    unit_price: unit ? cents(unit.pricePerUnit) : null,
    unit_price_measure: unit?.measureDescription ?? null,
    image_url: `https://a.fsimg.co.nz/product/retail/fan/image/400x400/${imageId}.png`,
    product_url: `https://${site}/shop/product/${productSlug}`,
  });
}

function createFoodstuffsScraper({ id, name, site, api }) {
  let token = null;

  async function refreshToken() {
    const res = await http(`https://${site}/api/user/get-current-user`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res?.access_token) throw new Error(`${name}: no guest access_token returned`);
    token = res.access_token;
  }

  async function call(path, body) {
    if (!token) await refreshToken();
    const opts = () => ({
      method: body ? 'POST' : 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    try {
      return await http(`${api}${path}`, opts());
    } catch (err) {
      if (!(err instanceof HttpError) || (err.status !== 401 && err.status !== 403)) throw err;
      await refreshToken(); // token expired — get a fresh one and retry once
      return http(`${api}${path}`, opts());
    }
  }

  function search(storeId, filters, page, facets = []) {
    return call('/v1/edge/search/paginated/products', {
      algoliaQuery: {
        attributesToHighlight: [],
        attributesToRetrieve: ['productID', 'Type', 'sponsored', ...CATEGORY_LEVELS],
        facets,
        filters,
        hitsPerPage: HITS_PER_PAGE,
        page,
        query: '',
      },
      algoliaFacetQueries: [],
      storeId,
      hitsPerPage: HITS_PER_PAGE,
      page,
      sortOrder: 'NI_POPULARITY_ASC',
      tobaccoQuery: false,
    });
  }

  const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  /**
   * Page through `filter`. A single query can only reach 1000 results, so
   * larger result sets are split by category (top level, then sub-levels).
   */
  async function collect(ctx, storeId, filter, count, depth, onProducts) {
    if (count >= MAX_RESULTS && depth < CATEGORY_LEVELS.length) {
      const facet = CATEGORY_LEVELS[depth];
      const res = await search(storeId, filter, 0, [facet]);
      const values = Object.entries(res.algoliaSearchResult?.facets?.[facet] ?? {});
      if (values.length) {
        for (const [value, n] of values) {
          if (depth === 0 && SKIP_TOP_CATEGORIES.has(value)) continue;
          await collect(ctx, storeId, `${filter} AND ${facet}:${quote(value)}`, n, depth + 1, onProducts);
        }
        return;
      }
    }
    if (count > MAX_RESULTS) ctx.log(`warning: ${filter} has ${count} products; only ${MAX_RESULTS} reachable`);

    const pages = Math.ceil(Math.min(count, MAX_RESULTS) / HITS_PER_PAGE);
    for (let page = 0; page < pages && (!ctx.maxPages || page < ctx.maxPages); page++) {
      const res = await search(storeId, filter, page);
      const products = res.products ?? [];
      await onProducts(products);
      if (products.length < HITS_PER_PAGE) break;
    }
  }

  return {
    id,
    name,

    async run(ctx) {
      const { stores: rawStores = [] } = await call('/v1/edge/store');
      const all = rawStores.map((s) =>
        storeRecord({
          store_id: s.id,
          name: s.name,
          region: s.region,
          address: s.address,
          latitude: s.latitude,
          longitude: s.longitude,
          url: `https://${site}`,
        }),
      );
      const stores = ctx.selectStores(all);
      await ctx.addStores(stores);

      await ctx.forEachStore(stores, (store) =>
        ctx.scrapeStore(store, async (emit) => {
          const seen = new Set();
          await collect(ctx, store.store_id, `stores:${store.store_id}`, Infinity, 0, async (products) => {
            const fresh = products.filter((p) => p.productId && !seen.has(p.productId));
            fresh.forEach((p) => seen.add(p.productId));
            await emit(fresh.map((p) => mapProduct(p, site)));
          });
        }),
      );
    },
  };
}

export const newWorld = createFoodstuffsScraper({
  id: 'new_world',
  name: 'New World',
  site: 'www.newworld.co.nz',
  api: 'https://api-prod.newworld.co.nz',
});

export const paknsave = createFoodstuffsScraper({
  id: 'paknsave',
  name: "PAK'nSAVE",
  site: 'www.paknsave.co.nz',
  api: 'https://api-prod.paknsave.co.nz',
});
