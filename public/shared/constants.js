/* ثوابت مشتركة بين الخادم والواجهة — أي تعديل هنا ينعكس على الطرفين */

export const CATS = [
  { id: 'restaurants', name: 'مطاعم', emoji: '🍽️', t: '#FCEFD3' },
  { id: 'grocery', name: 'بقالات', emoji: '🛒', t: '#E1EFE8' },
  { id: 'meat', name: 'لحوم وأسماك', emoji: '🥩', t: '#FBE4E1' },
  { id: 'bakery', name: 'مخابز', emoji: '🥖', t: '#F4E6D2' },
  { id: 'pharmacy', name: 'صيدليات', emoji: '💊', t: '#F3E6F5' },
  { id: 'gas', name: 'غاز ومياه', emoji: '🔥', t: '#FBE4E1' },
  { id: 'plumbing', name: 'سباكة', emoji: '🚰', t: '#E6ECF8' },
  { id: 'electric', name: 'كهرباء', emoji: '💡', t: '#FCEFD3' },
  { id: 'cafe', name: 'قهوة وحلويات', emoji: '☕', t: '#EEF2DA' },
  { id: 'home', name: 'أدوات منزلية', emoji: '🧹', t: '#E1EFE8' },
];
export const CAT = Object.fromEntries(CATS.map((c) => [c.id, c]));

/* awaiting_payment: طلب دفع إلكتروني لم يكتمل دفعه بعد — لا يظهر للسائقين */
export const ST = {
  awaiting_payment: { t: 'بانتظار الدفع', d: 'أكمل الدفع الإلكتروني لتأكيد الطلب', c: 'warn' },
  new: { t: 'طلب جديد', d: 'بانتظار سائق يقبل الطلب', c: 'warn' },
  accepted: { t: 'تم قبول الطلب', d: 'نبحث لك عن سائق', c: 'warn' },
  assigned: { t: 'تم تعيين سائق', d: 'السائق متجه للمتجر', c: 'on' },
  picked: { t: 'استلم السائق الطلب', d: 'الطلب جاهز مع السائق', c: 'on' },
  onway: { t: 'في الطريق إليك', d: 'جهّز المبلغ كاش', c: 'on' },
  delivered: { t: 'تم التوصيل', d: 'بالعافية عليك', c: 'mute' },
  cancelled: { t: 'ملغي', d: 'تم إلغاء الطلب', c: 'off' },
  trial: { t: 'طلب تجريبي', d: 'تجربة فقط، ما يتوصّل', c: 'mute' },
};
export const FLOW = ['new', 'accepted', 'assigned', 'picked', 'onway', 'delivered'];
export const ACTIVE = ['new', 'accepted', 'assigned', 'picked', 'onway'];
export const DRIVER_ACTIVE = ['assigned', 'picked', 'onway'];
/* الانتقالات المسموحة للسائق على طلبه */
export const DRIVER_NEXT = { assigned: 'picked', picked: 'onway', onway: 'delivered' };

export const PAY = [
  { id: 'cash', name: 'كاش عند الاستلام', e: '💵' },
  { id: 'bank', name: 'حوالة بنكية', e: '🏦' },
  { id: 'mada', name: 'مدى', e: '💳' },
  { id: 'applepay', name: 'Apple Pay', e: '📲' },
  { id: 'stcpay', name: 'STC Pay', e: '📱' },
  { id: 'card', name: 'فيزا / ماستركارد', e: '💳' },
];
/* الطرق الإلكترونية كلها تمر عبر بوابة الدفع نفسها */
export const ONLINE_METHODS = ['mada', 'applepay', 'stcpay', 'card'];

export const UNIT_PRESETS = [
  { label: 'ربع كيلو', mult: 0.25 },
  { label: 'نص كيلو', mult: 0.5 },
  { label: '٣ أرباع كيلو', mult: 0.75 },
  { label: 'كيلو', mult: 1 },
  { label: 'كيلو ونص', mult: 1.5 },
  { label: 'كيلوين', mult: 2 },
  { label: '٣ كيلو', mult: 3 },
  { label: '٥ كيلو', mult: 5 },
];
export const TINTS = ['#FCEFD3', '#E1EFE8', '#FBE4E1', '#E6ECF8', '#F3E6F5', '#EEF2DA'];
export const MAX_CART_STORES = 2;

export const DEFAULT_SETTINGS = {
  deliveryFee: 10,
  minOrder: 0,
  districts: [],
  announcement: '',
  supportPhone: '',
  payments: { cash: true, bank: true, mada: false, applepay: false, stcpay: false, card: false },
  bankName: '',
  bankHolder: '',
  bankIban: '',
  loyaltyOn: true,
  loyaltyEvery: 5,
  /* وضع التجربة: كل المتاجر ظاهرة، وأي زائر يطلب بدون تحقق، والطلبات ما تروح للسائقين */
  trialMode: true,
};

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const unitPrice = (p, u) => round2((Number(p.price) || 0) * u.mult);

/* الطلب قابل للاستلام من السائق: جديد، بدون سائق، ومسعّر (لو طلب خاص) */
export const claimableOrder = (o) =>
  !o.driverId && (o.status === 'new' || o.status === 'accepted') && !(o.isCustom && o.priceStatus === 'pending');

/* توحيد رقم الجوال السعودي إلى 05xxxxxxxx */
export function normalizePhone(t) {
  let n = String(t || '').replace(/[\s-]/g, '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  n = n.replace(/^\+/, '');
  if (/^9665\d{8}$/.test(n)) n = '0' + n.slice(3);
  else if (/^5\d{8}$/.test(n)) n = '0' + n;
  return /^05\d{8}$/.test(n) ? n : null;
}
export const arabicDigits = (t) => String(t || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\s/g, '');

/* ============ مواعيد العمل (بتوقيت الرياض UTC+3 دائماً، بدون توقيت صيفي) ============ */
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const validTime = (t) => HHMM.test(String(t || ''));
const toMin = (t) => { const m = String(t).match(HHMM); return m ? +m[1] * 60 + +m[2] : null; };
export const riyadhMinutes = (d = new Date()) => (d.getUTCHours() * 60 + d.getUTCMinutes() + 180) % 1440;

/* مفتوح الحين؟ يحترم الإغلاق اليدوي أولاً، ثم المواعيد (يدعم الدوام اللي يعدّي منتصف الليل مثل 16:00–02:00) */
export function storeOpenNow(s, d = new Date()) {
  if (!s || s.open === false) return false;
  const a = toMin(s.openAt), b = toMin(s.closeAt);
  if (a == null || b == null || a === b) return true;
  const n = riyadhMinutes(d);
  return a < b ? n >= a && n < b : n >= a || n < b;
}
/* نص الوقت بالعربي: 06:00 → 6:00ص، 00:00 → 12:00ص */
export function fmtTime(t) {
  const m = toMin(t); if (m == null) return '';
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
  return `${h % 12 || 12}:${mm}${h < 12 ? 'ص' : 'م'}`;
}
export const hoursLabel = (s) => (validTime(s.openAt) && validTime(s.closeAt) && s.openAt !== s.closeAt ? `${fmtTime(s.openAt)} – ${fmtTime(s.closeAt)}` : (s.hours || ''));

/* اسم مؤقت للمتاجر اللي ما تسمّت (يظهر في وضع التجربة فقط، وما ينحفظ) */
export function withDisplayNames(stores) {
  const n = {};
  return stores.map((s) => {
    if (String(s.name || '').trim()) return s;
    n[s.category] = (n[s.category] || 0) + 1;
    return { ...s, name: `${(CAT[s.category] || { name: 'متجر' }).name} — متجر ${n[s.category]}`, unnamed: true };
  });
}

/* توحيد النص العربي للبحث: يتجاهل الهمزات والتاء المربوطة والتشكيل */
export const normAr = (t) => String(t || '').toLowerCase().replace(/[ً-ٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/\s+/g, ' ').trim();
