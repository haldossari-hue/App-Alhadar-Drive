/* قراءة وكتابة الكيانات وتحويلها لأشكال الـ API */
import { signedFileUrl } from './auth.js';
import { claimableOrder } from '../public/shared/constants.js';

const bool = (v) => v === 1 || v === true;
const json = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

/* ============ المتاجر والمنتجات ============ */
export function productRow(r) {
  const p = { id: r.id, name: r.name, price: r.price, unit: r.unit || '', emoji: r.emoji || '📦', sec: r.sec || '', available: bool(r.available) };
  if (r.img) p.img = r.img;
  if (r.sale_type === 'weight') { p.saleType = 'weight'; p.units = json(r.units, []); }
  return p;
}
export function storeRow(r, products) {
  return {
    id: r.id, name: r.name, category: r.category, emoji: r.emoji, color: r.color, eta: r.eta,
    hours: r.hours || '', phone: r.phone || '', desc: r.descr || '', note: r.note || '', open: bool(r.open), sort: r.sort,
    products: products || [],
  };
}
export function loadStores(db, { namedOnly = false } = {}) {
  const stores = db.all('SELECT * FROM stores ORDER BY sort, id');
  const prods = db.all('SELECT * FROM products ORDER BY store_id, sort');
  const by = new Map();
  for (const p of prods) { if (!by.has(p.store_id)) by.set(p.store_id, []); by.get(p.store_id).push(productRow(p)); }
  return stores.filter((s) => !namedOnly || s.name.trim()).map((s) => storeRow(s, by.get(s.id)));
}
export function loadStore(db, id) {
  const s = db.get('SELECT * FROM stores WHERE id = ?', id);
  if (!s) return null;
  return storeRow(s, db.all('SELECT * FROM products WHERE store_id = ? ORDER BY sort', id).map(productRow));
}

/* يستبدل كل منتجات المتجر بالقائمة الجديدة (نفس سلوك محرّر المتجر) */
export function saveStore(db, id, s, products) {
  db.tx(() => {
    db.run(`INSERT INTO stores(id,name,category,emoji,color,eta,hours,phone,descr,note,open,sort,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, emoji=excluded.emoji, color=excluded.color,
        eta=excluded.eta, hours=excluded.hours, phone=excluded.phone, descr=excluded.descr, note=excluded.note,
        open=excluded.open, sort=excluded.sort, updated_at=excluded.updated_at`,
      id, s.name, s.category, s.emoji, s.color, s.eta, s.hours, s.phone, s.desc, s.note, s.open ? 1 : 0, s.sort, Date.now());
    if (products) {
      db.run('DELETE FROM products WHERE store_id = ?', id);
      products.forEach((p, i) => insertProduct(db, id, p, i));
    }
  });
}
export function insertProduct(db, storeId, p, sort) {
  db.run(`INSERT INTO products(id,store_id,name,price,unit,emoji,sec,img,available,sale_type,units,sort) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    p.id, storeId, p.name, p.price, p.unit || '', p.emoji || '📦', p.sec || '', p.img || null, p.available === false ? 0 : 1,
    p.saleType === 'weight' ? 'weight' : null, p.saleType === 'weight' ? JSON.stringify(p.units || []) : null, sort);
}

/* ============ الكوبونات ============ */
export function couponRow(r) {
  if (!r) return null;
  return {
    code: r.code, id: r.code, kind: r.kind, value: r.value, note: r.note || '', minOrder: r.min_order, maxUses: r.max_uses,
    usedCount: r.used_count, expiresAt: r.expires_at, categories: json(r.categories, []),
    oncePerCustomer: bool(r.once_per_customer), active: bool(r.active), createdAt: r.created_at,
  };
}
export const getCoupon = (db, code) => couponRow(db.get('SELECT * FROM coupons WHERE code = ?', String(code || '').toUpperCase()));

/* ============ العملاء والسائقون ============ */
export function customerRow(r) {
  if (!r) return null;
  return {
    phone: r.phone, name: r.name, district: r.district || '', address: r.address || '', map: r.map || '', lat: r.lat, lng: r.lng,
    deliveredCount: r.delivered_count, freeDeliveries: r.free_deliveries, createdAt: r.created_at,
  };
}
export function driverRow(r, { withLocation = false } = {}) {
  if (!r) return null;
  const d = { id: r.id, name: r.name, phone: r.phone, vehicle: r.vehicle || '', active: bool(r.active), online: bool(r.online) };
  if (withLocation && r.lat != null) d.loc = { lat: r.lat, lng: r.lng, at: r.loc_at };
  return d;
}

/* ============ الطلبات ============ */
export function orderRow(r) {
  const d = json(r.data, {});
  return {
    ...d,
    id: r.id, code: r.code, groupCode: r.group_code, storeId: r.store_id, driverId: r.driver_id, status: r.status,
    payment: r.payment, paymentStatus: r.payment_status, isCustom: bool(r.is_custom), priceStatus: r.price_status,
    subtotal: r.subtotal, discount: r.discount, fee: r.fee, total: r.total, freeDeliveryUsed: bool(r.free_delivery_used),
    settled: bool(r.settled), createdAt: r.created_at, updatedAt: r.updated_at, deliveredAt: r.delivered_at, settledAt: r.settled_at,
  };
}
export const getOrder = (db, id) => { const r = db.get('SELECT * FROM orders WHERE id = ?', id); return r ? orderRow(r) : null; };

/* شكل الطلب حسب من يشوفه — السائق ما يشوف بيانات العميل إلا بعد ما يستلم الطلب */
export function viewOrder(o, viewer, db) {
  const out = { ...o };
  delete out.receiptId; delete out.imageId;
  if (o.receiptId) out.receiptUrl = signedFileUrl(o.receiptId);
  if (o.imageId) out.image = signedFileUrl(o.imageId);
  if (viewer.role === 'driver' && o.driverId !== viewer.sub) {
    if (!claimableOrder(o)) return null;
    out.customer = { district: o.customer.district };
    delete out.receiptUrl;
  }
  if (viewer.role === 'customer') {
    if (['picked', 'onway'].includes(o.status) && o.driverId && db) {
      const d = db.get('SELECT lat, lng, loc_at FROM drivers WHERE id = ?', o.driverId);
      if (d && d.lat != null) out.driverLoc = { lat: d.lat, lng: d.lng, at: d.loc_at };
    }
  }
  return out;
}

export function writeOrder(db, o) {
  const { id, code, groupCode, storeId, driverId, status, payment, paymentStatus, isCustom, priceStatus, subtotal, discount, fee, total,
    freeDeliveryUsed, settled, createdAt, updatedAt, deliveredAt, settledAt, ...data } = o;
  db.run(`INSERT INTO orders(id,code,group_code,store_id,customer_phone,driver_id,status,payment,payment_status,is_custom,price_status,
      subtotal,discount,fee,total,free_delivery_used,settled,created_at,updated_at,delivered_at,settled_at,data)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET driver_id=excluded.driver_id, status=excluded.status, payment_status=excluded.payment_status,
      price_status=excluded.price_status, subtotal=excluded.subtotal, discount=excluded.discount, fee=excluded.fee, total=excluded.total,
      free_delivery_used=excluded.free_delivery_used, settled=excluded.settled, updated_at=excluded.updated_at,
      delivered_at=excluded.delivered_at, settled_at=excluded.settled_at, data=excluded.data`,
    id, code, groupCode, storeId, o.customer.phone, driverId || null, status, payment, paymentStatus, isCustom ? 1 : 0, priceStatus || null,
    subtotal, discount || 0, fee, total, freeDeliveryUsed ? 1 : 0, settled ? 1 : 0, createdAt, updatedAt, deliveredAt || null, settledAt || null,
    JSON.stringify(data));
}
