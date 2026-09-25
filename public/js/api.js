/* طبقة الاتصال بالخادم: الطلبات، البث اللحظي، وإشعارات Push */
import { lsg, lss } from './util.js';

const TOK = (role) => 'hd.tok.' + role;
export const tokens = {
  get: (role) => lsg(TOK(role), null),
  set: (role, t) => lss(TOK(role), t),
  clear: (role) => lss(TOK(role), null),
};

export class ApiError extends Error {
  constructor(msg, status, code) { super(msg); this.status = status; this.code = code; }
}

let onAuthLost = () => {};
export const setAuthLostHandler = (fn) => { onAuthLost = fn; };

export async function api(method, url, body, role) {
  const headers = {};
  const t = role ? tokens.get(role) : null;
  if (t) headers.Authorization = 'Bearer ' + t;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, { method, headers, body: payload }); }
  catch { throw new ApiError('تعذر الاتصال، تأكد من الإنترنت وحاول مرة أخرى', 0, 'network'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && j.code === 'auth' && role) { tokens.clear(role); onAuthLost(role); }
    throw new ApiError(j.error || 'صار خطأ، حاول مرة أخرى', r.status, j.code);
  }
  return j;
}

export async function upload(kind, blob, role, filename = 'file') {
  const fd = new FormData();
  fd.append('file', blob, filename);
  return api('POST', '/api/uploads?kind=' + kind, fd, role);
}

/* ============ البث اللحظي (SSE) مع إعادة اتصال تلقائية ============ */
let es = null, esRole = null, retry = null;
export function connectStream(role, onEvent, onReconnect) {
  disconnectStream();
  esRole = role;
  const open = async () => {
    if (esRole !== role) return;
    let q = '';
    if (role && tokens.get(role)) {
      try { q = '?t=' + encodeURIComponent((await api('POST', '/api/stream-ticket', {}, role)).ticket); }
      catch { /* نكمل كزائر */ }
    }
    if (esRole !== role) return;
    let first = true;
    es = new EventSource('/api/stream' + q);
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === 'hello') { if (!first) onReconnect(); first = false; return; }
      onEvent(ev);
    };
    es.onerror = () => {
      /* نعيد الاتصال بتذكرة جديدة (التذكرة صالحة دقيقة فقط) */
      es.close(); es = null;
      clearTimeout(retry);
      retry = setTimeout(() => { open().then(() => onReconnect()); }, 3000);
    };
  };
  open();
}
export function disconnectStream() {
  esRole = null;
  clearTimeout(retry);
  if (es) { es.close(); es = null; }
}

/* ============ Service Worker و Push ============ */
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const b64ToU8 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };

export async function enablePush(role, vapidKey) {
  if (!pushSupported()) throw new Error('جهازك ما يدعم الإشعارات. على الآيفون: أضف التطبيق للشاشة الرئيسية أولاً');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('ما تم السماح بالإشعارات من المتصفح');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(vapidKey) });
  await api('POST', '/api/push/subscribe', { sub: sub.toJSON() }, role);
  return true;
}
/* تحديث ربط الاشتراك بالدور الحالي بصمت (لو كان مفعّلاً مسبقاً) */
export async function refreshPush(role) {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api('POST', '/api/push/subscribe', { sub: sub.toJSON() }, role);
  } catch { /* تجاهل */ }
}
