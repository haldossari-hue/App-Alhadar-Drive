import { expect } from '@playwright/test';

export async function adminToken(request, pin = '1234') {
  const r = await request.post('/api/admin/login', { data: { pin } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).token;
}
const auth = (t) => ({ headers: { Authorization: 'Bearer ' + t } });

/* تجهيز بيانات أساسية عبر الـ API (مرة واحدة) */
export async function seed(request) {
  const t = await adminToken(request);
  const data = await (await request.get('/api/admin/data', auth(t))).json();
  if (data.stores.some((s) => s.name === 'مطعم الوادي')) return { t, data };
  await request.put('/api/admin/settings', { ...auth(t), data: { deliveryFee: 10, districts: 'حي الطرف\nحي البرقه', supportPhone: '0500112653', bankName: 'الراجحي', bankHolder: 'مؤسسة تجريبية', bankIban: 'SA0000000000000000000000', loyaltyEvery: 2 } });
  await request.put('/api/admin/stores/new', { ...auth(t), data: { name: 'مطعم الوادي', category: 'restaurants', eta: 25, products: [
    { id: 'k', name: 'كبسة لحم', price: 35, sec: 'الأطباق', emoji: '🍛' },
    { id: 'j', name: 'جريش', price: 0, sec: 'الأطباق', emoji: '🥣' },
  ] } });
  await request.put('/api/admin/stores/new', { ...auth(t), data: { name: 'ملحمة الأفلاج', category: 'meat', products: [
    { id: 'm', name: 'لحم حاشي', price: 80, saleType: 'weight', units: [{ label: 'نص كيلو' }, { label: 'كيلو' }], emoji: '🥩' },
  ] } });
  await request.put('/api/admin/stores/new', { ...auth(t), data: { name: 'تموينات حاتم', category: 'grocery', products: [{ id: 'w', name: 'ماء', price: 5, emoji: '💧' }] } });
  await request.put('/api/admin/drivers/new', { ...auth(t), data: { name: 'أبو فهد', phone: '0555000001', pin: '1111' } });
  await request.put('/api/admin/coupons/HADAR10', { ...auth(t), data: { kind: 'percent', value: 10, isNew: true } });
  return { t, data: await (await request.get('/api/admin/data', auth(t))).json() };
}

/* الرابط الرئيسي للعملاء، والسائق والإدارة لهم روابط خاصة */
export async function pickRole(page, role) {
  await page.goto({ customer: '/', driver: '/driver', admin: '/admin' }[role]);
}

export async function customerLogin(page, phone, name = 'عميل تجريبي') {
  await page.goto('/login');
  await page.locator('#au_phone').fill(phone);
  await page.getByRole('button', { name: 'إرسال الرمز' }).click();
  const code = (await page.locator('#devCode b').textContent()).trim();
  if (await page.locator('#au_name').count()) await page.locator('#au_name').fill(name);
  await page.locator('#au_code').fill(code);
  await page.locator('[data-act="authVerify"]').click();
  await expect(page.locator('.hero')).toBeVisible();
}

export async function driverLogin(page, phone = '0555000001', pin = '1111') {
  await pickRole(page, 'driver');
  await page.locator('#dl_phone').fill(phone);
  await page.locator('#dl_pin').fill(pin);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'طلبات متاحة للتوصيل' })).toBeVisible();
}

export async function fillAddress(page) {
  await page.locator('#co_district').selectOption('حي الطرف');
  await page.locator('#co_address').fill('شارع الملك فهد، باب أخضر');
}
