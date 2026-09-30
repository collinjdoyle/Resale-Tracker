import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'resale.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  brand       TEXT DEFAULT '',
  category    TEXT DEFAULT '',
  condition   TEXT DEFAULT '',
  size        TEXT DEFAULT '',
  upc         TEXT DEFAULT '',
  cost        REAL NOT NULL DEFAULT 0,
  bought_date TEXT,
  bought_from TEXT DEFAULT '',
  listed_on   TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','listed','sold')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_upc ON items(upc);

CREATE TABLE IF NOT EXISTS photos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  filename TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
  platform   TEXT NOT NULL,
  sold_price REAL NOT NULL,
  fees       REAL NOT NULL DEFAULT 0,
  shipping   REAL NOT NULL DEFAULT 0,
  sold_date  TEXT NOT NULL,
  notes      TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS expenses (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  amount   REAL NOT NULL,
  miles    REAL,
  note     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
`);

// Additive migrations for databases created by earlier versions.
const itemCols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
if (!itemCols.includes('list_price')) db.exec('ALTER TABLE items ADD COLUMN list_price REAL');

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

// Fee presets are only *suggestions* used to prefill the sell form; the real fee is always editable.
export const DEFAULT_FEES = {
  ebay:     { label: 'eBay',                 pct: 13.6, fixed: 0.4 },
  vinted:   { label: 'Vinted',               pct: 0,    fixed: 0 },
  facebook: { label: 'Facebook Marketplace', pct: 10,   fixed: 0 },
  fb_local: { label: 'Facebook (local)',     pct: 0,    fixed: 0 },
  amazon:   { label: 'Amazon',               pct: 15,   fixed: 0 },
  other:    { label: 'Other',                pct: 0,    fixed: 0 },
};

export function getFees() {
  const row = db.prepare("SELECT value FROM settings WHERE key='fees'").get();
  return row ? JSON.parse(row.value) : DEFAULT_FEES;
}
export function setFees(fees) {
  db.prepare("INSERT INTO settings(key,value) VALUES('fees',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(fees));
}

// Items joined with their sale + photos, plus computed profit.
const ITEM_SELECT = `
SELECT i.*, s.platform, s.sold_price, s.fees, s.shipping, s.sold_date, s.notes AS sale_notes,
       CASE WHEN s.id IS NULL THEN NULL ELSE s.sold_price - s.fees - s.shipping - i.cost END AS profit,
       MAX(0, CAST(julianday(COALESCE(s.sold_date, date('now'))) - julianday(COALESCE(i.bought_date, date(i.created_at))) AS INTEGER)) AS days_held
FROM items i LEFT JOIN sales s ON s.item_id = i.id`;

export function listItems({ status, q } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('i.status = ?'); args.push(status); }
  if (q) {
    where.push("(i.title LIKE ? OR i.brand LIKE ? OR i.upc LIKE ? OR i.category LIKE ? OR i.notes LIKE ?)");
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  const rows = db.prepare(`${ITEM_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC`).all(...args);
  return attachPhotos(rows);
}

export function getItem(id) {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id);
  return row ? attachPhotos([row])[0] : null;
}

function attachPhotos(rows) {
  if (!rows.length) return rows;
  const photos = db.prepare('SELECT id, item_id, filename FROM photos ORDER BY id').all();
  const byItem = new Map();
  for (const p of photos) {
    if (!byItem.has(p.item_id)) byItem.set(p.item_id, []);
    byItem.get(p.item_id).push({ id: p.id, url: `/uploads/${p.filename}` });
  }
  return rows.map(r => ({ ...r, photos: byItem.get(r.id) || [] }));
}

export function stats() {
  const one = sql => db.prepare(sql).get();
  const totals = one(`
    SELECT COUNT(*) AS sold_count,
           COALESCE(SUM(s.sold_price),0) AS revenue,
           COALESCE(SUM(s.fees),0) AS fees,
           COALESCE(SUM(s.shipping),0) AS shipping,
           COALESCE(SUM(i.cost),0) AS cogs,
           COALESCE(SUM(s.sold_price - s.fees - s.shipping - i.cost),0) AS profit
    FROM sales s JOIN items i ON i.id = s.item_id`);
  const stock = one(`SELECT COUNT(*) AS count, COALESCE(SUM(cost),0) AS cost FROM items WHERE status != 'sold'`);
  const byPlatform = db.prepare(`
    SELECT s.platform, COUNT(*) AS count, SUM(s.sold_price) AS revenue,
           SUM(s.sold_price - s.fees - s.shipping - i.cost) AS profit
    FROM sales s JOIN items i ON i.id = s.item_id GROUP BY s.platform ORDER BY profit DESC`).all();
  const byMonth = db.prepare(`
    SELECT substr(s.sold_date,1,7) AS month, COUNT(*) AS count, SUM(s.sold_price) AS revenue,
           SUM(s.sold_price - s.fees - s.shipping - i.cost) AS profit
    FROM sales s JOIN items i ON i.id = s.item_id GROUP BY month ORDER BY month DESC LIMIT 12`).all();
  const bySource = db.prepare(`
    SELECT CASE WHEN TRIM(i.bought_from) = '' THEN 'Unknown' ELSE TRIM(i.bought_from) END AS source,
           COUNT(*) AS count, SUM(s.sold_price - s.fees - s.shipping - i.cost) AS profit
    FROM sales s JOIN items i ON i.id = s.item_id GROUP BY source ORDER BY profit DESC LIMIT 5`).all();
  const avgDays = one(`
    SELECT AVG(MAX(0, julianday(s.sold_date) - julianday(COALESCE(i.bought_date, date(i.created_at))))) AS days
    FROM sales s JOIN items i ON i.id = s.item_id`).days;
  const exp = one('SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(miles),0) AS miles FROM expenses');
  const expByMonth = Object.fromEntries(db.prepare(
    'SELECT substr(date,1,7) AS month, SUM(amount) AS total FROM expenses GROUP BY month').all().map(r => [r.month, r.total]));
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = {
    month,
    profit: (byMonth.find(m => m.month === month)?.profit || 0) - (expByMonth[month] || 0),
    goal: getSetting('goal', 0),
  };
  for (const m of byMonth) m.expenses = expByMonth[m.month] || 0;
  const stale = one(`SELECT COUNT(*) AS n FROM items WHERE status != 'sold'
    AND julianday('now') - julianday(COALESCE(bought_date, date(created_at))) >= ${STALE_DAYS}`).n;
  return {
    totals: { ...totals, expenses: exp.total, miles: exp.miles, net: totals.profit - exp.total,
      avg_profit: totals.sold_count ? totals.profit / totals.sold_count : 0,
      margin: totals.revenue ? (totals.profit / totals.revenue) * 100 : 0, avg_days: avgDays },
    stock, stale, byPlatform, byMonth, bySource, thisMonth,
  };
}

export const STALE_DAYS = 60;

export const listExpenses = () => db.prepare('SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 300').all();
export const addExpense = e => db.prepare('INSERT INTO expenses (date, category, amount, miles, note) VALUES (?,?,?,?,?)')
  .run(e.date, e.category, e.amount, e.miles, e.note);
export const deleteExpense = id => db.prepare('DELETE FROM expenses WHERE id=?').run(id);
