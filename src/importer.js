/* استيراد بيانات النسخة القديمة (Claude Artifact).
   الحزمة: { format: 'alhadar-export-v1', collections: { stores:[{id,...}], settings, coupons, drivers, pimg, customers?, orders? } }
   تُستخدم من سطر الأوامر (scripts/import-artifact-export.js) ومن لوحة الإدارة (رفع ملف). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { saveStore, writeOrder } from './repo.js';
import { CAT, TINTS, UNIT_PRESETS, normalizePhone, round2 } from '../public/shared/constants.js';

export const BUNDLE_FORMAT = 'alhadar-export-v1';
const COLLECTIONS = ['stores', 'settings', 'coupons', 'drivers', 'pimg', 'customers', 'orders'];

/* يحوّل مجلد تصدير (مجلد لكل مجموعة، وملف JSON لكل مستند) إلى حزمة واحدة */
export function bundleFromDir(dir) {
  const collections = {};
  for (const c of COLLECTIONS) {
    const d = path.join(dir, c);
    if (!fs.existsSync(d)) continue;
    collections[c] = fs.readdirSync(d).filter((f) => f.endsWith('.json'))
      .map((f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) }));
  }
  return { format: BUNDLE_FORMAT, createdAt: Date.now(), collections };
}

export function importBundle(db, uploadsDir, bundle, { replace = false } = {}) {
  if (!bundle || bundle.format !== BUNDLE_FORMAT || typeof bundle.collections !== 'object') throw new Error('الملف ليس حزمة بيانات للهدار درايف');
  const C = (k) => (Array.isArray(bundle.collections[k]) ? bundle.collections[k] : []);
  const log = [];
  const written = [];
  try {
    db.tx(() => {
      if (replace) db.exec('DELETE FROM products; DELETE FROM stores; DELETE FROM coupons; DELETE FROM drivers;');

      /* المتاجر والمنتجات */
      let prodCount = 0, priced = 0;
      for (const s of C('stores')) {
        const products = (s.products || []).filter((p) => String(p.name || '').trim()).map((p) => {
          const o = { id: String(p.id), name: String(p.name).trim(), unit: p.unit || '', price: round2(Number(p.price) || 0), emoji: p.emoji || '📦', available: p.available !== false, sec: p.sec || '' };
          if (p.saleType === 'weight' && Array.isArray(p.units) && p.units.length) {
            o.saleType = 'weight';
            o.units = UNIT_PRESETS.filter((u) => p.units.some((x) => x.label === u.label));
            o.unit = '';
          }
          prodCount++; if (o.price > 0) priced++;
          return o;
        });
        const category = CAT[s.category] ? s.category : 'restaurants';
        saveStore(db, String(s.id), {
          name: String(s.name || '').trim(), category, emoji: s.emoji || CAT[category].emoji, color: s.color || TINTS[0], eta: Number(s.eta) || 30,
          hours: s.hours || '', phone: s.phone || '', desc: s.desc || '', note: s.note || '', open: s.open !== false, sort: Number(s.sort) || 99,
        }, products);
      }
      if (C('stores').length) log.push(`المتاجر: ${C('stores').length} (مسمّاة: ${C('stores').filter((s) => String(s.name || '').trim()).length}) — المنتجات: ${prodCount} (مسعّرة: ${priced})`);

      /* صور المنتجات: مستند لكل متجر {m: منتج→مفتاح، d: مفتاح→data URI}. الصور المتطابقة تُحفظ مرة وحدة */
      if (C('pimg').length) {
        fs.mkdirSync(uploadsDir, { recursive: true });
        const byHash = new Map();
        let linked = 0;
        for (const doc of C('pimg')) {
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
                const fp = path.join(uploadsDir, id);
                fs.writeFileSync(fp, buf);
                written.push(fp);
                db.run('INSERT INTO files(id, kind, mime, size, owner, created_at) VALUES(?,?,?,?,?,?)', id, 'product', mt[1], buf.length, 'import', Date.now());
              }
              byHash.set(h, id);
            }
            linked += Number(db.run('UPDATE products SET img = ? WHERE store_id = ? AND id = ?', '/files/' + id, String(doc.id), pid).changes);
          }
        }
        log.push(`صور المنتجات: ${linked} منتج مربوط بـ ${byHash.size} صورة`);
      }

      /* الإعدادات ورمز الإدارة (الرمز القديم يستمر يشتغل ويترقّى تشفيره عند أول دخول) */
      const st = C('settings').find((x) => x.id === 'app');
      if (st) {
        const { adminPinHash, adminPin, recoveryHash, id, ...rest } = st;
        delete rest.payments;
        db.saveSettings({ ...rest, payments: { cash: true, bank: st.payments ? st.payments.bank !== false : true } });
        const pinHash = adminPinHash || (adminPin ? 'plain$' + adminPin : null);
        if (pinHash) {
          const cur = db.kvGet('admin', null);
          db.kvSet('admin', { pinHash, recoveryHash: recoveryHash || (cur && cur.recoveryHash) || null, v: ((cur && cur.v) || 0) + 1 });
        }
        log.push(`الإعدادات: ${(rest.districts || []).length} حي، رسوم التوصيل ${rest.deliveryFee}، رمز الإدارة ${pinHash ? 'منقول من النسخة القديمة' : 'بدون تغيير'}`);
      }

      /* الكوبونات */
      for (const c of C('coupons')) {
        if (!['percent', 'fixed', 'free_delivery'].includes(c.kind)) continue;
        db.run(`INSERT OR REPLACE INTO coupons(code,kind,value,note,min_order,max_uses,used_count,expires_at,categories,once_per_customer,active,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, String(c.id).toUpperCase(), c.kind, Number(c.value) || 0, c.note || '', Number(c.minOrder) || 0, c.maxUses || null,
          Number(c.usedCount) || 0, c.expiresAt || null, JSON.stringify(c.categories || []), c.oncePerCustomer === false ? 0 : 1, c.active === false ? 0 : 1, c.createdAt || Date.now());
      }
      if (C('coupons').length) log.push(`الكوبونات: ${C('coupons').length}`);

      /* السائقون — الدخول صار بالجوال + الرمز */
      let dn = 0;
      for (const d of C('drivers')) {
        const phone = normalizePhone(d.phone);
        if (!phone) { log.push(`⚠️ السائق ${d.name} بدون جوال صحيح — تخطيته، أضفه من لوحة الإدارة`); continue; }
        const pinHash = d.pinHash || (d.pin ? 'plain$' + d.pin : null);
        if (!pinHash) { log.push(`⚠️ السائق ${d.name} بدون رمز — تخطيته`); continue; }
        db.run('DELETE FROM drivers WHERE phone = ? AND id != ?', phone, String(d.id));
        db.run('INSERT OR REPLACE INTO drivers(id,name,phone,pin_hash,vehicle,active,online,created_at) VALUES(?,?,?,?,?,?,?,?)',
          String(d.id), d.name, phone, pinHash, d.vehicle || '', d.active === false ? 0 : 1, d.online === false ? 0 : 1, Date.now());
        dn++;
      }
      if (C('drivers').length) log.push(`السائقون: ${dn}`);

      /* العملاء (اختياري) — تسجيل الدخول صار برمز SMS، فالرمز السري القديم لا يُنقل */
      for (const c of C('customers')) {
        const phone = normalizePhone(c.id);
        if (!phone) continue;
        db.run(`INSERT OR REPLACE INTO customers(phone,name,district,address,map,delivered_count,free_deliveries,created_at) VALUES(?,?,?,?,?,?,?,?)`,
          phone, c.name || 'عميل', c.district || '', c.address || '', c.map || '', Number(c.deliveredCount) || 0, Number(c.freeDeliveries) || 0, c.createdAt || Date.now());
        for (const code of Object.keys(c.usedCoupons || {})) db.run('INSERT OR IGNORE INTO customer_coupons(phone,code,used_at) VALUES(?,?,?)', phone, code.toUpperCase(), Date.now());
      }
      if (C('customers').length) log.push(`العملاء: ${C('customers').length}`);

      /* الطلبات (اختياري، للأرشيف والإحصائيات) */
      for (const o of C('orders')) {
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
      if (C('orders').length) log.push(`الطلبات: ${C('orders').length}`);
    });
  } catch (e) {
    /* تراجعت القاعدة، فنحذف الصور اللي انكتبت عشان ما تبقى ملفات يتيمة */
    for (const f of written) fs.rmSync(f, { force: true });
    throw e;
  }
  return log;
}
