/* منطق التسعير والكوبونات — دوال صافية بدون قاعدة بيانات، ومغطّاة باختبارات وحدة */
import { MAX_CART_STORES, round2, unitPrice } from '../../public/shared/constants.js';

export class CheckoutError extends Error {
  constructor(message, code = 'invalid') { super(message); this.code = code; }
}
const fmt = (n) => round2(n).toLocaleString('en-US') + ' ر.س';

/**
 * يبني سلال المتاجر من أسطر السلة، ويتجاهل أي منتج غير صالح (محذوف، غير مسعّر، غير متوفر).
 * lines: [{storeId, productId, unit: number|null, qty}]
 * getStore(id) => {id,name,category,open,emoji,eta,products:[...]}
 */
export function buildBaskets(lines, getStore) {
  const byStore = new Map();
  for (const l of lines || []) {
    const qty = Math.floor(Number(l.qty));
    if (!(qty > 0) || qty > 999) continue;
    const s = getStore(String(l.storeId));
    if (!s || !String(s.name || '').trim()) continue;
    const p = s.products.find((x) => x.id === String(l.productId));
    if (!p || !(Number(p.price) > 0) || p.available === false) continue;
    let u = null;
    if (l.unit != null && l.unit !== '') {
      if (!Array.isArray(p.units) || !p.units[Number(l.unit)]) continue;
      u = p.units[Number(l.unit)];
    } else if (p.saleType === 'weight') continue; /* منتج بالوزن لازم له وزن محدد */
    const price = u ? unitPrice(p, u) : Number(p.price);
    if (!byStore.has(s.id)) byStore.set(s.id, { s, lines: [], sub: 0, n: 0 });
    const b = byStore.get(s.id);
    const existing = b.lines.find((x) => x.p.id === p.id && x.u === u);
    if (existing) existing.q += qty; else b.lines.push({ p, u, q: qty, price });
    b.sub = round2(b.sub + price * qty);
    b.n += qty;
  }
  const baskets = [...byStore.values()];
  if (baskets.length > MAX_CART_STORES) throw new CheckoutError('تقدر تطلب من متجرين بحد أقصى بنفس الوقت', 'too_many_stores');
  return baskets;
}

/* هل الكوبون صالح بشكل عام لهذا العميل؟ يرجع رسالة الخطأ أو null */
export function couponGlobalError(c, { now = Date.now(), usedByCustomer = false } = {}) {
  if (!c || !c.active) return 'الكود غير صحيح';
  if (c.expiresAt && now > c.expiresAt) return 'الكود منتهي';
  if (c.maxUses && Number(c.usedCount || 0) >= c.maxUses) return 'انتهت الكمية المتاحة لهذا الكود';
  if (c.oncePerCustomer && usedByCustomer) return 'سبق واستخدمت هذا الكود';
  return null;
}

export function couponDiscount(c, sub) {
  if (c.kind === 'percent') return Math.min(sub, round2((sub * Number(c.value)) / 100));
  if (c.kind === 'fixed') return Math.min(sub, Number(c.value));
  return 0;
}

export function basketEligible(c, bk) {
  if (c.minOrder && bk.sub < c.minOrder) return false;
  if (c.categories && c.categories.length && !c.categories.includes(bk.s.category)) return false;
  return true;
}

/**
 * حساب الدفع الكامل. الكوبون يطبّق على متجر واحد فقط (الأكبر خصماً)،
 * والتوصيلة المجانية من الولاء تطبّق على طلب واحد فقط.
 */
export function computeCheckout({ baskets, settings, coupon = null, couponUsedByCustomer = false, freeDeliveries = 0, useFree = false, now = Date.now() }) {
  const fee0 = Math.max(0, Number(settings.deliveryFee) || 0);
  let couponMsg = '', couponOk = false, couponStoreId = null;

  if (coupon) {
    const err = couponGlobalError(coupon, { now, usedByCustomer: couponUsedByCustomer });
    if (err) couponMsg = err;
    else {
      let best = null;
      for (const bk of baskets) {
        if (!basketEligible(coupon, bk)) continue;
        const d = couponDiscount(coupon, bk.sub);
        if (!best || d > best.d) best = { id: bk.s.id, d };
      }
      if (!best) {
        couponMsg = coupon.categories && coupon.categories.length ? 'الكود لا يشمل متاجر سلتك' : 'الحد الأدنى لهذا الكود ' + fmt(coupon.minOrder || 0);
      } else {
        couponOk = true;
        couponStoreId = best.id;
        couponMsg = coupon.kind === 'free_delivery' ? 'تم تفعيل التوصيل المجاني 🎉' : 'تم تطبيق الخصم: -' + fmt(best.d);
      }
    }
  }

  const canUseFree = useFree && freeDeliveries > 0;
  let freeApplied = false;
  const rows = baskets.map((bk) => {
    let discount = 0, cp = null;
    if (couponOk && bk.s.id === couponStoreId) {
      discount = couponDiscount(coupon, bk.sub);
      cp = { code: coupon.code, kind: coupon.kind, value: Number(coupon.value) || 0, discount, oncePerCustomer: !!coupon.oncePerCustomer };
    }
    let fee = fee0, freeUsedHere = false;
    if (cp && cp.kind === 'free_delivery') fee = 0;
    else if (canUseFree && !freeApplied && fee0 > 0) { fee = 0; freeUsedHere = true; freeApplied = true; }
    const total = round2(Math.max(0, bk.sub - discount + fee));
    return { bk, discount, coupon: cp, fee, total, freeUsedHere };
  });
  const sum = (f) => round2(rows.reduce((a, r) => a + f(r), 0));
  return {
    rows,
    couponOk, couponMsg,
    grandSub: sum((r) => r.bk.sub),
    grandDiscount: sum((r) => r.discount),
    grandFee: sum((r) => r.fee),
    grandTotal: sum((r) => r.total),
  };
}

/* تحقق شروط الطلب قبل الإنشاء */
export function validateForPlacement(cx, settings) {
  if (!cx.rows.length) throw new CheckoutError('السلة فاضية', 'empty');
  const closed = cx.rows.find((r) => r.bk.s.open === false);
  if (closed) throw new CheckoutError(closed.bk.s.name + ' مغلق الآن', 'closed');
  const min = Number(settings.minOrder) || 0;
  if (min > 0) {
    const below = cx.rows.find((r) => r.bk.sub < min);
    if (below) throw new CheckoutError('الحد الأدنى لطلب ' + below.bk.s.name + ': ' + fmt(min), 'min_order');
  }
}

/* برنامج الولاء: هل يستحق العميل توصيلة مجانية بعد هذا التوصيل؟ */
export function loyaltyEarned(settings, deliveredCountAfter) {
  const every = Number(settings.loyaltyEvery) || 5;
  return settings.loyaltyOn !== false && every >= 2 && deliveredCountAfter > 0 && deliveredCountAfter % every === 0;
}
