import { test, expect } from '@playwright/test';
import { seed, adminToken, customerLogin, pickRole, fillAddress } from './helpers.js';

test.beforeAll(async ({ request }) => { await seed(request); });

test('صفحات السياسات تفتح برابط مباشر بدون تسجيل دخول', async ({ page }) => {
  await page.goto('/legal/privacy');
  await expect(page.locator('.legaltxt')).toContainText('نظام حماية البيانات الشخصية');
  await page.getByRole('button', { name: 'الشروط والأحكام' }).click();
  await expect(page).toHaveURL(/\/legal\/terms$/);
  await expect(page.locator('.legaltxt')).toContainText('عن الخدمة');
  await page.getByRole('button', { name: 'رجوع للتطبيق' }).click();
  await expect(page.getByRole('button', { name: /أبي أطلب/ })).toBeVisible();
  await expect(page.locator('.leglinks')).toBeVisible();
});

test('العميل: إعادة نفس الطلب بضغطة، والمتجر خارج الدوام يظهر مغلق', async ({ page, request }) => {
  await customerLogin(page, '0501110020', 'عبدالله');
  await page.locator('.srow', { hasText: 'ملحمة الأفلاج' }).click();
  await page.locator('.uchip', { hasText: 'كيلو' }).last().click();
  await page.locator('.cartbar button').click();
  await page.getByRole('button', { name: 'متابعة الطلب' }).click();
  await fillAddress(page);
  await page.locator('[data-act="placeOrder"]').click();
  await expect(page.locator('.oh .pill')).toHaveText('طلب جديد');
  await page.getByRole('button', { name: 'إلغاء الطلب' }).click();
  await page.locator('[data-act="confirmYes"]').click();
  await expect(page.locator('.oh .pill')).toHaveText('ملغي');

  await page.getByRole('button', { name: /اطلب نفس الطلب/ }).click();
  await expect(page.locator('.sh')).toContainText('لحم حاشي');
  await expect(page.locator('.sh .tot.big')).toContainText('90'); // كيلو 80 + توصيل 10
  await page.locator('[data-act="close"]').click();

  // إغلاق المتجر بالمواعيد (نافذة ساعة واحدة بعد ٦ ساعات من الحين)
  const t = await adminToken(request);
  const data = await (await request.get('/api/admin/data', { headers: { Authorization: 'Bearer ' + t } })).json();
  const st = data.stores.find((s) => s.name === 'ملحمة الأفلاج');
  const now = new Date(); const h = (now.getUTCHours() + 3 + 6) % 24;
  const hh = String(h).padStart(2, '0');
  await request.put('/api/admin/stores/' + st.id, { headers: { Authorization: 'Bearer ' + t }, data: { name: st.name, openAt: `${hh}:00`, closeAt: `${String((h + 1) % 24).padStart(2, '0')}:00` } });
  await expect(page.locator('.pill.off')).toHaveText('مغلق الآن', { timeout: 10000 });
  await expect(page.getByText('المتجر مغلق الآن، أوقات العمل')).toBeVisible();
  await expect(page.locator('.uchip')).toHaveCount(0);
  await request.put('/api/admin/stores/' + st.id, { headers: { Authorization: 'Bearer ' + t }, data: { name: st.name, openAt: '', closeAt: '' } });
});

test('الإدارة: مواعيد العمل من محرر المتجر، وبيانات المنشأة في التذييل', async ({ page }) => {
  await pickRole(page, 'admin');
  await page.locator('#ad_pin').fill('1234');
  await page.getByRole('button', { name: 'دخول' }).click();
  await page.locator('[data-go="stores"]').click();
  await page.locator('.srow', { has: page.locator('input[value="تموينات حاتم"]') }).getByRole('button', { name: 'تعديل' }).click();
  await page.locator('input[data-e="openAt"]').fill('07:00');
  await page.locator('input[data-e="closeAt"]').fill('01:00');
  await page.getByRole('button', { name: 'حفظ المتجر' }).click();
  await expect(page.locator('#toast')).toContainText('تم حفظ المتجر');

  await page.locator('[data-go="settings"]').click();
  await page.locator('#st_legal').fill('مؤسسة الهدار للتوصيل');
  await page.locator('#st_cr').fill('7001234567');
  await page.getByRole('button', { name: 'حفظ الإعدادات' }).click();
  await expect(page.locator('#toast')).toContainText('تم حفظ الإعدادات');

  await page.getByRole('button', { name: 'تبديل' }).click();
  await expect(page.locator('.foot')).toContainText('س.ت 7001234567');
  const boot = await (await page.request.get('/api/bootstrap')).json();
  const s = boot.stores.find((x) => x.name === 'تموينات حاتم');
  expect([s.openAt, s.closeAt]).toEqual(['07:00', '01:00']);
});
