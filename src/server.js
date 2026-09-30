import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, UPLOAD_DIR, STALE_DAYS, listItems, getItem, stats, getFees, setFees, getSetting, setSetting,
  listExpenses, addExpense, deleteExpense, listSales, getSale, soldQty, recalcStatus,
} from './db.js';
import { identify, writeListing, findMatches, aiEnabled } from './ai.js';
import { lookupUpc } from './upc.js';
import { rank, HASH_RE } from './similar.js';

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
app.get('/api/session', (req, res) => res.json({ authed: authed(req), currency: CURRENCY, ai: aiEnabled(), passwordRequired: !!PASSWORD, staleDays: STALE_DAYS }));

app.use(['/api', '/uploads'], (req, res, next) => authed(req) ? next() : res.status(401).json({ error: 'Login required' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(PUBLIC));

// ---------- helpers ----------
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const today = () => new Date().toISOString().slice(0, 10);
const fail = (status, message) => Object.assign(new Error(message), { status });
const ITEM_FIELDS = ['title', 'brand', 'category', 'condition', 'size', 'upc', 'bought_date', 'bought_from', 'listed_on', 'notes'];

function itemValues(b) {
  const v = {};
  for (const f of ITEM_FIELDS) if (b[f] !== undefined) v[f] = String(b[f] ?? '').trim();
  if (b.cost !== undefined) v.cost = num(b.cost);
  if (b.quantity !== undefined) v.quantity = Math.max(1, Math.floor(num(b.quantity)) || 1);
  if (b.list_price !== undefined) v.list_price = b.list_price === '' || b.list_price === null ? null : num(b.list_price);
  if (b.status !== undefined && ['in_stock', 'listed', 'sold'].includes(b.status)) v.status = b.status;
  if (v.upc) v.upc = normUpc(v.upc);
  return v;
}

// Scanners read a 12-digit UPC-A as a 13-digit EAN with a leading 0; store one form so history matches either way.
const normUpc = code => { const d = String(code).replace(/\D/g, ''); return d.length === 13 && d[0] === '0' ? d.slice(1) : d; };

const sniffExt = buf =>
  buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' :
  buf.subarray(1, 4).toString() === 'PNG' ? 'png' :
  buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;

// async route helper: sends the returned value as JSON, maps thrown errors to a status
const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).then(out => res.json(out)).catch(e => {
  if (!e.status) console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});

// ---------- items ----------
app.get('/api/items', (req, res) => res.json(listItems({ status: req.query.status, q: req.query.q })));

app.post('/api/items', wrap(req => {
  const b = req.body || {};
  const v = itemValues(b);
  if (!v.title) throw fail(400, 'Title is required');
  v.bought_date ||= today();
  const keys = Object.keys(v);
  const r = db.prepare(`INSERT INTO items (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => v[k]));
  const id = Number(r.lastInsertRowid);
  // "Add again" from history: reuse the old item's photos (copied, so deleting either item keeps the other's pictures).
  if (b.copy_photos_from) {
    for (const p of db.prepare('SELECT filename, hash FROM photos WHERE item_id=? ORDER BY id').all(Number(b.copy_photos_from))) {
      const ext = path.extname(p.filename);
      const filename = `${crypto.randomUUID()}${ext}`;
      try { fs.copyFileSync(path.join(UPLOAD_DIR, p.filename), path.join(UPLOAD_DIR, filename)); } catch { continue; }
      db.prepare('INSERT INTO photos (item_id, filename, hash) VALUES (?,?,?)').run(id, filename, p.hash);
    }
  }
  return getItem(id);
}));

app.get('/api/items/:id', (req, res) => {
  const item = getItem(Number(req.params.id));
  item ? res.json(item) : res.status(404).json({ error: 'Not found' });
});

app.put('/api/items/:id', wrap(req => {
  const id = Number(req.params.id);
  const cur = getItem(id);
  if (!cur) throw fail(404, 'Not found');
  const v = itemValues(req.body || {});
  const wanted = v.status;
  delete v.status;
  if (v.quantity !== undefined && v.quantity < cur.sold_qty) throw fail(400, `You've already sold ${cur.sold_qty} of these — quantity can't go below that`);
  const keys = Object.keys(v);
  if (keys.length) db.prepare(`UPDATE items SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => v[k]), id);
  recalcStatus(id);
  if (['in_stock', 'listed'].includes(wanted) && getItem(id).remaining > 0) db.prepare('UPDATE items SET status=? WHERE id=?').run(wanted, id);
  return getItem(id);
}));

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
  if (!ext) throw fail(415, 'Unsupported image (use JPEG, PNG or WebP)');
  const filename = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return filename;
}

const imageBody = req => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'No image body');
  return req.body;
};

app.post('/api/items/:id/photos', wrap(req => {
  const id = Number(req.params.id);
  if (!getItem(id)) throw fail(404, 'Not found');
  const filename = savePhoto(imageBody(req));
  const hash = String(req.headers['x-image-hash'] || '');
  db.prepare('INSERT INTO photos (item_id, filename, hash) VALUES (?,?,?)').run(id, filename, HASH_RE.test(hash) ? hash : null);
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

// "Looks like" search: client sends a fingerprint of the photo it just took; we return the closest items.
app.post('/api/similar', (req, res) => {
  const hash = String(req.body?.hash || '');
  if (!HASH_RE.test(hash)) return res.status(400).json({ error: 'Bad image fingerprint' });
  const photos = db.prepare('SELECT item_id, hash FROM photos WHERE hash IS NOT NULL').all();
  let ranked = rank(hash, photos, 30).map(r => ({ item: getItem(r.item_id), score: r.score })).filter(r => r.item);
  if (req.body.unsold) ranked = ranked.filter(r => r.item.remaining > 0);
  res.json({ photosIndexed: photos.length, matches: ranked.slice(0, 6).map(r => ({ ...r.item, score: Math.round(r.score * 100) / 100 })) });
});

// ---------- sales (one row per sale event; an item can be sold in several pieces) ----------
const saleFields = (b, qtyLimit) => {
  const qty = Math.max(1, Math.floor(num(b.qty ?? 1)) || 1);
  if (qty > qtyLimit) throw fail(400, qtyLimit > 0 ? `Only ${qtyLimit} left to sell` : 'None left to sell');
  if (!b.platform || b.sold_price === '' || b.sold_price == null || num(b.sold_price) < 0) throw fail(400, 'Platform and sold price are required');
  return [qty, String(b.platform), num(b.sold_price), num(b.fees), num(b.shipping), b.sold_date || today(), String(b.notes || '')];
};

app.get('/api/sales', (_req, res) => res.json(listSales()));

app.post('/api/items/:id/sell', wrap(req => {
  const id = Number(req.params.id);
  const item = getItem(id);
  if (!item) throw fail(404, 'Not found');
  const f = saleFields(req.body || {}, item.remaining);
  db.prepare('INSERT INTO sales (item_id, qty, platform, sold_price, fees, shipping, sold_date, notes) VALUES (?,?,?,?,?,?,?,?)').run(id, ...f);
  recalcStatus(id);
  return getItem(id);
}));

app.put('/api/sales/:id', wrap(req => {
  const sale = getSale(Number(req.params.id));
  if (!sale) throw fail(404, 'Not found');
  const item = getItem(sale.item_id);
  const f = saleFields(req.body || {}, item.quantity - soldQty(sale.item_id, sale.id));
  db.prepare('UPDATE sales SET qty=?, platform=?, sold_price=?, fees=?, shipping=?, sold_date=?, notes=? WHERE id=?').run(...f, sale.id);
  recalcStatus(sale.item_id);
  return getItem(sale.item_id);
}));

app.delete('/api/sales/:id', wrap(req => {
  const sale = getSale(Number(req.params.id));
  if (!sale) throw fail(404, 'Not found');
  db.prepare('DELETE FROM sales WHERE id=?').run(sale.id);
  recalcStatus(sale.item_id);
  return getItem(sale.item_id);
}));

// ---------- barcode lookup ----------
// Order: (1) your own past items with that barcode (instant, works for anything you have bought before),
// (2) UPCitemdb, (3) Open Food Facts. See upc.js.
app.get('/api/upc/:code', wrap(async req => {
  const code = normUpc(req.params.code);
  const existing = listItems({ q: code }).filter(i => i.upc === code);
  if (existing.length) {
    const p = existing[0];
    return { product: { source: 'history', upc: code, title: p.title, brand: p.brand, category: p.category, condition: p.condition, size: p.size }, existing };
  }
  return { ...(await lookupUpc(code)), existing };
}));

// Optional AI helpers (only when AI_PROVIDER is set up)
app.post('/api/identify', wrap(async req => {
  const ai = await identify(imageBody(req), req.headers['content-type'].split(';')[0]);
  const matches = findMatches(ai, listItems()).map(m => ({ ...m.item, score: Math.round(m.score * 100) / 100 }));
  const upcProduct = ai.upc ? (await lookupUpc(ai.upc)).product : null;
  return { ai, upcProduct, matches };
}));

app.post('/api/items/:id/listing', wrap(async req => {
  const item = getItem(Number(req.params.id));
  if (!item) throw fail(404, 'Not found');
  let photo = null;
  const first = db.prepare('SELECT filename FROM photos WHERE item_id=? ORDER BY id LIMIT 1').get(item.id);
  if (first) {
    const file = path.join(UPLOAD_DIR, first.filename);
    photo = { buf: fs.readFileSync(file), mime: file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
  }
  return writeListing(item, String(req.body?.platform || 'ebay'), photo);
}));

// ---------- expenses & settings ----------
app.get('/api/expenses', (_req, res) => res.json(listExpenses()));
app.post('/api/expenses', (req, res) => {
  const b = req.body || {};
  const amount = num(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0' });
  addExpense({
    date: b.date || today(), category: String(b.category || 'other').slice(0, 40), amount,
    miles: b.miles ? num(b.miles) : null, note: String(b.note || '').slice(0, 200),
  });
  res.status(201).json(listExpenses());
});
app.delete('/api/expenses/:id', (req, res) => { deleteExpense(Number(req.params.id)); res.json(listExpenses()); });

const settings = () => ({ goal: getSetting('goal', 0), mileage_rate: getSetting('mileage_rate', 0.7) });
app.get('/api/settings', (_req, res) => res.json(settings()));
app.put('/api/settings', (req, res) => {
  if (req.body?.goal !== undefined) setSetting('goal', Math.max(0, num(req.body.goal)));
  if (req.body?.mileage_rate !== undefined) setSetting('mileage_rate', Math.max(0, num(req.body.mileage_rate)));
  res.json(settings());
});

// ---------- fees, stats, exports ----------
app.get('/api/fees', (_req, res) => res.json(getFees()));
app.put('/api/fees', (req, res) => { setFees(req.body); res.json(getFees()); });
app.get('/api/stats', (_req, res) => res.json(stats()));

const csvEsc = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const sendCsv = (res, name, cols, rows) =>
  res.type('text/csv').attachment(name).send([cols.join(','), ...rows.map(r => cols.map(c => csvEsc(r[c])).join(','))].join('\n'));

app.get('/api/export.csv', (_req, res) => sendCsv(res, 'inventory-export.csv',
  ['id', 'title', 'brand', 'category', 'condition', 'size', 'upc', 'cost', 'quantity', 'sold_qty', 'remaining', 'list_price', 'days_held', 'bought_date', 'bought_from', 'status', 'profit', 'notes'], listItems()));
app.get('/api/sales.csv', (_req, res) => sendCsv(res, 'sales-export.csv',
  ['sold_date', 'title', 'brand', 'platform', 'qty', 'sold_price', 'fees', 'shipping', 'cost', 'profit', 'notes'], listSales()));
app.get('/api/expenses.csv', (_req, res) => sendCsv(res, 'expenses-export.csv', ['date', 'category', 'amount', 'miles', 'note'], listExpenses()));

// Container stop/update sends SIGTERM: finish requests and close SQLite so the WAL is flushed into the db file.
const server = app.listen(PORT, () => console.log(`resale-tracker listening on :${PORT} (AI: ${aiEnabled() ? process.env.AI_PROVIDER : 'off'}, auth: ${PASSWORD ? 'on' : 'off'})`));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* already closed */ } process.exit(0); }));
}
