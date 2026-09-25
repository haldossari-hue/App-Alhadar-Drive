/* اختبارات تكامل للـ API: كل التدفقات الأساسية من الطرف للطرف عبر الخادم */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app.js';
import { resetRateLimits } from '../../src/auth.js';

let app, dir;
const sent = [];
const pushes = [];
const fakePush = new Proxy({ publicKey: 'test', subscribe: () => true, unsubscribe() {} }, {
  get: (t, k) => (k in t ? t[k] : (...a) => { pushes.push([k, ...a]); return Promise.resolve(); }),
});

async function req(method, url, body, token) {
  const r = await app.inject({ method, url, payload: body, headers: token ? { authorization: 'Bearer ' + token } : {} });
  let json = null; try { json = r.json(); } catch { /* ليس JSON */ }
  return { status: r.statusCode, body: json, raw: r };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.body)}`); return r.body; };

let admin, driverTok, driver2Tok;
async function customer(phone, name = 'عميل') {
  const o = await ok(req('POST', '/api/auth/otp', { phone }));
  return (await ok(req('POST', '/api/auth/verify', { phone, code: o.devCode, name }))).token;
}
const addr = { name: 'محمد', district: 'حي الطرف', address: 'بيت باب أخضر' };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-'));
  app = await buildApp({ dataDir: dir, logger: false, push: fakePush, otpEcho: true, sendSms: async (p, t) => sent.push([p, t]) });
  admin = (await ok(req('POST', '/api/admin/login', { pin: '1234' }))).token;
  await ok(req('PUT', '/api/admin/settings', { deliveryFee: 10, minOrder: 0, districts: 'حي الطرف\nحي البرقه', loyaltyEvery: 2 }, admin));
  const s1 = await ok(req('PUT', '/api/admin/stores/new', { name: 'مطعم الوادي', category: 'restaurants', products: [{ id: 'k', name: 'كبسة', price: 30 }, { id: 'z', name: 'بدون سعر', price: 0 }] }, admin));
  const s2 = await ok(req('PUT', '/api/admin/stores/new', { name: 'ملحمة', category: 'meat', products: [{ id: 'm', name: 'لحم', price: 60, saleType: 'weight', units: [{ label: 'نص كيلو' }, { label: 'كيلو' }] }] }, admin));
  app.s1 = s1.id; app.s2 = s2.id;
  await ok(req('PUT', '/api/admin/drivers/new', { name: 'سائق ١', phone: '0555555551', pin: '1111' }, admin));
  await ok(req('PUT', '/api/admin/drivers/new', { name: 'سائق ٢', phone: '0555555552', pin: '2222' }, admin));
  driverTok = (await ok(req('POST', '/api/driver/login', { phone: '0555555551', pin: '1111' }))).token;
  driver2Tok = (await ok(req('POST', '/api/driver/login', { phone: '0555555552', pin: '2222' }))).token;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('التسجيل برمز SMS: رمز خاطئ مرفوض، والرمز الصحيح ينشئ الحساب', async () => {
  resetRateLimits();
  const o = await ok(req('POST', '/api/auth/otp', { phone: '0500000001' }));
  assert.equal(o.exists, false);
  assert.equal(sent.at(-1)[0], '0500000001');
  assert.match(sent.at(-1)[1], new RegExp(o.devCode));
  const bad = await req('POST', '/api/auth/verify', { phone: '0500000001', code: o.devCode === '0000' ? '1111' : '0000', name: 'x' });
  assert.equal(bad.status, 400);
  const noName = await req('POST', '/api/auth/verify', { phone: '0500000001', code: o.devCode });
  assert.equal(noName.body.code, 'need_name');
  const v = await ok(req('POST', '/api/auth/verify', { phone: '+966500000001', code: o.devCode, name: 'سارة' }));
  assert.equal(v.customer.name, 'سارة');
  await ok(req('POST', '/api/auth/otp', { phone: '0500000099' }));
  const again = await req('POST', '/api/auth/otp', { phone: '0500000099' });
  assert.equal(again.status, 429, 'لا يرسل رمز جديد قبل دقيقة');
});

test('طلب من متجرين = طلبان منفصلان برمز مرتبط A/B ورسوم توصيل لكل طلب', async () => {
  const t = await customer('0500000002');
  const items = [{ storeId: app.s1, productId: 'k', qty: 2 }, { storeId: app.s2, productId: 'm', unit: 1, qty: 1 }];
  const q = await ok(req('POST', '/api/checkout/quote', { items }, t));
  assert.equal(q.grandTotal, 60 + 60 + 20);
  const r = await ok(req('POST', '/api/orders', { items, customer: addr, payment: 'cash' }, t));
  assert.equal(r.orders.length, 2);
  const [a, b] = r.orders.map((o) => o.code);
  assert.equal(a.slice(0, 6), b.slice(0, 6));
  assert.deepEqual([a.at(-1), b.at(-1)], ['A', 'B']);
  assert.ok(r.orders.every((o) => o.fee === 10 && o.status === 'new'));
  assert.ok(pushes.some(([k, p]) => k === 'admins' && /طلب جديد/.test(p.title)), 'إشعار للإدارة');
});

test('المنتج بدون سعر لا يمكن طلبه، والحي خارج القائمة مرفوض', async () => {
  const t = await customer('0500000003');
  const r = await req('POST', '/api/orders', { items: [{ storeId: app.s1, productId: 'z', qty: 1 }], customer: addr, payment: 'cash' }, t);
  assert.equal(r.status, 400);
  const r2 = await req('POST', '/api/orders', { items: [{ storeId: app.s1, productId: 'k', qty: 1 }], customer: { ...addr, district: 'حي وهمي' }, payment: 'cash' }, t);
  assert.match(r2.body.error, /حيّك/);
});

test('التدفق المباشر: السائق يشوف الطلب فوراً بدون بيانات العميل، يستلمه، وسائق ثاني ما يقدر', async () => {
  const t = await customer('0500000004');
  const { orders: [o] } = await ok(req('POST', '/api/orders', { items: [{ storeId: app.s1, productId: 'k', qty: 1 }], customer: addr, payment: 'cash' }, t));
  const avail = (await ok(req('GET', '/api/driver/orders', null, driverTok))).available.find((x) => x.id === o.id);
  assert.ok(avail, 'الطلب ظاهر للسائق بدون موافقة الإدارة');
  assert.equal(avail.customer.phone, undefined, 'رقم العميل مخفي قبل الاستلام');
  assert.equal(avail.customer.address, undefined);
  const c1 = await ok(req('POST', `/api/driver/orders/${o.id}/claim`, {}, driverTok));
  assert.equal(c1.status, 'assigned');
  assert.equal(c1.customer.phone, '0500000004', 'تظهر بيانات العميل بعد الاستلام');
  const c2 = await req('POST', `/api/driver/orders/${o.id}/claim`, {}, driver2Tok);
  assert.equal(c2.status, 409);
  const bad = await req('POST', `/api/driver/orders/${o.id}/advance`, { to: 'delivered' }, driverTok);
  assert.equal(bad.status, 400, 'لا يقفز مباشرة للتوصيل');
  for (const to of ['picked', 'onway', 'delivered']) await ok(req('POST', `/api/driver/orders/${o.id}/advance`, { to }, driverTok));
  const mine = await ok(req('GET', '/api/my/orders', null, t));
  assert.equal(mine[0].status, 'delivered');
  assert.deepEqual(mine[0].log.map((l) => l.s), ['new', 'accepted', 'assigned', 'picked', 'onway', 'delivered']);
  const d = await ok(req('GET', '/api/driver/orders', null, driverTok));
  assert.ok(d.unsettled >= 40, 'الكاش مسجّل على السائق');
});

test('برنامج الولاء: توصيلة مجانية بعد N طلبات، تستخدم مرة وترجع عند الإلغاء', async () => {
  const t = await customer('0500000005');
  const place = (extra = {}) => ok(req('POST', '/api/orders', { items: [{ storeId: app.s1, productId: 'k', qty: 1 }], customer: addr, payment: 'cash', ...extra }, t));
  for (let i = 0; i < 2; i++) {
    const { orders: [o] } = await place();
    await ok(req('POST', `/api/driver/orders/${o.id}/claim`, {}, driverTok));
    for (const to of ['picked', 'onway', 'delivered']) await ok(req('POST', `/api/driver/orders/${o.id}/advance`, { to }, driverTok));
  }
  let me = await ok(req('GET', '/api/me', null, t));
  assert.equal(me.deliveredCount, 2);
  assert.equal(me.freeDeliveries, 1);
  const { orders: [free] } = await place({ useFree: true });
  assert.equal(free.fee, 0);
  assert.equal(free.freeDeliveryUsed, true);
  assert.equal((await ok(req('GET', '/api/me', null, t))).freeDeliveries, 0);
  await ok(req('POST', `/api/orders/${free.id}/cancel`, {}, t));
  me = await ok(req('GET', '/api/me', null, t));
  assert.equal(me.freeDeliveries, 1, 'التوصيلة المجانية ترجع عند الإلغاء');
});

test('الكوبون مرة واحدة لكل عميل، وعدّاد الاستخدام', async () => {
  await ok(req('PUT', '/api/admin/coupons/HADAR10', { kind: 'percent', value: 10, isNew: true }, admin));
  const t = await customer('0500000006');
  const body = { items: [{ storeId: app.s1, productId: 'k', qty: 2 }], customer: addr, payment: 'cash', coupon: 'hadar10' };
  const r = await ok(req('POST', '/api/orders', body, t));
  assert.equal(r.orders[0].discount, 6);
  assert.equal(r.orders[0].total, 60 - 6 + 10);
  const again = await req('POST', '/api/orders', body, t);
  assert.match(again.body.error, /سبق واستخدمت/);
  const data = await ok(req('GET', '/api/admin/data', null, admin));
  assert.equal(data.coupons.find((c) => c.code === 'HADAR10').usedCount, 1);
  const pub = await ok(req('GET', '/api/bootstrap'));
  assert.ok(pub.coupons.some((c) => c.code === 'HADAR10'), 'الكوبون يظهر بشريط العروض');
  assert.equal(pub.coupons[0].usedCount, undefined, 'بدون بيانات داخلية');
});

test('الطلب الخاص لا يظهر للسائقين قبل التسعير', async () => {
  const t = await customer('0500000007');
  const o = await ok(req('POST', '/api/orders/custom', { storeId: app.s1, description: '3 كيلو تمر سكري', customer: addr }, t));
  assert.equal(o.priceStatus, 'pending');
  assert.equal(o.total, 10);
  let d = await ok(req('GET', '/api/driver/orders', null, driverTok));
  assert.ok(!d.available.some((x) => x.id === o.id));
  const claim = await req('POST', `/api/driver/orders/${o.id}/claim`, {}, driverTok);
  assert.equal(claim.status, 409);
  const priced = await ok(req('POST', `/api/admin/orders/${o.id}/price`, { subtotal: 45 }, admin));
  assert.equal(priced.total, 55);
  d = await ok(req('GET', '/api/driver/orders', null, driverTok));
  assert.ok(d.available.some((x) => x.id === o.id));
  assert.ok(pushes.some(([k, ph, p]) => k === 'customer' && ph === '0500000007' && /تسعير/.test(p.title)));
});

test('الحوالة البنكية: الإثبات إلزامي، والملف خاص برابط موقّع، والطلب مستثنى من كاش السائق', async () => {
  const t = await customer('0500000008');
  const items = [{ storeId: app.s1, productId: 'k', qty: 1 }];
  const noProof = await req('POST', '/api/orders', { items, customer: addr, payment: 'bank' }, t);
  assert.equal(noProof.body.code, 'receipt_required');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 32)]);
  const boundary = 'XBOUNDARY';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), pdf, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({ method: 'POST', url: '/api/uploads?kind=receipt', payload, headers: { authorization: 'Bearer ' + t, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(up.statusCode, 200, up.body);
  const file = up.json();
  assert.equal(file.type, 'application/pdf');
  const other = await customer('0500000009');
  const stolen = await req('POST', '/api/orders', { items, customer: addr, payment: 'bank', receiptId: file.id }, other);
  assert.equal(stolen.body.code, 'receipt_required', 'ما يقدر عميل ثاني يستخدم إثبات غيره');
  const { orders: [o] } = await ok(req('POST', '/api/orders', { items, customer: addr, payment: 'bank', receiptId: file.id }, t));
  assert.equal(o.settled, true);
  assert.equal((await app.inject('/files/' + file.id)).statusCode, 403, 'الملف غير متاح بدون توقيع');
  const adm = (await ok(req('GET', '/api/admin/data', null, admin))).orders.find((x) => x.id === o.id);
  assert.equal((await app.inject(adm.receiptUrl)).statusCode, 200, 'الإدارة تفتح الإثبات');
  await ok(req('POST', `/api/driver/orders/${o.id}/claim`, {}, driver2Tok));
  for (const to of ['picked', 'onway', 'delivered']) await ok(req('POST', `/api/driver/orders/${o.id}/advance`, { to }, driver2Tok));
  const d2 = await ok(req('GET', '/api/driver/orders', null, driver2Tok));
  assert.equal(d2.unsettled, 0);
});

test('الدفع الإلكتروني: الطلب مخفي عن السائقين لين يتأكد الدفع من البوابة', async () => {
  process.env.PAYMENT_PROVIDER = 'fake';
  const { config } = await import('../../src/config.js');
  config.payments.provider = 'fake';
  try {
    const t = await customer('0500000010');
    const items = [{ storeId: app.s1, productId: 'k', qty: 1 }];
    const r = await ok(req('POST', '/api/orders', { items, customer: addr, payment: 'online' }, t));
    assert.equal(r.orders[0].status, 'awaiting_payment');
    assert.ok(r.payUrl);
    let d = await ok(req('GET', '/api/driver/orders', null, driverTok));
    assert.ok(!d.available.some((x) => x.id === r.orders[0].id));
    const pid = r.payUrl.split('/').pop();
    const pay = await app.inject({ method: 'POST', url: '/api/payments/fake/' + pid, payload: 'r=paid', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(pay.statusCode, 302);
    const mine = (await ok(req('GET', '/api/my/orders', null, t))).find((x) => x.id === r.orders[0].id);
    assert.equal(mine.status, 'new');
    assert.equal(mine.paymentStatus, 'paid');
    d = await ok(req('GET', '/api/driver/orders', null, driverTok));
    assert.ok(d.available.some((x) => x.id === r.orders[0].id));
    /* فشل الدفع: يلغى الطلب ويرجع الكوبون */
    const r2 = await ok(req('POST', '/api/orders', { items, customer: addr, payment: 'online' }, t));
    await app.inject({ method: 'POST', url: '/api/payments/fake/' + r2.payUrl.split('/').pop(), payload: 'r=failed', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const failed = (await ok(req('GET', '/api/my/orders', null, t))).find((x) => x.id === r2.orders[0].id);
    assert.equal(failed.status, 'cancelled');
  } finally { config.payments.provider = ''; }
});

test('المحادثة: فقط العميل والسائق المعيّن والإدارة', async () => {
  const t = await customer('0500000011');
  const { orders: [o] } = await ok(req('POST', '/api/orders', { items: [{ storeId: app.s1, productId: 'k', qty: 1 }], customer: addr, payment: 'cash' }, t));
  assert.equal((await req('POST', `/api/orders/${o.id}/chat`, { text: 'هلا' }, driverTok)).status, 403, 'قبل الاستلام ما يقدر السائق');
  await ok(req('POST', `/api/driver/orders/${o.id}/claim`, {}, driverTok));
  await ok(req('POST', `/api/orders/${o.id}/chat`, { text: 'وصلت المتجر' }, driverTok));
  await ok(req('POST', `/api/orders/${o.id}/chat`, { text: 'تمام' }, t));
  assert.equal((await req('GET', `/api/orders/${o.id}/chat`, null, driver2Tok)).status, 403);
  const msgs = await ok(req('GET', `/api/orders/${o.id}/chat`, null, admin));
  assert.deepEqual(msgs.map((m) => m.from), ['driver', 'customer']);
});

test('تتبع الموقع: السائق يرسل موقعه والعميل يستلمه أثناء التوصيل فقط', async () => {
  const t = await customer('0500000012');
  const { orders: [o] } = await ok(req('POST', '/api/orders', { items: [{ storeId: app.s1, productId: 'k', qty: 1 }], customer: addr, payment: 'cash' }, t));
  await ok(req('POST', `/api/driver/orders/${o.id}/claim`, {}, driver2Tok));
  await ok(req('POST', '/api/driver/location', { lat: 22.01, lng: 46.4 }, driver2Tok));
  let mine = (await ok(req('GET', '/api/my/orders', null, t))).find((x) => x.id === o.id);
  assert.equal(mine.driverLoc, undefined, 'قبل الاستلام من المتجر ما يظهر الموقع');
  await ok(req('POST', `/api/driver/orders/${o.id}/advance`, { to: 'picked' }, driver2Tok));
  mine = (await ok(req('GET', '/api/my/orders', null, t))).find((x) => x.id === o.id);
  assert.equal(mine.driverLoc.lat, 22.01);
});

test('الإدارة: استرجاع الرمز بعبارة الاسترجاع، وتغيير الرمز يلغي الجلسات القديمة', async () => {
  resetRateLimits();
  assert.equal((await req('POST', '/api/admin/recover/verify', { phrase: 'x' })).body.code, 'no_recovery');
  await ok(req('PUT', '/api/admin/settings', { recovery: 'نخلة طويق ٢٠٢٦' }, admin));
  assert.equal((await req('POST', '/api/admin/recover/verify', { phrase: 'خطأ' })).status, 401);
  const { token } = await ok(req('POST', '/api/admin/recover/verify', { phrase: 'نخلة طويق ٢٠٢٦' }));
  await ok(req('POST', '/api/admin/recover/reset', { token, pin: '98765' }));
  assert.equal((await req('GET', '/api/admin/data', null, admin)).status, 401, 'الجلسة القديمة انتهت');
  assert.equal((await req('POST', '/api/admin/login', { pin: '1234' })).status, 401);
  admin = (await ok(req('POST', '/api/admin/login', { pin: '98765' }))).token;
  assert.equal((await req('POST', '/api/admin/recover/reset', { token, pin: '1111' })).status, 401, 'رمز الاسترجاع يستخدم مرة');
});

test('الحماية: العميل ما يوصل للوحة الإدارة، والسائق الموقوف يخرج فوراً', async () => {
  const t = await customer('0500000013');
  assert.equal((await req('GET', '/api/admin/data', null, t)).status, 401);
  assert.equal((await req('GET', '/api/driver/orders', null, t)).status, 401);
  const data = await ok(req('GET', '/api/admin/data', null, admin));
  const d2 = data.drivers.find((d) => d.phone === '0555555552');
  await ok(req('PUT', '/api/admin/drivers/' + d2.id, { name: d2.name, phone: d2.phone, active: false }, admin));
  assert.equal((await req('GET', '/api/driver/orders', null, driver2Tok)).status, 401);
});

test('الترحيل: رموز النسخة القديمة (SHA-256) تشتغل وتترقّى', async () => {
  const crypto = await import('node:crypto');
  const legacy = crypto.createHash('sha256').update('hd:4321').digest('hex');
  app.db.kvSet('admin', { pinHash: legacy, recoveryHash: null, v: 50 });
  resetRateLimits();
  await ok(req('POST', '/api/admin/login', { pin: '4321' }));
  assert.match(app.db.kvGet('admin').pinHash, /^scrypt\$/);
});

test('استيراد حزمة النسخة القديمة من لوحة الإدارة (متاجر، صور، إعدادات، سائق، رمز إدارة)', async () => {
  resetRateLimits();
  admin = (await ok(req('POST', '/api/admin/login', { pin: '4321' }))).token; // الرمز من اختبار الترحيل السابق
  const crypto = await import('node:crypto');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bundle = { format: 'alhadar-export-v1', collections: {
    stores: [{ id: 'old1', name: 'مخبز الهدار', category: 'bakery', products: [{ id: 'p1', name: 'تميس', price: 2 }, { id: 'p2', name: 'صامولي', price: 0 }] }],
    pimg: [{ id: 'old1', m: { p1: 'k', p2: 'k' }, d: { k: png } }],
    settings: [{ id: 'app', deliveryFee: 13, districts: ['حي القيسيه'], adminPinHash: crypto.createHash('sha256').update('hd:7777').digest('hex') }],
    drivers: [{ id: 'dold', name: 'سائق قديم', phone: '0566666666', pin: '3333' }],
  } };
  const boundary = 'IMPB';
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.json"\r\nContent-Type: application/json\r\n\r\n`), Buffer.from(JSON.stringify(bundle)), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const cust = await customer('0500000020');
  const denied = await app.inject({ method: 'POST', url: '/api/admin/import', payload, headers: { authorization: 'Bearer ' + cust, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(denied.statusCode, 401, 'العميل ما يقدر يستورد');
  const r = await app.inject({ method: 'POST', url: '/api/admin/import', payload, headers: { authorization: 'Bearer ' + admin, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().adminChanged, true);
  const boot = await ok(req('GET', '/api/bootstrap'));
  const s = boot.stores.find((x) => x.id === 'old1');
  assert.equal(s.products.length, 2);
  assert.equal(s.products[0].img, s.products[1].img, 'الصورة المكررة تُحفظ مرة وحدة');
  assert.equal((await app.inject(s.products[0].img)).statusCode, 200);
  assert.equal(boot.settings.deliveryFee, 13);
  assert.equal((await req('GET', '/api/admin/data', null, admin)).status, 401, 'جلسة الإدارة تنتهي بعد نقل الرمز القديم');
  admin = (await ok(req('POST', '/api/admin/login', { pin: '7777' }))).token;
  await ok(req('POST', '/api/driver/login', { phone: '0566666666', pin: '3333' }));
  const bad = await app.inject({ method: 'POST', url: '/api/admin/import', payload: payload.toString().replace('alhadar-export-v1', 'x'), headers: { authorization: 'Bearer ' + admin, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(bad.statusCode, 400);
});
