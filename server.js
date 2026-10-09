const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'budget.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  planned_cents INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'expense',
  is_sinking_fund INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  who TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tx_budget_date ON transactions(budget_id, date);
`);

// Migrations for category features
try { db.exec(`ALTER TABLE categories ADD COLUMN type TEXT NOT NULL DEFAULT 'expense'`); } catch (e) { /* column already exists */ }
try { db.exec(`ALTER TABLE categories ADD COLUMN is_sinking_fund INTEGER NOT NULL DEFAULT 0`); } catch (e) { /* column already exists */ }
try { db.exec(`ALTER TABLE categories ADD COLUMN balance_cents INTEGER NOT NULL DEFAULT 0`); } catch (e) { /* column already exists */ }

// ---------- Helpers ----------
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
function newCode() {
  let s = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
const clean = (s, max = 60) => String(s ?? '').trim().slice(0, max);
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const isCents = (n) => Number.isInteger(n) && n >= 0 && n < 1e12;

// ---------- Real-time ----------
const rooms = new Map(); // code -> Set<ws>
function broadcast(code, from) {
  const room = rooms.get(code);
  if (!room) return;
  const msg = JSON.stringify({ type: 'changed', from: from || null });
  for (const ws of room) if (ws.readyState === 1) ws.send(msg);
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/budgets', (req, res) => {
  const name = clean(req.body.name) || 'Our Budget';
  let code;
  do code = newCode(); while (db.prepare('SELECT 1 FROM budgets WHERE code=?').get(code));
  const info = db.prepare('INSERT INTO budgets (code,name) VALUES (?,?)').run(code, name);
  const ins = db.prepare('INSERT INTO categories (budget_id,name,planned_cents,sort,type) VALUES (?,?,0,?,?)');
  ['Salary', 'Other Income'].forEach((n, i) => ins.run(info.lastInsertRowid, n, i, 'income'));
  ['Rent / Mortgage', 'Groceries', 'Transport', 'Fun'].forEach((n, i) => ins.run(info.lastInsertRowid, n, i + 10, 'expense'));
  res.json({ code, name });
});

// Everything below needs a valid household code.
const b = express.Router({ mergeParams: true });
app.use('/api/b/:code', (req, res, next) => {
  const budget = db.prepare('SELECT * FROM budgets WHERE code=?').get(String(req.params.code).toUpperCase());
  if (!budget) return res.status(404).json({ error: 'Budget not found. Check the code.' });
  req.budget = budget;
  next();
}, b);

b.get('/state', (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  const id = req.budget.id;
  const categories = db.prepare(`
    SELECT c.id, c.name, c.planned_cents AS planned, c.type, c.is_sinking_fund AS isSinkingFund, c.balance_cents AS balance,
      COALESCE(SUM(CASE WHEN t.type='expense' AND substr(t.date,1,7)=? THEN t.amount_cents END),0) AS spent
    FROM categories c LEFT JOIN transactions t ON t.category_id=c.id
    WHERE c.budget_id=? AND c.type='expense' GROUP BY c.id ORDER BY c.sort, c.id`).all(month, id);
  const incomeCategories = db.prepare(`
    SELECT c.id, c.name, c.planned_cents AS planned, c.type,
      COALESCE(SUM(CASE WHEN t.type='income' AND substr(t.date,1,7)=? THEN t.amount_cents END),0) AS actual
    FROM categories c LEFT JOIN transactions t ON t.category_id=c.id
    WHERE c.budget_id=? AND c.type='income' GROUP BY c.id ORDER BY c.sort, c.id`).all(month, id);
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='income' THEN amount_cents END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' AND category_id IS NULL THEN amount_cents END),0) AS uncategorized
    FROM transactions WHERE budget_id=? AND substr(date,1,7)=?`).get(id, month);
  const transactions = db.prepare(`
    SELECT t.id, t.type, t.amount_cents AS amount, t.note, t.date, t.who, t.category_id AS categoryId, c.name AS categoryName
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
    WHERE t.budget_id=? AND substr(t.date,1,7)=? ORDER BY t.date DESC, t.id DESC`).all(id, month);
  res.json({ name: req.budget.name, code: req.budget.code, month, categories, incomeCategories, income: totals.income, uncategorized: totals.uncategorized, transactions });
});

// Categories
b.post('/categories', (req, res) => {
  const name = clean(req.body.name);
  const planned = req.body.planned;
  const type = req.body.type === 'income' ? 'income' : 'expense';
  const isSinkingFund = type === 'expense' && (req.body.isSinkingFund === true || req.body.isSinkingFund === 'true' || req.body.isSinkingFund === 1);
  const balance = type === 'expense' && isSinkingFund ? (Number(req.body.balance) || 0) : 0;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!isCents(planned)) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!isCents(balance)) return res.status(400).json({ error: 'Enter a valid balance.' });
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM categories WHERE budget_id=?').get(req.budget.id).m;
  const info = db.prepare('INSERT INTO categories (budget_id,name,planned_cents,sort,type,is_sinking_fund,balance_cents) VALUES (?,?,?,?,?,?,?)')
    .run(req.budget.id, name, planned, max + 1, type, isSinkingFund ? 1 : 0, balance);
  broadcast(req.budget.code, req.get('x-client'));
  res.json({ id: info.lastInsertRowid });
});
b.put('/categories/:id', (req, res) => {
  const name = clean(req.body.name);
  const type = req.body.type === 'income' ? 'income' : 'expense';
  const isSinkingFund = type === 'expense' && (req.body.isSinkingFund === true || req.body.isSinkingFund === 'true' || req.body.isSinkingFund === 1);
  const balance = type === 'expense' && isSinkingFund ? (Number(req.body.balance) || 0) : 0;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  if (!isCents(req.body.planned)) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!isCents(balance)) return res.status(400).json({ error: 'Enter a valid balance.' });
  const r = db.prepare('UPDATE categories SET name=?, planned_cents=?, type=?, is_sinking_fund=?, balance_cents=? WHERE id=? AND budget_id=?')
    .run(name, req.body.planned, type, isSinkingFund ? 1 : 0, balance, req.params.id, req.budget.id);
  if (!r.changes) return res.status(404).json({ error: 'Category not found.' });
  broadcast(req.budget.code, req.get('x-client'));
  res.json({ ok: true });
});
b.delete('/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=? AND budget_id=?').run(req.params.id, req.budget.id);
  broadcast(req.budget.code, req.get('x-client'));
  res.json({ ok: true });
});

// Transactions
function readTx(req, res) {
  const { type, amount, date } = req.body;
  const note = clean(req.body.note, 120);
  const who = clean(req.body.who, 30);
  let categoryId = req.body.categoryId ?? null;
  if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Pick income or expense.' }), null;
  if (!Number.isInteger(amount) || amount <= 0 || amount >= 1e12) return res.status(400).json({ error: 'Enter an amount above zero.' }), null;
  if (!isDate(date)) return res.status(400).json({ error: 'Pick a valid date.' }), null;
  if (categoryId != null) {
    const cat = db.prepare('SELECT type, is_sinking_fund FROM categories WHERE id=? AND budget_id=?').get(categoryId, req.budget.id);
    if (!cat) return res.status(400).json({ error: 'Category not found.' }), null;
    const allowed = cat.type === type || (cat.is_sinking_fund === 1 && ['income', 'expense'].includes(type));
    if (!allowed) categoryId = null;
  }
  return { type, amount, date, note, who, categoryId };
}
function updateSinkingFundBalance(req, categoryId, type, amountCents, reverse = false) {
  if (categoryId == null) return;
  const cat = db.prepare('SELECT is_sinking_fund FROM categories WHERE id=? AND budget_id=?').get(categoryId, req.budget.id);
  if (!cat || cat.is_sinking_fund !== 1) return;
  const delta = (type === 'income' ? amountCents : -amountCents) * (reverse ? -1 : 1);
  db.prepare('UPDATE categories SET balance_cents = balance_cents + ? WHERE id=? AND budget_id=?').run(delta, categoryId, req.budget.id);
}
b.post('/transactions', (req, res) => {
  const t = readTx(req, res); if (!t) return;
  const info = db.prepare('INSERT INTO transactions (budget_id,category_id,type,amount_cents,note,date,who) VALUES (?,?,?,?,?,?,?)')
    .run(req.budget.id, t.categoryId, t.type, t.amount, t.note, t.date, t.who);
  updateSinkingFundBalance(req, t.categoryId, t.type, t.amount);
  broadcast(req.budget.code, req.get('x-client'));
  res.json({ id: info.lastInsertRowid });
});
b.put('/transactions/:id', (req, res) => {
  const t = readTx(req, res); if (!t) return;
  const existing = db.prepare('SELECT category_id, type, amount_cents FROM transactions WHERE id=? AND budget_id=?').get(req.params.id, req.budget.id);
  if (existing && existing.category_id != null) updateSinkingFundBalance(req, existing.category_id, existing.type, existing.amount_cents, true);
  const r = db.prepare('UPDATE transactions SET category_id=?, type=?, amount_cents=?, note=?, date=? WHERE id=? AND budget_id=?')
    .run(t.categoryId, t.type, t.amount, t.note, t.date, req.params.id, req.budget.id);
  if (!r.changes) return res.status(404).json({ error: 'Transaction not found.' });
  updateSinkingFundBalance(req, t.categoryId, t.type, t.amount);
  broadcast(req.budget.code, req.get('x-client'));
  res.json({ ok: true });
});
b.delete('/transactions/:id', (req, res) => {
  const existing = db.prepare('SELECT category_id, type, amount_cents FROM transactions WHERE id=? AND budget_id=?').get(req.params.id, req.budget.id);
  if (existing && existing.category_id != null) updateSinkingFundBalance(req, existing.category_id, existing.type, existing.amount_cents, true);
  db.prepare('DELETE FROM transactions WHERE id=? AND budget_id=?').run(req.params.id, req.budget.id);
  broadcast(req.budget.code, req.get('x-client'));
  res.json({ ok: true });
});

// ---------- Server + WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const code = (new URL(req.url, 'http://x').searchParams.get('code') || '').toUpperCase();
  if (!db.prepare('SELECT 1 FROM budgets WHERE code=?').get(code)) return ws.close(4004, 'bad code');
  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(ws);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('close', () => {
    const room = rooms.get(code);
    if (room) { room.delete(ws); if (!room.size) rooms.delete(code); }
  });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Budget app running on http://localhost:${PORT}`));
