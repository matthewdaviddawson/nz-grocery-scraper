// Shared record shape + helpers for turning each chain's data into one format.

export const PRICE_FIELDS = [
  'chain',
  'store_id',
  'product_id',
  'name',
  'brand',
  'size_text',
  'size_value',
  'size_unit',
  'sold_by',
  'barcode',
  'category',
  'price',
  'regular_price',
  'member_price',
  'multibuy_qty',
  'multibuy_total',
  'on_special',
  'promo_label',
  'unit_price',
  'unit_price_measure',
  'in_stock',
  'image_url',
  'product_url',
  'match_key',
  'scraped_at',
];

export const STORE_FIELDS = ['chain', 'store_id', 'name', 'region', 'address', 'latitude', 'longitude', 'url'];

export function money(n) {
  if (n == null || n === '') return null;
  const v = typeof n === 'string' ? Number(n.replace(/[$,\s]/g, '')) : Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

export const cents = (n) => (n == null ? null : money(Number(n) / 100));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeHtml(s) {
  if (s == null) return s;
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleCase(s) {
  if (!s) return s;
  return s.replace(/\b([a-z])([a-z']*)/g, (_, a, b) => a.toUpperCase() + b);
}

/**
 * Parse a pack-size string ("2L", "6 x 330ml", "375g", "10pk") into a
 * canonical value in g, ml or ea.
 */
export function parseSize(text) {
  const none = { size_value: null, size_unit: null };
  if (!text) return none;
  const s = String(text).toLowerCase().replace(/,/g, '');
  const toCanonical = (value, unit) => {
    if (/^(kg)$/.test(unit)) return { size_value: round3(value * 1000), size_unit: 'g' };
    if (/^(g|gm|gms|grams?)$/.test(unit)) return { size_value: round3(value), size_unit: 'g' };
    if (/^(mg)$/.test(unit)) return { size_value: round3(value / 1000), size_unit: 'g' };
    if (/^(l|lt|ltr|litres?|liters?)$/.test(unit)) return { size_value: round3(value * 1000), size_unit: 'ml' };
    if (/^(ml)$/.test(unit)) return { size_value: round3(value), size_unit: 'ml' };
    return { size_value: round3(value), size_unit: 'ea' };
  };
  const unitRe = '(kg|g|gm|gms|grams?|mg|ml|l|lt|ltr|litres?|liters?)';

  let m = s.match(new RegExp(`(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*${unitRe}\\b`));
  if (m) return toCanonical(Number(m[1]) * Number(m[2]), m[3]);
  m = s.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unitRe}\\s*[x×]\\s*(\\d+)\\b`));
  if (m) return toCanonical(Number(m[1]) * Number(m[3]), m[2]);
  m = s.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unitRe}\\b`));
  if (m) return toCanonical(Number(m[1]), m[2]);
  m = s.match(/(\d+)\s*(pk|pack|ea|each|s|pc|pcs|pieces|sachets|rolls|bags)\b/);
  if (m) return { size_value: Number(m[1]), size_unit: 'ea' };
  if (/^\s*(ea|each)\s*$/.test(s)) return { size_value: 1, size_unit: 'ea' };
  return none;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

const STOP_WORDS = new Set(['the', 'and', 'with', 'of', 'nz', 'new', 'zealand', 'pack', 'pk', 'ea', 'each']);

/**
 * A loose cross-chain grouping key: brand + sorted name words + canonical size.
 * Good enough to suggest matches; confirm them with barcodes where available.
 */
export function matchKey({ brand, name, size_value, size_unit }) {
  const clean = (s) =>
    (s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|pk|x)\b/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ');
  const brandWords = clean(brand).split(/\s+/).filter(Boolean);
  const words = clean(name)
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w) && !brandWords.includes(w));
  const size = size_value != null ? `${size_value}${size_unit}` : '';
  return `${brandWords.join(' ')}|${[...new Set(words)].sort().join(' ')}|${size}`;
}

/** Fill in defaults + derived fields so every record has the same shape. */
export function priceRecord(fields) {
  const rec = {};
  for (const f of PRICE_FIELDS) rec[f] = fields[f] ?? null;
  if (rec.size_value == null && rec.size_text) Object.assign(rec, parseSize(rec.size_text));
  if (rec.regular_price == null) rec.regular_price = rec.price;
  rec.on_special = Boolean(rec.on_special || (rec.regular_price != null && rec.price < rec.regular_price));
  rec.match_key = matchKey(rec);
  return rec;
}

export function storeRecord(fields) {
  const rec = {};
  for (const f of STORE_FIELDS) rec[f] = fields[f] ?? null;
  return rec;
}
