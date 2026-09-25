import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBaskets, computeCheckout, validateForPlacement, loyaltyEarned, CheckoutError } from '../../src/domain/pricing.js';
import { normalizePhone } from '../../public/shared/constants.js';

const S = {
  s1: { id: 's1', name: 'مطعم', category: 'restaurants', open: true, products: [
    { id: 'a', name: 'كبسة', price: 30, available: true },
    { id: 'b', name: 'بدون سعر', price: 0, available: true },
    { id: 'c', name: 'غير متوفر', price: 10, available: false },
  ] },
  s2: { id: 's2', name: 'ملحمة', category: 'meat', open: true, products: [
    { id: 'm', name: 'لحم', price: 60, available: true, saleType: 'weight', units: [{ label: 'نص كيلو', mult: 0.5 }, { label: 'كيلو', mult: 1 }] },
  ] },
  s3: { id: 's3', name: 'بقالة', category: 'grocery', open: true, products: [{ id: 'g', name: 'ماء', price: 5, available: true }] },
  hidden: { id: 'hidden', name: '', category: 'grocery', open: true, products: [{ id: 'x', name: 'x', price: 5, available: true }] },
};
const get = (id) => S[id];
const settings = { deliveryFee: 10, minOrder: 0, loyaltyOn: true, loyaltyEvery: 5 };

test('السلة تتجاهل المنتجات غير المسعّرة وغير المتوفرة والمتاجر المخفية', () => {
  const b = buildBaskets([
    { storeId: 's1', productId: 'a', qty: 2 }, { storeId: 's1', productId: 'b', qty: 1 },
    { storeId: 's1', productId: 'c', qty: 1 }, { storeId: 'hidden', productId: 'x', qty: 1 },
  ], get);
  assert.equal(b.length, 1);
  assert.equal(b[0].sub, 60);
});

test('البيع بالوزن: السعر = سعر الكيلو × المضاعف، والمنتج بالوزن بدون وزن مرفوض', () => {
  const b = buildBaskets([{ storeId: 's2', productId: 'm', unit: 0, qty: 3 }, { storeId: 's2', productId: 'm', qty: 1 }], get);
  assert.equal(b[0].lines.length, 1);
  assert.equal(b[0].lines[0].price, 30);
  assert.equal(b[0].sub, 90);
});

test('حد أقصى متجرين بالسلة', () => {
  assert.throws(() => buildBaskets([
    { storeId: 's1', productId: 'a', qty: 1 }, { storeId: 's2', productId: 'm', unit: 1, qty: 1 }, { storeId: 's3', productId: 'g', qty: 1 },
  ], get), (e) => e instanceof CheckoutError && e.code === 'too_many_stores');
});

test('الكوبون يطبق على المتجر الأكبر خصماً فقط، ورسوم التوصيل لكل طلب', () => {
  const baskets = buildBaskets([{ storeId: 's1', productId: 'a', qty: 1 }, { storeId: 's2', productId: 'm', unit: 1, qty: 2 }], get);
  const coupon = { code: 'X10', kind: 'percent', value: 10, active: true, oncePerCustomer: true, categories: [] };
  const cx = computeCheckout({ baskets, settings, coupon });
  assert.equal(cx.couponOk, true);
  const withC = cx.rows.filter((r) => r.coupon);
  assert.equal(withC.length, 1);
  assert.equal(withC[0].bk.s.id, 's2'); // 120 × 10% = 12 أكبر من 30 × 10%
  assert.equal(cx.grandDiscount, 12);
  assert.equal(cx.grandFee, 20);
  assert.equal(cx.grandTotal, 30 + 120 - 12 + 20);
});

test('الكوبون: قيود التصنيف والحد الأدنى والانتهاء والاستخدام السابق', () => {
  const baskets = buildBaskets([{ storeId: 's1', productId: 'a', qty: 1 }], get);
  const base = { code: 'C', kind: 'fixed', value: 5, active: true, oncePerCustomer: true, categories: [] };
  assert.equal(computeCheckout({ baskets, settings, coupon: { ...base, categories: ['meat'] } }).couponMsg, 'الكود لا يشمل متاجر سلتك');
  assert.match(computeCheckout({ baskets, settings, coupon: { ...base, minOrder: 50 } }).couponMsg, /الحد الأدنى/);
  assert.equal(computeCheckout({ baskets, settings, coupon: { ...base, expiresAt: 1 } }).couponMsg, 'الكود منتهي');
  assert.equal(computeCheckout({ baskets, settings, coupon: { ...base, maxUses: 2, usedCount: 2 } }).couponMsg, 'انتهت الكمية المتاحة لهذا الكود');
  assert.equal(computeCheckout({ baskets, settings, coupon: base, couponUsedByCustomer: true }).couponMsg, 'سبق واستخدمت هذا الكود');
  assert.equal(computeCheckout({ baskets, settings, coupon: { ...base, oncePerCustomer: false }, couponUsedByCustomer: true }).couponOk, true);
  assert.equal(computeCheckout({ baskets, settings, coupon: { ...base, value: 500 } }).grandDiscount, 30, 'الخصم لا يتجاوز قيمة المنتجات');
});

test('كوبون توصيل مجاني + توصيلة الولاء تطبق على طلب واحد فقط', () => {
  const baskets = buildBaskets([{ storeId: 's1', productId: 'a', qty: 1 }, { storeId: 's3', productId: 'g', qty: 2 }], get);
  const fd = computeCheckout({ baskets, settings, coupon: { code: 'FD', kind: 'free_delivery', value: 0, active: true, categories: [] } });
  assert.equal(fd.grandFee, 10);
  const loy = computeCheckout({ baskets, settings, freeDeliveries: 3, useFree: true });
  assert.equal(loy.rows.filter((r) => r.freeUsedHere).length, 1);
  assert.equal(loy.grandFee, 10);
  const none = computeCheckout({ baskets, settings, freeDeliveries: 0, useFree: true });
  assert.equal(none.grandFee, 20);
});

test('الحد الأدنى للطلب والمتجر المغلق', () => {
  const baskets = buildBaskets([{ storeId: 's3', productId: 'g', qty: 1 }], get);
  assert.throws(() => validateForPlacement(computeCheckout({ baskets, settings }), { ...settings, minOrder: 10 }), /الحد الأدنى/);
  const closed = buildBaskets([{ storeId: 's3', productId: 'g', qty: 1 }], (id) => ({ ...S[id], open: false }));
  assert.throws(() => validateForPlacement(computeCheckout({ baskets: closed, settings }), settings), /مغلق/);
});

test('برنامج الولاء: كل N طلبات', () => {
  assert.equal(loyaltyEarned({ loyaltyOn: true, loyaltyEvery: 4 }, 4), true);
  assert.equal(loyaltyEarned({ loyaltyOn: true, loyaltyEvery: 4 }, 5), false);
  assert.equal(loyaltyEarned({ loyaltyOn: false, loyaltyEvery: 4 }, 8), false);
});

test('توحيد أرقام الجوال', () => {
  assert.equal(normalizePhone('0512345678'), '0512345678');
  assert.equal(normalizePhone('+966512345678'), '0512345678');
  assert.equal(normalizePhone('512345678'), '0512345678');
  assert.equal(normalizePhone('٠٥١٢٣٤٥٦٧٨'), '0512345678');
  assert.equal(normalizePhone('0612345678'), null);
});
