import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, UPLOAD_DIR, listItems, getItem, stats, getFees, setFees } from './db.js';
import { identify, findMatches, aiEnabled } from './ai.js';
import { lookupUpc } from './upc.js';

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || 'dev-secret';
const CURRENCY = process.env.CURRENCY || '$';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.send('ok'));
app.use(express.json({ limit: '1mb' }));
app.use(express.raw({ type: 'image/*', limit: '12mb' }));

// ---------- auth (single shared password, optional) ----------
const token = () => crypto.createHmac('sha256', SECRET).update(PASSWORD).digest('hex');
const cookieOf = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => c.split(/=(.*)/s).slice(0, 2)));
const authed = req => {
  if (!PASSWORD) return true;
  const c = cookieOf(req).auth || '';
  return c.length === token().length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(token()));
};

app.post('/api/login', (req, res) => {
  const given = Buffer.from(String(req.body?.password || ''));
  const real = Buffer.from(PASSWORD);
  if (PASSWORD && !(given.length === real.length && crypto.timingSafeEqual(given, real))) return res.status(401).json({ error: 'Wrong password' });
  res.setHeader('Set-Cookie', `auth=${token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 365}`);
  res.json({ ok: true });
});
app.get('/api/session', (req, res) => res.json({ authed: authed(req), currency: CURRENCY, ai: aiEnabled(), passwordRequired: !!PASSWORD }));

app.use(['/api', '/uploads'], (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'Login required' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(PUBLIC));

// ---------- helpers ----------
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const today = () => new Date().toISOString().slice(0, 10);
const ITEM_FIELDS = ['title', 'brand', 'category', 'condition', 'size', 'upc', 'bought_date', 'bought_from', 'listed_on', 'notes'];

function itemValues(b) {
  const v = {};
  for (const f of ITEM_FIELDS) if (b[f] !== undefined) v[f] = String(b[f] ?? '').trim();
  if (b.cost !== undefined) v.cost = num(b.cost);
  if (b.status !== undefined && ['in_stock', 'listed', 'sold'].includes(b.status)) v.status = b.status;
  if (v.upc) v.upc = v.upc.replace(/\D/g, '');
  return v;
}

const sniffExt = buf =>
  buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' :
  buf.subarray(1, 4).toString() === 'PNG' ? 'png' :
  buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;

// async route helper: sends the returned value as JSON, maps thrown errors to a status
const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).then(out => res.json(out)).catch(e => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});

// ---------- items ----------
app.get('/api/items', (req, res) => res.json(listItems({ status: req.query.status, q: req.query.q })));

app.post('/api/items', (req, res) => {
  const v = itemValues(req.body || {});
  if (!v.title) return res.status(400).json({ error: 'Title is required' });
  v.bought_date ||= today();
  const keys = Object.keys(v);
  const r = db.prepare(`INSERT INTO items (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => v[k]));
  res.status(201).json(getItem(Number(r.lastInsertRowid)));
});

app.get('/api/items/:id', (req, res) => {
  const item = getItem(Number(req.params.id));
  item ? res.json(item) : res.status(404).json({ error: 'Not found' });
});

app.put('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getItem(id)) return res.status(404).json({ error: 'Not found' });
  const v = itemValues(req.body || {});
  delete v.status; // status changes only via list/sell endpoints
  const keys = Object.keys(v);
  if (keys.length) db.prepare(`UPDATE items SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => v[k]), id);
  if (req.body?.status && getItem(id).status !== 'sold' && ['in_stock', 'listed'].includes(req.body.status)) {
    db.prepare('UPDATE items SET status=? WHERE id=?').run(req.body.status, id);
  }
  res.json(getItem(id));
});

app.delete('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const files = db.prepare('SELECT filename FROM photos WHERE item_id=?').all(id);
  db.prepare('DELETE FROM items WHERE id=?').run(id);
  for (const f of files) fs.rmSync(path.join(UPLOAD_DIR, f.filename), { force: true });
  res.json({ ok: true });
});

// ---------- photos ----------
function savePhoto(buf) {
  const ext = sniffExt(buf);
  if (!ext) throw Object.assign(new Error('Unsupported image (use JPEG, PNG or WebP)'), { status: 415 });
  const filename = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return filename;
}

const imageBody = req => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('No image body'), { status: 400 });
  return req.body;
};

app.post('/api/items/:id/photos', wrap(req => {
  const id = Number(req.params.id);
  if (!getItem(id)) throw Object.assign(new Error('Not found'), { status: 404 });
  const filename = savePhoto(imageBody(req));
  db.prepare('INSERT INTO photos (item_id, filename) VALUES (?,?)').run(id, filename);
  return getItem(id);
}));

app.delete('/api/photos/:id', (req, res) => {
  const p = db.prepare('SELECT filename FROM photos WHERE id=?').get(Number(req.params.id));
  if (p) {
    db.prepare('DELETE FROM photos WHERE id=?').run(Number(req.params.id));
    fs.rmSync(path.join(UPLOAD_DIR, p.filename), { force: true });
  }
  res.json({ ok: true });
});

// ---------- sell / unsell ----------
app.post('/api/items/:id/sell', (req, res) => {
  const id = Number(req.params.id);
  if (!getItem(id)) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const price = num(b.sold_price);
  if (!b.platform || !(price >= 0) || b.sold_price === '' || b.sold_price == null) return res.status(400).json({ error: 'Platform and sold price are required' });
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO sales (item_id, platform, sold_price, fees, shipping, sold_date, notes) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(item_id) DO UPDATE SET platform=excluded.platform, sold_price=excluded.sold_price,
                fees=excluded.fees, shipping=excluded.shipping, sold_date=excluded.sold_date, notes=excluded.notes`)
      .run(id, String(b.platform), price, num(b.fees), num(b.shipping), b.sold_date || today(), String(b.notes || ''));
    db.prepare("UPDATE items SET status='sold' WHERE id=?").run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json(getItem(id));
});

app.delete('/api/items/:id/sell', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM sales WHERE item_id=?').run(id);
  db.prepare("UPDATE items SET status='in_stock' WHERE id=?").run(id);
  res.json(getItem(id));
});

// ---------- lookup helpers ----------
app.get('/api/upc/:code', wrap(async req => {
  const code = req.params.code.replace(/\D/g, '');
  const existing = listItems({ q: code }).filter(i => i.upc === code);
  return { product: await lookupUpc(code), existing };
}));

app.post('/api/identify', wrap(async req => {
  const buf = imageBody(req);
  const mime = req.headers['content-type'].split(';')[0];
  const ai = await identify(buf, mime);
  const all = listItems();
  const matches = findMatches(ai, all).map(m => ({ ...m.item, score: Math.round(m.score * 100) / 100 }));
  const upcProduct = ai.upc ? await lookupUpc(ai.upc) : null;
  return { ai, upcProduct, matches };
}));

// ---------- fees, stats, export ----------
app.get('/api/fees', (_req, res) => res.json(getFees()));
app.put('/api/fees', (req, res) => { setFees(req.body); res.json(getFees()); });
app.get('/api/stats', (_req, res) => res.json(stats()));

app.get('/api/export.csv', (_req, res) => {
  const cols = ['id', 'title', 'brand', 'category', 'condition', 'size', 'upc', 'cost', 'bought_date', 'bought_from', 'status', 'platform', 'sold_price', 'fees', 'shipping', 'sold_date', 'profit', 'notes'];
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const rows = listItems().map(i => cols.map(c => esc(i[c])).join(','));
  res.type('text/csv').attachment('resale-export.csv').send([cols.join(','), ...rows].join('\n'));
});

app.listen(PORT, () => console.log(`resale-tracker listening on :${PORT} (AI: ${aiEnabled() ? process.env.AI_PROVIDER : 'off'}, auth: ${PASSWORD ? 'on' : 'off'})`));
