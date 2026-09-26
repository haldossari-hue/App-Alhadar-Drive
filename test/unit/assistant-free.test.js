/* المساعد المجاني: عبارات عملاء حقيقية باللهجة، وكل وحدة لازم توصل للإجابة الصحيحة */
import { test, before, after, beforeEach } from 'node:test';
import { resetRateLimits } from '../../src/auth.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app.js';

const pushes = [];
const fakePush = new Proxy({ publicKey: 'test', subscribe: () => true, unsubscribe() {} }, {
  get: (t, k) => (k in t ? t[k] : (...a) => { pushes.push([k, ...a]); return Promise.resolve(); }),
});
let app, dir, admin;
async function req(method, url, body, token) {
  const r = await app.inject({ method, url, payload: body, headers: token ? { authorization: 'Bearer ' + token } : {} });
  let json = null; try { json = r.json(); } catch { /* */ }
  return { status: r.statusCode, body: json };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.body)}`); return r.body; };
/* كل سؤال في محادثة جديدة */
const ask = async (message, token) => ok(req('POST', '/api/assistant/chat', { message }, token));
/* محادثة متتابعة */
function convo(token) {
  let th = {};
  return async (message) => { const r = await ok(req('POST', '/api/assistant/chat', { ...th, message }, token)); th = { threadId: r.threadId, token: r.token || th.token }; return r; };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-free-'));
  app = await buildApp({ dataDir: dir, logger: false, push: fakePush, otpEcho: true, sendSms: async () => {}, anthropic: null });
  admin = (await ok(req('POST', '/api/admin/login', { pin: '1234' }))).token;
  await ok(req('PUT', '/api/admin/settings', { trialMode: false, deliveryFee: 13, minOrder: 10, districts: 'حي القيسيه\nحي البرقه\nحي الطرف', supportPhone: '0500112653', loyaltyEvery: 4 }, admin));
  await ok(req('PUT', '/api/admin/stores/new', { name: 'مطعم الوادي', category: 'restaurants', desc: 'مندي ومظبي', openAt: '00:00', closeAt: '23:59', products: [{ id: 'k', name: 'مندي لحم', price: 45, sec: 'المندي' }, { id: 'j', name: 'جريش', price: 0 }] }, admin));
  await ok(req('PUT', '/api/admin/stores/new', { name: 'تموينات حاتم', category: 'grocery', products: [{ id: 'w', name: 'ماء صحي', price: 5, unit: 'كرتون' }, { id: 'r', name: 'رز بسمتي', price: 60 }] }, admin));
  const closed = await ok(req('PUT', '/api/admin/stores/new', { name: 'صيدلية الشفاء', category: 'pharmacy', products: [{ id: 'p', name: 'بنادول', price: 9 }] }, admin));
  await ok(req('PATCH', '/api/admin/stores/' + closed.id, { open: false }, admin));
  await ok(req('PUT', '/api/admin/coupons/HADAR10', { kind: 'percent', value: 10, isNew: true }, admin));
});
beforeEach(() => resetRateLimits());
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('الأسئلة العامة: كل صيغة توصل للإجابة الصحيحة من الإعدادات', async () => {
  const cases = [
    ['كم رسوم التوصيل؟', /13 ر.س/],
    ['التوصيل بكم', /13 ر.س/],
    ['كم الحد الادنى للطلب', /الحد الأدنى للطلب 10 ر.س/],
    ['هل التوصيل مجاني؟', /13 ر.س/],
    ['وش الأحياء اللي توصلون لها', /• حي القيسيه[\s\S]*• حي الطرف/],
    ['توصلون حي البرقه؟', /نعم، نوصّل لـ حي البرقه/],
    ['توصلون حي العزيزية', /حي العزيزية مو ضمن الأحياء/],
    ['كيف ادفع', /كاش عند الاستلام[\s\S]*حوالة بنكية/],
    ['تقبلون مدى؟', /مدى/],
    ['عندكم كوبونات خصم', /HADAR10: خصم 10%/],
    ['وش برنامج الولاء', /كل 4 طلبات/],
    ['ابي اكلم الاداره', /0500112653/],
    ['كيف الغي طلبي', /تلغي الطلب بنفسك/],
    ['ابي استرجع فلوسي', /سياسة الاسترجاع/],
    ['السلام عليكم', /وعليكم السلام/],
    ['مشكور', /العفو/],
    ['المنتج اللي ابيه مو موجود', /اكتب طلبك بنفسك/],
  ];
  for (const [q, re] of cases) {
    const r = await ask(q);
    assert.match(r.reply, re, `السؤال: "${q}" ← الرد: "${r.reply}"`);
  }
});

test('ما يخلط الكلمات: "ماء صحي" و"الحين" ما تنفهم كسؤال عن الأحياء', async () => {
  const r1 = await ask('كم سعر الماء الصحي');
  assert.match(r1.reply, /ماء صحي \(تموينات حاتم\): 5 ر.س/);
  assert.doesNotMatch(r1.reply, /نوصّل/);
  const r2 = await ask('مين مفتوح الحين');
  assert.match(r2.reply, /المتاجر المفتوحة الحين/);
  assert.match(r2.reply, /مطعم الوادي/);
  assert.doesNotMatch(r2.reply, /صيدلية الشفاء/, 'المغلق ما يظهر ضمن المفتوح');
});

test('البحث عن منتج ومتجر: الأسعار الحقيقية، والمنتج بدون سعر "السعر قريباً"، والمغلق يوضح', async () => {
  assert.match((await ask('عندكم مندي؟')).reply, /مندي لحم \(مطعم الوادي\): 45 ر.س/);
  assert.match((await ask('ابي جريش')).reply, /جريش \(مطعم الوادي\): السعر قريباً/);
  assert.match((await ask('بكم الرز')).reply, /رز بسمتي \(تموينات حاتم\): 60 ر.س/);
  assert.match((await ask('ابي بنادول')).reply, /بنادول \(صيدلية الشفاء\): 9 ر.س — المتجر مغلق الحين/);
  const st = await ask('صيدلية الشفاء مفتوحة؟');
  assert.match(st.reply, /صيدلية الشفاء: مغلق الحين/);
  assert.match((await ask('مطعم الوادي')).reply, /مطعم الوادي: مفتوح الحين ✅[\s\S]*مندي لحم: 45 ر.س/);
});

test('سؤال ما يفهمه: يعترف ويعرض الخيارات، وما يخترع إجابة', async () => {
  const r = await ask('وش رأيك في الطقس بكرة');
  assert.match(r.reply, /ما فهمت سؤالك/);
  assert.ok(r.quick.includes('أرفع سؤالي للإدارة'));
  const say = convo();
  await say('أرفع سؤالي للإدارة');
  const r2 = await say('هل تفتحون فرع في ليلى؟ 0551230001');
  assert.match(r2.reply, /ما لقيت رقم طلب|رقم الطلب/);
});

test('وين طلبي: للزائر يوجهه، وللمسجّل يعرض طلباته الحقيقية فقط', async () => {
  assert.match((await ask('وين طلبي؟')).reply, /سجّل دخولك/);
  const o = await ok(req('POST', '/api/auth/otp', { phone: '0500000081' }));
  const tok = (await ok(req('POST', '/api/auth/verify', { phone: '0500000081', code: o.devCode, name: 'سالم' }))).token;
  const boot = await ok(req('GET', '/api/bootstrap'));
  const sid = boot.stores.find((x) => x.name === 'مطعم الوادي').id;
  const placed = await ok(req('POST', '/api/orders', { items: [{ storeId: sid, productId: 'k', qty: 1 }], customer: { name: 'سالم', district: 'حي الطرف', address: 'x' }, payment: 'cash' }, tok));
  const r = await ask('وين طلبي', tok);
  assert.match(r.reply, new RegExp(`#${placed.orders[0].code} من مطعم الوادي: طلب جديد`));
  /* "طلبي تأخر" يعرض الحالة أول ويعرض رفع شكوى كخيار */
  const late = await ask('طلبي تأخر', tok);
  assert.match(late.reply, /آخر طلباتك/);
  assert.ok(late.quick.includes('رفع شكوى أو ملاحظة'));
});

test('رفع شكوى من زائر بالخطوات: التفاصيل، رقم الطلب، التواصل، الملخص، ثم الموافقة', async () => {
  const say = convo();
  let r = await say('رفع شكوى أو ملاحظة');
  assert.deepEqual(r.quick, ['شكوى', 'بلاغ عن مشكلة', 'اقتراح أو ملاحظة', 'استفسار']);
  r = await say('شكوى');
  assert.match(r.reply, /اكتب التفاصيل/);
  r = await say('هي');
  assert.match(r.reply, /بشكل أوضح/, 'تفاصيل قصيرة جداً ما تنقبل');
  r = await say('الطلب وصل بارد والسائق تأخر ساعة');
  assert.ok(r.quick.includes('ما له علاقة بطلب'));
  r = await say('رقم الطلب ٤٨٢٩١٣');
  assert.match(r.reply, /اسمك ورقم جوالك/);
  r = await say('فهد بدون رقم');
  assert.match(r.reply, /ما لقيت رقم جوال صحيح/);
  r = await say('فهد 0551234567');
  assert.match(r.reply, /ملخص البلاغ[\s\S]*النوع: شكوى[\s\S]*رقم الطلب: 482913[\s\S]*فهد — 0551234567[\s\S]*أرفعه للإدارة؟/);
  assert.equal((await ok(req('GET', '/api/admin/tickets', null, admin))).filter((t) => t.details.includes('بارد')).length, 0, 'ما يرفع قبل الموافقة');
  r = await say('✅ ارفعه للإدارة');
  assert.match(r.reply, /تم رفع شكوى للإدارة برقم #\d{5}/);
  assert.equal(r.tickets.length, 1);
  const t = (await ok(req('GET', '/api/admin/tickets', null, admin))).find((x) => x.number === r.tickets[0].number);
  assert.equal(t.orderCode, '482913');
  assert.equal(t.phone, '0551234567');
  assert.equal(t.name, 'فهد');
  assert.equal(t.category, 'complaint');
  const tr = await ok(req('GET', `/api/admin/tickets/${t.id}/transcript`, null, admin));
  assert.ok(tr.length >= 14 && tr[0].from === 'customer', 'الإدارة تشوف المحادثة كاملة');
  /* بعد الرفع يرجع للأسئلة العادية */
  assert.match((await say('كم التوصيل')).reply, /13 ر.س/);
});

test('شكوى مباشرة بجملة وحدة، وتعديل، وإلغاء', async () => {
  const say = convo();
  let r = await say('ابي ارفع شكوى السائق كان تعامله سيء جداً ورفض يوصل لباب البيت');
  assert.match(r.reply, /فهمت عليك/, 'فهم التفاصيل من نفس الرسالة');
  r = await say('ما له علاقة بطلب');
  r = await say('نورة 0559990000');
  assert.match(r.reply, /التفاصيل: السائق كان تعامله سيء/);
  r = await say('✏️ تعديل');
  r = await say('السائق كان تعامله سيء ورفض يوصل');
  assert.match(r.reply, /ملخص البلاغ[\s\S]*التفاصيل: السائق كان تعامله سيء ورفض يوصل\n/, 'بعد التعديل يرجع للملخص مباشرة');
  r = await say('✅ ارفعه للإدارة');
  assert.match(r.reply, /تم رفع/);
  const c2 = convo();
  await c2('عندي اقتراح');
  const x = await c2('❌ إلغاء');
  assert.match(x.reply, /تم إلغاء البلاغ/);
});

test('للمسجّل: البلاغ ما يطلب جوال، والأمان: تنبيه عند مشاركة بطاقة، وتوجيه الطوارئ', async () => {
  const o = await ok(req('POST', '/api/auth/otp', { phone: '0500000082' }));
  const tok = (await ok(req('POST', '/api/auth/verify', { phone: '0500000082', code: o.devCode, name: 'منى' }))).token;
  const say = convo(tok);
  await say('عندي بلاغ');
  await say('التطبيق يعلق عند الدفع بالحوالة');
  const r = await say('ما له علاقة بطلب');
  assert.match(r.reply, /ملخص البلاغ/, 'تخطى سؤال الجوال');
  assert.doesNotMatch(r.reply, /التواصل:/);
  const d = await say('✅ ارفعه للإدارة');
  const t = (await ok(req('GET', '/api/admin/tickets', null, admin))).find((x) => x.number === d.tickets[0].number);
  assert.equal(t.customerPhone, '0500000082');
  assert.match((await ask('رقم بطاقتي 4111111111111111 ليش ما قبلت')).reply, /لا تشارك أرقام البطاقات/);
  assert.match((await ask('صار حادث للسائق')).reply, /911/);
});

test('التصنيفات والنوايا الإضافية: غاز، صيدلية، كهربائي، حي بدون كلمة "حي"، وقت التوصيل، المدح، التوظيف، "أفضل"', async () => {
  await ok(req('PUT', '/api/admin/stores/new', { name: 'غاز الهدار', category: 'gas', products: [{ id: 'g', name: 'تبديل أسطوانة غاز', price: 25 }] }, admin));
  await ok(req('PUT', '/api/admin/stores/new', { name: 'بقالة الوادي', category: 'grocery', products: [{ id: 's', name: 'مشروب غازي', price: 3 }, { id: 'b', name: 'أرز بسمتي', price: 30 }] }, admin));
  await ok(req('PUT', '/api/admin/stores/new', { name: 'نور للكهرباء', category: 'electric', products: [{ id: 'e', name: 'طلب كهربائي للبيت', price: 50 }] }, admin));
  const gas = await ask('عندكم غاز؟');
  assert.match(gas.reply, /^المتاجر المتوفرة:\n• غاز الهدار/, 'متجر الغاز أولاً مو المشروب الغازي');
  const ph = await ask('متى تفتح الصيدلية');
  assert.match(ph.reply, /صيدلية الشفاء/);
  assert.doesNotMatch(ph.reply, /أرز بسمتي/, '"متى" ما تطابق وسط "بسمتي"');
  assert.match((await ask('ابي كهربائي')).reply, /^المتاجر المتوفرة:\n• نور للكهرباء/);
  assert.match((await ask('توصلون للقيسيه')).reply, /نعم، نوصّل لـ حي القيسيه/);
  assert.match((await ask('كم يوصل الطلب')).reply, /وقت التوصيل التقريبي/);
  assert.match((await ask('التطبيق حلو')).reply, /شكراً لك/);
  assert.match((await ask('ابي اشتغل سائق عندكم')).reply, /للانضمام كسائق/);
  const best = await ask('وش افضل مطعم');
  assert.match(best.reply, /ما أقدر أفضّل متجر على ثاني/);
  assert.match(best.reply, /مطعم الوادي/);
});
