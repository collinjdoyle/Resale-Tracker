// Photo -> item details. Providers: anthropic (Claude vision), ollama (local vision model), none.
const PROVIDER = (process.env.AI_PROVIDER || 'none').toLowerCase();

const PROMPT = `You are helping a reseller catalogue a used item from a photo.
Identify the product as specifically as you can. Read any visible brand, model, size, or barcode digits from tags/labels/packaging.
Reply with ONLY a JSON object, no prose, with these keys:
{"title": "concise marketplace-style listing title", "brand": "", "category": "", "condition": "new|like new|good|fair|poor|unknown", "size": "", "upc": "digits only if a barcode number is clearly readable, else empty", "description": "1-2 sentences", "confidence": 0.0}
Use empty strings for anything you cannot determine. Do not guess a UPC.`;

export const aiEnabled = () => PROVIDER === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY : PROVIDER === 'ollama';

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no JSON');
  const o = JSON.parse(m[0]);
  return {
    title: String(o.title || ''), brand: String(o.brand || ''), category: String(o.category || ''),
    condition: String(o.condition || ''), size: String(o.size || ''),
    upc: String(o.upc || '').replace(/\D/g, ''), description: String(o.description || ''),
    confidence: Number(o.confidence) || 0,
  };
}

export async function identify(buf, mime = 'image/jpeg') {
  if (!aiEnabled()) throw Object.assign(new Error('Photo recognition is not configured'), { status: 501 });
  const b64 = buf.toString('base64');

  if (PROVIDER === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return parseJson(j.content.map(c => c.text || '').join(''));
  }

  // ollama
  const r = await fetch(`${process.env.OLLAMA_URL || 'http://localhost:11434'}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'qwen2.5vl',
      stream: false,
      format: 'json',
      messages: [{ role: 'user', content: PROMPT, images: [b64] }],
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return parseJson(j.message?.content || '');
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
