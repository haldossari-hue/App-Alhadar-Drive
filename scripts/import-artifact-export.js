/* استيراد بيانات النسخة القديمة (Claude Artifact) إلى قاعدة البيانات الجديدة.
   الاستخدام: npm run import:artifact -- <مجلد_التصدير> [--replace]
   المجلد يحتوي: stores/*.json, settings/app.json, coupons/*.json, drivers/*.json, pimg/*.json (الصور)
   واختيارياً: customers/*.json, orders/*.json (اسم الملف = معرف المستند) */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { saveStore } from '../src/repo.js';
import { writeOrder } from '../src/repo.js';
import { CAT, TINTS, UNIT_PRESETS, normalizePhone, round2 } from '../public/shared/constants.js';

const dir = process.argv[2];
const replace = process.argv.includes('--replace');
if (!dir || !fs.existsSync(dir)) { console.error('حدد مجلد التصدير'); process.exit(1); }

const readAll = (sub) => {
  const d = path.join(dir, sub);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) }));
};

const db = openDb(path.join(config.dataDir, 'alhadar.db'));
if (replace) db.exec('DELETE FROM products; DELETE FROM stores; DELETE FROM coupons; DELETE FROM drivers;');

/* المتاجر والمنتجات */
const stores = readAll('stores');
let prodCount = 0, priced = 0;
for (const s of stores) {
  const products = (s.products || []).filter((p) => String(p.name || '').trim()).map((p) => {
    const o = { id: String(p.id), name: String(p.name).trim(), unit: p.unit || '', price: round2(Number(p.price) || 0), emoji: p.emoji || '📦', available: p.available !== false, sec: p.sec || '' };
    /* الصور القديمة مخزنة في منصة Claude (/_blob/...) ولا تنتقل تلقائياً — تُرفع من جديد من لوحة الإدارة */
    if (p.saleType === 'weight' && Array.isArray(p.units) && p.units.length) {
      o.saleType = 'weight';
      o.units = UNIT_PRESETS.filter((u) => p.units.some((x) => x.label === u.label));
      o.unit = '';
    }
    prodCount++; if (o.price > 0) priced++;
    return o;
  });
  const category = CAT[s.category] ? s.category : 'restaurants';
  saveStore(db, s.id, {
    name: String(s.name || '').trim(), category, emoji: s.emoji || CAT[category].emoji, color: s.color || TINTS[0], eta: Number(s.eta) || 30,
    hours: s.hours || '', phone: s.phone || '', desc: s.desc || '', note: s.note || '', open: s.open !== false, sort: Number(s.sort) || 99,
  }, products);
}
console.log(`المتاجر: ${stores.length} (مسمّاة: ${stores.filter((s) => String(s.name || '').trim()).length}) — المنتجات: ${prodCount} (مسعّرة: ${priced})`);

/* صور المنتجات: مستند لكل متجر {m: منتج→مفتاح، d: مفتاح→data URI}. الصور المتطابقة تُحفظ مرة وحدة */
const pimgs = readAll('pimg');
if (pimgs.length) {
  const uploads = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const byHash = new Map();
  let linked = 0;
  for (const doc of pimgs) {
    const m = doc.m || {}, d = doc.d || null;
    for (const [pid, ref] of Object.entries(m)) {
      const uri = d ? d[ref] : ref;
      const mt = typeof uri === 'string' && uri.match(/^data:(image\/(?:webp|png|jpeg));base64,(.+)$/);
      if (!mt) continue;
      const buf = Buffer.from(mt[2], 'base64');
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      let id = byHash.get(h);
      if (!id) {
        id = 'fimg-' + h.slice(0, 24);
        if (!db.get('SELECT 1 FROM files WHERE id = ?', id)) {
          fs.writeFileSync(path.join(uploads, id), buf);
          db.run('INSERT INTO files(id, kind, mime, size, owner, created_at) VALUES(?,?,?,?,?,?)', id, 'product', mt[1], buf.length, 'import', Date.now());
        }
        byHash.set(h, id);
      }
      linked += db.run('UPDATE products SET img = ? WHERE store_id = ? AND id = ?', '/files/' + id, doc.id, pid).changes;
    }
  }
  console.log(`صور المنتجات: ${linked} منتج مربوط بـ ${byHash.size} صورة`);
}

/* الإعدادات ورمز الإدارة (الرمز القديم يستمر يشتغل ويترقّى تشفيره عند أول دخول) */
const st = readAll('settings').find((x) => x.id === 'app');
if (st) {
  const { adminPinHash, adminPin, recoveryHash, id, ...rest } = st;
  delete rest.payments;
  db.saveSettings({ ...rest, payments: { cash: true, bank: st.payments ? st.payments.bank !== false : true } });
  const pinHash = adminPinHash || (adminPin ? 'plain$' + adminPin : null);
  if (pinHash) db.kvSet('admin', { pinHash, recoveryHash: recoveryHash || null, v: 1 });
  console.log(`الإعدادات: ${(rest.districts || []).length} حي، رسوم التوصيل ${rest.deliveryFee}، رمز الإدارة ${pinHash ? 'منقول' : 'افتراضي'}`);
}

/* الكوبونات */
const coupons = readAll('coupons');
for (const c of coupons) {
  db.run(`INSERT OR REPLACE INTO coupons(code,kind,value,note,min_order,max_uses,used_count,expires_at,categories,once_per_customer,active,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, c.id.toUpperCase(), c.kind, Number(c.value) || 0, c.note || '', Number(c.minOrder) || 0, c.maxUses || null,
    Number(c.usedCount) || 0, c.expiresAt || null, JSON.stringify(c.categories || []), c.oncePerCustomer === false ? 0 : 1, c.active === false ? 0 : 1, c.createdAt || Date.now());
}
console.log(`الكوبونات: ${coupons.length}`);

/* السائقون — الدخول صار بالجوال + الرمز */
const drivers = readAll('drivers');
for (const d of drivers) {
  const phone = normalizePhone(d.phone);
  if (!phone) { console.warn(`  ⚠️ السائق ${d.name} بدون جوال صحيح — تخطيته، أضفه من لوحة الإدارة`); continue; }
  const pinHash = d.pinHash || (d.pin ? 'plain$' + d.pin : null);
  if (!pinHash) { console.warn(`  ⚠️ السائق ${d.name} بدون رمز — تخطيته`); continue; }
  db.run('INSERT OR REPLACE INTO drivers(id,name,phone,pin_hash,vehicle,active,online,created_at) VALUES(?,?,?,?,?,?,?,?)',
    d.id, d.name, phone, pinHash, d.vehicle || '', d.active === false ? 0 : 1, d.online === false ? 0 : 1, Date.now());
}
console.log(`السائقون: ${drivers.length}`);

/* العملاء (اختياري) — تسجيل الدخول صار برمز SMS، فالرمز السري القديم لا يُنقل */
const customers = readAll('customers');
for (const c of customers) {
  const phone = normalizePhone(c.id);
  if (!phone) continue;
  db.run(`INSERT OR REPLACE INTO customers(phone,name,district,address,map,delivered_count,free_deliveries,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    phone, c.name || 'عميل', c.district || '', c.address || '', c.map || '', Number(c.deliveredCount) || 0, Number(c.freeDeliveries) || 0, c.createdAt || Date.now());
  for (const code of Object.keys(c.usedCoupons || {})) db.run('INSERT OR IGNORE INTO customer_coupons(phone,code,used_at) VALUES(?,?,?)', phone, code.toUpperCase(), Date.now());
}
if (customers.length) console.log(`العملاء: ${customers.length}`);

/* الطلبات (اختياري، للأرشيف والإحصائيات) */
const orders = readAll('orders');
for (const o of orders) {
  const phone = normalizePhone(o.customer && o.customer.phone);
  if (!phone || !o.code) continue;
  const { receiptUrl, image, ...rest } = o;
  writeOrder(db, {
    ...rest, id: 'old_' + o.id, code: String(o.code), groupCode: String(o.code).replace(/[A-Z]$/, ''), customer: { ...o.customer, phone },
    paymentStatus: o.payment === 'bank' ? 'proof' : 'cod', payment: o.payment === 'bank' ? 'bank' : 'cash',
    isCustom: !!o.isCustom, priceStatus: o.priceStatus || null, settled: !!o.settled, freeDeliveryUsed: !!o.freeDeliveryUsed,
    legacyReceipt: receiptUrl ? true : undefined,
  });
}
if (orders.length) console.log(`الطلبات: ${orders.length}`);
console.log('تم الاستيراد ✅');
