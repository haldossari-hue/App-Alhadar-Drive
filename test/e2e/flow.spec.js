import { test, expect } from '@playwright/test';
import { seed, customerLogin, driverLogin, pickRole, fillAddress } from './helpers.js';

test.beforeAll(async ({ request }) => { await seed(request); });

test('تدفق حي: طلب يصل للإدارة والسائق فوراً، السائق يستلم، المحادثة، وتحديث الحالة للعميل', async ({ browser }) => {
  const mk = async () => (await browser.newContext({ locale: 'ar-SA' })).newPage();
  const [cust, drv, adm] = await Promise.all([mk(), mk(), mk()]);

  await pickRole(adm, 'admin');
  await adm.locator('#ad_pin').fill('1234');
  await adm.getByRole('button', { name: 'دخول' }).click();
  await expect(adm.getByRole('heading', { name: 'الطلبات' })).toBeVisible();
  await driverLogin(drv);
  await customerLogin(cust, '0501110010', 'سلطان');

  await cust.locator('.srow', { hasText: 'مطعم الوادي' }).click();
  await cust.locator('.pcard', { hasText: 'كبسة لحم' }).locator('.add').click();
  await cust.locator('.cartbar button').click();
  await cust.getByRole('button', { name: 'متابعة الطلب' }).click();
  await fillAddress(cust);
  await cust.locator('[data-act="placeOrder"]').click();
  await expect(cust.locator('.oh .pill')).toHaveText('طلب جديد');
  const code = (await cust.locator('.oh b').textContent()).match(/#(\d+)/)[1];

  // يظهر فوراً للإدارة والسائق بدون تحديث الصفحة
  await expect(adm.locator('#toast')).toContainText('طلب جديد #' + code, { timeout: 10000 });
  const card = drv.locator('.card', { hasText: '#' + code });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card).not.toContainText('باب أخضر'); // العنوان مخفي قبل الاستلام
  await card.getByRole('button', { name: 'استلام الطلب' }).click();
  await expect(drv.getByRole('heading', { name: 'طلباتي الحالية' })).toBeVisible();
  await expect(drv.locator('.card', { hasText: '#' + code })).toContainText('باب أخضر');

  await expect(cust.locator('.oh .pill')).toHaveText('تم تعيين سائق', { timeout: 10000 });
  await expect(cust.locator('#toast')).toContainText('تم تعيين سائق');

  // المحادثة
  await drv.getByRole('button', { name: '💬 محادثة العميل' }).click();
  await drv.locator('#chatInput').fill('وصلت المتجر، ثواني وأطلع');
  await drv.getByRole('button', { name: 'إرسال' }).click();
  await expect(cust.locator('#toast')).toContainText('رسالة جديدة من السائق', { timeout: 10000 });
  await cust.getByRole('button', { name: '💬 محادثة' }).click();
  await expect(cust.locator('#chatList')).toContainText('وصلت المتجر');
  await cust.locator('#chatInput').fill('الله يعطيك العافية');
  await cust.getByRole('button', { name: 'إرسال' }).click();
  await expect(drv.locator('#chatList')).toContainText('الله يعطيك العافية', { timeout: 10000 });
  await drv.locator('[data-act="close"]').click();
  await cust.locator('[data-act="close"]').click();

  await drv.getByRole('button', { name: 'استلمت الطلب من المتجر' }).click();
  await expect(cust.locator('#trackMap')).toBeVisible({ timeout: 10000 }); // خريطة التتبع
  await drv.getByRole('button', { name: 'انطلقت للعميل' }).click();
  await expect(cust.locator('.oh .pill')).toHaveText('في الطريق إليك', { timeout: 10000 });
  await drv.getByRole('button', { name: /تم التوصيل واستلمت 45/ }).click();
  await drv.locator('[data-act="confirmYes"]').click();
  await expect(cust.locator('.oh .pill')).toHaveText('تم التوصيل', { timeout: 10000 });

  await drv.locator('[data-go="done"]').click();
  await expect(drv.locator('.stat', { hasText: 'كاش معك' })).toContainText('45');
  await adm.locator('[data-go="drivers"]').click();
  await adm.getByRole('button', { name: /استلمت .*45/ }).click();
  await adm.locator('[data-act="confirmYes"]').click();
  await expect(adm.locator('#toast')).toContainText('تمت التسوية');
});

test('الطلب الخاص: الإدارة تسعّره ثم يظهر للسائق', async ({ browser }) => {
  const mk = async () => (await browser.newContext({ locale: 'ar-SA' })).newPage();
  const [cust, drv, adm] = await Promise.all([mk(), mk(), mk()]);
  await customerLogin(cust, '0501110011', 'منيرة');
  await driverLogin(drv);
  await pickRole(adm, 'admin');
  await adm.locator('#ad_pin').fill('1234');
  await adm.getByRole('button', { name: 'دخول' }).click();

  await cust.locator('.srow', { hasText: 'مطعم الوادي' }).click();
  await cust.getByRole('button', { name: '✍️ اكتب طلبك بنفسك' }).click();
  await cust.locator('#cs_desc').fill('صحن مندي كبير مع سلطة');
  await cust.getByRole('button', { name: 'متابعة الطلب' }).click();
  await fillAddress(cust);
  await cust.getByRole('button', { name: 'إرسال الطلب للمتجر' }).click();
  await expect(cust.getByText('بانتظار تسعير المتجر')).toBeVisible();
  const code = (await cust.locator('.oh b').textContent()).match(/#(\d+)/)[1];

  const acard = adm.locator('.card', { hasText: '#' + code }).first();
  await expect(acard).toBeVisible({ timeout: 10000 });
  await expect(drv.locator('.card', { hasText: '#' + code })).toHaveCount(0);
  await acard.locator('input[type=number]').fill('55');
  await acard.getByRole('button', { name: 'تحديد السعر' }).click();
  await expect(drv.locator('.card', { hasText: '#' + code })).toBeVisible({ timeout: 10000 });
  await expect(cust.locator('#toast')).toContainText('تم تسعير طلبك', { timeout: 10000 });
  await expect(cust.locator('.tot.big')).toContainText('65');
});

test('الإدارة: تعديل سعر منتج ينعكس للعميل مباشرة', async ({ browser }) => {
  const mk = async () => (await browser.newContext({ locale: 'ar-SA' })).newPage();
  const [cust, adm] = await Promise.all([mk(), mk()]);
  await customerLogin(cust, '0501110012', 'فيصل');
  await cust.locator('.srow', { hasText: 'مطعم الوادي' }).click();
  await expect(cust.locator('.pcard', { hasText: 'جريش' })).toContainText('السعر قريباً');

  await pickRole(adm, 'admin');
  await adm.locator('#ad_pin').fill('1234');
  await adm.getByRole('button', { name: 'دخول' }).click();
  await adm.locator('[data-go="prices"]').click();
  await adm.getByLabel('سعر جريش').fill('18');
  await adm.getByLabel('سعر جريش').blur();
  await expect(adm.locator('#toast')).toContainText('تم حفظ السعر');
  await expect(cust.locator('.pcard', { hasText: 'جريش' })).toContainText('18', { timeout: 10000 });
});
