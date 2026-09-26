/* اختبارات المساعد الذكي بنموذج محاكى: بدون اتصال فعلي وبدون تكلفة */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app.js';

const pushes = [];
const fakePush = new Proxy({ publicKey: 'test', subscribe: () => true, unsubscribe() {} }, {
  get: (t, k) => (k in t ? t[k] : (...a) => { pushes.push([k, ...a]); return Promise.resolve(); }),
});

/* نموذج محاكى: كل استدعاء ينفّذ الخطوة التالية من السيناريو، ويسجّل الطلبات للتحقق منها */
function fakeClaude() {
  const calls = [];
  let script = [];
  const create = async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const step = script.shift();
    if (!step) throw new Error('script exhausted');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(params) : step;
  };
  return { calls, set: (s) => { script = s; calls.length = 0; }, client: { messages: { create }, beta: { messages: { create } } } };
}
const toolUse = (name, input, id = 'tu_' + name) => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: '' }, { type: 'tool_use', id, name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const lastToolResult = (params) => {
  const m = params.messages[params.messages.length - 1];
  return JSON.parse(m.content.find((b) => b.type === 'tool_result').content);
};

let app, app2, dir, dir2, fake, admin, storeId;
async function req(a, method, url, body, token) {
  const r = await a.inject({ method, url, payload: body, headers: token ? { authorization: 'Bearer ' + token } : {} });
  let json = null; try { json = r.json(); } catch { /* */ }
  return { status: r.statusCode, body: json };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, `HTTP ${r.status}: ${JSON.stringify(r.body)}`); return r.body; };
async function customer(phone) {
  const o = await ok(req(app, 'POST', '/api/auth/otp', { phone }));
  return (await ok(req(app, 'POST', '/api/auth/verify', { phone, code: o.devCode, name: 'عميل' }))).token;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-ai-'));
  dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-ai2-'));
  fake = fakeClaude();
  app = await buildApp({ dataDir: dir, logger: false, push: fakePush, otpEcho: true, sendSms: async () => {}, anthropic: fake.client });
  app2 = await buildApp({ dataDir: dir2, logger: false, push: fakePush, anthropic: null });
  admin = (await ok(req(app, 'POST', '/api/admin/login', { pin: '1234' }))).token;
  await ok(req(app, 'PUT', '/api/admin/settings', { trialMode: false, deliveryFee: 12, districts: 'حي الطرف', supportPhone: '0500112653' }, admin));
  storeId = (await ok(req(app, 'PUT', '/api/admin/stores/new', { name: 'مطعم الوادي', category: 'restaurants', openAt: '06:00', closeAt: '23:30', products: [{ id: 'k', name: 'مندي لحم', price: 45 }, { id: 'z', name: 'جريش', price: 0 }] }, admin))).id;
});
after(async () => { await app.close(); await app2.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir2, { recursive: true, force: true }); });

test('بدون مفتاح API: المساعد معطّل، والنموذج البديل للبلاغات يشتغل', async () => {
  assert.equal((await ok(req(app2, 'GET', '/api/assistant/status'))).enabled, false);
  const r = await req(app2, 'POST', '/api/assistant/chat', { message: 'هلا' });
  assert.equal(r.status, 503);
  const bad = await req(app2, 'POST', '/api/tickets', { details: 'x', phone: '12' });
  assert.equal(bad.status, 400);
  const t = await ok(req(app2, 'POST', '/api/tickets', { category: 'complaint', subject: 'تأخر', details: 'الطلب تأخر ساعة', phone: '0551112222', name: 'سعد' }));
  assert.match(t.number, /^\d{5}$/);
  assert.ok(pushes.some(([k, p]) => k === 'admins' && /شكوى جديدة/.test(p.title)));
});

test('الإعداد: النموذج والتعليمات المخزنة مؤقتاً والأدوات الصارمة والنموذج البديل عند الرفض', async () => {
  fake.set([say('هلا والله! كيف أقدر أخدمك؟')]);
  const r = await ok(req(app, 'POST', '/api/assistant/chat', { message: 'السلام عليكم' }));
  assert.equal(r.reply, 'هلا والله! كيف أقدر أخدمك؟');
  assert.ok(r.threadId && r.token, 'محادثة جديدة برمز سري');
  const p = fake.calls[0];
  assert.equal(p.model, 'claude-opus-5');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.cache_control, { type: 'ephemeral' });
  assert.ok(p.output_config.effort);
  assert.equal(p.thinking, undefined, 'التفكير التكيفي افتراضي على Opus 5');
  assert.ok(p.tools.every((t) => t.strict === true && t.input_schema.additionalProperties === false));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(p.system[0].text), 'التعليمات ثابتة بدون تاريخ عشان التخزين المؤقت');
});

test('يجاوب من البيانات الحية: بحث، ثم تفاصيل المتجر، والمنتج بدون سعر يظهر "السعر قريباً"', async () => {
  let search, store;
  fake.set([
    toolUse('search_catalog', { query: 'مندي' }),
    (params) => { search = lastToolResult(params); return toolUse('get_store', { store_id: search.stores[0]?.store_id || search.products[0].store_id }); },
    (params) => { store = lastToolResult(params); return say('مطعم الوادي عنده مندي لحم بـ 45 ر.س.'); },
  ]);
  const r = await ok(req(app, 'POST', '/api/assistant/chat', { message: 'وين ألقى مندي؟' }));
  assert.equal(search.products[0].product, 'مندي لحم');
  assert.equal(search.products[0].price, '45 ر.س');
  assert.equal(store.name, 'مطعم الوادي');
  assert.equal(store.hours, '6:00ص – 11:30م');
  assert.ok(Object.values(store.sections).flat().some((x) => x.name === 'جريش' && /قريباً/.test(x.price)));
  assert.match(r.reply, /45/);
  /* السجل يبقى متسلسل: الرسالة الثالثة للنموذج فيها كل الأدوار السابقة */
  const roles = fake.calls[2].messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user']);
});

test('معلومات الخدمة: الرسوم والأحياء، ويعرف إن العميل غير مسجّل', async () => {
  let info;
  fake.set([toolUse('get_service_info', {}), (p) => { info = lastToolResult(p); return say('رسوم التوصيل 12 ر.س.'); }]);
  await ok(req(app, 'POST', '/api/assistant/chat', { message: 'كم التوصيل؟' }));
  assert.match(info.delivery_fee, /^12 ر.س/);
  assert.deepEqual(info.districts, ['حي الطرف']);
  assert.equal(info.customer_signed_in, false);
  assert.equal(info.support_phone, '0500112653');
});

test('البلاغ: يرفض بدون جوال للزائر، وبعد الجوال يرفع البلاغ وتوصل الإدارة', async () => {
  let err, done;
  const base = { category: 'complaint', subject: 'تأخر الطلب', details: 'طلبي تأخر ساعة والأكل وصل بارد', order_code: '#123456', contact_name: 'فهد', contact_phone: '' };
  fake.set([
    toolUse('create_ticket', base, 'a'),
    (p) => { err = p.messages.at(-1).content[0]; return toolUse('create_ticket', { ...base, contact_phone: '0551234567' }, 'b'); },
    (p) => { done = lastToolResult(p); return say(`تم رفع شكواك برقم ${done.ticket_number}.`); },
  ]);
  const r = await ok(req(app, 'POST', '/api/assistant/chat', { message: 'أبي أشتكي' }));
  assert.equal(err.is_error, true);
  assert.match(JSON.parse(err.content).error, /جوال/);
  assert.equal(r.tickets.length, 1);
  assert.equal(r.tickets[0].number, done.ticket_number);
  const list = await ok(req(app, 'GET', '/api/admin/tickets', null, admin));
  const t = list.find((x) => x.number === done.ticket_number);
  assert.equal(t.orderCode, '123456');
  assert.equal(t.phone, '0551234567');
  assert.equal(t.source, 'assistant');
  assert.ok(pushes.some(([k, p]) => k === 'admins' && p.tag === 'ticket-' + t.id));
  /* الإدارة تشوف المحادثة وتقفل البلاغ */
  const tr = await ok(req(app, 'GET', `/api/admin/tickets/${t.id}/transcript`, null, admin));
  assert.deepEqual(tr.map((m) => m.from), ['customer', 'assistant']);
  const closed = await ok(req(app, 'PATCH', `/api/admin/tickets/${t.id}`, { status: 'closed', adminNote: 'تم التواصل واعتذرنا' }, admin));
  assert.equal(closed.status, 'closed');
  assert.equal((await ok(req(app, 'GET', '/api/admin/data', null, admin))).openTickets, 0, 'بعد الإقفال ما يبقى بلاغ مفتوح');
});

test('الخصوصية: الطلبات للعميل نفسه فقط، والمحادثة ما تنفتح بحساب ثاني', async () => {
  const t1 = await customer('0500000071');
  await ok(req(app, 'POST', '/api/orders', { items: [{ storeId, productId: 'k', qty: 1 }], customer: { name: 'أ', district: 'حي الطرف', address: 'x' }, payment: 'cash' }, t1));
  let mine, guest;
  fake.set([toolUse('get_my_orders', {}), (p) => { mine = lastToolResult(p); return say('طلبك جديد.'); }]);
  const c1 = await ok(req(app, 'POST', '/api/assistant/chat', { message: 'وين طلبي؟' }, t1));
  assert.equal(mine.orders.length, 1);
  assert.equal(mine.orders[0].status, 'طلب جديد');
  fake.set([toolUse('get_my_orders', {}), (p) => { guest = p.messages.at(-1).content[0]; return say('سجّل دخولك.'); }]);
  await ok(req(app, 'POST', '/api/assistant/chat', { message: 'وين طلبي؟' }));
  assert.equal(guest.is_error, true, 'الزائر ما يشوف طلبات');
  /* عميل ثاني يحاول يستخدم نفس المحادثة */
  const t2 = await customer('0500000072');
  fake.set([say('هلا')]);
  const c2 = await ok(req(app, 'POST', '/api/assistant/chat', { threadId: c1.threadId, token: c1.token, message: 'هلا' }, t2));
  assert.notEqual(c2.threadId, c1.threadId);
  assert.equal(fake.calls[0].messages.length, 1, 'ما شاف رسائل العميل الأول');
  /* رمز خاطئ = محادثة جديدة */
  fake.set([say('هلا')]);
  const c3 = await ok(req(app, 'POST', '/api/assistant/chat', { threadId: c1.threadId, token: 'wrong', message: 'هلا' }, t1));
  assert.notEqual(c3.threadId, c1.threadId);
});

test('المتابعة في نفس المحادثة، والرفض بأسلوب لبق، وتعطّل الخدمة ما يكسر السجل', async () => {
  fake.set([say('أهلاً')]);
  const c = await ok(req(app, 'POST', '/api/assistant/chat', { message: 'هلا' }));
  fake.set([{ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: null } }]);
  const r = await ok(req(app, 'POST', '/api/assistant/chat', { threadId: c.threadId, token: c.token, message: 'سؤال غريب' }));
  assert.match(r.reply, /ما أقدر أساعد/);
  fake.set([Object.assign(new Error('overloaded'), { status: 529 })]);
  const e = await req(app, 'POST', '/api/assistant/chat', { threadId: c.threadId, token: c.token, message: 'ثاني' });
  assert.equal(e.status, 502);
  assert.match(e.body.error, /مشغول/);
  fake.set([say('تمام')]);
  await ok(req(app, 'POST', '/api/assistant/chat', { threadId: c.threadId, token: c.token, message: 'ثالث' }));
  const msgs = fake.calls[0].messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user'], 'الرسالة اللي فشلت ما انحفظت');
  assert.equal(msgs.at(-1).content, 'ثالث');
});
