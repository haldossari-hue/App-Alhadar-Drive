import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_SETTINGS } from '../public/shared/constants.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  emoji TEXT, color TEXT,
  eta INTEGER NOT NULL DEFAULT 30,
  hours TEXT, phone TEXT, descr TEXT, note TEXT,
  open INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 99,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  unit TEXT, emoji TEXT, sec TEXT, img TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  sale_type TEXT,           -- NULL = بالعدد، 'weight' = بالوزن
  units TEXT,               -- JSON [{label,mult}]
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, id)
);
CREATE TABLE IF NOT EXISTS customers (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  district TEXT, address TEXT, map TEXT, lat REAL, lng REAL,
  delivered_count INTEGER NOT NULL DEFAULT 0,
  free_deliveries INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_coupons (
  phone TEXT NOT NULL, code TEXT NOT NULL, used_at INTEGER NOT NULL,
  PRIMARY KEY (phone, code)
);
CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  vehicle TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  online INTEGER NOT NULL DEFAULT 1,
  lat REAL, lng REAL, loc_at INTEGER,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('percent','fixed','free_delivery')),
  value REAL NOT NULL DEFAULT 0,
  note TEXT,
  min_order REAL NOT NULL DEFAULT 0,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  categories TEXT NOT NULL DEFAULT '[]',
  once_per_customer INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  group_code TEXT NOT NULL,
  store_id TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  driver_id TEXT,
  status TEXT NOT NULL,
  payment TEXT NOT NULL,            -- cash | bank | online
  payment_status TEXT NOT NULL,     -- cod | proof | pending | paid | failed
  is_custom INTEGER NOT NULL DEFAULT 0,
  price_status TEXT,                -- pending | priced (للطلبات الخاصة)
  subtotal REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, fee REAL NOT NULL, total REAL NOT NULL,
  free_delivery_used INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  delivered_at INTEGER, settled_at INTEGER,
  data TEXT NOT NULL                -- JSON: items, customer, coupon, log, store snapshot, receipt...
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_phone, created_at);
CREATE INDEX IF NOT EXISTS orders_driver ON orders(driver_id, status);
CREATE INDEX IF NOT EXISTS orders_group ON orders(group_code);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  sender TEXT NOT NULL,             -- customer | driver | admin
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_order ON chat_messages(order_id, id);
CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,               -- product | custom | receipt
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  owner TEXT,                       -- role:id لمن رفع الملف
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  subject TEXT NOT NULL,            -- رقم العميل / معرف السائق / admin
  sub TEXT NOT NULL,                -- JSON PushSubscription
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_target ON push_subs(role, subject);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  group_code TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  amount REAL NOT NULL,
  status TEXT NOT NULL,             -- initiated | paid | failed | expired
  url TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_group ON payments(group_code);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,      -- رقم البلاغ للعميل مثل 4821
  category TEXT NOT NULL,           -- complaint | report | suggestion | inquiry | other
  subject TEXT NOT NULL,
  details TEXT NOT NULL,
  order_code TEXT,
  name TEXT, phone TEXT,
  customer_phone TEXT,              -- لو العميل مسجّل
  status TEXT NOT NULL DEFAULT 'open',  -- open | closed
  admin_note TEXT,
  source TEXT NOT NULL,             -- assistant | form
  thread_id TEXT,
  created_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status, created_at);
CREATE TABLE IF NOT EXISTS assistant_threads (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,         -- سر المحادثة (يمنع أي أحد ثاني يقرأها)
  customer_phone TEXT,
  messages TEXT NOT NULL,           -- سجل رسائل الـ API كامل (append-only)
  user_turns INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return wrap(db);
}

/* ترقيات القاعدة: إضافة أعمدة جديدة للقواعد القديمة بدون فقدان بيانات */
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (t, col, def) => { if (!cols(t).includes(col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`); };
  add('stores', 'open_at', 'TEXT');
  add('stores', 'close_at', 'TEXT');
  /* التحقق عبر واتساب الإدارة: الرمز يظهر للإدارة لترسله يدوياً */
  add('otp_codes', 'channel', "TEXT NOT NULL DEFAULT 'sms'");
  add('otp_codes', 'plain_code', 'TEXT');
  add('otp_codes', 'wa_sent_at', 'INTEGER');
}

function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const api = {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => db.exec(sql),
    /* معاملة متزامنة: كل شيء داخلها ينجح أو يتراجع مع بعض */
    tx(fn) {
      if (api._inTx) return fn();
      db.exec('BEGIN IMMEDIATE');
      api._inTx = true;
      try { const r = fn(); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
      finally { api._inTx = false; }
    },
    kvGet(key, def = null) {
      const r = api.get('SELECT value FROM kv WHERE key = ?', key);
      return r ? JSON.parse(r.value) : def;
    },
    kvSet(key, value) {
      api.run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    },
    settings() {
      return Object.assign({}, DEFAULT_SETTINGS, api.kvGet('settings', {}));
    },
    saveSettings(patch) {
      const next = Object.assign({}, api.kvGet('settings', {}), patch);
      api.kvSet('settings', next);
      return Object.assign({}, DEFAULT_SETTINGS, next);
    },
  };
  return api;
}
