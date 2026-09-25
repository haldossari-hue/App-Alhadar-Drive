/* خدمة الطلبات: الإنشاء، تدفق الحالات، الولاء، الاسترجاع، والإشعارات */
import { ACTIVE, ST, DRIVER_NEXT, claimableOrder, round2 } from '../public/shared/constants.js';
import { buildBaskets, computeCheckout, validateForPlacement, loyaltyEarned, CheckoutError } from './domain/pricing.js';
import { loadStore, getCoupon, getOrder, writeOrder, customerRow } from './repo.js';
import { randomDigits, randomId } from './auth.js';

export { CheckoutError };

export function createOrderService({ db, hub, push, log }) {
  const now = () => Date.now();

  function newGroupCode() {
    for (let i = 0; i < 20; i++) {
      const c = randomDigits(6);
      if (c[0] !== '0' && !db.get('SELECT 1 FROM orders WHERE group_code = ?', c)) return c;
    }
    return randomDigits(8);
  }

  /* ============ الإشعارات ============ */
  function announce(o, prev, extra = {}) {
    const wasClaimable = prev ? claimableOrder(prev) : false;
    const isClaimable = claimableOrder(o);
    const visibleNow = o.status !== 'awaiting_payment';
    const ev = { type: 'order', id: o.id };

    hub.admins(ev);
    if (visibleNow && (!prev || prev.status === 'awaiting_payment')) {
      hub.admins({ type: 'notify', text: 'طلب جديد #' + o.code, sound: true });
      push.admins({ title: 'طلب جديد #' + o.code, body: `${o.storeName} — ${round2(o.total)} ر.س`, url: '/?r=admin', tag: 'order-' + o.id });
    }
    if (isClaimable || wasClaimable) hub.drivers(ev);
    if (isClaimable && !wasClaimable) {
      hub.drivers({ type: 'notify', text: 'طلب متاح للتوصيل #' + o.code, sound: true, onlineOnly: true });
      push.onlineDrivers({ title: 'طلب متاح للتوصيل', body: `#${o.code} — ${o.storeName} ← ${o.customer.district}`, url: '/?r=driver', tag: 'avail-' + o.id });
    }
    if (o.driverId) hub.driver(o.driverId, ev);
    if (prev && prev.driverId && prev.driverId !== o.driverId) hub.driver(prev.driverId, ev);
    if (extra.assignedBy === 'admin' && o.driverId) {
      hub.driver(o.driverId, { type: 'notify', text: 'تم تعيين طلب لك #' + o.code, sound: true });
      push.driver(o.driverId, { title: 'تم تعيين طلب لك', body: '#' + o.code + ' — ' + o.storeName, url: '/?r=driver', tag: 'mine-' + o.id });
    }
    hub.customer(o.customer.phone, ev);
    if (prev && prev.status !== o.status && ST[o.status] && visibleNow) {
      const t = 'طلبك #' + o.code + ' — ' + ST[o.status].t;
      hub.customer(o.customer.phone, { type: 'notify', text: t, sound: true });
      push.customer(o.customer.phone, { title: ST[o.status].t, body: 'طلب #' + o.code + ' من ' + o.storeName, url: '/?r=customer&o=' + o.id, tag: 'cust-' + o.id });
    }
    if (prev && prev.isCustom && prev.priceStatus === 'pending' && o.priceStatus === 'priced') {
      hub.customer(o.customer.phone, { type: 'notify', text: 'تم تسعير طلبك #' + o.code + ': ' + round2(o.total) + ' ر.س', sound: true });
      push.customer(o.customer.phone, { title: 'تم تسعير طلبك', body: '#' + o.code + ' — الإجمالي ' + round2(o.total) + ' ر.س', url: '/?r=customer&o=' + o.id });
    }
  }

  const logAdd = (o, s) => (o.log || []).concat([{ s, t: now() }]);

  /* ============ حساب السلة (معاينة وتنفيذ) ============ */
  function quote(phone, body) {
    const settings = db.settings();
    const cust = customerRow(db.get('SELECT * FROM customers WHERE phone = ?', phone));
    const baskets = buildBaskets(body.items, (id) => loadStore(db, id));
    const code = String(body.coupon || '').trim().toUpperCase();
    let coupon = null, couponUsed = false;
    if (code) {
      coupon = getCoupon(db, code) || { code, active: false };
      couponUsed = !!db.get('SELECT 1 FROM customer_coupons WHERE phone = ? AND code = ?', phone, code);
    }
    const cx = computeCheckout({ baskets, settings, coupon, couponUsedByCustomer: couponUsed, freeDeliveries: cust ? cust.freeDeliveries : 0, useFree: !!body.useFree });
    return { cx, settings, cust, coupon };
  }

  function validateCustomer(c, settings) {
    const cu = {
      name: String(c.name || '').trim().slice(0, 80), district: String(c.district || '').trim(),
      address: String(c.address || '').trim().slice(0, 400), map: String(c.map || '').trim().slice(0, 500),
      notes: String(c.notes || '').trim().slice(0, 300),
    };
    if (Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)) && c.lat !== null && c.lat !== '') { cu.lat = Number(c.lat); cu.lng = Number(c.lng); }
    if (!cu.name) throw new CheckoutError('اكتب اسمك');
    if (!(settings.districts || []).length) throw new CheckoutError('التوصيل غير متاح حالياً');
    if (!cu.district || !settings.districts.includes(cu.district)) throw new CheckoutError('اختر حيّك داخل الهدار');
    if (!cu.address) throw new CheckoutError('اكتب وصف العنوان');
    if (cu.map && !/^https?:\/\//.test(cu.map)) cu.map = '';
    return cu;
  }

  function paymentMode(method, settings, receiptId, phone) {
    if (method === 'cash') return { payment: 'cash', paymentStatus: 'cod' };
    if (method === 'bank') {
      if (settings.payments && settings.payments.bank === false) throw new CheckoutError('الدفع بالحوالة غير متاح حالياً');
      const f = receiptId && db.get("SELECT * FROM files WHERE id = ? AND kind = 'receipt' AND owner = ?", String(receiptId), 'customer:' + phone);
      if (!f) throw new CheckoutError('أرفق صورة أو PDF لإثبات التحويل قبل إرسال الطلب', 'receipt_required');
      return { payment: 'bank', paymentStatus: 'proof', receiptId: f.id, receiptType: f.mime };
    }
    if (method === 'online') return { payment: 'online', paymentStatus: 'pending' };
    throw new CheckoutError('طريقة الدفع غير معروفة');
  }

  /* ينشئ طلب أو طلبين (واحد لكل متجر) بمعاملة واحدة */
  function place(phone, body, { onlineAvailable = false } = {}) {
    return db.tx(() => {
      const { cx, settings } = quote(phone, body);
      const cu = validateCustomer(body.customer || {}, settings);
      cu.phone = phone;
      validateForPlacement(cx, settings);
      if (body.coupon && !cx.couponOk) throw new CheckoutError(cx.couponMsg || 'الكود غير صحيح', 'coupon');
      if (body.payment === 'online' && !onlineAvailable) throw new CheckoutError('الدفع الإلكتروني غير متاح حالياً');
      const pm = paymentMode(body.payment, settings, body.receiptId, phone);
      const t = now();
      const group = newGroupCode();
      const status = pm.payment === 'online' ? 'awaiting_payment' : 'new';
      const orders = cx.rows.map((r, idx) => {
        const o = {
          id: randomId('o'), code: group + (cx.rows.length > 1 ? String.fromCharCode(65 + idx) : ''), groupCode: group,
          storeId: r.bk.s.id, storeName: r.bk.s.name, storeEmoji: r.bk.s.emoji || '🏪', storeCategory: r.bk.s.category, storePhone: r.bk.s.phone || '',
          items: r.bk.lines.map(({ p, q, u, price }) => ({ id: p.id, name: p.name, price, qty: q, unit: u ? u.label : (p.unit || '') })),
          subtotal: r.bk.sub, discount: r.discount, coupon: r.coupon, fee: r.fee, total: r.total,
          payment: pm.payment, paymentStatus: pm.paymentStatus, customer: cu, status, driverId: null, driverName: null, driverPhone: null,
          freeDeliveryUsed: r.freeUsedHere, settled: pm.payment !== 'cash', isCustom: false, priceStatus: null,
          createdAt: t, updatedAt: t, log: [{ s: status, t }],
        };
        if (pm.receiptId) { o.receiptId = pm.receiptId; o.receiptType = pm.receiptType; }
        writeOrder(db, o);
        return o;
      });
      consumePerks(phone, orders);
      db.run('UPDATE customers SET name = ?, district = ?, address = ?, map = COALESCE(NULLIF(?, \'\'), map) WHERE phone = ?', cu.name, cu.district, cu.address, cu.map, phone);
      return { orders, grandTotal: cx.grandTotal, group };
    });
  }

  function placeCustom(phone, body) {
    return db.tx(() => {
      const settings = db.settings();
      const cu = validateCustomer(body.customer || {}, settings);
      cu.phone = phone;
      const desc = String(body.description || '').trim().slice(0, 1500);
      if (!desc) throw new CheckoutError('اكتب وصف طلبك');
      const s = loadStore(db, String(body.storeId || ''));
      if (!s || !s.name.trim()) throw new CheckoutError('المتجر غير موجود');
      if (!s.open) throw new CheckoutError('المتجر مغلق الآن');
      const cust = customerRow(db.get('SELECT * FROM customers WHERE phone = ?', phone));
      const fee0 = Math.max(0, Number(settings.deliveryFee) || 0);
      const useFree = !!body.useFree && cust.freeDeliveries > 0 && fee0 > 0;
      const fee = useFree ? 0 : fee0;
      let imageId = null;
      if (body.imageId) {
        const f = db.get("SELECT id FROM files WHERE id = ? AND kind = 'custom' AND owner = ?", String(body.imageId), 'customer:' + phone);
        if (f) imageId = f.id;
      }
      const t = now();
      const group = newGroupCode();
      const o = {
        id: randomId('o'), code: group, groupCode: group, storeId: s.id, storeName: s.name, storeEmoji: s.emoji || '🏪', storeCategory: s.category, storePhone: s.phone || '',
        isCustom: true, priceStatus: 'pending', description: desc, imageId,
        items: [], subtotal: 0, discount: 0, coupon: null, fee, total: fee, payment: 'cash', paymentStatus: 'cod', customer: cu, status: 'new',
        driverId: null, driverName: null, driverPhone: null, freeDeliveryUsed: useFree, settled: false, createdAt: t, updatedAt: t, log: [{ s: 'new', t }],
      };
      writeOrder(db, o);
      consumePerks(phone, [o]);
      return o;
    });
  }

  /* خصم استخدام الكوبون والتوصيلة المجانية (يُسترجع عند الإلغاء أو فشل الدفع) */
  function consumePerks(phone, orders) {
    const withCoupon = orders.find((o) => o.coupon);
    if (withCoupon) {
      db.run('UPDATE coupons SET used_count = used_count + 1 WHERE code = ?', withCoupon.coupon.code);
      if (withCoupon.coupon.oncePerCustomer) db.run('INSERT OR IGNORE INTO customer_coupons(phone, code, used_at) VALUES(?,?,?)', phone, withCoupon.coupon.code, now());
    }
    const free = orders.filter((o) => o.freeDeliveryUsed).length;
    if (free) db.run('UPDATE customers SET free_deliveries = MAX(0, free_deliveries - ?) WHERE phone = ?', free, phone);
  }
  function refundPerks(o) {
    if (o.freeDeliveryUsed) db.run('UPDATE customers SET free_deliveries = free_deliveries + 1 WHERE phone = ?', o.customer.phone);
    if (o.coupon) {
      db.run('UPDATE coupons SET used_count = MAX(0, used_count - 1) WHERE code = ?', o.coupon.code);
      db.run('DELETE FROM customer_coupons WHERE phone = ? AND code = ?', o.customer.phone, o.coupon.code);
    }
  }

  /* ============ تغييرات الحالة ============ */
  function mutate(id, fn, extra) {
    const res = db.tx(() => {
      const prev = getOrder(db, id);
      if (!prev) throw new CheckoutError('الطلب غير موجود', 'not_found');
      const next = fn(structuredClone(prev));
      if (!next) return null;
      next.updatedAt = now();
      writeOrder(db, next);
      return { prev, next };
    });
    if (res) announce(res.next, res.prev, extra);
    return res && res.next;
  }

  function claim(driver, id) {
    if (!driver.online) throw new CheckoutError('فعّل الاتصال أولاً', 'offline');
    /* المعاملة الحصرية (BEGIN IMMEDIATE) تمنع سائقين من استلام نفس الطلب */
    return mutate(id, (o) => {
      if (!claimableOrder(o)) throw new CheckoutError('سائق ثاني أخذ الطلب', 'taken');
      let lg = o.log || [];
      if (o.status === 'new') lg = lg.concat([{ s: 'accepted', t: now() }]);
      Object.assign(o, { driverId: driver.id, driverName: driver.name, driverPhone: driver.phone, status: 'assigned', log: lg.concat([{ s: 'assigned', t: now() }]) });
      return o;
    });
  }

  function driverAdvance(driver, id, to) {
    let delivered = null;
    const o = mutate(id, (o) => {
      if (o.driverId !== driver.id) throw new CheckoutError('الطلب مو لك', 'forbidden');
      if (DRIVER_NEXT[o.status] !== to) throw new CheckoutError('لا يمكن نقل الطلب لهذه الحالة', 'bad_transition');
      o.status = to; o.log = logAdd(o, to);
      if (to === 'delivered') { o.deliveredAt = now(); if (o.payment === 'cash') o.cashCollected = true; delivered = o; }
      return o;
    });
    if (delivered) creditLoyalty(delivered);
    return o;
  }

  function adminAssign(id, driver) {
    return mutate(id, (o) => {
      if (!['new', 'accepted', 'assigned'].includes(o.status)) throw new CheckoutError('لا يمكن تعيين سائق لهذا الطلب');
      if (o.isCustom && o.priceStatus === 'pending') throw new CheckoutError('سعّر الطلب أولاً');
      Object.assign(o, { driverId: driver.id, driverName: driver.name, driverPhone: driver.phone });
      if (o.status !== 'assigned') {
        let lg = o.log || [];
        if (o.status === 'new') lg = lg.concat([{ s: 'accepted', t: now() }]);
        o.status = 'assigned'; o.log = lg.concat([{ s: 'assigned', t: now() }]);
      }
      return o;
    }, { assignedBy: 'admin' });
  }

  function adminDeliver(id) {
    let delivered = null;
    const o = mutate(id, (o) => {
      if (!['picked', 'onway'].includes(o.status)) throw new CheckoutError('الطلب ليس مع السائق بعد');
      o.status = 'delivered'; o.deliveredAt = now(); if (o.payment === 'cash') o.cashCollected = true; o.log = logAdd(o, 'delivered');
      delivered = o; return o;
    });
    if (delivered) creditLoyalty(delivered);
    return o;
  }

  function cancel(id, by) {
    return mutate(id, (o) => {
      if (by.role === 'customer') {
        if (o.customer.phone !== by.sub) throw new CheckoutError('الطلب غير موجود', 'not_found');
        if (!['new', 'awaiting_payment'].includes(o.status)) throw new CheckoutError('ما تقدر تلغي الطلب بعد ما يستلمه السائق، تواصل مع الإدارة');
      } else if (!ACTIVE.includes(o.status) && o.status !== 'awaiting_payment') throw new CheckoutError('الطلب منتهي');
      o.status = 'cancelled'; o.log = logAdd(o, 'cancelled'); o.cancelledBy = by.role;
      refundPerks(o);
      return o;
    });
  }

  function setCustomPrice(id, sub) {
    sub = round2(sub);
    if (!(sub > 0)) throw new CheckoutError('اكتب سعراً صحيحاً');
    return mutate(id, (o) => {
      if (!o.isCustom || o.priceStatus !== 'pending') throw new CheckoutError('الطلب مسعّر مسبقاً');
      if (o.status !== 'new') throw new CheckoutError('الطلب غير نشط');
      o.subtotal = sub; o.total = round2(sub + (Number(o.fee) || 0)); o.priceStatus = 'priced';
      return o;
    });
  }

  function settleDriver(driverId) {
    const t = now();
    const r = db.run("UPDATE orders SET settled = 1, settled_at = ? WHERE driver_id = ? AND status = 'delivered' AND settled = 0", t, driverId);
    hub.admins({ type: 'order' });
    hub.driver(driverId, { type: 'order' });
    return r.changes;
  }

  function creditLoyalty(o) {
    const earned = db.tx(() => {
      const c = db.get('SELECT delivered_count FROM customers WHERE phone = ?', o.customer.phone);
      if (!c) return false;
      const dc = c.delivered_count + 1;
      const win = loyaltyEarned(db.settings(), dc);
      db.run('UPDATE customers SET delivered_count = ?, free_deliveries = free_deliveries + ? WHERE phone = ?', dc, win ? 1 : 0, o.customer.phone);
      return win;
    });
    if (earned) {
      hub.customer(o.customer.phone, { type: 'notify', text: '🎁 كسبت توصيلة مجانية! تنستخدم تلقائياً بطلبك الجاي لو فعّلتها', sound: true });
      push.customer(o.customer.phone, { title: 'كسبت توصيلة مجانية 🎁', body: 'استخدمها بأي طلب جاي', url: '/?r=customer' });
    }
    hub.customer(o.customer.phone, { type: 'me' });
  }

  /* ============ الدفع الإلكتروني ============ */
  function markGroupPaid(group) {
    const list = db.all("SELECT id FROM orders WHERE group_code = ? AND status = 'awaiting_payment'", group);
    for (const { id } of list) {
      mutate(id, (o) => {
        o.status = 'new'; o.paymentStatus = 'paid'; o.settled = true; o.log = logAdd(o, 'new');
        return o;
      });
    }
    return list.length;
  }
  function markGroupFailed(group) {
    const list = db.all("SELECT id FROM orders WHERE group_code = ? AND status = 'awaiting_payment'", group);
    for (const { id } of list) {
      mutate(id, (o) => {
        o.status = 'cancelled'; o.paymentStatus = 'failed'; o.log = logAdd(o, 'cancelled'); o.cancelledBy = 'payment';
        refundPerks(o);
        return o;
      });
    }
  }

  return { quote, place, placeCustom, claim, driverAdvance, adminAssign, adminDeliver, cancel, setCustomPrice, settleDriver, markGroupPaid, markGroupFailed, announce };
}
