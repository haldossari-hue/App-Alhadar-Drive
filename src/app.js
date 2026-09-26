import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { config } from './config.js';
import { openDb } from './db.js';
import { createHub } from './services/realtime.js';
import { createPush } from './services/push.js';
import { sendSms } from './services/sms.js';
import { paymentsProvider, createPayment, fetchPaymentStatus } from './services/payments.js';
import { hashSecret, verifySecret, needsRehash, issueToken, readToken, TTL, rateLimit, randomId, randomDigits, signedFileUrl } from './auth.js';
import { createOrderService, CheckoutError } from './orders.js';
import { importBundle } from './importer.js';
import { LEGAL_DEFAULTS } from './legal-defaults.js';
import { toCsv, parseCsv } from './csv.js';
import { createAssistant, makeClient, TICKET_CATS } from './services/assistant.js';
import {
  insertProduct, loadStores, loadStore, saveStore, getCoupon, couponRow, customerRow, driverRow, getOrder, orderRow, viewOrder,
} from './repo.js';
import { CAT, CATS, TINTS, UNIT_PRESETS, DRIVER_ACTIVE, claimableOrder, normalizePhone, arabicDigits, round2, validTime, withDisplayNames } from '../public/shared/constants.js';

const httpError = (status, message, code) => Object.assign(new Error(message), { statusCode: status, code: code || 'error' });

export async function buildApp(opts = {}) {
  const dataDir = opts.dataDir || config.dataDir;
  const db = opts.db || openDb(opts.dbFile || path.join(dataDir, 'alhadar.db'));
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const app = Fastify({
    logger: opts.logger ?? { level: config.isProd ? 'info' : 'warn', redact: ['req.headers.authorization'] },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const hub = createHub();
  const push = opts.push || createPush(db, app.log);
  const svc = createOrderService({ db, hub, push, log: app.log });
  const sms = opts.sendSms || ((phone, text) => sendSms(phone, text, app.log));
  const onlinePay = () => !!paymentsProvider();

  app.decorate('db', db);
  app.decorate('hub', hub);
  app.decorate('svc', svc);

  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  /* ============ الأمان العام ============ */
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (!reply.getHeader('X-Frame-Options')) reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  /* الأخطاء: رسائل عربية واضحة للعميل بدون تسريب تفاصيل داخلية */
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof CheckoutError) return reply.code(err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : err.code === 'taken' ? 409 : 400).send({ error: err.message, code: err.code });
    /* 502: خدمة خارجية (SMS أو بوابة الدفع) ما ردّت — رسالتنا العربية مقصودة وتوصل للمستخدم */
    if (err.statusCode && (err.statusCode < 500 || err.statusCode === 502 || err.statusCode === 503)) return reply.code(err.statusCode).send({ error: err.message, code: err.code || 'error' });
    req.log.error(err);
    reply.code(500).send({ error: 'صار خطأ غير متوقع، حاول مرة أخرى', code: 'server' });
  });

  /* ============ الهوية ============ */
  const adminState = () => db.kvGet('admin', null) || initAdmin();
  function initAdmin() {
    const a = { pinHash: hashSecret(config.initialAdminPin), recoveryHash: null, v: 1 };
    db.kvSet('admin', a);
    return a;
  }

  if (config.adminResetPin && !opts.skipAdminReset) {
    const pin = arabicDigits(config.adminResetPin);
    if (/^\d{4,8}$/.test(pin)) {
      const a = adminState();
      /* نعيد الضبط مرة وحدة لكل قيمة، عشان إعادة التشغيل ما تلغي رمزاً غيّرته لاحقاً من الإعدادات */
      const mark = crypto.createHash('sha256').update('reset:' + pin).digest('hex');
      if (a.resetMark !== mark) {
        db.kvSet('admin', { ...a, pinHash: hashSecret(pin), v: a.v + 1, resetMark: mark });
        app.log.warn('تمت إعادة ضبط رمز الإدارة من ADMIN_RESET_PIN — احذف المتغير الآن');
        console.log('تمت إعادة ضبط رمز الإدارة من ADMIN_RESET_PIN — احذف المتغير الآن');
      }
    } else console.log('ADMIN_RESET_PIN لازم يكون من 4 إلى 8 أرقام — تم تجاهله');
  }

  app.decorateRequest('who', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? readToken(h.slice(7)) : null;
    if (!t || !t.role) return;
    if (t.role === 'admin' && t.v !== adminState().v) return;
    if (t.role === 'driver') {
      const d = db.get('SELECT * FROM drivers WHERE id = ?', t.sub);
      if (!d || !d.active || d.token_version !== t.v) return;
      req.driver = d;
    }
    if (t.role === 'customer' && !db.get('SELECT 1 FROM customers WHERE phone = ?', t.sub)) return;
    if (['admin', 'driver', 'customer'].includes(t.role)) req.who = { role: t.role, sub: t.sub };
  });
  const need = (role) => async (req) => {
    if (!req.who || req.who.role !== role) throw httpError(401, 'سجّل دخولك من جديد', 'auth');
  };
  const isCustomer = need('customer'), isDriver = need('driver'), isAdmin = need('admin');
  const limit = (key, max, ms) => { if (!rateLimit(key, max, ms)) throw httpError(429, 'محاولات كثيرة، انتظر شوي وحاول مرة ثانية', 'rate'); };

  /* ============ عام ============ */
  app.get('/api/health', async () => ({ ok: true, t: Date.now() }));

  function publicSettings() {
    const s = db.settings();
    return {
      deliveryFee: s.deliveryFee, minOrder: s.minOrder, districts: s.districts, announcement: s.announcement, supportPhone: s.supportPhone,
      payments: { cash: true, bank: s.payments.bank !== false, online: onlinePay() },
      bankName: s.bankName, bankHolder: s.bankHolder, bankIban: s.bankIban, loyaltyOn: s.loyaltyOn, loyaltyEvery: s.loyaltyEvery,
      legalName: s.legalName || '', crNumber: s.crNumber || '', vatNumber: s.vatNumber || '',
      trialMode: s.trialMode !== false,
    };
  }
  const legalTexts = () => ({ ...LEGAL_DEFAULTS, ...db.kvGet('legal', {}) });
  function publicCoupons() {
    const now = Date.now();
    return db.all('SELECT * FROM coupons WHERE active = 1 ORDER BY created_at DESC').map(couponRow)
      .filter((c) => (!c.expiresAt || now <= c.expiresAt) && (!c.maxUses || c.usedCount < c.maxUses))
      .map(({ code, kind, value, minOrder }) => ({ id: code, code, kind, value, minOrder }));
  }
  app.get('/api/bootstrap', async () => ({
    settings: publicSettings(),
    stores: db.settings().trialMode !== false ? withDisplayNames(loadStores(db)) : loadStores(db, { namedOnly: true }),
    coupons: publicCoupons(),
    vapidKey: push.publicKey,
  }));

  /* ============ المساعد الذكي والبلاغات ============ */
  const assistant = createAssistant({ db, hub, push, log: app.log, client: opts.anthropic !== undefined ? opts.anthropic : await makeClient(), legalTexts });
  app.get('/api/assistant/status', async () => ({ enabled: assistant.enabled() }));
  app.post('/api/assistant/chat', async (req) => {
    const b = req.body || {};
    limit('ai-ip:' + req.ip, 40, 600e3);
    if (b.threadId) limit('ai-thread:' + b.threadId, 20, 300e3);
    const phone = req.who && req.who.role === 'customer' ? req.who.sub : null;
    try { return await assistant.chat({ threadId: b.threadId, token: b.token, message: b.message, phone, onlinePay: onlinePay() }); }
    catch (e) {
      if (e.code === 'disabled') throw httpError(503, e.message, 'disabled');
      if (e.code === 'upstream') throw httpError(502, e.message, 'upstream');
      if (e.code === 'too_long' || e.code === 'empty') throw httpError(400, e.message, e.code);
      throw e;
    }
  });
  /* نموذج البلاغ البديل (يشتغل حتى لو المساعد غير متاح) */
  app.post('/api/tickets', async (req) => {
    limit('ticket-ip:' + req.ip, 8, 3600e3);
    const b = req.body || {};
    const phone = req.who && req.who.role === 'customer' ? req.who.sub : null;
    if (!phone && !normalizePhone(b.phone)) throw httpError(400, 'اكتب رقم جوال صحيح عشان نتواصل معك');
    if (!String(b.details || '').trim()) throw httpError(400, 'اكتب تفاصيل البلاغ');
    const t = assistant.createTicket({ category: b.category, subject: b.subject, details: b.details, orderCode: b.orderCode, name: b.name, phone: phone || b.phone, customerPhone: phone, source: 'form' });
    return { number: t.number };
  });
  const ticketOut = (r) => ({ id: r.id, number: r.number, category: r.category, categoryLabel: TICKET_CATS[r.category], subject: r.subject, details: r.details, orderCode: r.order_code, name: r.name, phone: r.phone, customerPhone: r.customer_phone, status: r.status, adminNote: r.admin_note, source: r.source, hasTranscript: !!r.thread_id, createdAt: r.created_at, closedAt: r.closed_at });
  app.get('/api/admin/tickets', { preHandler: isAdmin }, async () =>
    db.all("SELECT * FROM tickets ORDER BY (status = 'open') DESC, created_at DESC LIMIT 300").map(ticketOut));
  app.patch('/api/admin/tickets/:id', { preHandler: isAdmin }, async (req) => {
    const b = req.body || {};
    const t = db.get('SELECT * FROM tickets WHERE id = ?', req.params.id);
    if (!t) throw httpError(404, 'البلاغ غير موجود');
    const status = b.status === 'closed' ? 'closed' : b.status === 'open' ? 'open' : t.status;
    db.run('UPDATE tickets SET status = ?, admin_note = ?, closed_at = ? WHERE id = ?', status, b.adminNote !== undefined ? String(b.adminNote).slice(0, 2000) : t.admin_note, status === 'closed' ? (t.closed_at || Date.now()) : null, t.id);
    hub.admins({ type: 'ticket' });
    return ticketOut(db.get('SELECT * FROM tickets WHERE id = ?', t.id));
  });
  app.get('/api/admin/tickets/:id/transcript', { preHandler: isAdmin }, async (req) => {
    const t = db.get('SELECT thread_id FROM tickets WHERE id = ?', req.params.id);
    if (!t || !t.thread_id) throw httpError(404, 'ما فيه محادثة لهذا البلاغ');
    return assistant.transcript(t.thread_id);
  });

  /* ============ وضع التجربة: طلب بدون تسجيل، ما يروح للسائقين ============ */
  const trialOn = () => db.settings().trialMode !== false;
  const trialStore = (id) => {
    const all = withDisplayNames(loadStores(db));
    return all.find((x) => x.id === id) || null;
  };
  const quoteOut = (cx) => ({
    rows: cx.rows.map((r) => ({ storeId: r.bk.s.id, storeName: r.bk.s.name, sub: r.bk.sub, discount: r.discount, fee: r.fee, total: r.total, coupon: r.coupon, freeUsedHere: r.freeUsedHere })),
    couponOk: cx.couponOk, couponMsg: cx.couponMsg,
    grandSub: cx.grandSub, grandDiscount: cx.grandDiscount, grandFee: cx.grandFee, grandTotal: cx.grandTotal,
  });
  app.post('/api/trial/quote', async (req) => {
    if (!trialOn()) throw httpError(400, 'وضع التجربة متوقف', 'trial_off');
    return quoteOut(svc.trialQuote(req.body || {}, trialStore).cx);
  });
  app.post('/api/trial/orders', async (req) => {
    if (!trialOn()) throw httpError(400, 'وضع التجربة متوقف، سجّل دخولك واطلب طلباً عادياً', 'trial_off');
    limit('trial:' + req.ip, 15, 600e3);
    return { orders: svc.placeTrial(req.body || {}, trialStore) };
  });
  app.delete('/api/admin/trial-orders', { preHandler: isAdmin }, async () => {
    const r = db.run("DELETE FROM orders WHERE status = 'trial'");
    hub.admins({ type: 'order' });
    return { deleted: Number(r.changes) };
  });

  /* صفحات السياسات (عامة بدون تسجيل دخول — تطلبها بوابات الدفع ونظام حماية البيانات) */
  app.get('/api/legal', async () => ({ ...legalTexts(), ...(({ legalName, crNumber, vatNumber, supportPhone }) => ({ legalName, crNumber, vatNumber, supportPhone }))(publicSettings()) }));

  /* ============ حساب العميل: التحقق من الجوال ============ */
  /* sms: رسالة نصية عبر المزوّد. whatsapp: الرمز يظهر للإدارة وترسله من واتسابها (حل مؤقت لين يتفعّل مزوّد الرسائل) */
  const smsReady = () => !!opts.sendSms || config.sms.provider !== 'console';
  function verifyMode() {
    const m = db.settings().verifyMode;
    if (m === 'whatsapp' || m === 'sms') return m === 'sms' && !smsReady() && config.isProd ? 'whatsapp' : m;
    return !smsReady() && config.isProd ? 'whatsapp' : 'sms';
  }
  const otpPending = () => db.all(`SELECT o.phone, o.plain_code code, o.sent_at t, o.wa_sent_at waSentAt, c.name
      FROM otp_codes o LEFT JOIN customers c ON c.phone = o.phone
      WHERE o.channel = 'whatsapp' AND o.expires_at > ? ORDER BY o.sent_at DESC`, Date.now())
    .map((r) => ({ ...r, exists: r.name != null }));
  app.post('/api/auth/otp', async (req) => {
    const phone = normalizePhone(req.body && req.body.phone);
    if (!phone) throw httpError(400, 'رقم الجوال غير صحيح');
    limit('otp-ip:' + req.ip, 20, 3600e3);
    const now = Date.now();
    const cur = db.get('SELECT * FROM otp_codes WHERE phone = ?', phone);
    if (cur && now - cur.sent_at < 60e3) throw httpError(429, 'انتظر دقيقة قبل طلب رمز جديد', 'rate');
    const inWindow = cur && now - cur.window_start < 3600e3;
    if (inWindow && cur.sent_count >= 5) throw httpError(429, 'طلبت رموز كثيرة، حاول بعد ساعة', 'rate');
    const code = randomDigits(4);
    const mode = verifyMode();
    const wa = mode === 'whatsapp';
    db.run(`INSERT INTO otp_codes(phone, code_hash, expires_at, attempts, sent_at, sent_count, window_start, channel, plain_code, wa_sent_at) VALUES(?,?,?,0,?,1,?,?,?,NULL)
      ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at,
        sent_count=?, window_start=?, channel=excluded.channel, plain_code=excluded.plain_code, wa_sent_at=NULL`,
      phone, hashSecret(code), now + (wa ? 30 : 5) * 60e3, now, now, mode, wa ? code : null, inWindow ? cur.sent_count + 1 : 1, inWindow ? cur.window_start : now);
    const exists = !!db.get('SELECT 1 FROM customers WHERE phone = ?', phone);
    if (wa) {
      hub.admins({ type: 'otp' });
      hub.admins({ type: 'notify', text: `🔐 ${exists ? 'عميل' : 'عميل جديد'} ينتظر رمز التحقق: ${phone}`, sound: true });
      push.admins({ title: '🔐 عميل ينتظر رمز التحقق', body: `${phone} — افتح لوحة الإدارة وأرسل له الرمز بواتساب`, url: '/admin', tag: 'otp-' + phone });
      return { ok: true, exists, channel: 'whatsapp', supportPhone: db.settings().supportPhone || '', ...(config.otpDevEcho || opts.otpEcho ? { devCode: code } : {}) };
    }
    try { await sms(phone, `رمز الدخول للهدار درايف: ${code}\nلا تشاركه مع أحد.`); }
    catch (e) {
      req.log.error(e);
      /* نرجّع الحالة كما كانت عشان العميل يقدر يحاول فوراً بدون انتظار */
      if (cur) db.run('UPDATE otp_codes SET sent_at = ?, sent_count = ?, window_start = ?, code_hash = ? WHERE phone = ?', cur.sent_at, cur.sent_count, cur.window_start, cur.code_hash, phone);
      else db.run('DELETE FROM otp_codes WHERE phone = ?', phone);
      throw httpError(502, 'تعذر إرسال رسالة التحقق، حاول بعد شوي');
    }
    return { ok: true, exists, channel: 'sms', ...(config.otpDevEcho || opts.otpEcho ? { devCode: code } : {}) };
  });

  app.post('/api/auth/verify', async (req) => {
    const b = req.body || {};
    const phone = normalizePhone(b.phone);
    const code = arabicDigits(b.code);
    if (!phone || !/^\d{4}$/.test(code)) throw httpError(400, 'الرمز غير صحيح');
    const row = db.get('SELECT * FROM otp_codes WHERE phone = ?', phone);
    if (!row || row.expires_at < Date.now()) throw httpError(400, 'انتهت صلاحية الرمز، اطلب رمزاً جديداً', 'expired');
    if (row.attempts >= 5) throw httpError(429, 'محاولات كثيرة، اطلب رمزاً جديداً', 'rate');
    if (!verifySecret(code, row.code_hash)) {
      db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?', phone);
      throw httpError(400, 'الرمز غير صحيح', 'bad_code');
    }
    let c = db.get('SELECT * FROM customers WHERE phone = ?', phone);
    if (!c) {
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) throw httpError(400, 'اكتب اسمك', 'need_name');
      db.run('INSERT INTO customers(phone, name, created_at) VALUES(?,?,?)', phone, name, Date.now());
      c = db.get('SELECT * FROM customers WHERE phone = ?', phone);
    }
    const hadWa = row.channel === 'whatsapp';
    db.run('DELETE FROM otp_codes WHERE phone = ?', phone);
    if (hadWa) hub.admins({ type: 'otp' });
    return { token: issueToken({ role: 'customer', sub: phone }, TTL.customer), customer: customerRow(c) };
  });

  /* ============ العميل ============ */
  const meOf = (phone) => ({
    ...customerRow(db.get('SELECT * FROM customers WHERE phone = ?', phone)),
    usedCoupons: db.all('SELECT code FROM customer_coupons WHERE phone = ?', phone).map((r) => r.code),
  });
  app.get('/api/me', { preHandler: isCustomer }, async (req) => meOf(req.who.sub));
  app.patch('/api/me', { preHandler: isCustomer }, async (req) => {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw httpError(400, 'اكتب اسمك');
    const district = String(b.district || '').trim();
    if (district && !db.settings().districts.includes(district)) throw httpError(400, 'الحي غير متاح');
    let map = String(b.map || '').trim().slice(0, 500);
    if (map && !/^https?:\/\//.test(map)) map = '';
    const lat = Number.isFinite(Number(b.lat)) && b.lat !== null && b.lat !== '' ? Number(b.lat) : null;
    const lng = lat != null ? Number(b.lng) : null;
    db.run('UPDATE customers SET name=?, district=?, address=?, map=?, lat=COALESCE(?, lat), lng=COALESCE(?, lng) WHERE phone=?',
      name, district, String(b.address || '').trim().slice(0, 400), map, lat, lng, req.who.sub);
    return meOf(req.who.sub);
  });
  app.get('/api/my/orders', { preHandler: isCustomer }, async (req) =>
    db.all('SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 100', req.who.sub).map(orderRow).map((o) => viewOrder(o, req.who, db)));

  app.post('/api/checkout/quote', { preHandler: isCustomer }, async (req) => {
    return quoteOut(svc.quote(req.who.sub, req.body || {}).cx);
  });

  app.post('/api/orders', { preHandler: isCustomer }, async (req) => {
    limit('place:' + req.who.sub, 10, 600e3);
    const r = svc.place(req.who.sub, req.body || {}, { onlineAvailable: onlinePay() });
    let payUrl = null;
    if (r.orders[0].payment === 'online') {
      const pid = randomId('pay');
      try {
        const p = await createPayment({ paymentId: pid, amount: r.grandTotal, description: 'الهدار درايف — طلب #' + r.group });
        db.run('INSERT INTO payments(id, group_code, provider, provider_ref, amount, status, url, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
          pid, r.group, paymentsProvider(), p.ref, r.grandTotal, 'initiated', p.url, Date.now(), Date.now());
        payUrl = p.url;
      } catch (e) {
        req.log.error(e);
        svc.markGroupFailed(r.group);
        throw httpError(502, 'تعذر فتح بوابة الدفع، جرّب طريقة دفع ثانية');
      }
    } else r.orders.forEach((o) => svc.announce(o, null));
    return { orders: r.orders.map((o) => viewOrder(o, req.who, db)), payUrl };
  });

  app.post('/api/orders/custom', { preHandler: isCustomer }, async (req) => {
    limit('place:' + req.who.sub, 10, 600e3);
    const o = svc.placeCustom(req.who.sub, req.body || {});
    svc.announce(o, null);
    return viewOrder(o, req.who, db);
  });

  app.post('/api/orders/:id/cancel', async (req) => {
    if (!req.who || !['customer', 'admin'].includes(req.who.role)) throw httpError(401, 'سجّل دخولك من جديد', 'auth');
    const o = getOrder(db, req.params.id);
    if (o && o.status === 'awaiting_payment') {
      /* قبل الإلغاء نسأل البوابة: يمكن العميل دفع فعلاً والتأكيد ما وصلنا للحين */
      const p = db.get("SELECT * FROM payments WHERE group_code = ? AND status = 'initiated' ORDER BY created_at DESC LIMIT 1", o.groupCode);
      if (p && (await reconcile(p).catch(() => 'initiated')) === 'paid') throw httpError(409, 'تم الدفع فعلاً ✅ وطلبك صار جديد ووصل للسائقين', 'already_paid');
    }
    return viewOrder(svc.cancel(req.params.id, req.who), req.who, db);
  });

  /* إكمال دفع متعثر: يرجع رابط صفحة الدفع نفسها لو لسا صالحة */
  app.get('/api/orders/:id/pay', { preHandler: isCustomer }, async (req) => {
    const o = getOrder(db, req.params.id);
    if (!o || o.customer.phone !== req.who.sub) throw httpError(404, 'الطلب غير موجود');
    if (o.status !== 'awaiting_payment') throw httpError(400, o.paymentStatus === 'paid' ? 'الطلب مدفوع' : 'الطلب ما عاد بانتظار الدفع');
    const p = db.get("SELECT * FROM payments WHERE group_code = ? AND status = 'initiated' ORDER BY created_at DESC LIMIT 1", o.groupCode);
    if (!p) throw httpError(400, 'انتهت صلاحية الدفع، اطلب من جديد');
    if ((await reconcile(p).catch(() => 'initiated')) !== 'initiated') throw httpError(409, 'تحدّثت حالة الدفع، حدّث الصفحة', 'changed');
    return { url: p.url };
  });

  /* ============ السائق ============ */
  app.post('/api/driver/login', async (req) => {
    const phone = normalizePhone(req.body && req.body.phone);
    const pin = arabicDigits(req.body && req.body.pin);
    limit('dlogin:' + req.ip, 20, 900e3);
    limit('dlogin:' + phone, 8, 900e3);
    const d = phone && db.get('SELECT * FROM drivers WHERE phone = ?', phone);
    if (!d || !d.active || !verifySecret(pin, d.pin_hash)) throw httpError(401, 'الجوال أو الرمز غير صحيح', 'bad_login');
    if (needsRehash(d.pin_hash)) db.run('UPDATE drivers SET pin_hash = ? WHERE id = ?', hashSecret(pin), d.id);
    return { token: issueToken({ role: 'driver', sub: d.id, v: d.token_version }, TTL.driver), driver: driverRow(d) };
  });
  app.get('/api/driver/me', { preHandler: isDriver }, async (req) => driverRow(req.driver));
  app.post('/api/driver/online', { preHandler: isDriver }, async (req) => {
    const on = !!(req.body && req.body.online);
    db.run('UPDATE drivers SET online = ? WHERE id = ?', on ? 1 : 0, req.driver.id);
    hub.admins({ type: 'drivers' });
    return driverRow(db.get('SELECT * FROM drivers WHERE id = ?', req.driver.id));
  });
  app.get('/api/driver/orders', { preHandler: isDriver }, async (req) => {
    const who = req.who;
    const avail = db.all("SELECT * FROM orders WHERE driver_id IS NULL AND status IN ('new','accepted') ORDER BY created_at").map(orderRow).filter(claimableOrder);
    const mine = db.all(`SELECT * FROM orders WHERE driver_id = ? AND status IN (${DRIVER_ACTIVE.map(() => '?').join(',')}) ORDER BY created_at`, who.sub, ...DRIVER_ACTIVE).map(orderRow);
    const done = db.all("SELECT * FROM orders WHERE driver_id = ? AND status = 'delivered' ORDER BY delivered_at DESC LIMIT 200", who.sub).map(orderRow);
    const unsettled = db.get("SELECT COALESCE(SUM(total),0) s FROM orders WHERE driver_id = ? AND status = 'delivered' AND settled = 0", who.sub).s;
    const v = (o) => viewOrder(o, who, db);
    return { available: avail.map(v), mine: mine.map(v), done: done.map(v), unsettled: round2(unsettled), doneCount: db.get("SELECT COUNT(*) n FROM orders WHERE driver_id = ? AND status = 'delivered'", who.sub).n };
  });
  app.post('/api/driver/orders/:id/claim', { preHandler: isDriver }, async (req) => {
    const d = req.driver;
    return viewOrder(svc.claim({ id: d.id, name: d.name, phone: d.phone, online: !!d.online }, req.params.id), req.who, db);
  });
  app.post('/api/driver/orders/:id/advance', { preHandler: isDriver }, async (req) =>
    viewOrder(svc.driverAdvance({ id: req.driver.id }, req.params.id, String(req.body && req.body.to)), req.who, db));

  /* بث موقع السائق أثناء التوصيل — يصل للعميل صاحب الطلب النشط فقط */
  app.post('/api/driver/location', { preHandler: isDriver }, async (req) => {
    const lat = Number(req.body && req.body.lat), lng = Number(req.body && req.body.lng);
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw httpError(400, 'موقع غير صحيح');
    const t = Date.now();
    db.run('UPDATE drivers SET lat = ?, lng = ?, loc_at = ? WHERE id = ?', lat, lng, t, req.driver.id);
    const active = db.all("SELECT id, customer_phone FROM orders WHERE driver_id = ? AND status IN ('picked','onway')", req.driver.id);
    for (const o of active) hub.customer(o.customer_phone, { type: 'loc', orderId: o.id, lat, lng, at: t });
    hub.admins({ type: 'loc', driverId: req.driver.id, lat, lng, at: t });
    return { ok: true, tracking: active.length > 0 };
  });

  /* ============ الإدارة ============ */
  app.post('/api/admin/login', async (req) => {
    limit('alogin:' + req.ip, 10, 900e3);
    limit('alogin', 30, 900e3);
    const pin = arabicDigits(req.body && req.body.pin);
    const a = adminState();
    if (!verifySecret(pin, a.pinHash)) throw httpError(401, 'الرمز غير صحيح', 'bad_login');
    if (needsRehash(a.pinHash)) db.kvSet('admin', { ...a, pinHash: hashSecret(pin) });
    return { token: issueToken({ role: 'admin', sub: 'admin', v: a.v }, TTL.admin) };
  });
  app.post('/api/admin/recover/verify', async (req) => {
    limit('arecover:' + req.ip, 5, 3600e3);
    const a = adminState();
    if (!a.recoveryHash) throw httpError(400, 'ما فيه رمز استرجاع معدّ مسبقاً. تواصل مع مطوّر المنصة لإعادة الضبط.', 'no_recovery');
    const phrase = String((req.body && req.body.phrase) || '').trim();
    if (!verifySecret(phrase, a.recoveryHash, 'hd:rc:')) throw httpError(401, 'رمز الاسترجاع غير صحيح', 'bad_recovery');
    return { token: issueToken({ role: 'recover', v: a.v }, TTL.recover) };
  });
  app.post('/api/admin/recover/reset', async (req) => {
    const t = readToken(req.body && req.body.token);
    const a = adminState();
    if (!t || t.role !== 'recover' || t.v !== a.v) throw httpError(401, 'انتهت صلاحية الاسترجاع، ابدأ من جديد');
    const pin = arabicDigits(req.body.pin);
    if (!/^\d{4,8}$/.test(pin)) throw httpError(400, 'الرمز الجديد من 4 إلى 8 أرقام');
    db.kvSet('admin', { ...a, pinHash: hashSecret(pin), v: a.v + 1 });
    return { ok: true };
  });

  function adminSettings() {
    const s = db.settings();
    return { alertAfterMin: 7, ...s, payments: { ...s.payments, online: onlinePay() }, hasRecovery: !!adminState().recoveryHash, legal: legalTexts(), smsReady: smsReady(), verifyModeActive: verifyMode() };
  }
  function driversWithStats() {
    const stats = new Map(db.all(`SELECT driver_id,
        SUM(status = 'delivered') done,
        SUM(CASE WHEN status = 'delivered' AND settled = 0 THEN total ELSE 0 END) cash,
        SUM(status IN ('assigned','picked','onway')) act
      FROM orders WHERE driver_id IS NOT NULL GROUP BY driver_id`).map((r) => [r.driver_id, r]));
    return db.all('SELECT * FROM drivers ORDER BY created_at').map((r) => {
      const s = stats.get(r.id) || {};
      return { ...driverRow(r, { withLocation: true }), doneCount: s.done || 0, cash: round2(s.cash || 0), activeCount: s.act || 0 };
    });
  }
  app.get('/api/admin/data', { preHandler: isAdmin }, async (req) => {
    const orders = db.all(`SELECT * FROM orders WHERE status IN ('new','accepted','assigned','picked','onway','awaiting_payment')
      OR created_at > ? ORDER BY created_at DESC LIMIT 1000`, Date.now() - 45 * 864e5).map(orderRow).map((o) => viewOrder(o, req.who, db));
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    return {
      orders,
      drivers: driversWithStats(),
      coupons: db.all('SELECT * FROM coupons ORDER BY created_at DESC').map(couponRow),
      stores: loadStores(db),
      settings: adminSettings(),
      otp: otpPending(),
      openTickets: db.get("SELECT COUNT(*) n FROM tickets WHERE status = 'open'").n,
      cashWithDrivers: round2(db.get("SELECT COALESCE(SUM(total),0) s FROM orders WHERE status = 'delivered' AND settled = 0").s),
    };
  });

  app.get('/api/admin/otp', { preHandler: isAdmin }, async () => otpPending());
  app.post('/api/admin/otp/:phone/sent', { preHandler: isAdmin }, async (req) => {
    db.run("UPDATE otp_codes SET wa_sent_at = ? WHERE phone = ? AND channel = 'whatsapp'", Date.now(), req.params.phone);
    return { ok: true };
  });

  app.post('/api/admin/orders/:id/assign', { preHandler: isAdmin }, async (req) => {
    const d = db.get('SELECT * FROM drivers WHERE id = ? AND active = 1', String(req.body && req.body.driverId));
    if (!d) throw httpError(400, 'اختر سائق');
    return viewOrder(svc.adminAssign(req.params.id, { id: d.id, name: d.name, phone: d.phone }), req.who, db);
  });
  app.post('/api/admin/orders/:id/deliver', { preHandler: isAdmin }, async (req) => viewOrder(svc.adminDeliver(req.params.id), req.who, db));
  app.post('/api/admin/orders/:id/price', { preHandler: isAdmin }, async (req) => viewOrder(svc.setCustomPrice(req.params.id, Number(req.body && req.body.subtotal)), req.who, db));

  /* المتاجر */
  const catalogChanged = () => hub.all({ type: 'catalog' });
  function cleanStore(b, existing) {
    const name = String(b.name ?? existing?.name ?? '').trim().slice(0, 80);
    const category = CAT[b.category] ? b.category : existing?.category || 'restaurants';
    return {
      name, category,
      emoji: String(b.emoji || existing?.emoji || CAT[category].emoji).slice(0, 8),
      color: TINTS.includes(b.color) ? b.color : existing?.color || TINTS[0],
      eta: Math.min(300, Math.max(5, Number(b.eta) || existing?.eta || 30)),
      hours: String(b.hours ?? existing?.hours ?? '').trim().slice(0, 80),
      phone: normalizePhone(b.phone) || String(b.phone ?? existing?.phone ?? '').replace(/[^\d+]/g, '').slice(0, 15),
      desc: String(b.desc ?? existing?.desc ?? '').trim().slice(0, 160),
      note: String(b.note ?? existing?.note ?? '').trim().slice(0, 300),
      open: b.open === undefined ? existing?.open !== false : !!b.open,
      openAt: b.openAt !== undefined ? (validTime(b.openAt) ? b.openAt : '') : existing?.openAt || '',
      closeAt: b.closeAt !== undefined ? (validTime(b.closeAt) ? b.closeAt : '') : existing?.closeAt || '',
      sort: Number(b.sort) || existing?.sort || (db.get('SELECT COALESCE(MAX(sort),0)+1 n FROM stores').n),
    };
  }
  function cleanProducts(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).filter((p) => String(p.name || '').trim()).slice(0, 1000).map((p) => {
      let id = String(p.id || '').slice(0, 40);
      if (!id || seen.has(id)) id = randomId('p', 6);
      seen.add(id);
      const o = {
        id, name: String(p.name).trim().slice(0, 120), unit: String(p.unit || '').trim().slice(0, 40), price: round2(Math.max(0, Number(p.price) || 0)),
        emoji: String(p.emoji || '📦').slice(0, 8), available: p.available !== false, sec: String(p.sec || '').trim().slice(0, 60),
      };
      if (typeof p.img === 'string' && /^\/files\/[\w-]+$/.test(p.img)) o.img = p.img;
      if (p.saleType === 'weight') {
        const units = UNIT_PRESETS.filter((u) => (p.units || []).some((x) => x && x.label === u.label));
        if (units.length) { o.saleType = 'weight'; o.units = units; o.unit = ''; }
      }
      return o;
    });
  }
  app.put('/api/admin/stores/:id', { preHandler: isAdmin }, async (req) => {
    const b = req.body || {};
    const isNew = req.params.id === 'new';
    const id = isNew ? randomId('s', 6) : req.params.id;
    const existing = isNew ? null : loadStore(db, id);
    if (!isNew && !existing) throw httpError(404, 'المتجر غير موجود');
    const s = cleanStore(b, existing);
    if (!s.name) throw httpError(400, 'اكتب اسم المتجر');
    saveStore(db, id, s, b.products !== undefined ? cleanProducts(b.products) : null);
    catalogChanged();
    return loadStore(db, id);
  });
  app.patch('/api/admin/stores/:id', { preHandler: isAdmin }, async (req) => {
    const existing = loadStore(db, req.params.id);
    if (!existing) throw httpError(404, 'المتجر غير موجود');
    const b = req.body || {};
    const s = cleanStore({ ...existing, ...(b.name !== undefined ? { name: b.name } : {}), ...(b.open !== undefined ? { open: b.open } : {}) }, existing);
    saveStore(db, existing.id, s, null);
    catalogChanged();
    return loadStore(db, existing.id);
  });
  app.delete('/api/admin/stores/:id', { preHandler: isAdmin }, async (req) => {
    db.tx(() => { db.run('DELETE FROM products WHERE store_id = ?', req.params.id); db.run('DELETE FROM stores WHERE id = ?', req.params.id); });
    catalogChanged();
    return { ok: true };
  });
  app.patch('/api/admin/stores/:sid/products/:pid', { preHandler: isAdmin }, async (req) => {
    const b = req.body || {};
    const p = db.get('SELECT * FROM products WHERE store_id = ? AND id = ?', req.params.sid, req.params.pid);
    if (!p) throw httpError(404, 'المنتج غير موجود');
    if (b.price !== undefined) db.run('UPDATE products SET price = ? WHERE store_id = ? AND id = ?', round2(Math.max(0, Number(b.price) || 0)), p.store_id, p.id);
    if (b.available !== undefined) db.run('UPDATE products SET available = ? WHERE store_id = ? AND id = ?', b.available ? 1 : 0, p.store_id, p.id);
    catalogChanged();
    return { ok: true };
  });

  /* السائقون */
  app.put('/api/admin/drivers/:id', { preHandler: isAdmin }, async (req) => {
    const b = req.body || {};
    const isNew = req.params.id === 'new';
    const cur = isNew ? null : db.get('SELECT * FROM drivers WHERE id = ?', req.params.id);
    if (!isNew && !cur) throw httpError(404, 'السائق غير موجود');
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw httpError(400, 'اكتب اسم السائق');
    const phone = normalizePhone(b.phone);
    if (!phone) throw httpError(400, 'جوال السائق غير صحيح (يستخدمه للدخول)');
    const clash = db.get('SELECT id FROM drivers WHERE phone = ? AND id != ?', phone, cur ? cur.id : '');
    if (clash) throw httpError(400, 'هذا الجوال مسجّل لسائق آخر');
    const pin = arabicDigits(b.pin || '');
    if ((isNew || pin) && !/^\d{4,6}$/.test(pin)) throw httpError(400, 'الرمز السري من 4 إلى 6 أرقام');
    const active = b.active !== false;
    if (isNew) {
      const id = randomId('d', 6);
      db.run('INSERT INTO drivers(id,name,phone,pin_hash,vehicle,active,online,created_at) VALUES(?,?,?,?,?,?,1,?)',
        id, name, phone, hashSecret(pin), String(b.vehicle || '').trim().slice(0, 80), active ? 1 : 0, Date.now());
    } else {
      /* تغيير الرمز أو إيقاف الحساب يسجّل خروج السائق من كل أجهزته */
      const bump = pin || (!active && cur.active) ? 1 : 0;
      db.run('UPDATE drivers SET name=?, phone=?, vehicle=?, active=?, pin_hash=?, token_version = token_version + ? WHERE id=?',
        name, phone, String(b.vehicle || '').trim().slice(0, 80), active ? 1 : 0, pin ? hashSecret(pin) : cur.pin_hash, bump, cur.id);
    }
    hub.admins({ type: 'drivers' });
    return { ok: true };
  });
  app.delete('/api/admin/drivers/:id', { preHandler: isAdmin }, async (req) => {
    const busy = db.get("SELECT 1 FROM orders WHERE driver_id = ? AND status IN ('assigned','picked','onway')", req.params.id);
    if (busy) throw httpError(400, 'السائق عنده طلبات نشطة، أعد تعيينها أو أوقف الحساب بدل الحذف');
    const cash = db.get("SELECT 1 FROM orders WHERE driver_id = ? AND status = 'delivered' AND settled = 0", req.params.id);
    if (cash) throw httpError(400, 'السائق عنده كاش غير مسوّى، سوِّ الحساب أولاً');
    db.run('DELETE FROM drivers WHERE id = ?', req.params.id);
    return { ok: true };
  });
  app.post('/api/admin/drivers/:id/settle', { preHandler: isAdmin }, async (req) =>
    ({ settled: svc.settleDriver(req.params.id, req.body && req.body.expected != null ? Number(req.body.expected) : null) }));
  app.post('/api/admin/orders/:id/refunded', { preHandler: isAdmin }, async (req) => viewOrder(svc.markRefunded(req.params.id), req.who, db));

  /* الكوبونات */
  app.put('/api/admin/coupons/:code', { preHandler: isAdmin }, async (req) => {
    const b = req.body || {};
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw httpError(400, 'الكود من 3 إلى 20 حرف/رقم إنجليزي، بدون مسافات');
    const kind = ['percent', 'fixed', 'free_delivery'].includes(b.kind) ? b.kind : 'percent';
    let value = kind === 'free_delivery' ? 0 : Math.max(0, Number(b.value) || 0);
    if (kind !== 'free_delivery' && !(value > 0)) throw httpError(400, 'اكتب قيمة الخصم');
    if (kind === 'percent') value = Math.min(100, value);
    const cur = getCoupon(db, code);
    if (b.isNew && cur) throw httpError(400, 'الكود موجود مسبقاً');
    const cats = (Array.isArray(b.categories) ? b.categories : []).filter((c) => CAT[c]);
    let exp = null;
    if (b.expiresAt) {
      exp = typeof b.expiresAt === 'number' ? b.expiresAt : new Date(String(b.expiresAt) + 'T23:59:59+03:00').getTime();
      if (!Number.isFinite(exp)) exp = null;
    }
    db.run(`INSERT INTO coupons(code,kind,value,note,min_order,max_uses,used_count,expires_at,categories,once_per_customer,active,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET kind=excluded.kind, value=excluded.value, note=excluded.note, min_order=excluded.min_order,
        max_uses=excluded.max_uses, expires_at=excluded.expires_at, categories=excluded.categories,
        once_per_customer=excluded.once_per_customer, active=excluded.active`,
      code, kind, value, String(b.note || '').trim().slice(0, 200), Math.max(0, Number(b.minOrder) || 0),
      b.maxUses ? Math.max(1, Math.floor(Number(b.maxUses))) : null, cur ? cur.usedCount : 0, exp, JSON.stringify(cats),
      b.oncePerCustomer === false ? 0 : 1, b.active === false ? 0 : 1, cur ? cur.createdAt : Date.now());
    catalogChanged();
    return getCoupon(db, code);
  });
  app.delete('/api/admin/coupons/:code', { preHandler: isAdmin }, async (req) => {
    db.run('DELETE FROM coupons WHERE code = ?', String(req.params.code).toUpperCase());
    catalogChanged();
    return { ok: true };
  });

  /* الإعدادات */
  app.put('/api/admin/settings', { preHandler: isAdmin }, async (req) => {
    const b = req.body || {};
    const cur = db.settings();
    const patch = {};
    if (b.deliveryFee !== undefined) patch.deliveryFee = round2(Math.max(0, Number(b.deliveryFee) || 0));
    if (b.minOrder !== undefined) patch.minOrder = round2(Math.max(0, Number(b.minOrder) || 0));
    if (b.districts !== undefined) patch.districts = [...new Set((Array.isArray(b.districts) ? b.districts : String(b.districts).split('\n')).map((x) => String(x).trim()).filter(Boolean))].slice(0, 200);
    if (b.announcement !== undefined) patch.announcement = String(b.announcement).trim().slice(0, 200);
    if (b.supportPhone !== undefined) patch.supportPhone = normalizePhone(b.supportPhone) || String(b.supportPhone).replace(/[^\d+]/g, '').slice(0, 15);
    if (b.bankName !== undefined) patch.bankName = String(b.bankName).trim().slice(0, 80);
    if (b.bankHolder !== undefined) patch.bankHolder = String(b.bankHolder).trim().slice(0, 80);
    if (b.bankIban !== undefined) patch.bankIban = String(b.bankIban).replace(/\s+/g, '').toUpperCase().slice(0, 34);
    if (b.bankOn !== undefined) patch.payments = { ...cur.payments, cash: true, bank: !!b.bankOn };
    if (b.loyaltyOn !== undefined) patch.loyaltyOn = !!b.loyaltyOn;
    if (b.loyaltyEvery !== undefined) patch.loyaltyEvery = Math.max(2, Math.floor(Number(b.loyaltyEvery) || 5));
    if (b.trialMode !== undefined) patch.trialMode = !!b.trialMode;
    if (b.verifyMode !== undefined) patch.verifyMode = b.verifyMode === 'whatsapp' ? 'whatsapp' : 'sms';
    if (b.alertAfterMin !== undefined) patch.alertAfterMin = Math.min(120, Math.max(0, Math.floor(Number(b.alertAfterMin) || 0)));
    for (const k of ['legalName', 'crNumber', 'vatNumber']) if (b[k] !== undefined) patch[k] = String(b[k]).trim().slice(0, 120);
    if (b.legal && typeof b.legal === 'object') {
      const cur = db.kvGet('legal', {});
      for (const k of ['terms', 'privacy', 'refund']) if (typeof b.legal[k] === 'string') cur[k] = b.legal[k].trim().slice(0, 20000) || LEGAL_DEFAULTS[k];
      db.kvSet('legal', cur);
    }
    db.saveSettings(patch);
    /* تغيير رمز الإدارة ورمز الاسترجاع منفصل: أي خطأ فيهم ما يوقف حفظ بقية الإعدادات */
    const warnings = [];
    let a = adminState();
    const pin = arabicDigits(b.newPin || '');
    if (pin) {
      if (!/^\d{4,8}$/.test(pin)) warnings.push('رمز الإدارة الجديد يجب أن يكون من 4 إلى 8 أرقام، فما تغيّر');
      else a = { ...a, pinHash: hashSecret(pin), v: a.v + 1 };
    }
    const rec = String(b.recovery || '').trim();
    if (rec) {
      if (rec.length < 6) warnings.push('رمز الاسترجاع لازم 6 أحرف على الأقل، فما تغيّر');
      else a = { ...a, recoveryHash: hashSecret(rec) };
    }
    db.kvSet('admin', a);
    hub.all({ type: 'catalog' });
    const out = { settings: adminSettings(), warnings };
    if (pin && !warnings.length) out.token = issueToken({ role: 'admin', sub: 'admin', v: a.v }, TTL.admin);
    return out;
  });

  /* جدول المنتجات والأسعار (Excel/CSV): تصدير، تعديل في Excel، ثم استيراد */
  const CSV_HEAD = ['store_id', 'اسم المتجر', 'product_id', 'القسم', 'اسم المنتج', 'الوحدة', 'السعر', 'متوفر (1/0)', 'بالوزن (1/0)'];
  app.get('/api/admin/products.csv', { preHandler: isAdmin }, async (req, reply) => {
    const rows = [];
    for (const st of loadStores(db)) {
      if (!st.products.length) rows.push([st.id, st.name, '', '', '', '', '', '', '']);
      for (const p of st.products) rows.push([st.id, st.name, p.id, p.sec, p.name, p.unit, p.price || '', p.available ? 1 : 0, p.saleType === 'weight' ? 1 : 0]);
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="alhadar-products.csv"');
    return toCsv(CSV_HEAD, rows);
  });
  app.post('/api/admin/products.csv', { preHandler: isAdmin }, async (req) => {
    const file = await req.file();
    if (!file) throw httpError(400, 'اختر الملف');
    const rows = parseCsv((await file.toBuffer()).toString('utf8'));
    if (rows.length < 2 || rows[0][0].replace(/^\uFEFF/, '').trim() !== 'store_id') throw httpError(400, 'الملف لازم يكون بنفس أعمدة الملف المصدَّر (أول عمود store_id)');
    const out = { storesRenamed: 0, updated: 0, added: 0, skipped: 0, errors: [] };
    const num = (v) => { const t = arabicDigits(v).replace(/[^\d.]/g, ''); return t === '' ? null : round2(Number(t)); };
    db.tx(() => {
      const renamed = new Set();
      rows.slice(1).forEach((r, i) => {
        const line = i + 2;
        const [sid, sname, pid, sec, name, unit, price, avail] = r.map((x) => String(x ?? '').trim());
        const store = db.get('SELECT * FROM stores WHERE id = ?', sid);
        if (!store) { out.errors.push(`سطر ${line}: المتجر "${sid}" غير موجود`); out.skipped++; return; }
        if (sname && sname !== store.name && !renamed.has(sid)) { db.run('UPDATE stores SET name = ?, updated_at = ? WHERE id = ?', sname.slice(0, 80), Date.now(), sid); renamed.add(sid); out.storesRenamed++; }
        if (!pid && !name) return;
        const pr = num(price);
        if (price && pr == null) { out.errors.push(`سطر ${line}: السعر "${price}" غير صحيح`); out.skipped++; return; }
        const av = avail === '' ? null : !['0', 'لا', 'no', 'false'].includes(avail.toLowerCase());
        if (pid) {
          const p = db.get('SELECT * FROM products WHERE store_id = ? AND id = ?', sid, pid);
          if (!p) { out.errors.push(`سطر ${line}: المنتج "${pid}" غير موجود في ${store.name || sid}`); out.skipped++; return; }
          db.run('UPDATE products SET name = ?, unit = ?, sec = ?, price = ?, available = ? WHERE store_id = ? AND id = ?',
            (name || p.name).slice(0, 120), p.sale_type === 'weight' ? '' : unit.slice(0, 40), sec.slice(0, 60), pr ?? p.price, av == null ? p.available : av ? 1 : 0, sid, pid);
          out.updated++;
        } else {
          const sort = db.get('SELECT COALESCE(MAX(sort),-1)+1 n FROM products WHERE store_id = ?', sid).n;
          insertProduct(db, sid, { id: randomId('p', 6), name: name.slice(0, 120), unit: unit.slice(0, 40), sec: sec.slice(0, 60), price: pr || 0, available: av !== false }, sort);
          out.added++;
        }
      });
    });
    catalogChanged();
    out.errors = out.errors.slice(0, 30);
    return out;
  });

  /* استيراد بيانات النسخة القديمة (ملف حزمة JSON واحد) */
  app.post('/api/admin/import', { preHandler: isAdmin }, async (req) => {
    const file = await req.file({ limits: { fileSize: 30 * 1024 * 1024 } });
    if (!file) throw httpError(400, 'اختر ملف البيانات');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw httpError(400, 'الملف كبير، الحد الأقصى 30 ميجا');
    let bundle;
    try { bundle = JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'الملف ليس بصيغة صحيحة'); }
    let log;
    try { log = importBundle(db, uploadsDir, bundle, { replace: req.query.replace === '1' }); }
    catch (e) { req.log.warn(e); throw httpError(400, e.message || 'تعذر الاستيراد'); }
    hub.all({ type: 'catalog' });
    hub.admins({ type: 'drivers' });
    return { log, adminChanged: log.some((l) => l.includes('رمز الإدارة منقول')) };
  });

  /* ============ المحادثة ============ */
  function chatAccess(req) {
    const o = getOrder(db, req.params.id);
    const w = req.who;
    if (!o || !w) throw httpError(404, 'الطلب غير موجود');
    const ok = w.role === 'admin' || (w.role === 'customer' && o.customer.phone === w.sub) || (w.role === 'driver' && o.driverId === w.sub);
    if (!ok) throw httpError(403, 'غير مسموح');
    return o;
  }
  app.get('/api/orders/:id/chat', async (req) => {
    chatAccess(req);
    return db.all('SELECT id, sender "from", text, created_at t FROM chat_messages WHERE order_id = ? ORDER BY id DESC LIMIT 200', req.params.id).reverse();
  });
  app.post('/api/orders/:id/chat', async (req) => {
    const o = chatAccess(req);
    const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
    if (!text) throw httpError(400, 'اكتب رسالتك');
    limit('chat:' + req.who.role + req.who.sub, 60, 60e3);
    const t = Date.now();
    const r = db.run('INSERT INTO chat_messages(order_id, sender, text, created_at) VALUES(?,?,?,?)', o.id, req.who.role, text, t);
    const msg = { id: Number(r.lastInsertRowid), from: req.who.role, text, t };
    const ev = { type: 'chat', orderId: o.id, msg };
    hub.customer(o.customer.phone, ev);
    if (o.driverId) hub.driver(o.driverId, ev);
    hub.admins(ev);
    const label = { customer: 'العميل', driver: 'السائق', admin: 'الإدارة' }[req.who.role];
    const pl = { title: 'رسالة من ' + label + ' — #' + o.code, body: text.slice(0, 120), tag: 'chat-' + o.id };
    if (req.who.role !== 'customer') push.customer(o.customer.phone, { ...pl, url: '/order/' + o.id + '?chat=1' });
    if (req.who.role !== 'driver' && o.driverId) push.driver(o.driverId, { ...pl, url: '/driver?chat=' + o.id });
    return msg;
  });

  /* ============ البث اللحظي والإشعارات ============ */
  app.post('/api/stream-ticket', async (req) => {
    if (!req.who) throw httpError(401, 'سجّل دخولك', 'auth');
    return { ticket: issueToken({ p: 'stream', role: req.who.role, sub: req.who.sub }, TTL.stream) };
  });
  app.get('/api/stream', async (req, reply) => {
    const t = readToken(req.query.t);
    const who = t && t.p === 'stream' ? { role: t.role, sub: t.sub } : { role: 'guest', sub: null };
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('retry: 3000\n\n');
    hub.add(reply, who);
    reply.raw.write(`data: ${JSON.stringify({ type: 'hello', role: who.role })}\n\n`);
  });
  app.post('/api/push/subscribe', async (req) => {
    if (!req.who) throw httpError(401, 'سجّل دخولك', 'auth');
    if (!push.subscribe(req.who.role, req.who.sub, req.body && req.body.sub)) throw httpError(400, 'اشتراك غير صالح');
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => { push.unsubscribe(String((req.body && req.body.endpoint) || '')); return { ok: true }; });

  /* ============ الملفات ============ */
  const MAGIC = [
    ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ['image/png', (b) => b.slice(0, 4).toString('hex') === '89504e47'],
    ['image/webp', (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP'],
    ['application/pdf', (b) => b.slice(0, 4).toString() === '%PDF'],
  ];
  app.post('/api/uploads', async (req) => {
    const kind = String(req.query.kind || '');
    if (!req.who) throw httpError(401, 'سجّل دخولك', 'auth');
    if (kind === 'product' && req.who.role !== 'admin') throw httpError(403, 'غير مسموح');
    if (['custom', 'receipt'].includes(kind) && req.who.role !== 'customer') throw httpError(403, 'غير مسموح');
    if (!['product', 'custom', 'receipt'].includes(kind)) throw httpError(400, 'نوع غير معروف');
    limit('up:' + req.who.sub, 40, 3600e3);
    const file = await req.file();
    if (!file) throw httpError(400, 'ما فيه ملف');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw httpError(400, 'الملف كبير، الحد الأقصى 10 ميجا');
    const m = MAGIC.find(([, test]) => buf.length > 12 && test(buf));
    if (!m || (m[0] === 'application/pdf' && kind !== 'receipt')) throw httpError(400, kind === 'receipt' ? 'اختر صورة أو ملف PDF' : 'اختر صورة (JPG أو PNG)');
    const id = randomId('f', 12).replace(/_/g, '-');
    fs.writeFileSync(path.join(uploadsDir, id), buf);
    db.run('INSERT INTO files(id, kind, mime, size, owner, created_at) VALUES(?,?,?,?,?,?)', id, kind, m[0], buf.length, req.who.role + ':' + req.who.sub, Date.now());
    return { id, url: kind === 'product' ? '/files/' + id : signedFileUrl(id), type: m[0] };
  });
  app.get('/files/:id', async (req, reply) => {
    const f = db.get('SELECT * FROM files WHERE id = ?', req.params.id);
    if (!f) throw httpError(404, 'غير موجود');
    if (f.kind !== 'product') {
      const t = readToken(req.query.t);
      if (!t || t.p !== 'file' || t.f !== f.id) throw httpError(403, 'الرابط منتهي، حدّث الصفحة');
    }
    reply.header('Content-Type', f.mime);
    reply.header('Cache-Control', f.kind === 'product' ? 'public, max-age=31536000, immutable' : 'private, max-age=3600');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; plugin-types application/pdf");
    return reply.send(fs.createReadStream(path.join(uploadsDir, f.id)));
  });

  /* ============ الدفع الإلكتروني ============ */
  async function reconcile(p) {
    if (p.status !== 'initiated') return p.status;
    /* ملاحظة: الدفع المنتهي يُعاد فحصه من الـ webhook فقط، فلو دفع العميل متأخر نسجّله كمستحق للاسترجاع */
    const r = await fetchPaymentStatus(p);
    if (r.status === 'paid') {
      if (Math.abs((r.amount ?? p.amount) - p.amount) > 0.01) { app.log.error({ p }, 'payment amount mismatch'); return 'initiated'; }
      db.run("UPDATE payments SET status = 'paid', updated_at = ? WHERE id = ? AND status != 'paid'", Date.now(), p.id);
      if (!svc.markGroupPaid(p.group_code)) svc.markLatePaid(p.group_code);
      return 'paid';
    }
    if (r.status === 'failed') {
      db.run("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'initiated'", Date.now(), p.id);
      svc.markGroupFailed(p.group_code);
      return 'failed';
    }
    return 'initiated';
  }
  app.post('/api/payments/webhook', async (req) => {
    /* لا نثق بمحتوى الـ webhook: نأخذ المعرّف فقط ونسأل البوابة عن الحالة الحقيقية */
    const b = req.body || {};
    const d = b.data || b;
    const ref = d.invoice_id || (d.id && String(d.id)) || '';
    const pid = (d.metadata && d.metadata.payment_id) || '';
    const p = db.get('SELECT * FROM payments WHERE provider_ref = ? OR id = ?', ref, pid);
    if (p) await reconcile(p.status === 'expired' || p.status === 'failed' ? { ...p, status: 'initiated' } : p);
    return { ok: true };
  });
  app.get('/api/payments/return/:pid', async (req, reply) => {
    const p = db.get('SELECT * FROM payments WHERE id = ?', req.params.pid);
    if (!p) return reply.redirect('/');
    await reconcile(p).catch((e) => req.log.error(e));
    const o = db.get('SELECT id FROM orders WHERE group_code = ? ORDER BY code LIMIT 1', p.group_code);
    const n = db.get('SELECT COUNT(*) n FROM orders WHERE group_code = ?', p.group_code).n;
    return reply.redirect(n > 1 || !o ? '/orders' : '/order/' + o.id);
  });
  /* بوابة تجريبية للتطوير فقط */
  if (!config.isProd) {
    app.get('/api/payments/fake/:pid', async (req, reply) => {
      const p = db.get('SELECT * FROM payments WHERE id = ?', req.params.pid);
      if (!p) throw httpError(404, 'غير موجود');
      reply.type('text/html').send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><body dir=rtl style="font-family:sans-serif;padding:24px">
        <h2>بوابة دفع تجريبية</h2><p>المبلغ: ${p.amount} ر.س</p>
        <form method=post action="/api/payments/fake/${p.id}"><button name=r value=paid id=fakePay>ادفع (نجاح)</button> <button name=r value=failed id=fakeFail>فشل الدفع</button></form>`);
    });
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))));
    app.post('/api/payments/fake/:pid', async (req, reply) => {
      const p = db.get('SELECT * FROM payments WHERE id = ?', req.params.pid);
      if (!p) throw httpError(404, 'غير موجود');
      await reconcile({ ...p, _fakeResult: req.body && req.body.r === 'paid' ? 'paid' : 'failed' });
      return reply.redirect('/api/payments/return/' + p.id);
    });
  }
  /* تنبيه: طلب ما استلمه سائق، أو طلب خاص ما تسعّر، خلال المدة المحددة بالإعدادات */
  function alertStale() {
    const mins = Number(db.settings().alertAfterMin ?? 7);
    if (!(mins > 0)) return;
    const cutoff = Date.now() - mins * 60e3;
    const rows = db.all(`SELECT * FROM orders WHERE status IN ('new','accepted') AND driver_id IS NULL AND updated_at < ?
      AND json_extract(data, '$.staleAlertAt') IS NULL`, cutoff).map(orderRow);
    for (const o of rows) {
      db.run("UPDATE orders SET data = json_set(data, '$.staleAlertAt', ?) WHERE id = ?", Date.now(), o.id);
      const pending = o.isCustom && o.priceStatus === 'pending';
      const text = pending ? `⏰ طلب خاص #${o.code} ينتظر تسعيرك من ${mins} دقائق` : `⏰ الطلب #${o.code} بدون سائق من ${mins} دقائق`;
      hub.admins({ type: 'notify', text, sound: true });
      hub.admins({ type: 'order', id: o.id });
      push.admins({ title: pending ? 'طلب ينتظر التسعير' : 'طلب بدون سائق', body: text.replace('⏰ ', ''), url: '/admin', tag: 'stale-' + o.id });
      if (!pending) {
        hub.drivers({ type: 'notify', text: `🔔 الطلب #${o.code} لسا ينتظر سائق`, sound: true, onlineOnly: true });
        push.onlineDrivers({ title: 'طلب ينتظر سائق', body: `#${o.code} — ${o.storeName} ← ${o.customer.district}`, url: '/driver', tag: 'avail-' + o.id });
      }
    }
  }
  app.decorate('alertStale', alertStale);
  const staleTimer = setInterval(() => { try { alertStale(); } catch (e) { app.log.warn(e); } }, 60e3);
  staleTimer.unref();
  app.addHook('onClose', async () => clearInterval(staleTimer));

  /* الطلبات المعلقة بالدفع أكثر من 30 دقيقة: نتحقق منها ثم نلغيها إن لم تُدفع */
  const sweep = setInterval(async () => {
    for (const p of db.all("SELECT * FROM payments WHERE status = 'initiated' AND created_at < ?", Date.now() - 30 * 60e3)) {
      try {
        if ((await reconcile(p)) === 'initiated') {
          db.run("UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ?", Date.now(), p.id);
          svc.markGroupFailed(p.group_code);
        }
      } catch (e) { app.log.warn(e); }
    }
  }, 5 * 60e3);
  sweep.unref();
  app.addHook('onClose', async () => clearInterval(sweep));

  /* ============ الواجهة (PWA) ============ */
  await app.register(fastifyStatic, {
    root: path.join(config.root, 'public'),
    setHeaders(res, p) {
      if (p.endsWith('sw.js') || p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  });
  await app.register(fastifyStatic, { root: path.join(config.root, 'node_modules/leaflet/dist'), prefix: '/vendor/leaflet/', decorateReply: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/files/')) return reply.code(404).send({ error: 'غير موجود' });
    return reply.sendFile('index.html');
  });

  return app;
}

export { CATS };
