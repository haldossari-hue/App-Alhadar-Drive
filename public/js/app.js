/* الهدار درايف — الواجهة (عميل، سائق، إدارة) */
import { CATS, CAT, ST, FLOW, ACTIVE, PAY, UNIT_PRESETS, TINTS, MAX_CART_STORES, unitPrice, claimableOrder, DEFAULT_SETTINGS, storeOpenNow, hoursLabel } from '/shared/constants.js';
import { esc, fmt, lsg, lss, ago, clock, today0, uid, toast, beep, norm, has, waLink, secsOf, shrink, emblem, skyline } from './util.js';
import { api, upload, tokens, setAuthLostHandler, connectStream, disconnectStream, registerSW, pushSupported, enablePush, refreshPush } from './api.js';

/* ============ الحالة ============ */
const S = {
  role: roleFromPath(location.pathname),
  view: { name: 'home' },
  boot: null,                       // {settings, stores, coupons, vapidKey}
  cart: lsg('hd.cart', { items: {} }),
  q: '', orderFilter: 'active', priceQ: '', priceFilter: 'all',
  sheet: null, edit: null, pending: false,
  // العميل
  customer: null, orders: [], authStep: 'phone', authPhone: '', authExists: false, authErr: '', devCode: '', resendAt: 0,
  couponCode: '', coupon: null, couponMsg: '', couponOk: false, useFreeDelivery: false, quote: null,
  checkoutDraft: {}, storeChoice: 'list', customOrder: {}, checkoutCustom: false, payMethod: 'cash', checkoutReceipt: null,
  // السائق
  driver: null, dOrders: { available: [], mine: [], done: [], unsettled: 0, doneCount: 0 },
  // الإدارة
  adm: null, recover: null,
  // مشترك
  chatMsgs: {}, chatOrderId: null, driverLoc: {}, loaded: false, showCustHelp: false,
};
const set = () => Object.assign({}, DEFAULT_SETTINGS, S.boot ? S.boot.settings : {});

/* ============ الروابط: كل صفحة لها رابط، والرابط الرئيسي يفتح المتاجر مباشرة ============ */
function roleFromPath(p) { return /^\/driver/.test(p) ? 'driver' : /^\/admin/.test(p) ? 'admin' : 'customer'; }
const ROLE_HOME = { customer: 'home', driver: 'available', admin: 'aorders' };
const CUST_PATHS = { cat: 1, store: 1, order: 1, orders: 0, profile: 0, login: 0 };
function pathFor(role, v) {
  if (role === 'driver') return '/driver';
  if (role === 'admin') return '/admin';
  if (!v || v.name === 'home' || !(v.name in CUST_PATHS)) return '/';
  return '/' + v.name + (CUST_PATHS[v.name] && v.arg ? '/' + encodeURIComponent(v.arg) : '');
}
function viewFromPath(p) {
  const m = p.match(/^\/(cat|store|order|orders|profile|login)(?:\/([^/?#]+))?/);
  return m ? { name: m[1], arg: m[2] ? decodeURIComponent(m[2]) : undefined } : { name: 'home' };
}
function syncUrl(replace) {
  const u = pathFor(S.role, S.view);
  if (location.pathname === u) return;
  if (replace) history.replaceState(null, '', u); else history.pushState(null, '', u);
}
const needsLogin = (v) => ['orders', 'order', 'profile', 'login'].includes(v.name);
const stores = () => (S.boot ? S.boot.stores : []);
const named = () => stores().filter((s) => (s.name || '').trim());
const sname = (s) => (s.name || '').trim() || ('متجر بدون اسم — ' + ((CAT[s.category] || {}).name || ''));
const meRole = () => (S.role === 'driver' ? 'driver' : S.role === 'admin' ? 'admin' : 'customer');
const loggedIn = () => !!(S.role && tokens.get(S.role));
const call = (method, url, body) => api(method, url, body, S.role);

/* ============ السلة ============ */
const splitCartKey = (k) => { const i = k.indexOf('::'); if (i < 0) return { sid: null, pid: k, ui: null }; const sid = k.slice(0, i), rest = k.slice(i + 2); const j = rest.indexOf('~'); return j < 0 ? { sid, pid: rest, ui: null } : { sid, pid: rest.slice(0, j), ui: +rest.slice(j + 1) }; };
const fullCartKey = (sid, rawKey) => sid + '::' + rawKey;
function cartStoreIds() { const s = new Set(); Object.keys(S.cart.items).forEach((k) => { const { sid } = splitCartKey(k); if (sid) s.add(sid); }); return [...s]; }
function basketFor(sid) {
  const s = stores().find((x) => x.id === sid); if (!s) return { s: null, lines: [], sub: 0, n: 0 };
  const lines = []; let sub = 0, n = 0;
  Object.entries(S.cart.items).forEach(([key, q]) => {
    const parsed = splitCartKey(key); if (parsed.sid !== sid) return;
    const p = (s.products || []).find((x) => x.id === parsed.pid);
    if (!p || !(q > 0) || !(Number(p.price) > 0) || p.available === false) return;
    const u = parsed.ui != null && Array.isArray(p.units) ? p.units[parsed.ui] : null;
    if (parsed.ui != null && !u) return;
    const price = u ? unitPrice(p, u) : Number(p.price);
    const rawKey = parsed.ui != null ? parsed.pid + '~' + parsed.ui : parsed.pid;
    lines.push({ p, q, u, key: rawKey, price }); sub += price * q; n += q;
  });
  return { s, lines, sub, n };
}
const cartBaskets = () => cartStoreIds().map(basketFor).filter((b) => b.s);
const cartLines = () => Object.entries(S.cart.items).map(([k, qty]) => { const { sid, pid, ui } = splitCartKey(k); return { storeId: sid, productId: pid, unit: ui, qty }; });
const saveCart = () => lss('hd.cart', S.cart);

function pimg(p, cls) {
  return p && p.img ? `<img src="${esc(p.img)}" alt="" loading="lazy">` : `<span class="${cls || ''}">${esc((p && p.emoji) || '📦')}</span>`;
}

/* ============ التحميل والتحديث ============ */
async function loadBoot() { S.boot = await api('GET', '/api/bootstrap'); }
async function loadRole() {
  if (!loggedIn()) return;
  if (S.role === 'customer') {
    const [me, orders] = await Promise.all([call('GET', '/api/me'), call('GET', '/api/my/orders')]);
    S.customer = me; S.orders = orders;
  } else if (S.role === 'driver') {
    const [me, d] = await Promise.all([call('GET', '/api/driver/me'), call('GET', '/api/driver/orders')]);
    S.driver = me; S.dOrders = d; syncTracking();
  } else if (S.role === 'admin') {
    S.adm = await call('GET', '/api/admin/data');
  }
}


let refreshT = null;
function refreshSoon(what = 'role') {
  clearTimeout(refreshT);
  refreshT = setTimeout(async () => {
    try { if (what === 'all') await loadBoot(); await loadRole(); } catch (e) { console.warn(e); }
    soft(); if (S.sheet && S.sheet.type !== 'store' && S.sheet.type !== 'coupon' && S.sheet.type !== 'driver') renderSheet();
  }, 250);
}

function onEvent(ev) {
  if (ev.type === 'order' || ev.type === 'drivers' || ev.type === 'me' || ev.type === 'otp') refreshSoon();
  else if (ev.type === 'catalog') refreshSoon('all');
  else if (ev.type === 'notify') {
    if (ev.onlineOnly && S.role === 'driver' && S.driver && !S.driver.online) return;
    if (ev.sound) beep();
    toast(ev.text);
  } else if (ev.type === 'chat') {
    const list = S.chatMsgs[ev.orderId];
    if (list && !list.some((m) => m.id === ev.msg.id)) list.push(ev.msg);
    const open = S.sheet && S.sheet.type === 'chat' && S.chatOrderId === ev.orderId;
    if (open) renderSheet();
    else if (ev.msg.from !== meRole() && S.role !== 'admin') {
      beep(); toast('رسالة جديدة من ' + ({ customer: 'العميل', driver: 'السائق', admin: 'الإدارة' }[ev.msg.from] || ''));
    }
  } else if (ev.type === 'loc' && ev.orderId) {
    S.driverLoc[ev.orderId] = { lat: ev.lat, lng: ev.lng, at: ev.at };
    updateTrackMap();
  }
}

async function startRole() {
  S.loaded = false; render();
  try { await loadRole(); } catch (e) { console.warn(e); }
  S.loaded = true;
  connectStream(loggedIn() ? S.role : null, onEvent, () => refreshSoon('all'));
  if (loggedIn()) refreshPush(S.role);
  render();
}
setAuthLostHandler((role) => {
  if (role !== S.role) return;
  S.customer = null; S.driver = null; S.adm = null;
  toast('انتهت الجلسة، سجّل دخولك من جديد');
  connectStream(null, onEvent, () => refreshSoon('all'));
  render();
});

/* ============ العرض ============ */
function soft() {
  const a = document.activeElement;
  if (a && document.getElementById('app').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { S.pending = true; return; }
  render();
}
document.addEventListener('focusout', (e) => {
  if (!S.pending) return;
  const r = e.relatedTarget;
  if (r && document.getElementById('app').contains(r) && /INPUT|TEXTAREA|SELECT/.test(r.tagName)) return;
  setTimeout(() => { if (S.pending) soft(); }, 50);
});

function render() {
  S.pending = false;
  const app = document.getElementById('app');
  if (S.legal) { app.innerHTML = vLegal(); return; }
  if (!S.boot) { app.innerHTML = topBar() + `<div class="wrap"><div class="empty"><span class="e">🛵</span>جارِ تحميل الهدار درايف…</div></div>`; return; }
  if (S.role === 'customer') {
    if (!loggedIn() && needsLogin(S.view)) app.innerHTML = topBar() + vCustAuth() + nav();
    else if (loggedIn() && !S.customer) app.innerHTML = topBar() + `<div class="wrap"><div class="empty"><span class="e">👤</span>جارِ تحميل حسابك…</div></div>`;
    else app.innerHTML = topBar() + vCustomer() + cartBar() + nav();
  } else if (S.role === 'driver') app.innerHTML = topBar() + vDriver() + (loggedIn() && S.driver ? nav() : '');
  else app.innerHTML = topBar() + vAdmin() + (loggedIn() && S.adm ? nav() : '');
  if (S.role === 'customer' && S.view.name === 'home' && S.q) updateResults();
  afterRender();
}
function topBar() {
  const lab = { customer: 'واجهة العميل', driver: 'واجهة السائق', admin: 'لوحة الإدارة' }[S.role];
  let extra = '';
  if (S.role === 'driver' && loggedIn() && S.driver) extra = `<button class="ib" data-act="drvOnline">${S.driver.online ? '🟢 متصل' : '⚪ غير متصل'}</button>`;
  const right = S.role === 'customer'
    ? (loggedIn() ? '' : `<button class="ib" data-go="login">دخول</button>`)
    : `<button class="ib" data-act="switchRole" aria-label="المتجر">🛍️ المتجر</button>`;
  const sub = S.role === 'customer' ? 'توصيل داخل الهدار' : lab;
  return `<header class="top"><div class="in"><button class="brand" data-go="home" style="border:0;background:none;padding:0;text-align:right">${emblem(34)}<span class="bt"><b>الهدار درايف</b><small>${sub}</small></span></button><div class="sp"></div>${extra}${right}</div><div class="najdi"></div></header>`;
}
const LEGAL_T = { terms: 'الشروط والأحكام', privacy: 'سياسة الخصوصية', refund: 'الاسترجاع والإلغاء' };
function vLegal() {
  const L = S.legalData; const pg = LEGAL_T[S.legal] ? S.legal : 'terms';
  const bits = L ? [L.legalName, L.crNumber ? 'السجل التجاري: ' + L.crNumber : '', L.vatNumber ? 'الرقم الضريبي: ' + L.vatNumber : '', L.supportPhone ? 'التواصل: ' + L.supportPhone : ''].filter(Boolean) : [];
  return `<header class="top"><div class="in"><div class="brand">${emblem(34)}<span class="bt"><b>الهدار درايف</b><small>${LEGAL_T[pg]}</small></span></div><div class="sp"></div><button class="ib" data-act="closeLegal">رجوع للتطبيق</button></div><div class="najdi"></div></header>
  <div class="wrap">
    <div class="chips" style="margin-top:14px">${Object.entries(LEGAL_T).map(([k, t]) => `<button class="chip ${k === pg ? 'on' : ''}" data-act="legalTab" data-v="${k}">${t}</button>`).join('')}</div>
    <div class="card legaltxt">${L ? esc(L[pg] || '') : 'جارِ التحميل…'}</div>
    ${bits.length ? `<div class="card">${bits.map((b) => `<div class="ol">${esc(b)}</div>`).join('')}</div>` : ''}
  </div>`;
}
async function openLegal(page, push = true) {
  S.legal = page;
  if (push) history.pushState({ legal: page }, '', '/legal/' + page);
  render(); window.scrollTo(0, 0);
  if (!S.legalData) { try { S.legalData = await api('GET', '/api/legal'); } catch (e) { toast(e.message); } render(); }
}
window.addEventListener('popstate', () => {
  const m = location.pathname.match(/^\/legal\/(\w+)/);
  S.legal = m ? m[1] : null; render();
});

const errBox = (m) => (m ? `<div class="notice errbox">${esc(m)}</div>` : '');

function vCustAuth() {
  if (S.authStep === 'code') {
    const wait = Math.max(0, Math.ceil((S.resendAt - Date.now()) / 1000));
    return `<div class="wrap"><div class="center">
      <h2>${S.authExists ? 'تسجيل الدخول' : 'حساب جديد'}</h2>
      ${S.authChannel === 'whatsapp'
        ? `<div class="notice">📲 بيوصلك <b>رمز التحقق على واتساب</b> من رقم الإدارة${S.authSupport ? ` <b dir="ltr">${esc(S.authSupport)}</b>` : ''} إلى <b dir="ltr">${esc(S.authPhone)}</b> خلال دقائق. خلّ هذي الصفحة مفتوحة.</div>
           ${S.authSupport ? `<a class="btn wa sm" style="margin-bottom:12px" target="_blank" rel="noopener" href="${waLink(S.authSupport)}?text=${encodeURIComponent('السلام عليكم، أبي رمز التحقق لتطبيق الهدار درايف لرقمي ' + S.authPhone)}">تأخر الرمز؟ راسل الإدارة</a>` : ''}`
        : `<p class="muted" style="margin-top:0">أرسلنا رمز تحقق من 4 أرقام برسالة نصية إلى <b dir="ltr">${esc(S.authPhone)}</b></p>`}
      ${S.devCode ? `<div class="notice" id="devCode">وضع التطوير — الرمز: <b dir="ltr">${esc(S.devCode)}</b></div>` : ''}
      ${S.authExists ? '' : `<div class="field"><label>الاسم</label><input id="au_name" autocomplete="name" value="${esc(S.authName || '')}"></div>`}
      <div class="field otp"><label>رمز التحقق</label><input id="au_code" inputmode="numeric" autocomplete="one-time-code" maxlength="4"></div>
      ${errBox(S.authErr)}
      <button class="btn block" data-act="authVerify">${S.authExists ? 'دخول' : 'إنشاء الحساب والدخول'}</button>
      <div class="row" style="justify-content:space-between;margin-top:8px">
        <button class="linkbtn" data-act="authBack">تغيير الرقم</button>
        <button class="linkbtn" data-act="authResend" ${wait ? 'disabled' : ''} id="resendBtn">${wait ? `إعادة الإرسال بعد ${wait} ث` : 'إعادة إرسال الرمز'}</button>
      </div>
    </div></div>`;
  }
  return `<div class="wrap"><div class="center">
    ${emblem(56)}
    <h2 style="margin-top:14px">تسجيل الدخول</h2>
    <p class="muted" style="margin-top:0">${S.afterLogin ? 'باقي خطوة وحدة: اكتب رقم جوالك عشان نأكد طلبك ونوصلك تحديثاته.' : 'اكتب رقم جوالك ونرسل لك رمز تحقق.'}</p>
    <div class="field"><label>رقم الجوال</label><input id="au_phone" inputmode="tel" dir="ltr" placeholder="05xxxxxxxx" value="${esc(S.authPhone || '')}"></div>
    ${errBox(S.authErr)}
    <button class="btn block" data-act="authPhone">إرسال الرمز</button>
    <p class="hint" style="text-align:center;margin-top:12px">بالمتابعة أنت توافق على <a href="/legal/terms" data-legal="terms">الشروط والأحكام</a> و<a href="/legal/privacy" data-legal="privacy">سياسة الخصوصية</a></p>
  </div></div>`;
}
function nav() {
  let items = [];
  if (S.role === 'customer') {
    const act = S.orders.filter((o) => ACTIVE.includes(o.status) || o.status === 'awaiting_payment').length;
    items = [['home', '🏠', 'الرئيسية'], ['orders', '🧾', 'طلباتي', act], ['profile', '👤', loggedIn() ? 'بياناتي' : 'دخول']];
  } else if (S.role === 'driver') {
    items = [['available', '📦', 'متاحة', S.dOrders.available.length], ['mine', '🛵', 'طلباتي', S.dOrders.mine.length], ['done', '💵', 'المنجزة']];
  } else {
    const nw = S.adm.orders.filter((o) => o.status === 'new').length + ((S.adm.otp || []).filter((r) => !r.waSentAt).length);
    items = [['aorders', '🧾', 'الطلبات', nw], ['coupons', '🎟️', 'كوبونات'], ['prices', '🏷️', 'الأسعار'], ['stores', '🏪', 'المتاجر'], ['drivers', '🛵', 'السائقون'], ['settings', '⚙️', 'الإعدادات']];
  }
  const cur = S.view.name;
  return `<nav class="nav"><div class="in">${items.map(([v, e, t, b]) => {
    const on = cur === v || (v === 'home' && ['cat', 'store'].includes(cur)) || (v === 'orders' && cur === 'order') || (v === 'profile' && cur === 'login');
    return `<button class="${on ? 'on' : ''}" data-go="${v}"><span class="ne">${e}</span>${t}${b ? `<span class="badge">${b}</span>` : ''}</button>`;
  }).join('')}</div></nav>`;
}
function pushBar() {
  if (!loggedIn() || !pushSupported() || Notification.permission !== 'default' || lsg('hd.pushAsked.' + S.role, false)) return '';
  const txt = { customer: 'فعّل الإشعارات عشان يوصلك تحديث طلبك حتى لو التطبيق مقفل', driver: 'فعّل الإشعارات عشان توصلك الطلبات الجديدة حتى لو الجوال مقفل', admin: 'فعّل الإشعارات عشان توصلك الطلبات الجديدة فوراً' }[S.role];
  return `<div class="pushbar">🔔 <span>${txt}</span><button class="btn sm" data-act="enablePush">تفعيل</button><button class="x" data-act="dismissPush" aria-label="إخفاء">✕</button></div>`;
}

/* ============ واجهة العميل ============ */
function vCustomer() {
  const v = S.view;
  if (v.name === 'cat') return vCat(v.arg);
  if (v.name === 'store') return vStore(v.arg);
  if (v.name === 'orders') return vMyOrders();
  if (v.name === 'order') return vOrder(v.arg);
  if (v.name === 'profile') return vProfile();
  if (v.name === 'login') { S.view = { name: 'home' }; syncUrl(true); }
  return vHome();
}
function catsGrid() { return `<div class="cats">${CATS.map((c) => `<button class="cat" style="--t:${esc(c.t || TINTS[0])}" data-go="cat" data-arg="${c.id}"><span class="ce">${c.emoji}</span>${c.name}</button>`).join('')}</div>`; }
function vHome() {
  const st = set();
  return `<div class="wrap">
    <section class="hero"><div class="najdi"></div>
      <div class="wm"><span class="a">الهدار </span><span class="b">درايف</span></div>
      <p>وش تبي اليوم؟ نوصله لبابك.</p>
      <span class="zone">📍 التوصيل داخل مدينة الهدار فقط، محافظة الأفلاج</span>
      ${skyline()}
    </section>
    ${pushBar()}
    ${st.announcement ? `<div class="notice">📣 ${esc(st.announcement)}</div>` : ''}
    ${promoStrip()}
    <div class="search"><input type="search" id="q" value="${esc(S.q)}" placeholder="ابحث عن متجر أو منتج" autocomplete="off"></div>
    <div id="results">
      ${quickStrip()}
      ${catsGrid()}
      <h2>كل المتاجر</h2>
      ${storeList(named())}
    </div>
    ${footer()}
  </div>`;
}
function promoStrip() {
  const list = (S.boot.coupons || []);
  if (!list.length) return '';
  const lbl = (c) => (c.kind === 'percent' ? `خصم ${Number(c.value) || 0}%` : c.kind === 'fixed' ? `خصم ${fmt(c.value)}` : 'توصيل مجاني');
  return `<h2 style="margin-top:20px">🎟️ عروض وكوبونات</h2>
    <div class="quick promos">${list.map((c) => `<button type="button" class="qcard promocard" data-act="copyCode" data-v="${esc(c.code)}">
      <span class="qt promoicn">🎁</span>
      <span class="qb"><b>${esc(lbl(c))}</b><small class="pcode">${esc(c.code)}</small>${c.minOrder > 0 ? `<small>من ${fmt(c.minOrder)}</small>` : ''}</span>
    </button>`).join('')}</div>`;
}
function quickStrip() {
  const list = named().filter((s) => storeOpenNow(s)).slice().sort((a, b) => (Number(a.eta) || 30) - (Number(b.eta) || 30)).slice(0, 8);
  if (list.length < 3) return '';
  return `<h2 style="margin-top:20px">⚡ توصيل سريع الآن</h2>
    <div class="quick">${list.map((s) => { const c = CAT[s.category] || {}; return `<button class="qcard" data-go="store" data-arg="${s.id}"><span class="qt" style="--t:${esc(s.color || TINTS[0])}">${esc(s.emoji || c.emoji)}</span><span class="qb"><b>${esc(s.name)}</b><small>🕒 ${Number(s.eta) || 30} د</small></span></button>`; }).join('')}</div>`;
}
function legalLinks() { return `<div class="leglinks"><a href="/legal/terms" data-legal="terms">الشروط والأحكام</a> · <a href="/legal/privacy" data-legal="privacy">الخصوصية</a> · <a href="/legal/refund" data-legal="refund">الاسترجاع</a></div>`; }
function bizLine() { const st = set(); const bits = [st.legalName, st.crNumber ? 'س.ت ' + st.crNumber : '', st.vatNumber ? 'الرقم الضريبي ' + st.vatNumber : ''].filter(Boolean); return bits.length ? `<br><small>${esc(bits.join(' · '))}</small>` : ''; }
function footer() { const sp = set().supportPhone; return `<div class="foot"><div class="najdi"></div>الهدار درايف، توصيل محلي داخل مدينة الهدار${sp ? `<br>للتواصل: <a href="tel:${esc(sp)}" dir="ltr">${esc(sp)}</a>` : ''}${bizLine()}${legalLinks()}<div class="leglinks"><a href="/driver" data-act="toRole" data-v="driver">دخول السائقين</a></div></div>`; }
function updateResults() {
  const el = document.getElementById('results'); if (!el) return;
  const q = norm(S.q);
  if (!q) { el.innerHTML = `${catsGrid()}<h2>كل المتاجر</h2>${storeList(named())}`; return; }
  const ss = named().filter((s) => has(s.name, q) || has((CAT[s.category] || {}).name, q) || has(s.desc, q));
  const prods = []; named().forEach((s) => (s.products || []).forEach((p) => { if (has(p.name, q) || has(p.sec, q)) prods.push([p, s]); }));
  prods.sort((a, b) => (Number(b[0].price) > 0) - (Number(a[0].price) > 0));
  el.innerHTML = `${ss.length ? `<h2>المتاجر</h2>${storeList(ss)}` : ''}
    ${prods.length ? `<h2>المنتجات</h2><div class="grid">${prods.slice(0, 30).map(([p, s]) => prodCard(p, s, true)).join('')}</div>` : ''}
    ${!ss.length && !prods.length ? `<div class="empty"><span class="e">🔎</span>ما لقينا نتائج لـ "${esc(S.q.trim())}"</div>` : ''}`;
}
function storeList(list) {
  if (!list.length) return `<div class="empty"><span class="e">🏪</span>المتاجر قيد التجهيز، ترقبونا قريباً.</div>`;
  return `<div class="list">${list.map(storeRow).join('')}</div>`;
}
function storeRow(s) {
  const c = CAT[s.category] || { name: '', emoji: '🏪' };
  const open = storeOpenNow(s);
  return `<button class="srow${open ? '' : ' closed'}" data-go="store" data-arg="${s.id}">
    <span class="tile" style="--t:${esc(s.color || TINTS[0])}">${esc(s.emoji || c.emoji)}</span>
    <span class="sinfo"><b>${esc(s.name)}</b><small>${esc(s.desc || c.name)}</small><small>🕒 ${Number(s.eta) || 30} دقيقة${hoursLabel(s) ? ` · ${esc(hoursLabel(s))}` : ''}</small></span>
    ${open ? '<span class="pill on"><span class="dot"></span>مفتوح</span>' : '<span class="pill off">مغلق</span>'}
  </button>`;
}
function vCat(id) {
  const c = CAT[id] || CATS[0];
  return `<div class="wrap">
    <button class="back" data-go="home">→ الرئيسية</button>
    <div class="chips">${CATS.map((x) => `<button class="chip ${x.id === c.id ? 'on' : ''}" data-go="cat" data-arg="${x.id}">${x.emoji} ${x.name}</button>`).join('')}</div>
    <h2 style="margin-top:6px">${c.emoji} ${c.name}</h2>
    ${storeList(named().filter((s) => s.category === c.id))}
  </div>`;
}
function vStore(id) {
  const s = named().find((x) => x.id === id);
  if (!s) return `<div class="wrap"><button class="back" data-go="home">→ الرئيسية</button><div class="empty">المتجر غير موجود.</div></div>`;
  const c = CAT[s.category] || {};
  const prods = s.products || [];
  const secs = secsOf(s);
  const body = secs.map((k, i) => {
    const list = prods.filter((p) => ((p.sec || '').trim() || 'منتجات أخرى') === k).sort((a, b) => (a.available === false) - (b.available === false));
    return `<section class="sec"><h3 id="sec_${i}">${esc(k)}<small>${list.length}</small></h3><div class="grid">${list.map((p) => prodCard(p, s)).join('')}</div></section>`;
  }).join('');
  return `<div class="wrap">
    <button class="back" data-go="cat" data-arg="${s.category}">→ ${c.name || 'رجوع'}</button>
    <div class="sban" style="--t:${esc(s.color || TINTS[0])}">
      <div class="shead">
        <span class="tile">${esc(s.emoji || c.emoji)}</span>
        <div><h1>${esc(s.name)}</h1>${s.desc ? `<div class="desc">${esc(s.desc)}</div>` : ''}
        <div class="meta">${!storeOpenNow(s) ? '<span class="pill off">مغلق الآن</span>' : '<span class="pill on">مفتوح</span>'}<span class="pill mute">🕒 ${Number(s.eta) || 30} دقيقة</span>${hoursLabel(s) ? `<span class="pill mute">${esc(hoursLabel(s))}</span>` : ''}<span class="pill mute">🛵 ${set().deliveryFee > 0 ? fmt(set().deliveryFee) : 'توصيل مجاني'}</span></div></div>
      </div><div class="najdi"></div>
    </div>
    ${s.note ? `<div class="notice">${esc(s.note)}</div>` : ''}
    <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn sm line" data-act="shareStore" data-id="${s.id}" data-n="${esc(s.name)}">🔗 مشاركة رابط المتجر</button></div>
    ${!storeOpenNow(s) ? `<div class="notice errbox">المتجر مغلق الآن${s.open !== false && hoursLabel(s) ? `، أوقات العمل ${esc(hoursLabel(s))}` : ''}. تقدر تتصفح المنتجات، والطلب يتاح وقت الدوام.</div>` : ''}
    <div class="chips" style="margin:14px 0 2px">
      <button class="chip ${S.storeChoice !== 'custom' ? 'on' : ''}" data-act="storeMode" data-v="list">📋 من قائمة المتجر</button>
      <button class="chip ${S.storeChoice === 'custom' ? 'on' : ''}" data-act="storeMode" data-v="custom">✍️ اكتب طلبك بنفسك</button>
    </div>
    ${S.storeChoice === 'custom' ? customOrderForm(s) : `
    ${secs.length > 1 ? `<div class="secbar"><div class="chips">${secs.map((k, i) => `<button class="chip" data-act="toSec" data-v="${i}">${esc(k)}</button>`).join('')}</div></div>` : ''}
    ${prods.length ? body : `<div class="empty"><span class="e">📦</span>لا توجد منتجات بعد.</div>`}`}
  </div>`;
}
function customOrderForm(s) {
  const co = S.customOrder || {};
  return `<div class="card" style="margin-top:12px">
    <h3 style="margin-bottom:6px">اكتب طلبك</h3>
    <p class="muted" style="margin:0 0 10px">اشرح اللي تبيه بالتفصيل (الصنف، الكمية، أي تفضيلات)، والمتجر يحدد لك السعر قبل ما يتأكد الطلب.</p>
    <div class="field"><textarea id="cs_desc" placeholder="مثال: أبي 3 كيلو تمر سكري درجة أولى، وكيلو سمن بلدي" style="min-height:100px">${esc(co.desc || '')}</textarea></div>
    <div class="field"><label>صورة توضيحية (اختياري)</label>
      ${co.img ? `<div class="pimg" style="width:110px;height:110px;border-radius:14px;margin-bottom:8px;overflow:hidden"><img src="${esc(co.img)}" style="width:100%;height:100%;object-fit:cover"></div>` : ''}
      <button class="btn sm line" type="button" data-act="csPhoto">${co.img ? 'تغيير الصورة' : '+ إضافة صورة'}</button>
      <input type="file" id="csImgIn" accept="image/*" hidden></div>
    <button class="btn block" style="margin-top:10px" data-act="csContinue" data-s="${s.id}">متابعة الطلب</button>
  </div>`;
}
function prodCard(p, s, showStore) {
  const priced = Number(p.price) > 0;
  const avail = p.available !== false && storeOpenNow(s);
  const weight = Array.isArray(p.units) && p.units.length > 0;
  let body;
  if (!avail) body = `<div class="pfoot"><span class="price">${priced ? fmt(p.price) + (weight ? ' /كغ' : '') : ''}</span><span class="soon">غير متوفر</span></div>`;
  else if (!priced) body = `<div class="pfoot"><span></span><span class="soon">السعر قريباً</span></div>`;
  else if (weight) {
    body = `<div class="units">${p.units.map((u, ui) => {
      const key = p.id + '~' + ui; const q = S.cart.items[fullCartKey(s.id, key)] || 0; const up = unitPrice(p, u);
      return q ? `<div class="ustep"><button data-act="qty" data-s="${s.id}" data-p="${key}" data-d="-1" aria-label="إنقاص">−</button><b>${esc(u.label)} ×${q}</b><button data-act="qty" data-s="${s.id}" data-p="${key}" data-d="1" aria-label="زيادة">+</button></div>`
        : `<button class="uchip" data-act="qty" data-s="${s.id}" data-p="${key}" data-d="1">${esc(u.label)}<b>${fmt(up)}</b></button>`;
    }).join('')}</div>`;
  } else {
    const q = S.cart.items[fullCartKey(s.id, p.id)] || 0;
    const act = q ? `<div class="step"><button data-act="qty" data-s="${s.id}" data-p="${p.id}" data-d="1" aria-label="زيادة">+</button><span>${q}</span><button data-act="qty" data-s="${s.id}" data-p="${p.id}" data-d="-1" aria-label="إنقاص">−</button></div>`
      : `<button class="add" data-act="qty" data-s="${s.id}" data-p="${p.id}" data-d="1" aria-label="أضف للسلة">+</button>`;
    body = `<div class="pfoot"><span class="price">${fmt(p.price)}</span>${act}</div>`;
  }
  return `<div class="pcard${avail ? '' : ' na'}">
    <div class="pimg" style="--t:${esc(s.color || TINTS[0])}">${pimg(p, 'pe')}</div>
    <div class="pbody"><b>${esc(p.name)}</b><small>${weight ? 'السعر لكل كيلو' : esc(p.unit || '')}${showStore ? ` — ${esc(s.name)}` : ''}</small>
      ${body}
    </div>
  </div>`;
}
function cartBar() {
  if (!['home', 'cat', 'store'].includes(S.view.name)) return '';
  const bs = cartBaskets(); const n = bs.reduce((a, x) => a + x.n, 0); const sub = bs.reduce((a, x) => a + x.sub, 0);
  if (!n) return '';
  return `<div class="cartbar"><button data-act="openCart"><span><span class="n">${n}</span>عرض السلة${bs.length > 1 ? ' (متجرين)' : ''}</span><span>${fmt(sub)}</span></button></div>`;
}
function vMyOrders() {
  const list = S.orders;
  return `<div class="wrap"><h2>طلباتي</h2>
    ${list.length ? list.map((o) => `<button class="srow" data-go="order" data-arg="${o.id}" style="margin-bottom:8px">
      <span class="tile">${esc(o.storeEmoji || '🧾')}</span>
      <span class="sinfo"><b>${esc(o.storeName)}</b><small>#${esc(o.code)} — ${ago(o.createdAt)}</small><small>${fmt(o.total)}</small></span>
      <span class="pill ${ST[o.status].c}">${ST[o.status].t}</span></button>`).join('')
    : `<div class="empty"><span class="e">🧾</span>ما عندك طلبات للحين.<br><br><button class="btn" data-go="home">تصفح المتاجر</button></div>`}
  </div>`;
}
function vOrder(id) {
  const o = S.orders.find((x) => x.id === id);
  if (!o) return `<div class="wrap"><button class="back" data-go="orders">→ طلباتي</button><div class="empty">الطلب غير موجود.</div></div>`;
  const idx = FLOW.indexOf(o.status);
  let tl;
  if (o.status === 'cancelled') tl = `<ul class="tl"><li class="done">طلب جديد<small>${clock(o.createdAt)}</small></li><li class="cur">ملغي${o.cancelledBy === 'payment' ? ' (لم يكتمل الدفع)' : ''}<small>${clock(o.updatedAt)}</small></li></ul>`;
  else if (o.status === 'awaiting_payment') tl = `<div class="notice">💳 بانتظار إكمال الدفع الإلكتروني. لو ما اكتمل خلال 30 دقيقة يُلغى الطلب تلقائياً.</div><button class="btn block" style="margin-top:10px" data-act="resumePay" data-id="${o.id}">إكمال الدفع</button>`;
  else tl = `<ul class="tl">${FLOW.map((s, i) => { const lg = (o.log || []).find((l) => l.s === s); const d = s === 'onway' && o.payment !== 'cash' ? 'تم الدفع مسبقاً، الطلب في الطريق' : ST[s].d; return `<li class="${i < idx ? 'done' : i === idx ? 'cur' : ''}">${ST[s].t}<small>${lg ? clock(lg.t) : i === idx ? d : ''}</small></li>`; }).join('')}</ul>`;
  const tracking = ['picked', 'onway'].includes(o.status);
  return `<div class="wrap">
    <button class="back" data-go="orders">→ طلباتي</button>
    <div class="card">
      <div class="oh"><b>طلب #${esc(o.code)}</b><span class="pill ${ST[o.status].c}">${ST[o.status].t}</span></div>
      <div class="ol">${esc(o.storeEmoji)} ${esc(o.storeName)}</div>
      ${tl}
      ${o.driverName && ACTIVE.includes(o.status) ? `<div class="acts"><span>🛵 السائق: <b>${esc(o.driverName)}</b></span>${o.driverPhone ? `<a class="btn sm palm" href="tel:${esc(o.driverPhone)}">اتصال</a>` : ''}<button class="btn sm dark" data-act="openChat" data-id="${o.id}">💬 محادثة</button></div>` : ''}
      ${tracking ? `<div class="locline"><span class="livebadge"><span class="dot"></span>تتبع مباشر</span><span id="locAge">${trackAgeText(o)}</span></div><div id="trackMap" class="mapbox" data-order="${o.id}"></div>` : ''}
    </div>
    ${o.isCustom ? `<div class="card"><div class="ol">✍️ ${esc(o.description || '')}</div>${o.image ? `<img src="${esc(o.image)}" style="width:100%;max-width:220px;border-radius:12px;margin-top:8px">` : ''}</div>` : ''}
    <div class="card">${o.isCustom && o.priceStatus === 'pending' ? `<div class="notice">⏳ بانتظار تسعير المتجر. رسوم التوصيل ${o.fee > 0 ? fmt(o.fee) : 'مجانية'}، وراح تضاف تكلفة المنتجات بعد التسعير.</div>` : `${itemsTable(o)}${totalsX({ subtotal: o.subtotal, discount: o.discount || 0, code: o.coupon ? o.coupon.code : null, fee: o.fee, total: o.total })}`}${o.freeDeliveryUsed ? '<div class="ol">🎁 استُخدمت توصيلة مجانية لهذا الطلب</div>' : ''}${payLine(o)}</div>
    <div class="card"><div class="ol">📍 ${esc(o.customer.district)}، ${esc(o.customer.address)}</div>${o.customer.notes ? `<div class="ol">📝 ${esc(o.customer.notes)}</div>` : ''}</div>
    ${set().supportPhone ? `<div class="acts" style="margin-bottom:10px"><a class="btn line sm" href="tel:${esc(set().supportPhone)}">📞 اتصال بالإدارة</a><a class="btn wa sm" href="${waLink(set().supportPhone)}" target="_blank" rel="noopener">واتساب الإدارة</a></div>` : ''}
    ${o.refundDue ? `<div class="notice">💸 مبلغ ${fmt(o.refundDue)} مستحق لك، وبنرجعه لنفس وسيلة الدفع خلال أيام عمل.</div>` : o.refundedAt ? `<div class="notice">✅ تم استرجاع ${fmt(o.refundedAmount)}</div>` : ''}
    ${['delivered', 'cancelled'].includes(o.status) && !o.isCustom && (o.items || []).length ? `<button class="btn gold block" style="margin-bottom:8px" data-act="reorder" data-id="${o.id}">🔁 اطلب نفس الطلب مرة ثانية</button>` : ''}
    ${['new', 'awaiting_payment'].includes(o.status) ? `<button class="btn red block" data-act="custCancel" data-id="${o.id}">إلغاء الطلب</button>` : ''}
  </div>`;
}
function trackAgeText(o) {
  const l = S.driverLoc[o.id] || o.driverLoc;
  return l ? 'آخر تحديث ' + ago(l.at) : 'بانتظار موقع السائق…';
}
function payLine(o) {
  if (o.payment === 'bank') return `<div class="ol">🏦 الدفع حوالة بنكية${o.receiptUrl ? ` — <a href="${esc(o.receiptUrl)}" target="_blank" rel="noopener">عرض إثبات التحويل</a>` : ''}</div>`;
  if (o.payment === 'online') return `<div class="ol">💳 دفع إلكتروني — ${o.paymentStatus === 'paid' ? '<b>مدفوع ✅</b>' : o.paymentStatus === 'failed' ? 'لم يكتمل' : 'بانتظار الدفع'}</div>`;
  return `<div class="ol">💵 الدفع كاش عند الاستلام</div>`;
}
function itemsTable(o) { return `<table class="items">${(o.items || []).map((i) => `<tr><td>${i.qty}× ${esc(i.name)}${i.unit ? ` <span class="munit">(${esc(i.unit)})</span>` : ''}</td><td>${fmt(i.price * i.qty)}</td></tr>`).join('')}</table>`; }
function totalsX(o) { return `<div style="margin-top:8px"><div class="tot"><span>المنتجات</span><span>${fmt(o.subtotal)}</span></div>${o.discount > 0 ? `<div class="tot"><span>خصم${o.code ? ` (${esc(o.code)})` : ''}</span><span class="savings">-${fmt(o.discount)}</span></div>` : ''}<div class="tot"><span>التوصيل</span><span>${o.fee > 0 ? fmt(o.fee) : 'مجاني'}</span></div><div class="tot big"><span>الإجمالي</span><span>${fmt(o.total)}</span></div></div>`; }
function vProfile() {
  const c = S.customer || {}, st = set(), every = Math.max(2, Number(st.loyaltyEvery) || 5), have = Number(c.deliveredCount) || 0, mod = have % every, free = Number(c.freeDeliveries) || 0;
  return `<div class="wrap"><h2>بياناتي</h2>
    <div class="card"><div class="oh"><b>${esc(c.name || '')}</b></div><div class="ol" dir="ltr" style="text-align:right">📱 ${esc(c.phone || '')}</div></div>
    ${st.loyaltyOn !== false ? `<div class="offer"><div class="row" style="align-items:flex-start;gap:8px">🎁 <span>${free > 0 ? `عندك <b>${free}</b> توصيلة مجانية جاهزة — استخدمها بأي طلب جاي.` : `وصّل <b>${every - mod}</b> طلبات كمان وتاخذ توصيلة مجانية تلقائياً.`}</span></div>${free > 0 ? '' : `<div class="loybar"><div class="loyfill" style="width:${Math.round((mod / every) * 100)}%"></div></div><small class="muted">${mod}/${every}</small>`}</div>` : ''}
    ${pushBar()}
    <div class="field"><label>الاسم</label><input id="pf_name" value="${esc(c.name || '')}"></div>
    <div class="field"><label>الحي</label><select id="pf_district">${districtOpts(c.district)}</select></div>
    <div class="field"><label>وصف العنوان</label><textarea id="pf_address" placeholder="مثال: شارع الملك فهد، بيت باب أخضر جنب المسجد">${esc(c.address || '')}</textarea></div>
    <div class="field"><label>رابط الموقع (اختياري)</label><input id="pf_map" dir="ltr" value="${esc(c.map || '')}" placeholder="رابط خرائط جوجل">
      <button type="button" class="linkbtn" data-act="useMyLoc" data-t="pf_map">📍 استخدم موقعي الحالي</button></div>
    <button class="btn block" data-act="saveProfile">حفظ البيانات</button>
    <button class="btn line block" style="margin-top:8px" data-act="logout">تسجيل الخروج</button>
    ${footer()}
  </div>`;
}
function districtOpts(sel) {
  const ds = set().districts || [];
  return `<option value="">اختر الحي</option>` + ds.map((d) => `<option ${d === sel ? 'selected' : ''}>${esc(d)}</option>`).join('');
}

/* ============ خريطة التتبع (Leaflet + OpenStreetMap) ============ */
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletP) {
    leafletP = new Promise((res, rej) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css'; document.head.appendChild(css);
      const js = document.createElement('script'); js.src = '/vendor/leaflet/leaflet.js'; js.onload = () => res(window.L); js.onerror = rej; document.head.appendChild(js);
    });
  }
  return leafletP;
}
const HADAR = [22.0, 46.45]; // مركز ابتدائي تقريبي لمنطقة الهدار/الأفلاج — يتحرك تلقائياً لموقع السائق والعميل
let track = null;
async function afterRender() {
  const el = document.getElementById('trackMap');
  if (!el) { track = null; return; }
  const oid = el.dataset.order;
  const L = await loadLeaflet().catch(() => null);
  if (!L || !document.body.contains(el)) return;
  const o = S.orders.find((x) => x.id === oid);
  const m = L.map(el, { zoomControl: false, attributionControl: true }).setView(HADAR, 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  const icon = (e) => L.divIcon({ className: 'drvpin', html: e, iconSize: [30, 30], iconAnchor: [15, 15] });
  const home = o && o.customer.lat != null ? L.marker([o.customer.lat, o.customer.lng], { icon: icon('🏠') }).addTo(m) : null;
  track = { m, oid, drv: null, home, icon };
  updateTrackMap();
}
function updateTrackMap() {
  const age = document.getElementById('locAge');
  if (!track) return;
  const o = S.orders.find((x) => x.id === track.oid);
  const l = S.driverLoc[track.oid] || (o && o.driverLoc);
  if (age && o) age.textContent = trackAgeText(o);
  if (!l) return;
  if (!track.drv) track.drv = window.L.marker([l.lat, l.lng], { icon: track.icon('🛵') }).addTo(track.m);
  else track.drv.setLatLng([l.lat, l.lng]);
  if (track.home) track.m.fitBounds(window.L.latLngBounds([track.drv.getLatLng(), track.home.getLatLng()]).pad(0.3), { maxZoom: 16 });
  else track.m.setView([l.lat, l.lng], 15);
}

/* ============ واجهة السائق ============ */
function vDriver() {
  if (!loggedIn()) return vDriverLogin();
  if (!S.driver) return `<div class="wrap"><div class="empty"><span class="e">🛵</span>جارِ التحميل…</div></div>`;
  const v = S.view.name; const d = S.driver; const D = S.dOrders;
  if (v === 'mine') {
    return `<div class="wrap"><h2>طلباتي الحالية</h2>
      ${D.mine.some((o) => ['picked', 'onway'].includes(o.status)) ? `<div class="notice">📍 موقعك يُشارك مع العميل أثناء التوصيل. خلّ التطبيق مفتوح لين توصل.</div>` : ''}
      ${D.mine.length ? D.mine.map(dOrder).join('') : `<div class="empty"><span class="e">🛵</span>ما عندك طلبات حالياً. شوف الطلبات المتاحة.</div>`}</div>`;
  }
  if (v === 'done') {
    const list = D.done;
    const t = list.filter((o) => o.deliveredAt >= today0());
    return `<div class="wrap">
      <div class="stats"><div class="stat"><b>${t.length}</b><small>توصيلات اليوم</small></div><div class="stat"><b>${fmt(t.reduce((a, o) => a + (o.fee || 0), 0))}</b><small>رسوم توصيل اليوم</small></div><div class="stat"><b>${fmt(D.unsettled)}</b><small>كاش معك لم يُسلَّم للإدارة</small></div><div class="stat"><b>${D.doneCount}</b><small>كل التوصيلات</small></div></div>
      <h2>المنجزة</h2>${list.slice(0, 50).map((o) => `<div class="card"><div class="oh"><b>#${esc(o.code)}</b>${o.payment !== 'cash' ? '<span class="pill mute">مدفوع مسبقاً</span>' : o.settled ? '<span class="pill mute">تمت التسوية</span>' : '<span class="pill warn">كاش معك</span>'}<small>${ago(o.deliveredAt)}</small></div><div class="ol">${esc(o.storeName)} ← ${esc(o.customer.district)}</div><div class="ol"><b>${fmt(o.total)}</b></div></div>`).join('') || '<div class="empty">لا يوجد بعد.</div>'}
    </div>`;
  }
  return `<div class="wrap">${pushBar()}<h2>طلبات متاحة للتوصيل</h2>
    ${!d.online ? `<div class="notice">أنت غير متصل. فعّل الاتصال من الأعلى عشان تستقبل الطلبات.</div>` : ''}
    ${D.available.length ? D.available.map(dOrder).join('') : `<div class="empty"><span class="e">📦</span>ما فيه طلبات متاحة الحين. بننبهك أول ما يوصل طلب.</div>`}</div>`;
}
function vDriverLogin() {
  return `<div class="wrap"><div class="center">
    <h2>دخول السائق</h2>
    <div class="field"><label>رقم الجوال</label><input id="dl_phone" inputmode="tel" dir="ltr" placeholder="05xxxxxxxx"></div>
    <div class="field pinrow"><label>الرمز السري</label><input id="dl_pin" type="password" inputmode="numeric" maxlength="6"></div>
    <button class="btn block" data-act="driverLogin">دخول</button>
    <button type="button" class="btn line block" style="margin-top:8px" data-act="toggleCustHelp">نسيت الرمز؟</button>
    ${S.showCustHelp ? forgotHelpBox() : ''}
  </div></div>`;
}
function forgotHelpBox() {
  const sp = set().supportPhone;
  return `<div class="notice" style="margin-top:10px">الإدارة تقدر تعيّن لك رمزاً جديداً من لوحة التحكم. تواصل معنا:
    ${sp ? `<div class="acts" style="margin-top:8px;justify-content:center"><a class="btn sm palm" href="tel:${esc(sp)}">📞 اتصال</a><a class="btn sm wa" href="${waLink(sp)}" target="_blank" rel="noopener">واتساب</a></div>` : ''}</div>`;
}
function dOrder(o) {
  const c = o.customer || {};
  const prepaid = o.payment !== 'cash';
  const payLbl = o.payment === 'bank' ? 'حوالة' : 'مدفوع إلكترونياً';
  let act = '';
  if (claimableOrder(o)) act = `<button class="btn block" data-act="claim" data-id="${o.id}">استلام الطلب</button>`;
  else if (o.status === 'assigned') act = `<button class="btn block" data-act="adv" data-id="${o.id}" data-to="picked">استلمت الطلب من المتجر</button>`;
  else if (o.status === 'picked') act = `<button class="btn block" data-act="adv" data-id="${o.id}" data-to="onway">انطلقت للعميل</button>`;
  else if (o.status === 'onway') act = `<button class="btn palm block" data-act="adv" data-id="${o.id}" data-to="delivered">${prepaid ? 'تم التوصيل' : `تم التوصيل واستلمت ${fmt(o.total)} كاش`}</button>`;
  const showCust = o.driverId === (S.driver && S.driver.id);
  return `<div class="card">
    <div class="oh"><b>#${esc(o.code)}</b><span class="pill ${ST[o.status].c}">${ST[o.status].t}</span><small>${ago(o.createdAt)}</small></div>
    ${prepaid ? `<div class="ol">${o.payment === 'bank' ? '🏦' : '💳'} ${payLbl} — لا تحصّل مبلغ${o.receiptUrl ? ` — <a href="${esc(o.receiptUrl)}" target="_blank" rel="noopener">عرض الإثبات</a>` : ''}</div>` : ''}
    <div class="ol">🏪 من: <b>${esc(o.storeName)}</b>${o.storePhone ? ` — <a href="tel:${esc(o.storePhone)}">${esc(o.storePhone)}</a>` : ''}</div>
    <div class="ol">📍 إلى: <b>${esc(c.district)}</b>${showCust ? `، ${esc(c.address)}` : ''}</div>
    ${showCust ? `<div class="ol">👤 ${esc(c.name)} — <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a> — <a href="${waLink(c.phone)}" target="_blank" rel="noopener">واتساب</a>${c.map ? ` — <a href="${esc(c.map)}" target="_blank" rel="noopener">الموقع</a>` : c.lat != null ? ` — <a href="https://maps.google.com/?q=${c.lat},${c.lng}" target="_blank" rel="noopener">الموقع</a>` : ''}</div>${c.notes ? `<div class="ol">📝 ${esc(c.notes)}</div>` : ''}<div class="acts" style="margin-top:6px"><button class="btn sm dark" data-act="openChat" data-id="${o.id}">💬 محادثة العميل</button></div>` : ''}
    ${o.isCustom ? `<div class="ol">✍️ ${esc(o.description || '')}</div>` : ''}
    <details><summary>${o.isCustom ? 'تفاصيل السعر' : (o.items || []).reduce((a, i) => a + i.qty, 0) + ' منتجات'} — ${prepaid ? `${fmt(o.total)} ${payLbl}` : `حصّل ${fmt(o.total)} كاش`}</summary>${itemsTable(o)}${totalsX({ subtotal: o.subtotal, discount: o.discount || 0, code: o.coupon ? o.coupon.code : null, fee: o.fee, total: o.total })}</details>
    <div class="acts">${act}</div>
  </div>`;
}

/* مشاركة موقع السائق أثناء التوصيل (كل 10 ثوانٍ كحد أقصى) */
let geoWatch = null, lastSent = 0;
function syncTracking() {
  const need = S.role === 'driver' && S.dOrders.mine.some((o) => ['assigned', 'picked', 'onway'].includes(o.status));
  if (need && geoWatch == null && 'geolocation' in navigator) {
    geoWatch = navigator.geolocation.watchPosition((pos) => {
      if (Date.now() - lastSent < 10000) return;
      lastSent = Date.now();
      call('POST', '/api/driver/location', { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  } else if (!need && geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
}

/* ============ لوحة الإدارة ============ */
function vAdmin() {
  if (!loggedIn()) return `<div class="wrap"><div class="center"><h2>دخول الإدارة</h2>
    <div class="field pinrow"><label>الرمز السري</label><input id="ad_pin" type="password" inputmode="numeric" maxlength="8"></div>
    <button class="btn block" data-act="adminLogin">دخول</button>
    <button type="button" class="btn line block" style="margin-top:8px" data-act="forgotAdmin">نسيت الرمز؟</button>
    <p class="hint" style="margin-top:12px">غيّر الرمز الافتراضي من الإعدادات بعد أول دخول.</p></div></div>`;
  if (!S.adm) return `<div class="wrap"><div class="empty"><span class="e">🗝️</span>جارِ التحميل…</div></div>`;
  const v = S.view.name;
  if (v === 'coupons') return vCoupons();
  if (v === 'prices') return vPrices();
  if (v === 'stores') return vStores();
  if (v === 'drivers') return vDrivers();
  if (v === 'settings') return vSettings();
  return vAOrders();
}
function vAOrders() {
  const O = S.adm.orders; const t0 = today0();
  const td = O.filter((o) => o.createdAt >= t0 && o.status !== 'awaiting_payment');
  const del = td.filter((o) => o.status === 'delivered');
  const active = O.filter((o) => ACTIVE.includes(o.status));
  const f = S.orderFilter;
  const fl = { active: ['النشطة', (o) => ACTIVE.includes(o.status)], new: ['الجديدة', (o) => o.status === 'new'], delivered: ['المكتملة', (o) => o.status === 'delivered'], cancelled: ['الملغاة', (o) => o.status === 'cancelled'], refund: ['استرجاع 💸', (o) => !!o.refundDue], all: ['الكل', (o) => o.status !== 'awaiting_payment'] };
  const list = O.filter(fl[f][1]);
  return `<div class="wrap wide">
    ${pushBar()}
    <div class="stats">
      <div class="stat"><b>${td.length}</b><small>طلبات اليوم</small></div>
      <div class="stat"><b>${fmt(del.reduce((a, o) => a + (o.total || 0), 0))}</b><small>مبيعات اليوم المسلّمة</small></div>
      <div class="stat"><b>${active.length}</b><small>طلبات قيد التنفيذ</small></div>
      <div class="stat"><b>${fmt(S.adm.cashWithDrivers)}</b><small>كاش لدى السائقين</small></div>
    </div>
    ${otpCard()}
    <h2>الطلبات</h2>
    <div class="chips">${Object.entries(fl).filter(([k, [, fn]]) => k !== 'refund' || O.some(fn)).map(([k, [t, fn]]) => `<button class="chip ${k === f ? 'on' : ''}" data-act="ofilter" data-v="${k}">${t} (${O.filter(fn).length})</button>`).join('')}</div>
    ${list.length ? list.map(aOrder).join('') : `<div class="empty"><span class="e">🧾</span>لا توجد طلبات هنا.</div>`}
  </div>`;
}
function otpCard() {
  const list = (S.adm && S.adm.otp) || [];
  if (!list.length) return '';
  return `<div class="card otpcard" style="margin-top:14px">
    <div class="oh"><b>🔐 عملاء ينتظرون رمز التحقق (${list.length})</b></div>
    <p class="hint" style="margin:4px 0 8px">اضغط "إرسال بواتساب"، وبيفتح واتساب على محادثة العميل والرسالة جاهزة، وأنت تضغط إرسال.</p>
    ${list.map((r) => `<div class="otprow">
      <span><b dir="ltr">${esc(r.phone)}</b> ${r.exists ? `<small>— ${esc(r.name)}</small>` : '<span class="pill warn">جديد</span>'}<br><small class="muted">${ago(r.t)} · الرمز <b dir="ltr">${esc(r.code)}</b>${r.waSentAt ? ' · ✓ أُرسل' : ''}</small></span>
      <button class="btn sm ${r.waSentAt ? 'line' : 'wa'}" data-act="sendOtpWa" data-p="${esc(r.phone)}" data-c="${esc(r.code)}">${r.waSentAt ? 'إعادة الإرسال' : '📲 إرسال بواتساب'}</button>
    </div>`).join('')}
  </div>`;
}
function aOrder(o) {
  const c = o.customer || {};
  const ds = S.adm.drivers.filter((d) => d.active);
  const pending = o.isCustom && o.priceStatus === 'pending';
  let acts = '';
  if (ACTIVE.includes(o.status)) {
    acts = `<div class="acts">
      ${!pending && ['new', 'accepted', 'assigned'].includes(o.status) ? `<select id="as_${o.id}" aria-label="اختر سائق"><option value="">تعيين سائق يدوياً…</option>${ds.map((d) => `<option value="${d.id}" ${d.id === o.driverId ? 'selected' : ''}>${esc(d.name)}${!d.online ? ' (غير متصل)' : ''}</option>`).join('')}</select><button class="btn sm dark" data-act="assign" data-id="${o.id}">تعيين</button>` : ''}
      ${['picked', 'onway'].includes(o.status) ? `<button class="btn sm palm" data-act="adminDeliver" data-id="${o.id}">تأكيد التوصيل</button>` : ''}
      ${o.driverId ? `<button class="btn sm line" data-act="openChat" data-id="${o.id}">💬 المحادثة</button>` : ''}
      <button class="btn sm red" data-act="adminCancel" data-id="${o.id}">إلغاء</button>
    </div>`;
  }
  const payFlag = o.payment === 'bank'
    ? `<div class="ol bankflag">🏦 <b>دفع بحوالة بنكية</b>${o.receiptUrl ? ` — <a href="${esc(o.receiptUrl)}" target="_blank" rel="noopener">${o.receiptType === 'application/pdf' ? '📄 عرض ملف الإثبات' : '🖼️ عرض صورة الإثبات'}</a>` : '<span style="color:var(--danger)"> — لم يُرفق إثبات!</span>'}</div>`
    : o.payment === 'online' ? `<div class="ol bankflag">💳 <b>دفع إلكتروني</b> — ${o.paymentStatus === 'paid' ? 'مدفوع ✅' : o.paymentStatus === 'failed' ? 'فشل' : 'بانتظار الدفع'}</div>` : '';
  return `<div class="card">
    <div class="oh"><b>#${esc(o.code)}</b><span class="pill ${ST[o.status].c}">${ST[o.status].t}</span><small>${ago(o.createdAt)}</small></div>
    ${o.refundDue ? `<div class="notice errbox" style="margin:6px 0">💸 <b>يحتاج استرجاع ${fmt(o.refundDue)}</b> للعميل${o.latePayment ? ' (دفع بعد إلغاء الطلب)' : ''}<div class="acts" style="margin-top:6px"><button class="btn sm palm" data-act="markRefunded" data-id="${o.id}">تم الاسترجاع</button></div></div>` : o.refundedAt ? `<div class="ol">✅ تم استرجاع ${fmt(o.refundedAmount)}</div>` : ''}
    ${o.staleAlertAt && ['new', 'accepted'].includes(o.status) && !o.driverId ? `<div class="ol" style="color:var(--danger)">⏰ متأخر: ${o.isCustom && o.priceStatus === 'pending' ? 'ينتظر التسعير' : 'ما استلمه سائق'}</div>` : ''}
    ${payFlag}
    <div class="ol">${esc(o.storeEmoji)} <b>${esc(o.storeName)}</b>${o.storePhone ? ` — <a href="tel:${esc(o.storePhone)}">اتصال بالمتجر</a>` : ''}</div>
    <div class="ol">👤 ${esc(c.name)} — <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a> — <a href="${waLink(c.phone)}" target="_blank" rel="noopener">واتساب</a></div>
    <div class="ol">📍 ${esc(c.district)}، ${esc(c.address)}${c.map ? ` — <a href="${esc(c.map)}" target="_blank" rel="noopener">الموقع</a>` : ''}</div>
    ${c.notes ? `<div class="ol">📝 ${esc(c.notes)}</div>` : ''}
    ${o.driverName ? `<div class="ol">🛵 ${esc(o.driverName)}</div>` : ''}
    ${o.isCustom ? `<div class="card" style="margin:8px 0"><div class="ol">✍️ ${esc(o.description || '')}</div>${o.image ? `<img src="${esc(o.image)}" style="width:100%;max-width:200px;border-radius:12px;margin-top:8px">` : ''}
      ${pending ? `<div class="row" style="margin-top:10px"><input id="cp_${o.id}" type="number" min="0" step="0.5" dir="ltr" placeholder="سعر المنتجات" style="flex:1;padding:9px 10px;border-radius:11px;border:1px solid var(--line);background:var(--surface)"><button class="btn sm dark" data-act="setCustomPrice" data-id="${o.id}">تحديد السعر</button></div>` : ''}
    </div>` : ''}
    <details><summary>${o.isCustom ? 'تفاصيل السعر' : (o.items || []).reduce((a, i) => a + i.qty, 0) + ' منتجات'} — ${fmt(o.total)} ${o.payment === 'bank' ? 'حوالة' : o.payment === 'online' ? 'إلكتروني' : 'كاش'}</summary>${itemsTable(o)}${totalsX({ subtotal: o.subtotal, discount: o.discount || 0, code: o.coupon ? o.coupon.code : null, fee: o.fee, total: o.total })}</details>
    ${acts}
  </div>`;
}
function vPrices() {
  const zero = S.adm.stores.reduce((a, s) => a + (s.products || []).filter((p) => !(Number(p.price) > 0)).length, 0);
  return `<div class="wrap wide">
    <h2>الأسعار</h2>
    <p class="muted" style="margin-top:0">عدّل السعر ويُحفظ مباشرة. المنتجات بسعر صفر تظهر للعميل "السعر قريباً" ولا يمكن طلبها${zero ? `، وعندك <b>${zero}</b> منتج بدون سعر` : ''}.</p>
    <div class="search" style="margin:0 0 8px"><input type="search" id="pq" value="${esc(S.priceQ)}" placeholder="ابحث عن منتج أو متجر"></div>
    <div class="chips"><button class="chip ${S.priceFilter === 'all' ? 'on' : ''}" data-act="pfilter" data-v="all">كل المنتجات</button><button class="chip ${S.priceFilter === 'zero' ? 'on' : ''}" data-act="pfilter" data-v="zero">بدون سعر (${zero})</button><button class="chip ${S.priceFilter === 'named' ? 'on' : ''}" data-act="pfilter" data-v="named">المتاجر الظاهرة فقط</button></div>
    <div id="presults">${priceGroups(norm(S.priceQ))}</div>
  </div>`;
}
function priceGroups(q) {
  const f = S.priceFilter;
  const g = S.adm.stores.filter((s) => f !== 'named' || (s.name || '').trim()).map((s) => {
    const sm = has(s.name, q);
    const ps = (s.products || []).filter((p) => (!q || sm || has(p.name, q) || has(p.sec, q)) && (f !== 'zero' || !(Number(p.price) > 0)));
    if (!ps.length) return '';
    return `<section class="pgroup"><header><span class="tile" style="width:36px;height:36px;font-size:20px;border-radius:10px;--t:${esc(s.color || TINTS[0])}">${esc(s.emoji)}</span><h3>${esc(sname(s))}</h3><small style="margin-inline-start:auto">${ps.length} منتج</small></header>
      ${ps.map((p) => `<div class="prow"><span class="pe3">${pimg(p, '')}</span><span><b style="font-weight:500">${esc(p.name)}</b><br><small>${p.saleType === 'weight' ? 'للكيلو' : esc(p.unit || '')}</small>${p.sec ? `<small class="sec">${esc(p.sec)}</small>` : ''}</span>
        <input type="number" min="0" step="0.5" inputmode="decimal" class="${Number(p.price) > 0 ? '' : 'zero'}" value="${Number(p.price) || ''}" placeholder="السعر" data-price data-s="${s.id}" data-p="${p.id}" aria-label="سعر ${esc(p.name)}">
        <label class="sw" title="متوفر"><input type="checkbox" ${p.available !== false ? 'checked' : ''} data-avail data-s="${s.id}" data-p="${p.id}" aria-label="متوفر"><span></span></label></div>`).join('')}
    </section>`;
  }).join('');
  return g || `<div class="empty">لا نتائج.</div>`;
}
function vStores() {
  const all = S.adm.stores; const nm = all.filter((s) => (s.name || '').trim()).length;
  return `<div class="wrap wide">
    <div class="row" style="justify-content:space-between;margin-top:16px"><h2 style="margin:0">المتاجر (${all.length})</h2><button class="btn sm" data-act="newStore">+ متجر جديد</button></div>
    ${all.length - nm ? `<div class="notice">عندك ${all.length - nm} متجر بدون اسم. المتجر ما يظهر للعملاء إلا بعد ما تكتب اسمه.</div>` : ''}
    <div class="list" style="margin-top:12px">${all.map((s) => { const c = CAT[s.category] || {}; return `<div class="srow">
      <span class="tile" style="--t:${esc(s.color || TINTS[0])}">${esc(s.emoji || c.emoji)}</span>
      <span class="sinfo"><input class="inp" style="padding:7px 10px;${(s.name || '').trim() ? '' : 'border-color:var(--sun);background:var(--sun-soft)'}" data-sname data-s="${s.id}" value="${esc(s.name || '')}" placeholder="اكتب اسم المتجر" aria-label="اسم المتجر"><small>${c.name || ''} — ${(s.products || []).length} منتج، مسعّر ${(s.products || []).filter((p) => Number(p.price) > 0).length}</small></span>
      <label class="sw" title="مفتوح"><input type="checkbox" ${s.open !== false ? 'checked' : ''} data-open data-s="${s.id}" aria-label="مفتوح"><span></span></label>
      <button class="btn sm line" data-act="editStore" data-id="${s.id}">تعديل</button></div>`; }).join('')}</div>
  </div>`;
}
function vDrivers() {
  const ds = S.adm.drivers;
  return `<div class="wrap wide">
    <div class="row" style="justify-content:space-between;margin-top:16px"><h2 style="margin:0">السائقون (${ds.length})</h2><button class="btn sm" data-act="newDriver">+ سائق جديد</button></div>
    <div style="margin-top:12px">${ds.map((d) => `<div class="card"><div class="oh"><b>🛵 ${esc(d.name)}</b>${!d.active ? '<span class="pill off">موقوف</span>' : !d.online ? '<span class="pill mute">غير متصل</span>' : '<span class="pill on">متصل</span>'}</div>
        <div class="ol"><a href="tel:${esc(d.phone)}">${esc(d.phone || '')}</a>${d.vehicle ? ` — ${esc(d.vehicle)}` : ''}${d.loc ? ` — <a href="https://maps.google.com/?q=${d.loc.lat},${d.loc.lng}" target="_blank" rel="noopener">📍 آخر موقع (${ago(d.loc.at)})</a>` : ''}</div>
        <div class="ol">طلبات حالية: <b>${d.activeCount}</b> — منجزة: <b>${d.doneCount}</b> — كاش معه: <b>${fmt(d.cash)}</b></div>
        <div class="acts">${d.cash > 0 ? `<button class="btn sm palm" data-act="settle" data-id="${d.id}">استلمت ${fmt(d.cash)} منه</button>` : ''}<button class="btn sm line" data-act="editDriver" data-id="${d.id}">تعديل</button></div></div>`).join('') || '<div class="empty"><span class="e">🛵</span>أضف أول سائق.</div>'}</div>
  </div>`;
}
function vCoupons() {
  const list = S.adm.coupons;
  return `<div class="wrap wide">
    <div class="row" style="justify-content:space-between;margin-top:16px"><h2 style="margin:0">الكوبونات والعروض (${list.length})</h2><button class="btn sm" data-act="newCoupon">+ كوبون</button></div>
    ${loyaltyCard()}
    ${list.length ? list.map(couponRow).join('') : '<div class="empty"><span class="e">🎟️</span>ما فيه كوبونات بعد. أنشئ أول كوبون للعملاء.</div>'}
  </div>`;
}
function couponRow(c) {
  const kindLbl = { percent: 'نسبة خصم', fixed: 'خصم ثابت', free_delivery: 'توصيل مجاني' }[c.kind] || c.kind;
  const val = c.kind === 'percent' ? c.value + '%' : c.kind === 'fixed' ? fmt(c.value) : '—';
  const catsTxt = c.categories && c.categories.length ? c.categories.map((x) => (CAT[x] || {}).name || x).join('، ') : 'كل الأقسام';
  return `<div class="card">
    <div class="oh"><b style="direction:ltr">${esc(c.code)}</b><span class="pill ${c.active ? 'on' : 'off'}">${c.active ? 'مفعّل' : 'موقوف'}</span></div>
    <div class="ol">${kindLbl} — ${val}${c.minOrder ? ` — حد أدنى ${fmt(c.minOrder)}` : ''}</div>
    <div class="ol">${catsTxt} — استُخدم ${c.usedCount || 0}${c.maxUses ? ` من ${c.maxUses}` : ''}${c.expiresAt ? ` — ينتهي ${new Date(c.expiresAt).toLocaleDateString('ar-SA-u-nu-latn')}` : ''}</div>
    ${c.note ? `<div class="ol">📝 ${esc(c.note)}</div>` : ''}
    <div class="acts"><button class="btn sm line" data-act="editCoupon" data-id="${esc(c.code)}">تعديل</button></div>
  </div>`;
}
function loyaltyCard() {
  const st = S.adm.settings;
  return `<div class="card">
    <div class="oh"><b>🎁 برنامج الولاء التلقائي</b></div>
    <div class="ol">توصيل مجاني تلقائي للعميل بعد عدد طلبات محدد، بدون أي كود.</div>
    <label class="row" style="margin-top:10px"><span class="sw"><input type="checkbox" id="lo_on" ${st.loyaltyOn !== false ? 'checked' : ''}><span></span></span> مفعّل</label>
    <div class="field" style="margin-top:8px"><label>عدد الطلبات لكل توصيلة مجانية</label><input id="lo_every" type="number" min="2" dir="ltr" value="${Number(st.loyaltyEvery) || 5}"></div>
    <button class="btn sm dark" data-act="saveLoyalty">حفظ</button>
  </div>`;
}
function vSettings() {
  const st = S.adm.settings;
  return `<div class="wrap">
    <h2>إعدادات التوصيل</h2>
    <div class="two"><div class="field"><label>رسوم التوصيل (ر.س)</label><input id="st_fee" type="number" min="0" step="0.5" dir="ltr" value="${Number(st.deliveryFee) || 0}"></div>
    <div class="field"><label>الحد الأدنى للطلب (ر.س)</label><input id="st_min" type="number" min="0" step="1" dir="ltr" value="${Number(st.minOrder) || 0}"></div></div>
    <div class="field"><label>أحياء الهدار المتاحة للتوصيل</label><textarea id="st_districts" style="min-height:130px">${esc((st.districts || []).join('\n'))}</textarea><span class="hint">كل حي في سطر. العميل لا يقدر يطلب إلا لحي من هذه القائمة.</span></div>
    <div class="field"><label>رقم تواصل الإدارة (يظهر للعملاء)</label><input id="st_support" dir="ltr" inputmode="tel" value="${esc(st.supportPhone || '')}" placeholder="05xxxxxxxx"></div>
    <div class="field"><label>إعلان يظهر للعملاء (اختياري)</label><input id="st_ann" value="${esc(st.announcement || '')}" placeholder="مثال: التوصيل مجاني يوم الجمعة"></div>
    <div class="field"><label>طريقة التحقق من جوال العميل</label>
      <select id="st_verify"><option value="whatsapp" ${st.verifyModeActive === 'whatsapp' ? 'selected' : ''}>واتساب الإدارة (أنت ترسل الرمز يدوياً)</option><option value="sms" ${st.verifyModeActive === 'sms' ? 'selected' : ''} ${st.smsReady ? '' : 'disabled'}>رسالة نصية تلقائية${st.smsReady ? '' : ' — يحتاج تفعيل مزوّد الرسائل'}</option></select>
      <span class="hint">${st.smsReady ? 'مزوّد الرسائل مفعّل.' : 'مزوّد الرسائل (Unifonic أو Taqnyat) مو مفعّل للحين، فالتحقق يتم عن طريق واتساب الإدارة تلقائياً.'} المستخدم يسجّل مرة وحدة كل 90 يوم.</span></div>
    <div class="field"><label>نبّهني إذا طلب ما استلمه سائق خلال (دقيقة)</label><input id="st_alert" type="number" min="0" max="120" dir="ltr" value="${Number(st.alertAfterMin ?? 7)}"><span class="hint">يوصلك تنبيه، ويتذكّر السائقين المتصلين بالطلب. ينطبق كذلك على الطلبات الخاصة اللي ما تسعّرت. اكتب 0 لإيقافه.</span></div>
    <h2>بيانات المنشأة</h2>
    <p class="hint" style="margin-top:0">تظهر في أسفل التطبيق وصفحات السياسات. بوابة الدفع (Moyasar) ونظام التجارة الإلكترونية يطلبونها.</p>
    <div class="field"><label>اسم المنشأة (كما في السجل التجاري)</label><input id="st_legal" value="${esc(st.legalName || '')}"></div>
    <div class="two"><div class="field"><label>رقم السجل التجاري</label><input id="st_cr" dir="ltr" inputmode="numeric" value="${esc(st.crNumber || '')}"></div>
    <div class="field"><label>الرقم الضريبي (اختياري)</label><input id="st_vat" dir="ltr" inputmode="numeric" value="${esc(st.vatNumber || '')}"></div></div>
    <details class="card"><summary>📄 نصوص السياسات (الشروط، الخصوصية، الاسترجاع)</summary>
      <p class="hint">نصوص مبدئية جاهزة. راجعها مع مختص قانوني وعدّلها قبل الإطلاق. تظهر على <a href="/legal/terms" data-legal="terms">صفحة السياسات</a>.</p>
      ${['terms', 'privacy', 'refund'].map((k) => `<div class="field"><label>${LEGAL_T[k]}</label><textarea id="lg_${k}" style="min-height:180px">${esc((st.legal || {})[k] || '')}</textarea></div>`).join('')}
    </details>
    <h2>طرق الدفع</h2>
    ${PAY.map((p) => { const live = p.id === 'cash' || p.id === 'bank' || st.payments.online; return `<div class="pay ${live ? 'sel' : 'dis'}"><span class="pe2">${p.e}</span><b>${p.name}</b>${live ? '<span class="pill on">مفعّل</span>' : '<span class="pill mute">يحتاج ربط بوابة دفع</span>'}</div>`; }).join('')}
    <p class="hint">${st.payments.online ? 'بوابة الدفع الإلكتروني مربوطة ومفعّلة.' : 'الدفع الإلكتروني (مدى، Apple Pay، STC Pay، البطاقات) يتفعّل تلقائياً بعد إضافة مفاتيح بوابة الدفع (Moyasar) في إعدادات الخادم.'}</p>
    <label class="row" style="margin:12px 0"><span class="sw"><input type="checkbox" id="st_bankon" ${st.payments.bank === false ? '' : 'checked'}><span></span></span> قبول الدفع بالحوالة البنكية</label>
    <div class="field"><label>اسم البنك</label><input id="st_bankname" value="${esc(st.bankName || '')}" placeholder="مثال: بنك الراجحي"></div>
    <div class="two"><div class="field"><label>اسم صاحب الحساب</label><input id="st_bankholder" value="${esc(st.bankHolder || '')}"></div>
    <div class="field"><label>رقم الآيبان</label><input id="st_bankiban" dir="ltr" value="${esc(st.bankIban || '')}" placeholder="SA00 0000 0000 0000 0000 0000"></div></div>
    <p class="hint" style="margin-top:-4px">هذي البيانات تظهر للعميل عند اختيار الدفع بالحوالة، ويرفع صورة أو PDF لإثبات التحويل قبل إرسال الطلب.</p>
    <h2>الأمان</h2>
    <div class="field pinrow"><label>رمز دخول جديد للإدارة</label><input id="st_pin" type="password" inputmode="numeric" maxlength="8" value="" placeholder="••••" autocomplete="new-password"><span class="hint">اتركه فاضي إذا ما تبي تغيّر الرمز. تغيير الرمز يسجّل خروج أي جهاز آخر.</span></div>
    <div class="field"><label>رمز استرجاع احتياطي (لو نسيت رمز الدخول)</label><input id="st_recovery" type="password" autocomplete="new-password" placeholder="${st.hasRecovery ? '•••••• (معدّ مسبقاً — اتركه فاضي إذا ما تبي تغيّره)' : 'مثال: عبارة أو رمز يصعب تخمينه'}"><span class="hint">${st.hasRecovery ? 'مفعّل. احفظه في مكان آمن.' : 'لسا ما عندك رمز استرجاع. لو نسيت رمز الدخول بدون هذا الرمز، بتحتاج إعادة ضبط من الخادم.'}</span></div>
    <button class="btn block" data-act="saveSettings">حفظ الإعدادات</button>
    <h2>المنتجات والأسعار في Excel</h2>
    <p class="hint" style="margin-top:0">نزّل كل المتاجر والمنتجات في ملف، وعبّئ الأسعار وأسماء المتاجر في Excel، وارفعه. يعدّل الأسعار والأسماء والأقسام والتوفّر. سطر بدون <b dir="ltr">product_id</b> يضيف منتج جديد للمتجر.</p>
    <div class="row"><button class="btn line" data-act="csvExport">⬇️ تنزيل الملف</button><button class="btn line" data-act="csvPick">⬆️ رفع الملف بعد التعديل</button></div>
    <input type="file" id="csvIn" accept=".csv,text/csv" hidden>
    ${S._csvLog ? `<div class="card" style="margin-top:10px">${S._csvLog.map((l) => `<div class="ol">${esc(l)}</div>`).join('')}</div>` : ''}
    <h2>استيراد بيانات النسخة القديمة</h2>
    <p class="hint" style="margin-top:0">ارفع ملف الحزمة (<b dir="ltr">alhadar-import.json</b>) لنقل المتاجر والمنتجات وصورها، والأحياء، وبيانات الحوالة، والكوبونات، والسائقين. <b>تنبيه:</b> رمز دخول الإدارة يصير نفس رمز النسخة القديمة بعد الاستيراد، وتحتاج تسجّل دخولك فيه من جديد.</p>
    <button class="btn line block" data-act="importPick">📦 اختيار ملف البيانات</button>
    <input type="file" id="importIn" accept="application/json,.json" hidden>
    ${S._importLog ? `<div class="card" style="margin-top:10px">${S._importLog.map((l) => `<div class="ol">${esc(l)}</div>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:14px"><button class="btn line block" data-act="logout">تسجيل الخروج</button></div>
  </div>`;
}

/* ============ النوافذ السفلية ============ */
function openSheet(s) { S.sheet = s; renderSheet(); }
function closeSheet() { S.sheet = null; S.edit = null; document.getElementById('sheet').innerHTML = ''; }
function askConfirm(msg, onYes, cls) { S._confirmPrev = S.sheet; S._confirmMsg = msg; S._confirmYes = onYes; S._confirmCls = cls || 'red'; S.sheet = { type: 'confirm' }; renderSheet(); }
function renderSheet() {
  const el = document.getElementById('sheet'); const s = S.sheet;
  if (!s) { el.innerHTML = ''; return; }
  const fns = { cart: shCart, checkout: shCheckout, store: shStore, driver: shDriver, coupon: shCoupon, confirm: shConfirm, chat: shChat, recover: shRecover };
  const prevScroll = el.querySelector('.sh') ? el.querySelector('.sh').scrollTop : 0;
  el.innerHTML = `<div class="bd" data-act="bdClose"><div class="sh" role="dialog" aria-modal="true">${fns[s.type]()}</div></div>`;
  const sh = el.querySelector('.sh'); if (sh && s.keepScroll) sh.scrollTop = prevScroll;
  s.keepScroll = true;
  if (s.type === 'chat') { const c = document.getElementById('chatList'); if (c) c.scrollTop = c.scrollHeight; }
}
const shHead = (t, closeAct = 'close') => `<div class="grab"></div><div class="shtitle"><h3>${t}</h3><button class="x" data-act="${closeAct}" aria-label="إغلاق">✕</button></div>`;
function shRecover() {
  if (S.recover && S.recover.token) {
    return shHead('تعيين رمز دخول جديد') + `
    <div class="field pinrow"><label>الرمز الجديد (4-8 أرقام)</label><input id="rc_new" type="password" inputmode="numeric" maxlength="8"></div>
    <div class="field pinrow"><label>تأكيد الرمز الجديد</label><input id="rc_new2" type="password" inputmode="numeric" maxlength="8"></div>
    <button class="btn block" data-act="recoverSetPin">حفظ الرمز الجديد</button>`;
  }
  return shHead('استرجاع الدخول') + `
    <div class="field"><label>رمز الاسترجاع الاحتياطي</label><input id="rc_phrase" type="password" autocomplete="off"></div>
    <button class="btn block" data-act="recoverVerify">تحقق</button>
    <p class="hint">لو ما عندك رمز استرجاع، يعيد مطوّر المنصة ضبط الرمز من الخادم (راجع دليل التشغيل).</p>`;
}
function shConfirm() {
  return shHead('تأكيد', 'confirmNo') + `
    <p style="margin:0 0 18px">${esc(S._confirmMsg || '')}</p>
    <div class="row">
      <button class="btn ${S._confirmCls || 'red'} block" data-act="confirmYes">تأكيد</button>
      <button class="btn line block" data-act="confirmNo">تراجع</button>
    </div>`;
}
function findOrder(id) {
  if (S.role === 'customer') return S.orders.find((x) => x.id === id);
  if (S.role === 'driver') return [...S.dOrders.mine, ...S.dOrders.available, ...S.dOrders.done].find((x) => x.id === id);
  return S.adm && S.adm.orders.find((x) => x.id === id);
}
function shChat() {
  const oid = S.chatOrderId; const o = findOrder(oid);
  const msgs = S.chatMsgs[oid];
  const me = meRole();
  const other = S.role === 'driver' ? (o ? o.customer.name : 'العميل') : S.role === 'admin' ? 'العميل والسائق' : (o ? o.driverName || 'السائق' : 'السائق');
  return shHead(`محادثة مع ${esc(other || '')} — #${o ? esc(o.code) : ''}`) + `
    <div id="chatList" class="chatlist">${!msgs ? '<p class="muted" style="text-align:center">جارِ التحميل…</p>' : msgs.length ? msgs.map((m) => chatBubble(m, me)).join('') : '<p class="muted" style="text-align:center">ابدأ المحادثة…</p>'}</div>
    <div class="chatrow"><input id="chatInput" placeholder="اكتب رسالتك…" autocomplete="off"><button class="btn sm dark" data-act="sendChat" data-id="${oid}">إرسال</button></div>`;
}
function chatBubble(m, me) {
  const mine = m.from === me;
  const label = { customer: 'العميل', driver: 'السائق', admin: 'الإدارة' }[m.from] || m.from;
  return `<div class="cbub ${mine ? 'me' : ''}"><div class="cb-inner">${mine ? '' : `<small>${esc(label)} — ${clock(m.t)}</small>`}<div>${esc(m.text)}</div>${mine ? `<small style="text-align:left">${clock(m.t)}</small>` : ''}</div></div>`;
}
function totalsSimple(o) { return `<div style="margin-top:8px"><div class="tot"><span>المنتجات</span><span>${fmt(o.subtotal)}</span></div><div class="tot"><span>التوصيل</span><span>${o.fee > 0 ? fmt(o.fee) : 'مجاني'}</span></div><div class="tot big"><span>الإجمالي</span><span>${fmt(o.total)}</span></div></div>`; }
function shCart() {
  const bs = cartBaskets(); const st = set();
  const totalN = bs.reduce((a, x) => a + x.n, 0);
  if (!totalN) return shHead('السلة') + `<div class="empty">السلة فاضية.</div>`;
  const fee = Number(st.deliveryFee) || 0;
  const belowMin = bs.filter((x) => st.minOrder > 0 && x.sub < st.minOrder);
  const grandSub = bs.reduce((a, x) => a + x.sub, 0);
  const grandFee = fee * bs.length;
  return shHead('السلة' + (bs.length > 1 ? ' (متجرين)' : '')) + `
    ${bs.map((c) => `
      <div class="cartstore">${esc(c.s.emoji || '🏪')} ${esc(c.s.name)}</div>
      ${c.lines.map(({ p, q, u, key, price }) => `<div class="citem"><span class="pe3">${pimg(p, '')}</span><div class="n"><b style="font-weight:500">${esc(p.name)}</b><br><small>${u ? esc(u.label) + ' · ' : ''}${fmt(price)}</small></div>
        <div class="step"><button data-act="qty" data-s="${c.s.id}" data-p="${key}" data-d="1" data-sheet="1">+</button><span>${q}</span><button data-act="qty" data-s="${c.s.id}" data-p="${key}" data-d="-1" data-sheet="1">−</button></div></div>`).join('')}
      <div class="tot" style="margin:6px 0 2px"><span>مجموع ${esc(c.s.name)}</span><span>${fmt(c.sub)}</span></div>
      ${st.minOrder > 0 && c.sub < st.minOrder ? `<div class="notice">الحد الأدنى لطلب ${esc(c.s.name)}: ${fmt(st.minOrder)}</div>` : ''}
    `).join('<hr class="cartdiv">')}
    <div style="margin-top:10px">${totalsSimple({ subtotal: grandSub, fee: grandFee, total: grandSub + grandFee })}</div>
    ${bs.length > 1 ? `<p class="hint">هذا طلبان منفصلان (طلب لكل متجر)، كل وحد برسوم توصيل مستقلة، ويوصلونك بشكل منفصل.</p>` : ''}
    <button class="btn block" style="margin-top:14px" data-act="toCheckout" ${belowMin.length ? 'disabled' : ''}>متابعة الطلب</button>
    <button class="btn line block" style="margin-top:8px" data-act="clearCart">تفريغ السلة</button>`;
}
function addressFields(cust, withNotes) {
  const d = S.checkoutDraft || {};
  const val = (k, def) => (d[k] !== undefined ? d[k] : def || '');
  return `<div class="field"><label>الاسم</label><input id="co_name" value="${esc(val('co_name', cust.name))}" autocomplete="name"></div>
    <div class="field"><label>رقم الجوال</label><input value="${esc(cust.phone || '')}" disabled dir="ltr"></div>
    <div class="field"><label>الحي</label><select id="co_district">${districtOpts(val('co_district', cust.district))}</select></div>
    <div class="field"><label>وصف العنوان</label><textarea id="co_address" placeholder="الشارع، لون الباب، أقرب معلم">${esc(val('co_address', cust.address))}</textarea></div>
    <div class="field"><label>رابط الموقع (اختياري)</label><input id="co_map" dir="ltr" value="${esc(val('co_map', cust.map))}" placeholder="رابط خرائط جوجل">
      <button type="button" class="linkbtn" data-act="useMyLoc" data-t="co_map">📍 استخدم موقعي الحالي</button></div>
    ${withNotes ? `<div class="field"><label>ملاحظات للطلب (اختياري)</label><input id="co_notes" value="${esc(val('co_notes', ''))}" placeholder="مثال: بدون بصل"></div>` : ''}`;
}
function shCheckout() {
  if (S.checkoutCustom) return shCheckoutCustom();
  const baskets = cartBaskets(); const st = set(); const cust = S.customer || {};
  const qx = S.quote;
  const freeAvail = Number(cust.freeDeliveries) || 0;
  const bankOn = st.payments.bank !== false; const onlineOn = !!st.payments.online;
  const pay = S.payMethod === 'bank' && bankOn ? 'bank' : S.payMethod === 'online' && onlineOn ? 'online' : 'cash';
  const receipt = S.checkoutReceipt;
  const storesLine = baskets.map((x) => x.s.name).join(' + ');
  const etaMax = baskets.length ? Math.max(...baskets.map((x) => Number(x.s.eta) || 30)) : 30;
  const total = qx ? qx.grandTotal : 0;
  return shHead('تأكيد الطلب') + `
    <div class="zone" style="margin:0 0 14px">📍 التوصيل داخل الهدار فقط · من ${esc(storesLine)} · 🕒 ${etaMax} دقيقة تقريباً</div>
    ${baskets.length > 1 ? `<div class="notice">طلبك بيصير طلبين منفصلين (وحد لكل متجر)، كل وحد برسوم توصيل خاصة فيه، ويوصلونك بشكل منفصل.</div>` : ''}
    ${addressFields(cust, true)}
    <div class="field"><label>كود الخصم (اختياري)</label>
      <div class="couponrow"><input id="co_coupon" value="${esc(S.couponCode || '')}" dir="ltr" placeholder="مثال: HADAR10">
      <button class="btn sm dark" type="button" data-act="applyCoupon">تطبيق</button></div>
      ${S.couponMsg ? `<div class="hint" id="couponMsg" style="color:${S.couponOk ? 'var(--palm)' : 'var(--danger)'}">${esc(S.couponMsg)}</div>` : ''}
    </div>
    ${freeAvail > 0 ? `<label class="row" style="margin:0 0 12px"><span class="sw"><input type="checkbox" id="co_free" ${S.useFreeDelivery ? 'checked' : ''}><span></span></span> استخدم توصيلة مجانية (متبقي ${freeAvail})</label>` : ''}
    <h3 style="margin:16px 0 10px">طريقة الدفع</h3>
    <div class="payopts">
      <button type="button" class="pay ${pay === 'cash' ? 'sel' : ''}" data-act="pickPay" data-v="cash"><span class="pe2">💵</span><b>كاش عند الاستلام</b>${pay === 'cash' ? '<span class="pill on">✓</span>' : ''}</button>
      ${bankOn ? `<button type="button" class="pay ${pay === 'bank' ? 'sel' : ''}" data-act="pickPay" data-v="bank"><span class="pe2">🏦</span><b>حوالة بنكية</b>${pay === 'bank' ? '<span class="pill on">✓</span>' : ''}</button>` : ''}
      ${onlineOn ? `<button type="button" class="pay ${pay === 'online' ? 'sel' : ''}" data-act="pickPay" data-v="online"><span class="pe2">💳</span><b>مدى / Apple Pay / STC Pay / بطاقة</b>${pay === 'online' ? '<span class="pill on">✓</span>' : ''}</button>` : ''}
    </div>
    ${onlineOn ? '' : PAY.filter((p) => p.id !== 'cash' && p.id !== 'bank').map((p) => `<div class="pay dis"><span class="pe2">${p.e}</span><b>${p.name}</b><span class="pill mute">قريباً</span></div>`).join('')}
    ${pay === 'bank' ? `<div class="card bankbox" style="margin-top:10px">
      <div class="ol">🏦 <b>${esc(st.bankName || '—')}</b></div>
      <div class="ol">👤 ${esc(st.bankHolder || '—')}</div>
      <div class="row" style="justify-content:space-between;align-items:center;margin-top:4px"><span class="iban" dir="ltr">${esc(st.bankIban || '—')}</span>${st.bankIban ? '<button type="button" class="btn sm line" data-act="copyIban">نسخ</button>' : ''}</div>
      <p class="hint" style="margin:8px 0 10px">حوّل مبلغ <b>${fmt(total)}</b> على الحساب أعلاه${baskets.length > 1 ? ' (يغطي الطلبين معاً)' : ''}، ثم ارفع صورة أو PDF لإثبات التحويل قبل إرسال الطلب.</p>
      ${receipt ? `<div class="rcpt"><span class="ok">✅ ${receipt.type === 'application/pdf' ? '📄 ملف PDF مرفوع' : '🖼️ صورة مرفوعة'}</span><button type="button" class="btn sm line" data-act="rcptUpload">تغيير</button></div>`
        : `<button type="button" class="btn sm dark" data-act="rcptUpload">📎 إرفاق إثبات التحويل</button>`}
      <input type="file" id="rcptIn" accept="image/*,application/pdf" hidden>
    </div>` : ''}
    ${pay === 'online' ? `<p class="hint" style="margin-top:8px">بعد إرسال الطلب تنتقل لصفحة الدفع الآمنة، والطلب يوصل للسائقين بعد تأكيد الدفع.</p>` : ''}
    <div class="card" style="margin-top:12px" id="coTotals">
      ${!qx ? '<div class="muted">جارِ حساب المجموع…</div>' : `
      ${qx.rows.length > 1 ? qx.rows.map((r) => `<div class="tot"><span>${esc(r.storeName)}</span><span>${fmt(r.total)}</span></div>`).join('') : ''}
      ${totalsX({ subtotal: qx.grandSub, discount: qx.grandDiscount, code: S.couponOk ? S.couponCode : null, fee: qx.grandFee, total: qx.grandTotal })}`}
    </div>
    <p class="hint" style="text-align:center">بإرسال الطلب أنت توافق على <a href="/legal/terms" data-legal="terms">الشروط</a> و<a href="/legal/refund" data-legal="refund">سياسة الاسترجاع</a></p>
    <button class="btn block" data-act="placeOrder" ${qx ? '' : 'disabled'}>${pay === 'bank' ? `أرسل الطلب — ${fmt(total)} حوالة` : pay === 'online' ? `متابعة للدفع — ${fmt(total)}` : `أرسل الطلب — ${fmt(total)} كاش`}</button>`;
}
function shCheckoutCustom() {
  const cust = S.customer || {}; const st = set(); const co = S.customOrder || {};
  const s = stores().find((x) => x.id === co.storeId);
  const freeAvail = Number(cust.freeDeliveries) || 0;
  const useFree = S.useFreeDelivery && freeAvail > 0;
  const fee0 = Number(st.deliveryFee) || 0;
  const fee = useFree ? 0 : fee0;
  return shHead('طلب خاص') + `
    <div class="zone" style="margin:0 0 14px">✍️ من ${esc(s ? s.name : '')} · سيحدد المتجر السعر قبل التأكيد</div>
    <div class="notice" style="margin-bottom:14px">${esc(co.desc || '')}${co.img ? `<br><img src="${esc(co.img)}" style="width:100%;max-width:200px;border-radius:12px;margin-top:8px">` : ''}</div>
    ${addressFields(cust, false)}
    ${freeAvail > 0 ? `<label class="row" style="margin:0 0 12px"><span class="sw"><input type="checkbox" id="co_free" ${useFree ? 'checked' : ''}><span></span></span> استخدم توصيلة مجانية (متبقي ${freeAvail})</label>` : ''}
    <div class="card"><div class="tot"><span>رسوم التوصيل</span><span>${fee > 0 ? fmt(fee) : 'مجاني'}</span></div></div>
    <p class="hint" style="margin-top:8px">سعر المنتجات يحدده المتجر بعد مراجعة طلبك، والدفع كاش عند الاستلام. راح يوصلك المجموع النهائي على صفحة الطلب.</p>
    <button class="btn block" style="margin-top:10px" data-act="placeCustomOrder">إرسال الطلب للمتجر</button>`;
}
function shStore() {
  const e = S.edit;
  return shHead(e._new ? 'متجر جديد' : 'تعديل المتجر') + `
    <div class="field"><label>اسم المتجر</label><input data-e="name" value="${esc(e.name)}"></div>
    <div class="two"><div class="field"><label>التصنيف</label><select data-e="category">${CATS.map((c) => `<option value="${c.id}" ${c.id === e.category ? 'selected' : ''}>${c.name}</option>`).join('')}</select></div>
    <div class="field"><label>الرمز (إيموجي)</label><input data-e="emoji" value="${esc(e.emoji || '')}" maxlength="4"></div></div>
    <div class="two"><div class="field"><label>وقت التوصيل (دقيقة)</label><input data-e="eta" type="number" min="5" dir="ltr" value="${Number(e.eta) || 30}"></div>
    <div class="field"><label>جوال المتجر</label><input data-e="phone" dir="ltr" inputmode="tel" value="${esc(e.phone || '')}"></div></div>
    <div class="field"><label>وصف قصير</label><input data-e="desc" value="${esc(e.desc || '')}" placeholder="مثال: مندي ومظبي وأكلات نجدية"></div>
    <div class="field"><label>مواعيد العمل (تلقائي بتوقيت الرياض)</label>
      <div class="two"><div><small class="muted">يفتح</small><input type="time" data-e="openAt" value="${esc(e.openAt || '')}" dir="ltr"></div><div><small class="muted">يغلق</small><input type="time" data-e="closeAt" value="${esc(e.closeAt || '')}" dir="ltr"></div></div>
      <span class="hint">المتجر يقفل ويفتح تلقائياً بهذي المواعيد، ويدعم الدوام اللي يعدّي منتصف الليل (مثل 4:00م إلى 2:00ص). اتركها فاضية لو المتجر مفتوح طول اليوم.${e.hours && !e.openAt ? ` النص القديم: "${esc(e.hours)}"` : ''}</span></div>
    <div class="field"><label>ملاحظة تظهر في صفحة المتجر (اختياري)</label><input data-e="note" value="${esc(e.note || '')}"></div>
    <div class="field"><label>لون الخلفية</label><div class="row">${TINTS.map((t) => `<button data-act="tint" data-v="${t}" aria-label="لون" style="width:34px;height:34px;border-radius:10px;background:${t};border:2px solid ${e.color === t ? 'var(--ink)' : 'var(--line)'}"></button>`).join('')}</div></div>
    <div class="row" style="justify-content:space-between;margin:18px 0 10px"><h3>المنتجات (${e.products.length})</h3><button class="btn sm" data-act="addProd">+ منتج</button></div>
    <p class="hint" style="margin-top:-4px">اضغط على صورة المنتج لرفع صورة حقيقية.</p>
    ${e.products.map((p, i) => {
      const weight = p.saleType === 'weight';
      return `<div class="pedit">
      <div class="r1"><button class="ph" data-act="upImg" data-i="${i}" aria-label="صورة المنتج">${pimg(p, '')}</button><input class="inp" data-pe="${i}:name" value="${esc(p.name)}" placeholder="اسم المنتج"></div>
      <div class="seg" style="margin-top:8px"><button type="button" class="segb ${!weight ? 'on' : ''}" data-act="prodType" data-i="${i}" data-v="count">بالعدد/العبوة</button><button type="button" class="segb ${weight ? 'on' : ''}" data-act="prodType" data-i="${i}" data-v="weight">بالوزن (كيلو)</button></div>
      ${weight ? `<div class="r2"><input class="inp" data-pe="${i}:price" type="number" min="0" step="0.5" dir="ltr" value="${Number(p.price) || ''}" placeholder="السعر لكل كيلو"><input class="inp" data-pe="${i}:emoji" value="${esc(p.emoji || '')}" maxlength="4" aria-label="إيموجي"></div>
      <p class="hint" style="margin:6px 0 4px">الأوزان المتاحة للعميل يختار منها:</p>
      <div class="ucks">${UNIT_PRESETS.map((u, ui) => `<button type="button" class="uck ${(p.units || []).some((x) => x.label === u.label) ? 'on' : ''}" data-act="toggleUnit" data-i="${i}" data-u="${ui}">${u.label}</button>`).join('')}</div>`
        : `<div class="r2"><input class="inp" data-pe="${i}:unit" value="${esc(p.unit || '')}" placeholder="الوحدة/الحجم"><input class="inp" data-pe="${i}:price" type="number" min="0" step="0.5" dir="ltr" value="${Number(p.price) || ''}" placeholder="السعر"><input class="inp" data-pe="${i}:emoji" value="${esc(p.emoji || '')}" maxlength="4" aria-label="إيموجي"></div>`}
      <input class="inp" style="margin-top:8px" data-pe="${i}:sec" value="${esc(p.sec || '')}" placeholder="القسم (مثال: المشروبات)" list="secList">
      <div class="acts" style="margin-top:8px">${p.img ? `<button class="btn sm line" data-act="rmImg" data-i="${i}">إزالة الصورة</button>` : ''}<button class="btn sm red" data-act="rmProd" data-i="${i}">حذف المنتج</button></div>
    </div>`;
    }).join('')}
    <datalist id="secList">${[...new Set(e.products.map((p) => (p.sec || '').trim()).filter(Boolean))].map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
    <input type="file" id="imgIn" accept="image/*" hidden>
    <button class="btn block" style="margin-top:12px" data-act="saveStore">حفظ المتجر</button>
    ${e._new ? '' : `<button class="btn red block" style="margin-top:8px" data-act="delStore">حذف المتجر</button>`}`;
}
function shDriver() {
  const e = S.edit;
  return shHead(e._new ? 'سائق جديد' : 'تعديل السائق') + `
    <div class="field"><label>الاسم</label><input data-e="name" value="${esc(e.name || '')}"></div>
    <div class="field"><label>الجوال (يستخدمه للدخول)</label><input data-e="phone" dir="ltr" inputmode="tel" value="${esc(e.phone || '')}"></div>
    <div class="field"><label>المركبة (اختياري)</label><input data-e="vehicle" value="${esc(e.vehicle || '')}" placeholder="مثال: هايلكس بيضاء"></div>
    <div class="field pinrow"><label>${e._new ? 'الرمز السري للدخول' : 'رمز سري جديد (اختياري)'}</label><input data-e="pin" inputmode="numeric" maxlength="6" value="" autocomplete="new-password"><span class="hint">من 4 إلى 6 أرقام، ويُحفظ مشفّراً${e._new ? '' : '. اتركه فاضي لإبقاء الرمز الحالي'}.</span></div>
    <label class="row" style="margin-bottom:14px"><span class="sw"><input type="checkbox" data-e="active" ${e.active !== false ? 'checked' : ''}><span></span></span> الحساب مفعّل</label>
    <button class="btn block" data-act="saveDriver">حفظ</button>
    ${e._new ? '' : `<button class="btn red block" style="margin-top:8px" data-act="delDriver">حذف السائق</button>`}`;
}
function shCoupon() {
  const e = S.edit;
  return shHead(e._new ? 'كوبون جديد' : 'تعديل الكوبون') + `
    <div class="field"><label>الكود</label><input data-e="code" value="${esc(e.code || '')}" dir="ltr" placeholder="HADAR10" ${e._new ? '' : 'disabled'}></div>
    <div class="field"><label>النوع</label><select data-e="kind" data-rerender="1">
      <option value="percent" ${e.kind === 'percent' ? 'selected' : ''}>نسبة خصم %</option>
      <option value="fixed" ${e.kind === 'fixed' ? 'selected' : ''}>خصم ثابت (ر.س)</option>
      <option value="free_delivery" ${e.kind === 'free_delivery' ? 'selected' : ''}>توصيل مجاني</option>
    </select></div>
    ${e.kind !== 'free_delivery' ? `<div class="field"><label>القيمة${e.kind === 'percent' ? ' (%)' : ' (ر.س)'}</label><input data-e="value" type="number" min="0" step="${e.kind === 'percent' ? '1' : '0.5'}" dir="ltr" value="${Number(e.value) || ''}"></div>` : ''}
    <div class="two"><div class="field"><label>حد أدنى للطلب (اختياري)</label><input data-e="minOrder" type="number" min="0" dir="ltr" value="${Number(e.minOrder) || ''}"></div>
    <div class="field"><label>عدد مرات الاستخدام (اختياري)</label><input data-e="maxUses" type="number" min="1" dir="ltr" value="${e.maxUses || ''}"></div></div>
    <div class="field"><label>تاريخ الانتهاء (اختياري)</label><input data-e="expiresAt" type="date" dir="ltr" value="${e.expiresAt ? (typeof e.expiresAt === 'number' ? new Date(e.expiresAt + 3 * 3600e3).toISOString().slice(0, 10) : e.expiresAt) : ''}"></div>
    <div class="field"><label>الأقسام المشمولة (اتركها فاضية لكل الأقسام)</label>
    <div class="row">${CATS.map((c) => `<button data-act="toggleCat" data-v="${c.id}" type="button" class="chip ${(e.categories || []).includes(c.id) ? 'on' : ''}">${c.emoji} ${c.name}</button>`).join('')}</div></div>
    <label class="row" style="margin:10px 0"><span class="sw"><input type="checkbox" data-e="oncePerCustomer" ${e.oncePerCustomer !== false ? 'checked' : ''}><span></span></span> مرة واحدة لكل عميل</label>
    <label class="row" style="margin-bottom:10px"><span class="sw"><input type="checkbox" data-e="active" ${e.active !== false ? 'checked' : ''}><span></span></span> مفعّل</label>
    <div class="field"><label>ملاحظة داخلية (اختياري)</label><input data-e="note" value="${esc(e.note || '')}"></div>
    <button class="btn block" data-act="saveCoupon">حفظ الكوبون</button>
    ${e._new ? '' : `<button class="btn red block" style="margin-top:8px" data-act="delCoupon">حذف الكوبون</button>`}`;
}

/* ============ الأحداث ============ */
function go(name, arg) {
  if (name === 'store' && (S.view.name !== 'store' || S.view.arg !== arg)) { S.storeChoice = 'list'; S.customOrder = {}; }
  S.view = { name, arg };
  syncUrl();
  render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  if (/^\/legal\//.test(location.pathname)) return;
  S.legal = null;
  const role = roleFromPath(location.pathname);
  if (S.sheet) closeSheet();
  if (role !== S.role) { S.role = role; S.view = { name: ROLE_HOME[role] }; startRole(); return; }
  if (role === 'customer') { S.view = viewFromPath(location.pathname); render(); window.scrollTo(0, 0); }
});
document.addEventListener('click', async (e) => {
  const lg = e.target.closest('[data-legal]');
  if (lg) { e.preventDefault(); closeSheet(); openLegal(lg.dataset.legal); return; }
  const g = e.target.closest('[data-go]');
  if (g) { go(g.dataset.go, g.dataset.arg); return; }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'bdClose') { if (e.target === b) { if (S.sheet && S.sheet.type === 'confirm') ACT.confirmNo(); else closeSheet(); } return; }
  const fn = ACT[a];
  if (fn) {
    if (b.tagName !== 'LABEL') e.preventDefault();
    if (b.disabled) return;
    const wasDisabled = b.disabled;
    try { await fn(b, e); }
    catch (err) { console.warn(err); toast(err && err.message ? err.message : 'صار خطأ غير متوقع، حاول مرة أخرى'); }
    finally { if (document.body.contains(b) && !wasDisabled) b.disabled = false; }
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') { S.q = t.value; updateResults(); return; }
  if (t.id === 'pq') { S.priceQ = t.value; const el = document.getElementById('presults'); if (el) el.innerHTML = priceGroups(norm(S.priceQ)); return; }
  if (t.id && t.id.indexOf('co_') === 0 && t.id !== 'co_free' && t.id !== 'co_coupon') { S.checkoutDraft[t.id] = t.value; return; }
  if (t.id === 'cs_desc') { S.customOrder = S.customOrder || {}; S.customOrder.desc = t.value; return; }
  if (t.id === 'au_name') { S.authName = t.value; return; }
  if (S.edit && t.dataset.e && t.type !== 'checkbox') { S.edit[t.dataset.e] = t.value; if (t.dataset.rerender) renderSheet(); return; }
  if (S.edit && t.dataset.pe) { const [i, f] = t.dataset.pe.split(':'); S.edit.products[+i][f] = f === 'price' ? Number(t.value) || 0 : t.value; }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'co_free') { S.useFreeDelivery = t.checked; await refreshQuote(); return; }
  if (t.id && t.id.indexOf('co_') === 0 && t.id !== 'co_coupon') { S.checkoutDraft[t.id] = t.value; return; }
  if (S.edit && t.dataset.e) { S.edit[t.dataset.e] = t.type === 'checkbox' ? t.checked : t.value; if (t.dataset.rerender) renderSheet(); return; }
  try {
    if (t.hasAttribute('data-price')) {
      const v = Math.max(0, Number(t.value) || 0); t.classList.toggle('zero', !(v > 0));
      await call('PATCH', `/api/admin/stores/${t.dataset.s}/products/${t.dataset.p}`, { price: v });
      patchLocalProduct(t.dataset.s, t.dataset.p, { price: v }); toast('تم حفظ السعر'); return;
    }
    if (t.hasAttribute('data-avail')) {
      await call('PATCH', `/api/admin/stores/${t.dataset.s}/products/${t.dataset.p}`, { available: t.checked });
      patchLocalProduct(t.dataset.s, t.dataset.p, { available: t.checked }); toast(t.checked ? 'المنتج متوفر' : 'المنتج غير متوفر'); return;
    }
    if (t.hasAttribute('data-sname')) {
      const v = t.value.trim(); const s = S.adm.stores.find((x) => x.id === t.dataset.s);
      if (!s || v === (s.name || '')) return;
      await call('PATCH', '/api/admin/stores/' + s.id, { name: v }); s.name = v;
      toast(v ? 'تم حفظ الاسم، المتجر ظاهر للعملاء' : 'المتجر مخفي عن العملاء'); return;
    }
    if (t.hasAttribute('data-open')) {
      await call('PATCH', '/api/admin/stores/' + t.dataset.s, { open: t.checked });
      toast(t.checked ? 'المتجر مفتوح' : 'المتجر مغلق'); return;
    }
  } catch (err) { toast(err.message); return; }
  if (t.id === 'imgIn' && t.files && t.files[0]) uploadProductImg(t.files[0]);
  if (t.id === 'csImgIn' && t.files && t.files[0]) uploadCustomPhoto(t.files[0]);
  if (t.id === 'rcptIn' && t.files && t.files[0]) uploadReceipt(t.files[0]);
  if (t.id === 'importIn' && t.files && t.files[0]) importData(t.files[0]);
  if (t.id === 'csvIn' && t.files && t.files[0]) importCsv(t.files[0]);
});
async function importCsv(file) {
  toast('جارِ رفع الملف…');
  try {
    const fd = new FormData(); fd.append('file', file, file.name);
    const r = await call('POST', '/api/admin/products.csv', fd);
    S._csvLog = [`✅ تحديث ${r.updated} منتج، إضافة ${r.added} منتج، تسمية ${r.storesRenamed} متجر${r.skipped ? `، تخطّي ${r.skipped} سطر` : ''}`, ...r.errors];
    await Promise.all([loadRole(), loadBoot()]); render(); toast('تم تحديث المنتجات ✅');
  } catch (err) { toast(err.message); }
}
async function importData(file) {
  askConfirm('استيراد البيانات من "' + file.name + '"؟ المتاجر والإعدادات الحالية بتنستبدل ببيانات الملف.', async () => {
    toast('جارِ الاستيراد…');
    const fd = new FormData(); fd.append('file', file, file.name);
    const r = await call('POST', '/api/admin/import', fd);
    S._importLog = r.log.concat(['تم الاستيراد ✅']);
    await loadBoot();
    if (r.adminChanged) {
      tokens.clear('admin'); S.adm = null;
      toast('تم الاستيراد ✅ سجّل دخولك برمز الإدارة القديم');
      S.view = { name: 'aorders' }; startRole(); return;
    }
    await loadRole(); render(); toast('تم الاستيراد ✅');
  }, 'palm');
}
function patchLocalProduct(sid, pid, patch) {
  const s = S.adm && S.adm.stores.find((x) => x.id === sid); if (!s) return;
  s.products = s.products.map((p) => (p.id === pid ? Object.assign({}, p, patch) : p));
}

async function refreshQuote() {
  if (!S.sheet || S.sheet.type !== 'checkout' || S.checkoutCustom) { renderSheet(); return; }
  try {
    const q = await call('POST', '/api/checkout/quote', { items: cartLines(), coupon: S.couponOk || S._tryCoupon ? S.couponCode : '', useFree: S.useFreeDelivery });
    S.quote = q;
    if (S._tryCoupon) { S.couponOk = q.couponOk; S.couponMsg = q.couponMsg; S._tryCoupon = false; if (!q.couponOk) { S.quote = await call('POST', '/api/checkout/quote', { items: cartLines(), coupon: '', useFree: S.useFreeDelivery }); } }
  } catch (err) { toast(err.message); }
  renderSheet();
}
function resetCheckout() {
  S.coupon = null; S.couponCode = ''; S.couponMsg = ''; S.couponOk = false; S.useFreeDelivery = false; S.checkoutDraft = {};
  S.payMethod = 'cash'; S.checkoutReceipt = null; S.quote = null; S.checkoutCustom = false;
}
function draftCustomer() {
  const v = (id) => ((document.getElementById(id) || {}).value || '').trim();
  const d = { name: v('co_name'), district: v('co_district'), address: v('co_address'), map: v('co_map'), notes: v('co_notes') };
  if (S._loc) { d.lat = S._loc.lat; d.lng = S._loc.lng; }
  return d;
}

const ACT = {
  legalTab(b) { S.legal = b.dataset.v; history.replaceState({ legal: S.legal }, '', '/legal/' + S.legal); render(); },
  closeLegal() { S.legal = null; history.replaceState(null, '', pathFor(S.role, S.view)); render(); },
  switchRole() { closeSheet(); S.role = 'customer'; S.view = { name: 'home' }; syncUrl(); syncTracking(); startRole(); },
  toRole(b) { closeSheet(); S.role = b.dataset.v; S.view = { name: ROLE_HOME[S.role] }; syncUrl(); startRole(); },
  async shareStore(b) {
    const url = location.origin + '/store/' + encodeURIComponent(b.dataset.id);
    const title = b.dataset.n + ' — الهدار درايف';
    try {
      if (navigator.share) { await navigator.share({ title, text: 'اطلب من ' + b.dataset.n + ' على الهدار درايف', url }); return; }
      await navigator.clipboard.writeText(url); toast('تم نسخ رابط المتجر');
    } catch (e) { if (e && e.name !== 'AbortError') toast(url); }
  },
  logout() {
    const r = S.role; tokens.clear(r);
    S.customer = null; S.driver = null; S.adm = null; S.orders = []; S.authStep = 'phone'; S.authErr = '';
    S.view = { name: ROLE_HOME[r] }; syncUrl(true);
    syncTracking(); startRole();
  },
  async enablePush() { await enablePush(S.role, S.boot.vapidKey); lss('hd.pushAsked.' + S.role, true); toast('تم تفعيل الإشعارات 🔔'); render(); },
  dismissPush() { lss('hd.pushAsked.' + S.role, true); render(); },
  qty(b) {
    const sid = b.dataset.s, rawKey = b.dataset.p, d = +b.dataset.d;
    const active = cartStoreIds();
    if (d > 0 && !active.includes(sid) && active.length >= MAX_CART_STORES) { toast('تقدر تطلب من متجرين بحد أقصى بنفس الوقت — أفرغ منتجات متجر عشان تضيف من هذا المتجر'); return; }
    const key = fullCartKey(sid, rawKey);
    const q = Math.max(0, (S.cart.items[key] || 0) + d);
    if (q) S.cart.items[key] = q; else delete S.cart.items[key];
    saveCart();
    if (b.dataset.sheet) renderSheet();
    render();
  },
  openCart() { openSheet({ type: 'cart' }); },
  pickPay(b) { S.payMethod = b.dataset.v; renderSheet(); },
  copyIban() { const iban = (set().bankIban || '').trim(); if (!iban) return; (navigator.clipboard ? navigator.clipboard.writeText(iban) : Promise.reject()).then(() => toast('تم نسخ رقم الآيبان')).catch(() => toast('تعذر النسخ، انسخه يدوياً')); },
  copyCode(b) { const code = b.dataset.v; (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject()).then(() => toast('تم نسخ الكود ' + code + ' — الصقه عند الدفع')).catch(() => toast('الكود: ' + code)); S.couponCode = code; },
  rcptUpload() { const el = document.getElementById('rcptIn'); if (el) el.click(); },
  async confirmYes() {
    const fn = S._confirmYes; const prev = S._confirmPrev; S._confirmYes = null; S._confirmPrev = null;
    try { if (fn) await fn(); }
    finally { if (S.sheet && S.sheet.type === 'confirm') { S.sheet = prev || null; renderSheet(); } }
  },
  confirmNo() { S.sheet = S._confirmPrev || null; S._confirmPrev = null; S._confirmYes = null; renderSheet(); },
  async openChat(b) {
    const oid = b.dataset.id; S.chatOrderId = oid;
    openSheet({ type: 'chat' });
    S.chatMsgs[oid] = await call('GET', `/api/orders/${oid}/chat`);
    if (S.sheet && S.sheet.type === 'chat') renderSheet();
  },
  async sendChat(b) {
    const oid = b.dataset.id; const el = document.getElementById('chatInput'); const text = (el.value || '').trim();
    if (!text) return; el.value = '';
    const m = await call('POST', `/api/orders/${oid}/chat`, { text });
    const list = S.chatMsgs[oid] = S.chatMsgs[oid] || [];
    if (!list.some((x) => x.id === m.id)) list.push(m);
    renderSheet();
    const inp = document.getElementById('chatInput'); if (inp) inp.focus();
  },
  useMyLoc(b) {
    if (!('geolocation' in navigator)) { toast('جهازك ما يدعم تحديد الموقع'); return; }
    toast('جارِ تحديد موقعك…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;
      S._loc = { lat, lng };
      const url = `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
      const el = document.getElementById(b.dataset.t); if (el) el.value = url;
      if (b.dataset.t === 'co_map') S.checkoutDraft.co_map = url;
      toast('تم تحديد موقعك ✅');
    }, () => toast('ما قدرنا نحدد موقعك، تأكد من السماح بالوصول للموقع'), { enableHighAccuracy: true, timeout: 15000 });
  },
  storeMode(b) { S.storeChoice = b.dataset.v; render(); },
  csPhoto() {
    if (!loggedIn()) { askLogin(null); return; } const el = document.getElementById('csImgIn'); if (el) el.click(); },
  csContinue(b) {
    const desc = (document.getElementById('cs_desc').value || '').trim();
    if (!desc) { toast('اكتب وصف طلبك'); return; }
    if (!(set().districts || []).length) { toast('التوصيل غير متاح حالياً'); return; }
    S.customOrder = Object.assign({}, S.customOrder, { desc, storeId: b.dataset.s });
    if (!loggedIn()) { askLogin('custom'); return; }
    S.checkoutDraft = {}; S.checkoutCustom = true;
    openSheet({ type: 'checkout' });
  },
  async placeCustomOrder(b) {
    const co = S.customOrder || {};
    b.disabled = true;
    const o = await call('POST', '/api/orders/custom', { storeId: co.storeId, description: co.desc, imageId: co.imgId || null, customer: draftCustomer(), useFree: S.useFreeDelivery });
    S.customOrder = {}; S.storeChoice = 'list'; resetCheckout();
    await loadRole();
    closeSheet(); toast('تم إرسال طلبك للمتجر'); go('order', o.id);
  },
  toSec(b) { const h = document.getElementById('sec_' + b.dataset.v); if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  pfilter(b) { S.priceFilter = b.dataset.v; render(); },
  close() { closeSheet(); },
  clearCart() { S.cart = { items: {} }; saveCart(); resetCheckout(); closeSheet(); render(); },
  async toCheckout() {
    if (!(set().districts || []).length) { toast('التوصيل غير متاح حالياً'); return; }
    if (!loggedIn()) { askLogin('checkout'); return; }
    S.checkoutDraft = {}; S.checkoutCustom = false; S.quote = null;
    if (S.couponCode && !S.couponOk) S._tryCoupon = true;
    openSheet({ type: 'checkout' });
    await refreshQuote();
  },
  async applyCoupon() {
    S.couponCode = (document.getElementById('co_coupon').value || '').trim().toUpperCase();
    if (!S.couponCode) { S.couponOk = false; S.couponMsg = ''; await refreshQuote(); return; }
    S._tryCoupon = true; S.couponOk = false;
    await refreshQuote();
  },
  async placeOrder(b) {
    const st = set();
    const pay = S.payMethod === 'bank' && st.payments.bank !== false ? 'bank' : S.payMethod === 'online' && st.payments.online ? 'online' : 'cash';
    if (pay === 'bank' && !S.checkoutReceipt) { toast('أرفق صورة أو PDF لإثبات التحويل قبل إرسال الطلب'); return; }
    b.disabled = true;
    const r = await call('POST', '/api/orders', {
      items: cartLines(), coupon: S.couponOk ? S.couponCode : '', useFree: S.useFreeDelivery, customer: draftCustomer(),
      payment: pay, receiptId: S.checkoutReceipt ? S.checkoutReceipt.id : null,
    });
    S.cart = { items: {} }; saveCart(); resetCheckout();
    if (r.payUrl) { toast('جارِ تحويلك لصفحة الدفع…'); location.href = r.payUrl; return; }
    await loadRole();
    closeSheet();
    toast(r.orders.length > 1 ? 'تم إرسال طلبيك' : 'تم إرسال طلبك');
    if (r.orders.length > 1) go('orders'); else go('order', r.orders[0].id);
  },
  custCancel(b) {
    askConfirm('تبي تلغي الطلب؟', async () => {
      try { await call('POST', `/api/orders/${b.dataset.id}/cancel`); toast('تم إلغاء الطلب'); }
      catch (err) { toast(err.message); }
      await loadRole(); render();
    });
  },
  async resumePay(b) {
    b.disabled = true;
    try { const r = await call('GET', `/api/orders/${b.dataset.id}/pay`); location.href = r.url; }
    catch (err) { toast(err.message); await loadRole(); render(); }
  },
  reorder(b) {
    const o = S.orders.find((x) => x.id === b.dataset.id); if (!o) return;
    const s = stores().find((x) => x.id === o.storeId);
    if (!s) { toast('المتجر غير متاح حالياً'); return; }
    const others = cartStoreIds().filter((id) => id !== s.id);
    if (others.length >= MAX_CART_STORES) { toast('سلتك فيها متجرين، أفرغها أول'); return; }
    let added = 0, missing = 0;
    for (const it of o.items) {
      const p = (s.products || []).find((x) => x.id === it.id);
      if (!p || !(Number(p.price) > 0) || p.available === false) { missing++; continue; }
      let key = p.id;
      if (Array.isArray(p.units) && p.units.length) {
        const ui = p.units.findIndex((u) => u.label === it.unit);
        if (ui < 0) { missing++; continue; }
        key = p.id + '~' + ui;
      }
      const k = fullCartKey(s.id, key);
      S.cart.items[k] = (S.cart.items[k] || 0) + it.qty; added++;
    }
    saveCart();
    if (!added) { toast('المنتجات هذي ما عادت متوفرة'); return; }
    toast(missing ? `انضاف ${added} منتج للسلة، و${missing} ما عاد متوفر` : 'انضاف طلبك للسلة ✅');
    go('store', s.id);
    if (storeOpenNow(s)) openSheet({ type: 'cart' });
  },
  sendOtpWa(b) {
    const phone = b.dataset.p, code = b.dataset.c;
    /* نفتح واتساب قبل أي انتظار عشان المتصفح ما يحجب النافذة */
    window.open(waLink(phone) + '?text=' + encodeURIComponent(`رمز الدخول للهدار درايف: ${code}\nلا تشاركه مع أحد.`), '_blank', 'noopener');
    call('POST', `/api/admin/otp/${encodeURIComponent(phone)}/sent`).then(() => refreshSoon()).catch(() => {});
  },
  async markRefunded(b) {
    const o = S.adm.orders.find((x) => x.id === b.dataset.id); if (!o) return;
    askConfirm(`تأكيد إنك رجّعت ${fmt(o.refundDue)} للعميل ${o.customer.name}؟`, async () => { await call('POST', `/api/admin/orders/${o.id}/refunded`); toast('تم تسجيل الاسترجاع'); await loadRole(); render(); }, 'palm');
  },
  async saveProfile(b) {
    const v = (id) => document.getElementById(id).value.trim();
    b.disabled = true;
    S.customer = await call('PATCH', '/api/me', { name: v('pf_name'), district: v('pf_district'), address: v('pf_address'), map: v('pf_map'), ...(S._loc || {}) });
    toast('تم حفظ بياناتك');
  },

  /* حساب العميل */
  async authPhone(b) {
    const phone = (document.getElementById('au_phone').value || '').trim();
    S.authPhone = phone; S.authErr = ''; b.disabled = true;
    try {
      const r = await api('POST', '/api/auth/otp', { phone });
      S.authExists = r.exists; S.devCode = r.devCode || ''; S.authStep = 'code'; S.resendAt = Date.now() + 60000;
      S.authChannel = r.channel; S.authSupport = r.supportPhone || '';
      tickResend();
    } catch (err) { S.authErr = err.message; }
    render();
    const c = document.getElementById(S.authExists ? 'au_code' : 'au_name'); if (c) c.focus();
  },
  async authResend(b) {
    b.disabled = true;
    try { const r = await api('POST', '/api/auth/otp', { phone: S.authPhone }); S.devCode = r.devCode || ''; S.resendAt = Date.now() + 60000; S.authErr = ''; toast('تم إرسال رمز جديد'); tickResend(); }
    catch (err) { S.authErr = err.message; }
    render();
  },
  authBack() { S.authStep = 'phone'; S.authErr = ''; S.devCode = ''; render(); },
  async authVerify(b) {
    const code = (document.getElementById('au_code').value || '').trim();
    const nameEl = document.getElementById('au_name'); const name = nameEl ? nameEl.value.trim() : '';
    if (!S.authExists && !name) { S.authErr = 'اكتب اسمك'; render(); return; }
    b.disabled = true;
    try {
      const r = await api('POST', '/api/auth/verify', { phone: S.authPhone, code, name });
      tokens.set('customer', r.token); S.authStep = 'phone'; S.authErr = ''; S.devCode = '';
      const after = S.afterLogin; S.afterLogin = null;
      if (S.view.name === 'login') { S.view = S.returnView || { name: 'home' }; S.returnView = null; syncUrl(true); }
      await startRole();
      toast('أهلاً ' + (S.customer ? S.customer.name : '') + ' 👋');
      if (after === 'checkout') ACT.toCheckout();
      else if (after === 'custom') { S.checkoutDraft = {}; S.checkoutCustom = true; openSheet({ type: 'checkout' }); }
    } catch (err) { S.authErr = err.message; render(); }
  },

  /* السائق */
  async driverLogin(b) {
    b.disabled = true;
    const r = await api('POST', '/api/driver/login', { phone: document.getElementById('dl_phone').value, pin: document.getElementById('dl_pin').value.trim() });
    tokens.set('driver', r.token); S.view = { name: 'available' };
    await startRole();
  },
  async drvOnline() {
    S.driver = await call('POST', '/api/driver/online', { online: !S.driver.online });
    toast(S.driver.online ? 'أنت متصل' : 'أنت غير متصل'); render();
  },
  async claim(b) {
    if (!S.driver.online) { toast('فعّل الاتصال أولاً'); return; }
    b.disabled = true;
    try { await call('POST', `/api/driver/orders/${b.dataset.id}/claim`); toast('الطلب صار عندك'); await loadRole(); go('mine'); }
    catch (err) { toast(err.message); await loadRole(); render(); }
  },
  adv(b) {
    const o = S.dOrders.mine.find((x) => x.id === b.dataset.id); if (!o) return; const to = b.dataset.to;
    const run = async () => { await call('POST', `/api/driver/orders/${o.id}/advance`, { to }); toast(ST[to].t); await loadRole(); render(); };
    if (to === 'delivered' && o.payment === 'cash') { askConfirm('تأكد أنك استلمت ' + fmt(o.total) + ' كاش من العميل', run, 'palm'); return; }
    if (to === 'delivered') { askConfirm('تأكيد توصيل الطلب #' + o.code + '؟', run, 'palm'); return; }
    b.disabled = true;
    return run();
  },
  toggleCustHelp() { S.showCustHelp = !S.showCustHelp; render(); },

  /* الإدارة */
  async adminLogin(b) {
    b.disabled = true;
    const r = await api('POST', '/api/admin/login', { pin: document.getElementById('ad_pin').value.trim() });
    tokens.set('admin', r.token); S.view = { name: 'aorders' };
    await startRole();
  },
  async csvExport(b) {
    b.disabled = true;
    const r = await fetch('/api/admin/products.csv', { headers: { Authorization: 'Bearer ' + tokens.get('admin') } });
    if (!r.ok) { toast('تعذر التنزيل، سجّل دخولك من جديد'); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = 'alhadar-products.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('تم تنزيل الملف — افتحه في Excel');
  },
  csvPick() { const el = document.getElementById('csvIn'); if (el) { el.value = ''; el.click(); } },
  importPick() { const el = document.getElementById('importIn'); if (el) { el.value = ''; el.click(); } },
  forgotAdmin() { S.recover = {}; openSheet({ type: 'recover' }); },
  async recoverVerify(b) {
    const phrase = (document.getElementById('rc_phrase').value || '').trim();
    if (!phrase) { toast('اكتب رمز الاسترجاع'); return; }
    b.disabled = true;
    S.recover = { token: (await api('POST', '/api/admin/recover/verify', { phrase })).token }; renderSheet();
  },
  async recoverSetPin(b) {
    const p1 = document.getElementById('rc_new').value.trim(), p2 = document.getElementById('rc_new2').value.trim();
    if (!/^\d{4,8}$/.test(p1)) { toast('الرمز الجديد من 4 إلى 8 أرقام'); return; }
    if (p1 !== p2) { toast('الرمزان غير متطابقين'); return; }
    b.disabled = true;
    await api('POST', '/api/admin/recover/reset', { token: S.recover.token, pin: p1 });
    S.recover = null; closeSheet(); toast('تم تعيين رمز دخول جديد، سجّل دخولك فيه الآن');
  },
  ofilter(b) { S.orderFilter = b.dataset.v; render(); },
  async setCustomPrice(b) {
    const el = document.getElementById('cp_' + b.dataset.id); const sub = Math.max(0, Number(el.value) || 0);
    if (!(sub > 0)) { toast('اكتب سعراً صحيحاً'); return; }
    b.disabled = true;
    await call('POST', `/api/admin/orders/${b.dataset.id}/price`, { subtotal: sub });
    toast('تم تحديد السعر، الطلب صار متاح للسائقين'); await loadRole(); render();
  },
  async assign(b) {
    const did = document.getElementById('as_' + b.dataset.id).value;
    if (!did) { toast('اختر سائق'); return; }
    b.disabled = true;
    await call('POST', `/api/admin/orders/${b.dataset.id}/assign`, { driverId: did });
    toast('تم تعيين ' + (S.adm.drivers.find((d) => d.id === did) || {}).name); await loadRole(); render();
  },
  adminDeliver(b) {
    const o = S.adm.orders.find((x) => x.id === b.dataset.id); if (!o) return;
    askConfirm('تأكيد توصيل الطلب #' + o.code + '؟', async () => { await call('POST', `/api/admin/orders/${o.id}/deliver`); toast('تم التوصيل'); await loadRole(); render(); }, 'palm');
  },
  adminCancel(b) {
    const o = S.adm.orders.find((x) => x.id === b.dataset.id); if (!o) return;
    askConfirm('إلغاء الطلب #' + o.code + '؟', async () => { await call('POST', `/api/orders/${o.id}/cancel`); toast('تم الإلغاء'); await loadRole(); render(); });
  },
  settle(b) {
    const d = S.adm.drivers.find((x) => x.id === b.dataset.id); if (!d) return;
    askConfirm('تأكيد استلام ' + fmt(d.cash) + ' من ' + d.name + '؟', async () => {
      try { await call('POST', `/api/admin/drivers/${d.id}/settle`, { expected: d.cash }); toast('تمت التسوية'); }
      catch (err) { toast(err.message); }
      await loadRole(); render();
    }, 'palm');
  },
  newCoupon() { S.edit = { _new: true, code: '', note: '', kind: 'percent', value: 10, minOrder: 0, maxUses: null, expiresAt: null, categories: [], oncePerCustomer: true, active: true }; openSheet({ type: 'coupon' }); },
  editCoupon(b) { const c = S.adm.coupons.find((x) => x.code === b.dataset.id); if (!c) return; S.edit = Object.assign({}, c, { categories: [...(c.categories || [])] }); openSheet({ type: 'coupon' }); },
  toggleCat(b) { const e = S.edit; const v = b.dataset.v; e.categories = e.categories || []; const i = e.categories.indexOf(v); if (i > -1) e.categories.splice(i, 1); else e.categories.push(v); renderSheet(); },
  async saveCoupon(b) {
    const e = S.edit; const code = (e.code || '').trim().toUpperCase();
    b.disabled = true;
    await call('PUT', '/api/admin/coupons/' + encodeURIComponent(code || '-'), { ...e, isNew: !!e._new });
    closeSheet(); toast('تم حفظ الكوبون'); await loadRole(); render();
  },
  delCoupon() { const e = S.edit; askConfirm('حذف الكوبون ' + e.code + '؟', async () => { await call('DELETE', '/api/admin/coupons/' + encodeURIComponent(e.code)); closeSheet(); toast('تم الحذف'); await loadRole(); render(); }); },
  async saveLoyalty(b) {
    b.disabled = true;
    const r = await call('PUT', '/api/admin/settings', { loyaltyOn: document.getElementById('lo_on').checked, loyaltyEvery: document.getElementById('lo_every').value });
    S.adm.settings = r.settings; toast('تم الحفظ');
  },
  newStore() { S.edit = { _new: true, name: '', category: 'restaurants', emoji: '🏪', eta: 30, phone: '', note: '', color: TINTS[0], open: true, products: [] }; openSheet({ type: 'store' }); },
  editStore(b) { const s = S.adm.stores.find((x) => x.id === b.dataset.id); if (!s) return; S.edit = JSON.parse(JSON.stringify(s)); openSheet({ type: 'store' }); },
  tint(b) { S.edit.color = b.dataset.v; renderSheet(); },
  addProd() { S.edit.products.unshift({ id: 'p' + uid(), name: '', unit: '', price: 0, emoji: '📦', available: true, sec: '' }); renderSheet(); },
  rmProd(b) { const i = +b.dataset.i; askConfirm('حذف المنتج؟', () => { S.edit.products.splice(i, 1); }); },
  rmImg(b) { delete S.edit.products[+b.dataset.i].img; renderSheet(); },
  upImg(b) { S.edit._imgIdx = +b.dataset.i; document.getElementById('imgIn').click(); },
  prodType(b) {
    const i = +b.dataset.i, v = b.dataset.v, p = S.edit.products[i];
    if (v === 'weight') { if (!Array.isArray(p.units) || !p.units.length) p.units = [UNIT_PRESETS[3]]; p.saleType = 'weight'; }
    else { delete p.saleType; delete p.units; }
    renderSheet();
  },
  toggleUnit(b) {
    const i = +b.dataset.i, ui = +b.dataset.u, p = S.edit.products[i], u = UNIT_PRESETS[ui];
    p.units = Array.isArray(p.units) ? p.units.slice() : [];
    const idx = p.units.findIndex((x) => x.label === u.label);
    if (idx >= 0) { if (p.units.length > 1) p.units.splice(idx, 1); } else p.units.push(u);
    p.units.sort((a, c) => a.mult - c.mult);
    renderSheet();
  },
  async saveStore(b) {
    const e = S.edit; if (!(e.name || '').trim()) { toast('اكتب اسم المتجر'); return; }
    b.disabled = true;
    await call('PUT', '/api/admin/stores/' + (e._new ? 'new' : e.id), e);
    closeSheet(); toast('تم حفظ المتجر'); await Promise.all([loadRole(), loadBoot()]); render();
  },
  delStore() { const e = S.edit; askConfirm('حذف "' + e.name + '" نهائياً؟', async () => { await call('DELETE', '/api/admin/stores/' + e.id); closeSheet(); toast('تم حذف المتجر'); await Promise.all([loadRole(), loadBoot()]); render(); }); },
  newDriver() { S.edit = { _new: true, name: '', phone: '', vehicle: '', pin: '', active: true }; openSheet({ type: 'driver' }); },
  editDriver(b) { const d = S.adm.drivers.find((x) => x.id === b.dataset.id); if (!d) return; S.edit = Object.assign({}, d, { pin: '' }); openSheet({ type: 'driver' }); },
  async saveDriver(b) {
    const e = S.edit;
    b.disabled = true;
    await call('PUT', '/api/admin/drivers/' + (e._new ? 'new' : e.id), e);
    closeSheet(); toast('تم حفظ السائق'); await loadRole(); render();
  },
  delDriver() { const e = S.edit; askConfirm('حذف السائق ' + e.name + '؟', async () => { await call('DELETE', '/api/admin/drivers/' + e.id); closeSheet(); toast('تم الحذف'); await loadRole(); render(); }); },
  async saveSettings(b) {
    const v = (id) => document.getElementById(id).value;
    b.disabled = true;
    const r = await call('PUT', '/api/admin/settings', {
      deliveryFee: v('st_fee'), minOrder: v('st_min'), supportPhone: v('st_support'), districts: v('st_districts'), announcement: v('st_ann'),
      bankName: v('st_bankname'), bankHolder: v('st_bankholder'), bankIban: v('st_bankiban'), bankOn: document.getElementById('st_bankon').checked,
      newPin: v('st_pin').trim(), recovery: v('st_recovery').trim(),
      alertAfterMin: v('st_alert'), verifyMode: v('st_verify'), legalName: v('st_legal'), crNumber: v('st_cr'), vatNumber: v('st_vat'),
      legal: { terms: v('lg_terms'), privacy: v('lg_privacy'), refund: v('lg_refund') },
    });
    S.legalData = null;
    if (r.token) tokens.set('admin', r.token);
    S.adm.settings = r.settings;
    await loadBoot();
    toast('تم حفظ الإعدادات' + (r.warnings.length ? ' — تنبيه: ' + r.warnings.join('، ') : ''));
    render();
  },
};

/* الزائر يطلب: نسجّل دخوله ثم نكمل من نفس المكان */
function askLogin(after) {
  closeSheet();
  S.afterLogin = after; S.returnView = S.view.name === 'login' ? S.returnView : S.view;
  S.authStep = 'phone'; S.authErr = '';
  go('login');
  if (after) toast('سجّل برقم جوالك عشان نكمل طلبك');
}

function tickResend() {
  clearInterval(tickResend._t);
  tickResend._t = setInterval(() => {
    const el = document.getElementById('resendBtn');
    if (!el) { clearInterval(tickResend._t); return; }
    const wait = Math.max(0, Math.ceil((S.resendAt - Date.now()) / 1000));
    el.disabled = wait > 0; el.textContent = wait ? `إعادة الإرسال بعد ${wait} ث` : 'إعادة إرسال الرمز';
    if (!wait) clearInterval(tickResend._t);
  }, 1000);
}

async function uploadProductImg(file) {
  if (!S.edit) return; const i = S.edit._imgIdx;
  if (file.size > 10 * 1024 * 1024) { toast('الصورة كبيرة، اختر صورة أصغر من 10 ميجا'); return; }
  toast('جارِ رفع الصورة…');
  try {
    const r = await upload('product', await shrink(file), 'admin', 'p.jpg');
    if (S.edit && S.edit.products[i]) { S.edit.products[i].img = r.url; renderSheet(); toast('تم رفع الصورة، اضغط حفظ المتجر'); }
  } catch (err) { toast(err.message || 'تعذر رفع الصورة'); }
}
async function uploadCustomPhoto(file) {
  if (file.size > 10 * 1024 * 1024) { toast('الصورة كبيرة، اختر صورة أصغر من 10 ميجا'); return; }
  toast('جارِ رفع الصورة…');
  try {
    const r = await upload('custom', await shrink(file), 'customer', 'c.jpg');
    S.customOrder = S.customOrder || {}; S.customOrder.img = r.url; S.customOrder.imgId = r.id;
    render(); toast('تم إرفاق الصورة');
  } catch (err) { toast(err.message || 'تعذر رفع الصورة'); }
}
async function uploadReceipt(file) {
  const isPdf = file.type === 'application/pdf';
  if (!isPdf && !file.type.startsWith('image/')) { toast('اختر صورة أو ملف PDF'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('الملف كبير، الحد الأقصى 10 ميجا'); return; }
  toast('جارِ رفع إثبات التحويل…');
  try {
    const r = await upload('receipt', isPdf ? file : await shrink(file, 1600), 'customer', isPdf ? 'r.pdf' : 'r.jpg');
    S.checkoutReceipt = { id: r.id, url: r.url, type: r.type };
    renderSheet(); toast('تم إرفاق إثبات التحويل');
  } catch (err) { toast(err.message || 'تعذر رفع الملف'); }
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.sheet) { if (S.sheet.type === 'confirm') ACT.confirmNo(); else closeSheet(); }
  if (e.key === 'Enter' && e.target.id === 'chatInput') { const b = document.querySelector('[data-act="sendChat"]'); if (b) b.click(); }
});
window.addEventListener('online', () => { document.querySelector('.offline')?.remove(); refreshSoon('all'); });
window.addEventListener('offline', () => { if (!document.querySelector('.offline')) document.body.insertAdjacentHTML('beforeend', '<div class="offline">لا يوجد اتصال بالإنترنت</div>'); });

/* ============ التشغيل ============ */
(async function init() {
  const qs = new URLSearchParams(location.search);
  const lm = location.pathname.match(/^\/legal\/(\w+)/);
  if (lm) openLegal(lm[1], false);
  /* روابط الإشعارات القديمة (?r=...) تتحول للروابط الجديدة */
  const r = qs.get('r');
  if (['customer', 'driver', 'admin'].includes(r)) S.role = r;
  S.view = S.role === 'customer' ? viewFromPath(location.pathname) : { name: ROLE_HOME[S.role] };
  if (S.role === 'customer' && qs.get('o')) S.view = { name: 'order', arg: qs.get('o') };
  if (S.role === 'customer' && qs.get('v') === 'orders') S.view = { name: 'orders' };
  if (S.role === 'driver' && qs.get('chat')) S.view = { name: 'mine' };
  if (!lm) syncUrl(true);
  render();
  registerSW();
  for (;;) {
    try { await loadBoot(); break; }
    catch { render(); await new Promise((res) => setTimeout(res, 3000)); }
  }
  await startRole();
  const chatId = qs.get('chat') === '1' ? (qs.get('o') || (S.view.name === 'order' && S.view.arg)) : qs.get('chat');
  if (chatId && loggedIn()) ACT.openChat({ dataset: { id: chatId } }).catch(() => {});
})();
