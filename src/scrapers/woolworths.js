// Woolworths NZ (formerly Countdown) — public JSON API used by woolworths.co.nz.
// Prices are for the site's default store; Woolworths pricing is largely national.

import { http } from '../lib/http.js';
import { money, priceRecord, storeRecord, titleCase } from '../lib/normalize.js';

const BASE = 'https://www.woolworths.co.nz';
const HEADERS = { accept: 'application/json', 'x-requested-with': 'OnlineShopping.WebApp' };
const PAGE_SIZE = 120;

function mapProduct(p, department) {
  const pr = p.price ?? {};
  const soldByKg = /kg/i.test(p.unit ?? '');
  const sale = money(pr.salePrice);
  const original = money(pr.originalPrice) ?? sale;

  // Club prices need an Everyday Rewards card, so they are the member price;
  // everything else discounted is a normal special.
  const price = pr.isClubPrice ? original : sale;
  const memberPrice = pr.isClubPrice ? sale : null;

  // Woolworths rarely runs multi-buys; read them defensively in case the shape varies.
  const multi = p.productTag?.multiBuy;
  const multiQty = multi?.quantity ?? multi?.multiBuyQuantity ?? null;
  const multiTotal = money(multi?.value ?? multi?.multiBuyPrice ?? null);

  // "IsGreatPrice" -> "Great price"
  const tag = p.productTag?.tagType;
  const tagLabel =
    tag && tag !== 'Other'
      ? tag.replace(/^Is/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/ (\w)/g, (_, c) => ` ${c.toLowerCase()}`)
      : null;

  return priceRecord({
    product_id: p.sku,
    name: titleCase(p.name),
    brand: titleCase(p.brand),
    size_text: soldByKg ? 'per kg' : p.size?.volumeSize,
    sold_by: soldByKg ? 'kg' : 'each',
    barcode: p.barcode || null,
    category: p.departments?.[0]?.name ?? department,
    price,
    regular_price: original,
    member_price: memberPrice,
    multibuy_qty: multiQty && multiTotal ? multiQty : null,
    multibuy_total: multiQty && multiTotal ? multiTotal : null,
    on_special: Boolean(pr.isSpecial && !pr.isClubPrice),
    promo_label: pr.isClubPrice ? 'Club price' : tagLabel,
    unit_price: money(p.size?.cupPrice),
    unit_price_measure: p.size?.cupMeasure ?? null,
    in_stock: p.availabilityStatus ? p.availabilityStatus === 'In Stock' : null,
    image_url: p.images?.big ?? null,
    product_url: `${BASE}/shop/productdetails?stockcode=${p.sku}&name=${p.slug ?? ''}`,
  });
}

export default {
  id: 'woolworths',
  name: 'Woolworths',

  async run(ctx) {
    const store = storeRecord({
      store_id: 'online',
      name: 'Woolworths Online (default store)',
      url: BASE,
    });
    await ctx.addStores([store]);

    await ctx.scrapeStore(store, async (emit) => {
      const shell = await http(`${BASE}/api/v1/shell`, { headers: HEADERS });
      const departments =
        shell.mainNavs
          ?.find((n) => n.label === 'Browse')
          ?.navigationItems?.find((n) => n.label === 'Department')?.items ?? [];
      if (!departments.length) throw new Error('Could not find the Woolworths department list (API changed?)');

      const seen = new Set();
      for (const dept of departments) {
        const slug = dept.url.split('/').filter(Boolean).pop();
        const filter = encodeURIComponent(`Department;;${slug};false`);
        for (let page = 1; !ctx.maxPages || page <= ctx.maxPages; page++) {
          const url =
            `${BASE}/api/v1/products?target=browse&inStockProductsOnly=false` +
            `&size=${PAGE_SIZE}&page=${page}&dasFilter=${filter}`;
          const data = await http(url, { headers: HEADERS });
          const items = data.products?.items ?? [];
          const products = items.filter((i) => i.type === 'Product' && i.sku && !seen.has(i.sku));
          products.forEach((p) => seen.add(p.sku));
          await emit(products.map((p) => mapProduct(p, dept.label)));
          const total = data.products?.totalItems ?? 0;
          if (!items.length || page * PAGE_SIZE >= total) break;
        }
      }
    });
  },
};
