// UPC/EAN -> product details. Sources, in order: UPCitemdb (best for toys/general goods; free tier is ~100 lookups/day),
// Open Products Facts (community, general goods), Open Food Facts (groceries - rarely useful for toys).
// Results are cached so repeat scans never spend the daily quota.
import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS upc_cache (
  code TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT (datetime('now')))`);

const MISS_TTL_DAYS = 3; // remember "not found" briefly; products do get added to these databases over time

function cached(code) {
  const row = db.prepare('SELECT json, fetched_at FROM upc_cache WHERE code=?').get(code);
  if (!row) return undefined;
  const product = JSON.parse(row.json);
  if (product) return product;
  const ageDays = (Date.now() - new Date(row.fetched_at + 'Z').getTime()) / 86400000;
  return ageDays < MISS_TTL_DAYS ? null : undefined;
}
const remember = (code, product) => db.prepare(
  "INSERT INTO upc_cache(code,json,fetched_at) VALUES(?,?,datetime('now')) ON CONFLICT(code) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at"
).run(code, JSON.stringify(product));

const get = (url, headers = {}) => fetch(url, { headers, signal: AbortSignal.timeout(8000) });

async function upcItemDb(code) {
  const key = process.env.UPCITEMDB_KEY;
  const r = await get(key ? `https://api.upcitemdb.com/prod/v1/lookup?upc=${code}` : `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`,
    key ? { user_key: key, key_type: '3scale' } : {});
  if (r.status === 429) return { limited: true };
  if (!r.ok) return { product: null, unsure: true };
  const p = (await r.json()).items?.[0];
  return p ? { product: { source: 'upcitemdb', title: p.title || '', brand: p.brand || '', category: (p.category || '').split('>').pop().trim(), description: p.description || '' } } : { product: null };
}

async function openFacts(host, code) {
  const r = await get(`https://${host}/api/v2/product/${code}.json?fields=product_name,brands,categories`);
  if (!r.ok) return { product: null, unsure: true };
  const j = await r.json();
  if (j.status !== 1 || !j.product?.product_name) return { product: null };
  return { product: { source: host.split('.')[1], title: j.product.product_name, brand: (j.product.brands || '').split(',')[0].trim(), category: (j.product.categories || '').split(',')[0].trim(), description: '' } };
}

// -> { product | null, note? }. `note` explains a failure the user should know about (rate limit, offline).
export async function lookupUpc(code) {
  code = String(code).replace(/\D/g, '');
  if (code.length < 8) return { product: null };
  const hit = cached(code);
  if (hit !== undefined) return { product: hit };

  let limited = false, unsure = false;
  for (const source of [() => upcItemDb(code), () => openFacts('world.openproductsfacts.org', code), () => openFacts('world.openfoodfacts.org', code)]) {
    try {
      const r = await source();
      if (r.limited) { limited = true; continue; }
      if (r.unsure) unsure = true;
      if (r.product) { const product = { ...r.product, upc: code }; remember(code, product); return { product }; }
    } catch { unsure = true; }
  }
  if (limited) return { product: null, note: 'Barcode lookup limit reached for today — type the details in, or try again tomorrow.' };
  if (unsure) return { product: null, note: "Couldn't reach the barcode databases — check the server's internet connection." };
  remember(code, null); // every source answered "not found"
  return { product: null };
}
