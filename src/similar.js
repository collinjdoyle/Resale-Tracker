// Very basic "looks like" matching, no AI. The browser computes a fingerprint of each photo:
//   64 hex chars  = 256-bit difference hash (shape/brightness layout)
//  128 hex chars  = 64-bin colour histogram (1 byte per bin)
// Matches are only suggestions: the user picks the right item from the closest few.
export const HASH_RE = /^[0-9a-f]{192}$/;

const popcount = n => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };

function parse(hash) {
  const bits = [];
  for (let i = 0; i < 64; i += 2) bits.push(parseInt(hash.slice(i, i + 2), 16));
  const hist = [];
  for (let i = 64; i < 192; i += 2) hist.push(parseInt(hash.slice(i, i + 2), 16));
  return { bits, hist };
}

export function similarity(h1, h2) {
  const a = parse(h1), b = parse(h2);
  let ham = 0;
  for (let i = 0; i < 32; i++) ham += popcount(a.bits[i] ^ b.bits[i]);
  const shape = Math.max(0, (1 - ham / 256 - 0.5) * 2);       // random photos sit near 0.5, so rescale to 0..1
  let inter = 0, total = 0;
  for (let i = 0; i < 64; i++) { inter += Math.min(a.hist[i], b.hist[i]); total += Math.max(a.hist[i], 1); }
  const colour = Math.min(1, inter / total);
  return 0.55 * shape + 0.45 * colour;
}

// photos: [{ item_id, hash }] -> best score per item, highest first
export function rank(hash, photos, limit = 6) {
  const best = new Map();
  for (const p of photos) {
    if (!p.hash || !HASH_RE.test(p.hash)) continue;
    const s = similarity(hash, p.hash);
    if (s > (best.get(p.item_id) ?? -1)) best.set(p.item_id, s);
  }
  return [...best].map(([item_id, score]) => ({ item_id, score })).sort((x, y) => y.score - x.score).slice(0, limit);
}
