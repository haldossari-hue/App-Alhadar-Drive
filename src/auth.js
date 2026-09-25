import crypto from 'node:crypto';
import { config } from './config.js';

/* ============ تشفير الرموز السرية ============ */
/* الصيغة: scrypt$<salt>$<hash>. ونقبل صيغ النسخة القديمة (SHA-256 بدون ملح) لترحيل الحسابات، ثم نرقّيها تلقائياً */

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(secret), salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}

/* legacyPrefix: النسخة القديمة كانت تشفّر 'hd:'+pin للرموز و 'hd:rc:'+phrase للاسترجاع */
export function verifySecret(secret, stored, legacyPrefix = 'hd:') {
  if (!stored || secret == null || secret === '') return false;
  const s = String(secret);
  if (stored.startsWith('scrypt$')) {
    const [, salt, h] = stored.split('$');
    const got = crypto.scryptSync(s, salt, 32);
    const want = Buffer.from(h, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  if (stored.startsWith('plain$')) return safeEq(s, stored.slice(6));
  if (/^[0-9a-f]{64}$/.test(stored)) {
    return safeEq(crypto.createHash('sha256').update(legacyPrefix + s).digest('hex'), stored);
  }
  return false;
}
export const needsRehash = (stored) => !String(stored || '').startsWith('scrypt$');

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ============ رموز الجلسة (توقيع HMAC) ============ */

const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', config.secret).update(data).digest('base64url');

export function issueToken(payload, ttlSec) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${sign(body)}`;
}

export function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEq(sign(body), sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}

export const TTL = {
  customer: 60 * 60 * 24 * 90,
  driver: 60 * 60 * 24 * 30,
  admin: 60 * 60 * 12,
  stream: 60,
  file: 60 * 60 * 6,
  recover: 60 * 10,
};

/* رابط موقّع مؤقت لملف خاص (إثبات تحويل، صورة طلب خاص) */
export function signedFileUrl(id) {
  if (!id) return null;
  return `/files/${id}?t=${issueToken({ f: id, p: 'file' }, TTL.file)}`;
}

/* ============ محدد محاولات بسيط بالذاكرة ============ */
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 50000) buckets.clear();
  return b.n <= max;
}
export const resetRateLimits = () => buckets.clear();

export const randomId = (prefix = '', bytes = 9) => prefix + crypto.randomBytes(bytes).toString('base64url');
export const randomDigits = (n) => Array.from(crypto.randomBytes(n), (x) => x % 10).join('');
