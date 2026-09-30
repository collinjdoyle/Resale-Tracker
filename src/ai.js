// Photo -> item details, and listing-text writing.
// Providers: ollama (local vision model, recommended), anthropic (Claude API, optional), none.
const PROVIDER = (process.env.AI_PROVIDER || 'none').toLowerCase();
const TIMEOUT_MS = (Number(process.env.AI_TIMEOUT_SECONDS) || 180) * 1000; // local CPU models can be slow

export const aiEnabled = () => PROVIDER === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY : PROVIDER === 'ollama';

const IDENTIFY_PROMPT = `You are helping a reseller catalogue a used item from a photo.
Identify the product as specifically as you can. Read any visible brand, model, size, or barcode digits from tags/labels/packaging.
Reply with ONLY a JSON object, no prose, with these keys:
{"title": "concise marketplace-style listing title", "brand": "", "category": "", "condition": "new|like new|good|fair|poor|unknown", "size": "", "upc": "digits only if a barcode number is clearly readable, else empty", "description": "1-2 sentences", "confidence": 0.0}
Use empty strings for anything you cannot determine. Do not guess a UPC.`;

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no JSON');
  return JSON.parse(m[0]);
}

// One model call. images = [{ buf, mime }]. Returns the raw text reply.
async function callModel(prompt, images = [], { json = true, maxTokens = 600 } = {}) {
  if (!aiEnabled()) throw Object.assign(new Error('AI is not configured (set AI_PROVIDER)'), { status: 501 });
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  if (PROVIDER === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: [
          ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.buf.toString('base64') } })),
          { type: 'text', text: prompt },
        ] }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).content.map(c => c.text || '').join('');
  }

  const r = await fetch(`${process.env.OLLAMA_URL || 'http://ollama:11434'}/api/chat`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'qwen2.5vl:3b',
      stream: false,
      ...(json ? { format: 'json' } : {}),
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
      messages: [{ role: 'user', content: prompt, ...(images.length ? { images: images.map(i => i.buf.toString('base64')) } : {}) }],
    }),
  }).catch(e => { throw new Error(e.name === 'TimeoutError' ? 'The AI took too long (first photo after a restart is slowest) — try again' : `Cannot reach Ollama: ${e.message}`); });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).message?.content || '';
}

export async function identify(buf, mime = 'image/jpeg') {
  const o = extractJson(await callModel(IDENTIFY_PROMPT, [{ buf, mime }]));
  return {
    title: String(o.title || ''), brand: String(o.brand || ''), category: String(o.category || ''),
    condition: String(o.condition || ''), size: String(o.size || ''),
    upc: String(o.upc || '').replace(/\D/g, ''), description: String(o.description || ''),
    confidence: Number(o.confidence) || 0,
  };
}

const PLATFORM_STYLE = {
  ebay: 'eBay: title up to 80 characters packed with searchable keywords (brand, item type, size, color, model). Description: clear bullet-style facts, condition, measurements if known.',
  vinted: 'Vinted: short friendly title (brand + item + size). Casual, honest 2-3 sentence description mentioning condition and size. No hashtags spam.',
  facebook: 'Facebook Marketplace: simple title (item + brand + size). Short description with condition, and pickup/shipping mention. Plain and friendly.',
  amazon: 'Amazon: clean factual title, brand first, no promotional words. Bullet-style description.',
};

// Write a marketplace title + description for an item. First photo (if any) is shown to a vision model.
export async function writeListing(item, platform, photo) {
  const facts = [
    `Title: ${item.title}`, item.brand && `Brand: ${item.brand}`, item.category && `Category: ${item.category}`,
    item.condition && `Condition: ${item.condition}`, item.size && `Size: ${item.size}`, item.notes && `Seller notes: ${item.notes}`,
  ].filter(Boolean).join('\n');
  const prompt = `Write a marketplace listing for a used item being resold.
Platform style — ${PLATFORM_STYLE[platform] || PLATFORM_STYLE.ebay}
Use ONLY the facts below (and the photo if given). Do not invent measurements, materials, flaws or authenticity claims. Be honest about condition.
${facts}
Reply with ONLY JSON: {"title": "", "description": ""}`;
  const o = extractJson(await callModel(prompt, photo ? [photo] : [], { maxTokens: 700 }));
  return { title: String(o.title || ''), description: String(o.description || '') };
}

// --- similarity against existing inventory (used for "is this already in the system?") ---
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'with', 'in', 'new', 'used', 'size']);
const tokens = s => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t && !STOP.has(t)));

export function scoreMatch(query, item) {
  if (query.upc && item.upc && query.upc === item.upc) return 1;
  const a = tokens(`${query.brand} ${query.title}`);
  const b = tokens(`${item.brand} ${item.title}`);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function findMatches(query, items, { min = 0.3, limit = 5 } = {}) {
  return items
    .map(item => ({ item, score: scoreMatch(query, item) }))
    .filter(m => m.score >= min)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}
