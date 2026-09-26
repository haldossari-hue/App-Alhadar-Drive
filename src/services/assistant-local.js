/* المساعد المجاني: يشتغل داخل التطبيق بدون أي خدمة خارجية أو تكلفة.
   يفهم الأسئلة الشائعة بالكلمات المفتاحية، ويجاوب من بيانات التطبيق مباشرة (ما يولّد ولا يخمّن)،
   ويرفع البلاغات بخطوات واضحة مع تأكيد العميل. */
import crypto from 'node:crypto';
import {
  CAT, ST, storeOpenNow, hoursLabel, withDisplayNames, normAr, normalizePhone, arabicDigits, round2,
} from '../../public/shared/constants.js';
import { loadStores, orderRow } from '../repo.js';
import { randomId, hashSecret, verifySecret } from '../auth.js';

const MENU = ['رسوم التوصيل', 'الأحياء المشمولة', 'طرق الدفع', 'المتاجر المفتوحة الحين', 'وين طلبي؟', 'رفع شكوى أو ملاحظة'];
const CATS = { complaint: 'شكوى', report: 'بلاغ عن مشكلة', suggestion: 'اقتراح أو ملاحظة', inquiry: 'استفسار' };
const MAX_LOG = 200;

/* كلمات ما تفيد البحث (تُحذف قبل البحث في المتاجر والمنتجات) */
const STOP = new Set(['عندكم', 'عندك', 'فيه', 'في', 'ابي', 'ابغي', 'ابغا', 'ابغى', 'ودي', 'كم', 'سعر', 'اسعار', 'بكم', 'وين', 'الاقي', 'القى', 'احصل', 'هل', 'يوجد', 'متوفر', 'موجود', 'من', 'على', 'عن', 'لو', 'سمحت', 'تكفى', 'الله', 'يعطيك', 'العافيه', 'اطلب', 'طلب', 'ممكن', 'اريد', 'حق', 'مال', 'و', 'او', 'ال', 'شي', 'شيء', 'ايش', 'وش', 'متى', 'مين', 'افضل', 'احسن', 'فيها', 'يبيع', 'تبيع', 'يبيعون', 'محل', 'المحل', 'مطعم', 'متجر', 'المتجر',
  'ما', 'لا', 'ليش', 'لي', 'يا', 'انا', 'انت', 'هذا', 'هذي', 'ذا', 'كيف', 'ليه', 'بس', 'اذا', 'عشان', 'علشان', 'رقم', 'الحين', 'الان', 'اليوم', 'زين', 'طيب']);
/* كلمات منتجات من حرفين تستاهل البحث */
for (const w of [...STOP]) STOP.add(normAr(w));
const SHORT_OK = new Set(['رز', 'بن']);

/* الكلمات القصيرة (3 أحرف أو أقل) تُطابق ككلمة كاملة، عشان "حي" ما تطابق "الحين" أو "صحي" */
/* مطابقة من بداية الكلمة (مو من وسطها): "متي" ما تطابق "بسمتي"، و"صيدليه" تطابق "صيدليات" */
const stemQ = (w) => (w.length > 4 ? w.replace(/(ات|ه)$/, '') : w);
const textWords = (txt) => normAr(txt).split(' ').map((x) => x.replace(/^(وال|بال|لل|ال)/, ''));
const wordHit = (q, txt) => { const st = stemQ(q); return textWords(txt).some((x) => x.startsWith(st)); };

/* كلمات تدل على تصنيف */
const CAT_WORDS = {
  restaurants: ['مطعم', 'مطاعم', 'غداء', 'عشاء', 'فطور', 'وجبه', 'وجبات'],
  grocery: ['بقاله', 'بقالات', 'تموينات', 'سوبرماركت', 'ماركت'],
  meat: ['ملحمه', 'لحوم', 'سمك', 'اسماك', 'جزار'],
  bakery: ['مخبز', 'مخابز', 'فرن'],
  pharmacy: ['صيدليه', 'صيدليات', 'دواء', 'ادويه'],
  gas: ['غاز', 'اسطوانه', 'دبه غاز', 'وايت'],
  plumbing: ['سباك', 'سباكه', 'تسريب مويه', 'مواسير'],
  electric: ['كهربائي', 'كهربا', 'كهرباء', 'فني كهرباء'],
  cafe: ['كافيه', 'كوفي', 'حلويات', 'حلا'],
  home: ['ادوات منزليه', 'منظفات'],
};
for (const k of Object.keys(CAT_WORDS)) CAT_WORDS[k] = CAT_WORDS[k].map(normAr);
function detectCats(t) {
  const ws = t.split(' ').map((x) => x.replace(/^(وال|بال|لل|ال)/, ''));
  return Object.entries(CAT_WORDS).filter(([, kws]) => kws.some((k) => (k.includes(' ') ? t.includes(k) : ws.includes(k)))).map(([id]) => id);
}

const has = (t, ...kws) => kws.some((w) => (w.length <= 3 && !w.includes(' ')
  ? t.split(' ').some((x) => x === w || x === 'ال' + w || x === 'و' + w || x === 'وال' + w || x === 'ب' + w || x === 'بال' + w)
  : t.includes(w)));

export function createLocalAssistant({ db, createTicket, legalTexts }) {
  const settings = () => db.settings();
  const catalog = () => (settings().trialMode !== false ? withDisplayNames(loadStores(db)) : loadStores(db, { namedOnly: true }));
  const priceText = (p) => (Number(p.price) > 0 ? `${round2(p.price)} ر.س${p.saleType === 'weight' ? ' للكيلو' : ''}` : 'السعر قريباً');

  /* ============ المحادثات (نفس جدول المساعد الذكي بشكل مختلف) ============ */
  function openThread(threadId, token, phone) {
    if (threadId && token) {
      const t = db.get('SELECT * FROM assistant_threads WHERE id = ?', String(threadId));
      if (t && verifySecret(String(token), t.token_hash) && (!t.customer_phone || t.customer_phone === phone)) {
        const st = JSON.parse(t.messages);
        if (st && st.v === 'local') return { thread: t, state: st, token: null };
      }
    }
    const id = randomId('c', 10);
    const tok = crypto.randomBytes(18).toString('base64url');
    const now = Date.now();
    const state = { v: 'local', log: [], flow: null };
    db.run('INSERT INTO assistant_threads(id, token_hash, customer_phone, messages, created_at, updated_at) VALUES(?,?,?,?,?,?)', id, hashSecret(tok), phone || null, JSON.stringify(state), now, now);
    return { thread: db.get('SELECT * FROM assistant_threads WHERE id = ?', id), state, token: tok };
  }

  /* ============ الإجابات ============ */
  function feeAnswer() {
    const st = settings();
    const min = Number(st.minOrder) > 0 ? `\nالحد الأدنى للطلب ${round2(st.minOrder)} ر.س لكل متجر.` : '';
    const free = Number(st.deliveryFee) > 0 ? `رسوم التوصيل ${round2(st.deliveryFee)} ر.س لكل طلب.` : 'التوصيل مجاني حالياً.';
    return `${free}${min}\nوإذا طلبت من متجرين بنفس الوقت، كل متجر يصير طلب مستقل برسومه.`;
  }
  function districtsAnswer(t, raw) {
    const ds = settings().districts || [];
    if (!ds.length) return 'التوصيل غير متاح حالياً، وبنعلن الأحياء قريباً إن شاء الله.';
    const core = (d) => normAr(d).replace(/^حي /, '').replace(/^ال/, '');
    const named = ds.find((d) => core(d).length > 2 && t.split(' ').some((w) => w.replace(/^(وال|بال|لل|ال|ل)/, '') === core(d)));
    if (named) return `إيه نعم، نوصّل لـ ${named} ✅`;
    /* نعرض اسم الحي كما كتبه العميل (مو بصيغة البحث الموحّدة) */
    const asked = String(raw || '').match(/حي\s+([^\s؟?،,.!]+)/);
    if (asked && !/المشمول|الي|اللي/.test(normAr(asked[1]))) return `حي ${asked[1]} مو ضمن الأحياء المشمولة حالياً.\nالأحياء اللي نوصّل لها:\n${ds.map((d) => '• ' + d).join('\n')}`;
    return `نوصّل داخل مدينة الهدار لهذي الأحياء:\n${ds.map((d) => '• ' + d).join('\n')}`;
  }
  function paymentAnswer(onlinePay) {
    const st = settings();
    const m = ['• كاش عند الاستلام'];
    if (st.payments && st.payments.bank !== false) m.push('• حوالة بنكية (ترفع صورة إثبات التحويل مع الطلب)');
    if (onlinePay) m.push('• مدى / Apple Pay / STC Pay / بطاقات');
    else m.push('• الدفع الإلكتروني (مدى وApple Pay وغيرها) قريباً');
    return `طرق الدفع المتاحة:\n${m.join('\n')}`;
  }
  function loyaltyAnswer(phone) {
    const st = settings();
    if (st.loyaltyOn === false) return 'برنامج الولاء متوقف حالياً.';
    let mine = '';
    if (phone) {
      const c = db.get('SELECT delivered_count, free_deliveries FROM customers WHERE phone = ?', phone);
      if (c) mine = c.free_deliveries > 0 ? `\nعندك الحين ${c.free_deliveries} توصيلة مجانية جاهزة 🎁 تختارها وقت الطلب.` : `\nباقي لك ${st.loyaltyEvery - (c.delivered_count % st.loyaltyEvery)} طلبات وتاخذ توصيلة مجانية.`;
    }
    return `كل ${st.loyaltyEvery} طلبات مكتملة تاخذ توصيلة مجانية تلقائياً 🎁 بدون كود.${mine}`;
  }
  function openNowAnswer() {
    const all = catalog();
    const open = all.filter((s) => storeOpenNow(s));
    if (!open.length) return 'ما فيه متاجر مفتوحة الحين.';
    return `المتاجر المفتوحة الحين (${open.length}):\n${open.slice(0, 12).map((s) => `• ${s.name}${hoursLabel(s) ? ` (${hoursLabel(s)})` : ''}`).join('\n')}${open.length > 12 ? `\nوغيرها ${open.length - 12}، تشوفهم في الرئيسية.` : ''}`;
  }
  function storeStatus(s) {
    const open = storeOpenNow(s);
    const hrs = hoursLabel(s);
    return `${s.name}: ${open ? 'مفتوح الحين ✅' : 'مغلق الحين'}${hrs ? `\nأوقات العمل: ${hrs}` : ''}\nوقت التوصيل التقريبي ${Number(s.eta) || 30} دقيقة.`;
  }
  function ordersAnswer(phone) {
    if (!phone) {
      return settings().trialMode !== false
        ? 'طلباتك تلقاها في "طلباتي" أسفل الشاشة.\nوللعلم: التطبيق في مرحلة التجربة، والطلبات تجريبية وما تتوصّل فعلياً.'
        : 'عشان أشوف طلباتك سجّل دخولك برقم جوالك من "دخول"، أو افتح "طلباتي".';
    }
    const rows = db.all('SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 3', phone).map(orderRow);
    if (!rows.length) return 'ما عندك طلبات للحين.';
    return `آخر طلباتك:\n${rows.map((o) => `• #${o.code} من ${o.storeName}: ${(ST[o.status] || {}).t || o.status}${o.driverName && ['assigned', 'picked', 'onway'].includes(o.status) ? ` (السائق ${o.driverName})` : ''}${o.isCustom && o.priceStatus === 'pending' ? ' — بانتظار التسعير' : ''}${o.refundDue ? ` — مستحق لك ${o.refundDue} ر.س` : ''}`).join('\n')}\nوالتفاصيل الكاملة في "طلباتي".`;
  }
  function cancelAnswer() {
    return 'تقدر تلغي الطلب بنفسك من صفحة الطلب ما دامت حالته "طلب جديد".\nبعد ما يستلمه السائق، الإلغاء يكون بالتواصل مع الإدارة. وإذا كنت دافع مسبقاً يرجع لك المبلغ.';
  }
  function refundAnswer() {
    const txt = String(legalTexts().refund || '').split('\n').filter((l) => /^\s*-/.test(l)).slice(0, 4).map((l) => '• ' + l.replace(/^\s*-\s*/, '')).join('\n');
    return `سياسة الاسترجاع باختصار:\n${txt || 'تواصل مع الإدارة للتفاصيل.'}\nوإذا عندك مشكلة في طلب معيّن، أقدر أرفعها للإدارة.`;
  }
  function contactAnswer() {
    const sp = settings().supportPhone;
    return `${sp ? `رقم الإدارة: ${sp} (اتصال أو واتساب).\n` : ''}وإذا تبي، أرفع رسالتك للإدارة الحين وهم يتواصلون معك.`;
  }

  /* بحث في المتاجر والمنتجات بالكلمات المهمة من السؤال */
  function searchAnswer(t) {
    const words = t.split(' ').map((w) => w.replace(/^(وال|بال|لل|ال)/, '')).filter((w) => (w.length > 2 || SHORT_OK.has(w)) && !/^\d+$/.test(w) && !STOP.has(w) && !STOP.has('ال' + w));
    if (!words.length) return null;
    const all = catalog();
    const score = (txt) => words.reduce((a, w) => a + (wordHit(w, txt) ? 1 : 0), 0);
    /* اسم متجر مذكور بالكامل = سؤال عن المتجر نفسه */
    const exact = all.find((s) => !s.unnamed && normAr(s.name).length > 2 && t.includes(normAr(s.name)));
    if (exact) {
      const priced = exact.products.filter((p) => Number(p.price) > 0 && p.available !== false).slice(0, 5);
      return { text: `${storeStatus(exact)}${priced.length ? `\nمن منتجاته:\n${priced.map((p) => `• ${p.name}: ${priceText(p)}`).join('\n')}` : ''}`, store: exact.id };
    }
    const cats = detectCats(t);
    const stores = all.map((s) => ({ s, sc: score(s.name) * 2 + score((CAT[s.category] || {}).name) * 2 + score(s.desc) + (cats.includes(s.category) ? 3 : 0) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc || storeOpenNow(b.s) - storeOpenNow(a.s)).slice(0, 5);
    const prods = [];
    for (const s of all) for (const p of s.products) {
      const sc = score(p.name) * 2 + score(p.sec);
      if (sc > 0) prods.push({ s, p, sc: sc + (Number(p.price) > 0 ? 0.5 : 0) + (storeOpenNow(s) ? 0.3 : 0) });
    }
    prods.sort((a, b) => b.sc - a.sc);
    if (!stores.length && !prods.length) return null;
    const lines = [];
    /* سؤال عن تصنيف (غاز، صيدلية، سباك...): المتاجر أولاً */
    if (cats.length && stores.length) {
      lines.push('المتاجر المتوفرة:');
      for (const { s } of stores) lines.push(`• ${s.name}: ${storeOpenNow(s) ? 'مفتوح' : 'مغلق'}${hoursLabel(s) ? ` (${hoursLabel(s)})` : ''}`);
      const rel = prods.filter((x) => cats.includes(x.s.category)).slice(0, 4);
      if (rel.length) { lines.push('\nمن خدماتهم ومنتجاتهم:'); for (const { s, p } of rel) lines.push(`• ${p.name} (${s.name}): ${p.available === false ? 'غير متوفر' : priceText(p)}`); }
      return { text: lines.join('\n') };
    }
    if (prods.length) {
      lines.push(`لقيت ${prods.length > 6 ? 'منتجات كثيرة، هذي أقربها' : 'هذي المنتجات'}:`);
      for (const { s, p } of prods.slice(0, 6)) lines.push(`• ${p.name} (${s.name}): ${p.available === false ? 'غير متوفر' : priceText(p)}${storeOpenNow(s) ? '' : ' — المتجر مغلق الحين'}`);
    }
    if (stores.length && (!prods.length || stores[0].sc >= 2)) {
      lines.push(prods.length ? '\nومتاجر ممكن تفيدك:' : 'لقيت هذي المتاجر:');
      for (const { s } of stores) lines.push(`• ${s.name}: ${storeOpenNow(s) ? 'مفتوح' : 'مغلق'}${hoursLabel(s) ? ` (${hoursLabel(s)})` : ''}`);
    }
    return { text: lines.join('\n') };
  }

  /* ============ خطوات رفع البلاغ ============ */
  /* صريح: العميل طلب رفع بلاغ بالاسم */
  function explicitCategory(t) {
    if (has(t, 'اقتراح', 'اقترح', 'ملاحظه', 'ملاحظات')) return 'suggestion';
    if (has(t, 'شكوي', 'اشتكي', 'شكوه')) return 'complaint';
    if (has(t, 'بلاغ', 'ابلغ')) return 'report';
    return null;
  }
  /* ضمني: وصف مشكلة بدون ما يطلب بلاغ */
  function implicitCategory(t) {
    if (has(t, 'زعلان', 'سيء', 'سيئ', 'متاخر', 'تاخر', 'بارد', 'تعامل')) return 'complaint';
    if (has(t, 'مشكله', 'خطا', 'غلط', 'ناقص', 'خربان', 'ما وصل', 'مو شغال', 'تالف')) return 'report';
    return null;
  }
  const detectCategory = (t) => explicitCategory(t) || implicitCategory(t);
  function flowStep(flow, raw, t, phone) {
    const out = (text, quick = []) => ({ text, quick });
    if (has(t, 'الغاء البلاغ', 'لا تكمل', 'الغ البلاغ', 'خلاص الغ') || t === 'الغاء' || t === '❌ الغاء') return { done: true, ...out('تم إلغاء البلاغ. إذا احتجت شي ثاني أنا حاضر.', MENU) };
    if (flow.step === 'cat') {
      const pick = Object.entries(CATS).find(([, v]) => t.includes(normAr(v).split(' ')[0])) || [detectCategory(t)];
      if (!pick[0]) return out('اختر نوع البلاغ:', Object.values(CATS));
      flow.category = pick[0]; flow.step = 'details';
      return out(`تمام، ${CATS[flow.category]}. اكتب التفاصيل: وش صار بالضبط؟`);
    }
    if (flow.step === 'details') {
      if (raw.length < 6) return out('اكتب التفاصيل بشكل أوضح شوي عشان الإدارة تقدر تساعدك.');
      flow.details = raw.slice(0, 2000);
      /* بعد التعديل نرجع للملخص مباشرة بدون إعادة الأسئلة */
      if (flow.editing) { flow.editing = false; flow.step = 'confirm'; flow.shown = false; return flowStep(flow, '', '', phone); }
      flow.step = 'order';
      return out('إذا البلاغ له علاقة بطلب، اكتب رقم الطلب. وإذا لا، اضغط الزر.', ['ما له علاقة بطلب']);
    }
    if (flow.step === 'order') {
      const num = arabicDigits(raw).match(/\d{5,8}[A-Za-z]?/);
      flow.orderCode = num ? num[0] : '';
      if (!num && !has(t, 'ما له', 'لا', 'بدون', 'ماله')) return out('ما لقيت رقم طلب في رسالتك. اكتب الرقم (مثل 482913)، أو اضغط الزر.', ['ما له علاقة بطلب']);
      flow.step = phone ? 'confirm' : 'contact';
      if (!phone) return out('اكتب اسمك ورقم جوالك عشان الإدارة تتواصل معك (مثال: محمد 05xxxxxxxx).');
    }
    if (flow.step === 'contact') {
      const ph = normalizePhone((arabicDigits(raw).match(/(?:\+?966|0)?5\d{8}/) || [''])[0]);
      if (!ph) return out('ما لقيت رقم جوال صحيح. اكتبه بهذا الشكل: 05xxxxxxxx');
      flow.phone = ph; flow.name = raw.replace(/[+\d٠-٩\s-]{9,}/g, ' ').replace(/[،,]/g, ' ').trim().slice(0, 60);
      flow.step = 'confirm';
    }
    if (flow.step === 'confirm') {
      if (flow.shown) {
        if (has(t, 'ارفع', 'نعم', 'اي', 'ايه', 'تمام', 'اكيد', 'ok', 'موافق', '✅')) {
          const tk = createTicket({ category: flow.category, subject: flow.details.slice(0, 70), details: flow.details, orderCode: flow.orderCode, name: flow.name, phone: phone || flow.phone, customerPhone: phone, source: 'assistant', threadId: flow.threadId });
          return { done: true, ticket: tk, text: `✅ تم رفع ${CATS[flow.category]} للإدارة برقم #${tk.number}.\nبيراجعونه ويتواصلون معك في أقرب وقت.`, quick: [] };
        }
        if (has(t, 'عدل', 'تعديل', '✏️')) { flow.step = 'details'; flow.shown = false; flow.editing = true; return out('اكتب التفاصيل من جديد:'); }
        return out('اختر: أرفع البلاغ، أو أعدّله، أو ألغيه.', ['✅ ارفعه للإدارة', '✏️ تعديل', '❌ إلغاء']);
      }
      flow.shown = true;
      return out(`هذا ملخص البلاغ:\n• النوع: ${CATS[flow.category]}\n• التفاصيل: ${flow.details}${flow.orderCode ? `\n• رقم الطلب: ${flow.orderCode}` : ''}${!phone ? `\n• التواصل: ${flow.name ? flow.name + ' — ' : ''}${flow.phone}` : ''}\n\nأرفعه للإدارة؟`, ['✅ ارفعه للإدارة', '✏️ تعديل', '❌ إلغاء']);
    }
    return { done: true, ...out('صار خلل بسيط، ابدأ البلاغ من جديد.', MENU) };
  }

  /* ============ فهم الرسالة ============ */
  function respond(state, raw, phone, threadId, onlinePay) {
    const t = normAr(raw.replace(/[؟?!.,،]/g, ' '));
    const out = (text, quick = MENU) => ({ text, quick });
    if (state.flow) {
      state.flow.threadId = threadId;
      const r = flowStep(state.flow, raw, t, phone);
      if (r.done) state.flow = null;
      return r;
    }
    if (has(t, '911', 'حادث', 'حريق', 'تسرب', 'تسريب غاز', 'اصابه', 'طوارئ')) return out('⚠️ إذا فيه خطر على السلامة اتصل على الطوارئ 911 فوراً.\nوبعدها إذا احتجت، أرفع بلاغ للإدارة.', ['رفع شكوى أو ملاحظة']);
    /* رقم يشبه رقم بطاقة، أو رمز/كلمة مرور مع أرقام: ننبه العميل وما نعالج الرسالة */
    const digits = arabicDigits(raw).replace(/[\s-]/g, '');
    if (/\d{12,19}/.test(digits) || (/(بطاق|فيزا|ماستر|رمز التحقق|كود التحقق|الرمز السري|كلمه المرور|الباسورد|otp|cvv)/.test(t) && /\d{3,}/.test(digits))) return out('⚠️ لا تشارك أرقام البطاقات أو رموز التحقق أو كلمات المرور مع أحد، حتى معي 🙏\nولو عندك مشكلة في الدفع، أرفعها للإدارة بدون ما تكتب هذي البيانات.', ['رفع شكوى أو ملاحظة']);
    if (t === normAr('رفع شكوى أو ملاحظة')) { state.flow = { step: 'cat', threadId }; return out('وش نوع البلاغ؟', Object.values(CATS)); }
    /* الإلغاء والاسترجاع قبل "وين طلبي" (لأن "كيف ألغي طلبي" فيها كلمة "طلبي") */
    if (has(t, 'الغي', 'الغاء', 'كنسل', 'اكنسل')) return out(cancelAnswer());
    if (has(t, 'استرجاع', 'استرداد', 'ترجيع', 'ارجاع', 'فلوسي', 'تعويض', 'استرجع')) return out(refundAnswer(), ['رفع شكوى أو ملاحظة']);
    /* كم ياخذ التوصيل: للمسجّل اللي عنده طلب نشط نعرض طلبه، وإلا المدة التقريبية */
    if (has(t, 'كم يوصل', 'كم ياخذ', 'مده التوصيل', 'وقت التوصيل', 'متي يوصل', 'كم دقيقه', 'بسرعه')) {
      const active = phone && db.get("SELECT 1 FROM orders WHERE customer_phone = ? AND status IN ('new','accepted','assigned','picked','onway')", phone);
      if (active) return out(ordersAnswer(phone), ['رفع شكوى أو ملاحظة']);
      const etas = catalog().map((x) => Number(x.eta) || 30);
      return out(`وقت التوصيل التقريبي يختلف حسب المتجر: من ${Math.min(...etas)} إلى ${Math.max(...etas)} دقيقة، ويظهر في صفحة كل متجر 🕒\nوبعد الطلب تتابع حالته خطوة بخطوة من "طلباتي".`);
    }
    if (has(t, 'اشتغل', 'وظيفه', 'وظايف', 'توظيف', 'انضم', 'اسجل كسائق', 'اصير سائق', 'اضيف متجري', 'متجري')) {
      return out(`حياك! للانضمام كسائق أو إضافة متجرك، تواصل مع الإدارة${settings().supportPhone ? ` على ${settings().supportPhone}` : ''}، أو خلني أرفع طلبك لهم.`, ['أرفع سؤالي للإدارة']);
    }
    if (has(t, 'حلو', 'رائع', 'ممتاز', 'جميل', 'مبدعين', 'كفو', 'احسنتم') && has(t, 'تطبيق', 'التطبيق', 'الخدمه', 'خدمتكم', 'شغلكم') ) {
      return out('شكراً لك على كلامك الطيب 🌷 يسعدنا! وإذا عندك اقتراح يخلي الخدمة أحسن، أرفعه للإدارة.', ['رفع شكوى أو ملاحظة']);
    }
    if (has(t, 'افضل', 'احسن', 'انصحني', 'تنصح')) {
      const cs = detectCats(t);
      const list = catalog().filter((x) => !cs.length || cs.includes(x.category));
      if (list.length) return out(`ما أقدر أفضّل متجر على ثاني، لكن هذي المتوفرة${cs.length ? '' : ' عندنا'}:\n${list.slice(0, 8).map((x) => `• ${x.name}: ${storeOpenNow(x) ? 'مفتوح' : 'مغلق'}`).join('\n')}`);
    }
    /* "وين طلبي" قبل الشكوى الضمنية: نعرض الحالة أولاً ونعرض رفع شكوى كخيار */
    if (!explicitCategory(t) && has(t, 'وين طلبي', 'طلبي', 'حاله الطلب', 'طلباتي', 'وصل الطلب')) return out(ordersAnswer(phone), ['رفع شكوى أو ملاحظة']);
    const cat = detectCategory(t);
    if (cat) {
      {
        state.flow = { step: 'cat', threadId };
        if (cat) {
          state.flow.category = cat;
          const rest = raw.replace(/(ابي|ابغى|أبي|أبغى|ودي)?\s*(ارفع|أرفع|رفع)?\s*(شكوى|شكوي|بلاغ|اقتراح|ملاحظة|ملاحظه)/, '').trim();
          if (rest.length > 25) { state.flow.details = rest.slice(0, 2000); state.flow.step = 'order'; return out(`فهمت عليك، وآسفين على الإزعاج إن كان فيه مشكلة.\nإذا له علاقة بطلب اكتب رقمه، وإذا لا اضغط الزر.`, ['ما له علاقة بطلب']); }
          state.flow.step = 'details';
          return out(`${cat === 'complaint' ? 'آسفين على الإزعاج 🙏 ' : ''}اكتب التفاصيل: وش صار بالضبط؟`, []);
        }
        return out('وش نوع البلاغ؟', Object.values(CATS));
      }
    }
    if (has(t, 'السلام', 'هلا', 'مرحبا', 'اهلين', 'اهلا', 'صباح', 'مساء', 'هاي') && t.length < 25) return out('وعليكم السلام وهلا فيك 👋 أنا مساعد الهدار درايف. وش أقدر أخدمك؟');
    if (has(t, 'شكرا', 'مشكور', 'يعطيك العافيه', 'تسلم', 'جزاك') && t.length < 30) return out('العفو، بالخدمة دايماً 🌷', []);
    if (has(t, 'الغي', 'الغاء', 'كنسل')) return out(cancelAnswer());
    if (has(t, 'استرجاع', 'استرداد', 'ترجيع', 'ارجاع', 'فلوسي', 'تعويض')) return out(refundAnswer(), ['رفع شكوى أو ملاحظة']);
    if (has(t, 'رسوم', 'سعر التوصيل', 'كم التوصيل', 'التوصيل بكم', 'حد ادني', 'الحد الادني', 'التوصيل مجاني', 'توصيل مجاني')) return out(feeAnswer());
    if (has(t, 'حي', 'احياء', 'الاحياء', 'توصلون', 'توصلوا', 'مناطق', 'منطقتي', 'تغطون')) return out(districtsAnswer(t, raw));
    if (has(t, 'دفع', 'ادفع', 'مدي', 'كاش', 'نقد', 'تحويل', 'حواله', 'ابل باي', 'apple', 'stc', 'بطاقه', 'فيزا')) return out(paymentAnswer(onlinePay));
    if (has(t, 'ولاء', 'توصيله مجانيه', 'مجاني', 'نقاط')) return out(loyaltyAnswer(phone));
    if (has(t, 'كوبون', 'خصم', 'كود', 'عرض', 'عروض')) {
      const now = Date.now();
      const cs = db.all('SELECT * FROM coupons WHERE active = 1').filter((c) => (!c.expires_at || now <= c.expires_at) && (!c.max_uses || c.used_count < c.max_uses));
      return out(cs.length ? `العروض الحالية:\n${cs.slice(0, 5).map((c) => `• ${c.code}: ${c.kind === 'percent' ? `خصم ${c.value}%` : c.kind === 'fixed' ? `خصم ${c.value} ر.س` : 'توصيل مجاني'}${c.min_order ? ` (من ${c.min_order} ر.س)` : ''}`).join('\n')}\nتكتب الكود عند تأكيد الطلب.` : 'ما فيه كوبونات حالياً، وتابع العروض في الرئيسية.');
    }
    if (has(t, 'تجربه', 'تجريبي')) return out(settings().trialMode !== false ? 'التطبيق حالياً في مرحلة التجربة 🧪 تقدر تتصفح وتطلب كتجربة بدون تسجيل ولا دفع، والطلبات ما تتوصّل فعلياً للحين.' : 'التطبيق شغّال والطلبات حقيقية وتتوصّل ✅');
    if (has(t, 'موظف', 'الاداره', 'اكلم', 'تواصل', 'رقمكم', 'رقم الدعم', 'واتس', 'اتصل')) return out(contactAnswer(), ['رفع شكوى أو ملاحظة']);
    if (has(t, 'طلب خاص', 'اكتب طلبي', 'غير موجود', 'مو موجود')) return out('إذا اللي تبيه مو في القائمة، افتح المتجر واختر "✍️ اكتب طلبك بنفسك"، وتكتب طلبك والمتجر يحدد السعر.');
    if (has(t, 'مفتوح', 'مفتوحه', 'دوام', 'يفتح', 'تفتح', 'يقفل', 'تقفل', 'مسكر', 'مغلق', 'فاتح', 'فاتحه')) {
      const s = catalog().find((x) => !x.unnamed && t.includes(normAr(x.name)));
      if (s) return out(storeStatus(s));
      const q2 = t.replace(/(مفتوحه|مفتوح|دوام|يفتح|تفتح|يقفل|تقفل|مسكر|مغلق|فاتحه|فاتح|الحين|الان|متي)/g, ' ').replace(/\s+/g, ' ').trim();
      const found = q2 && searchAnswer(q2);
      if (found && (found.store || detectCats(q2).length)) return out(found.text);
      return out(openNowAnswer());
    }
    const found = searchAnswer(t);
    if (found) return out(found.text + '\n\nتقدر تطلب من صفحة المتجر مباشرة.', []);
    return out('ما فهمت سؤالك تماماً 🙏 اختر من المواضيع تحت، أو اكتب اسم المنتج أو المتجر اللي تبحث عنه.\nوإذا سؤالك يحتاج الإدارة، أرفعه لهم.', [...MENU.slice(0, 5), 'أرفع سؤالي للإدارة']);
  }

  async function chat({ threadId, token, message, phone, onlinePay }) {
    const raw = String(message || '').trim().slice(0, 2000);
    if (!raw) throw Object.assign(new Error('اكتب رسالتك'), { code: 'empty' });
    const { thread, state, token: newToken } = openThread(threadId, token, phone);
    let r;
    /* "أرفع سؤالي للإدارة" = استفسار مباشر بدون المرور على اختيار النوع */
    if (normAr(raw) === normAr('أرفع سؤالي للإدارة')) {
      state.flow = { step: 'details', category: 'inquiry', threadId: thread.id };
      r = { text: 'اكتب سؤالك بالتفصيل، وأرفعه للإدارة:', quick: [] };
    } else r = respond(state, raw, phone, thread.id, onlinePay);
    state.log.push({ from: 'customer', text: raw }, { from: 'assistant', text: r.text });
    state.log = state.log.slice(-MAX_LOG);
    db.run('UPDATE assistant_threads SET messages = ?, user_turns = user_turns + 1, customer_phone = COALESCE(customer_phone, ?), updated_at = ? WHERE id = ?',
      JSON.stringify(state), phone || null, Date.now(), thread.id);
    const tickets = r.ticket ? [{ number: r.ticket.number, category: CATS[r.ticket.category] || 'بلاغ', subject: r.ticket.subject }] : [];
    return { threadId: thread.id, token: newToken, reply: r.text, quick: r.quick || [], tickets };
  }

  return { chat };
}
