// UPC/EAN -> product details. Tries UPCitemdb (general goods), then Open Food Facts (groceries/cosmetics).
export async function lookupUpc(code) {
  code = String(code).replace(/\D/g, '');
  if (code.length < 8) return null;

  try {
    const key = process.env.UPCITEMDB_KEY;
    const url = key
      ? `https://api.upcitemdb.com/prod/v1/lookup?upc=${code}`
      : `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`;
    const r = await fetch(url, { headers: key ? { user_key: key, key_type: '3scale' } : {} });
    if (r.ok) {
      const p = (await r.json()).items?.[0];
      if (p) return { source: 'upcitemdb', upc: code, title: p.title || '', brand: p.brand || '', category: (p.category || '').split('>').pop().trim(), description: p.description || '', image: p.images?.[0] || '' };
    }
  } catch { /* fall through */ }

  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,categories,image_url`);
    if (r.ok) {
      const j = await r.json();
      if (j.status === 1) return { source: 'openfoodfacts', upc: code, title: j.product.product_name || '', brand: (j.product.brands || '').split(',')[0].trim(), category: (j.product.categories || '').split(',')[0].trim(), description: '', image: j.product.image_url || '' };
    }
  } catch { /* none found */ }

  return null;
}
