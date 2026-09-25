import { test, expect } from '@playwright/test';
import { seed, customerLogin, fillAddress } from './helpers.js';

test.beforeAll(async ({ request }) => { await seed(request); });

test('العميل: تسجيل برمز SMS، السلة من متجرين، حد المتجرين، كوبون، وطلبان A/B', async ({ page }) => {
  await customerLogin(page, '0501110001', 'نورة');
  await expect(page.getByText('HADAR10')).toBeVisible(); // شريط العروض

  await page.locator('.srow', { hasText: 'مطعم الوادي' }).click();
  await expect(page.getByText('السعر قريباً')).toBeVisible(); // منتج بدون سعر
  await page.locator('.pcard', { hasText: 'كبسة لحم' }).locator('.add').click();
  await page.locator('.pcard', { hasText: 'كبسة لحم' }).getByLabel('زيادة').click();

  await page.goto('/');
  await page.locator('.srow', { hasText: 'ملحمة الأفلاج' }).click();
  await page.locator('.uchip', { hasText: 'نص كيلو' }).click(); // بيع بالوزن
  await expect(page.locator('.ustep')).toContainText('نص كيلو ×1');

  await page.goto('/');
  await page.locator('.srow', { hasText: 'تموينات حاتم' }).click();
  await page.locator('.pcard', { hasText: 'ماء' }).locator('.add').click();
  await expect(page.locator('#toast')).toContainText('متجرين بحد أقصى');

  await page.locator('.cartbar button').click();
  await expect(page.locator('.sh')).toContainText('(متجرين)');
  await expect(page.locator('.sh .tot.big')).toContainText('130'); // 70 + 40 + 2×10
  await page.getByRole('button', { name: 'متابعة الطلب' }).click();
  await fillAddress(page);
  await page.locator('#co_coupon').fill('hadar10');
  await page.getByRole('button', { name: 'تطبيق' }).click();
  await expect(page.locator('#couponMsg')).toContainText('تم تطبيق الخصم: -7'); // 10% من 70 (أكبر من 10% من 40)
  await expect(page.locator('#coTotals .tot.big')).toContainText('123');
  await page.locator('[data-act="placeOrder"]').click();

  await expect(page.getByRole('heading', { name: 'طلباتي' })).toBeVisible();
  const codes = await page.locator('.srow small').filter({ hasText: '#' }).allTextContents();
  const cs = codes.map((t) => t.match(/#(\d+[AB])/)[1]).sort();
  expect(cs).toHaveLength(2);
  expect(cs[0].slice(0, 6)).toBe(cs[1].slice(0, 6));
});

test('العميل: الحوالة البنكية تتطلب إثبات قبل الإرسال', async ({ page }) => {
  await customerLogin(page, '0501110002', 'خالد');
  await page.locator('.srow', { hasText: 'مطعم الوادي' }).click();
  await page.locator('.pcard', { hasText: 'كبسة لحم' }).locator('.add').click();
  await page.locator('.cartbar button').click();
  await page.getByRole('button', { name: 'متابعة الطلب' }).click();
  await fillAddress(page);
  await page.getByRole('button', { name: /حوالة بنكية/ }).click();
  await expect(page.locator('.bankbox')).toContainText('SA0000000000000000000000');
  await page.locator('[data-act="placeOrder"]').click();
  await expect(page.locator('#toast')).toContainText('أرفق صورة أو PDF');
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2D7E1B50000000049454E44AE426082', 'hex');
  await page.locator('#rcptIn').setInputFiles({ name: 'r.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.rcpt')).toContainText('مرفوعة');
  await page.locator('[data-act="placeOrder"]').click();
  await expect(page.getByText('الدفع حوالة بنكية')).toBeVisible();
  await expect(page.getByRole('link', { name: 'عرض إثبات التحويل' })).toBeVisible();
});

test('العميل: الدفع الإلكتروني عبر البوابة ثم يصير الطلب جديد ومدفوع', async ({ page }) => {
  await customerLogin(page, '0501110003', 'ريم');
  await page.locator('.srow', { hasText: 'مطعم الوادي' }).click();
  await page.locator('.pcard', { hasText: 'كبسة لحم' }).locator('.add').click();
  await page.locator('.cartbar button').click();
  await page.getByRole('button', { name: 'متابعة الطلب' }).click();
  await fillAddress(page);
  await page.getByRole('button', { name: /مدى/ }).click();
  await page.locator('[data-act="placeOrder"]').click();
  await expect(page.getByText('بوابة دفع تجريبية')).toBeVisible();
  await page.locator('#fakePay').click();
  await expect(page.getByText('مدفوع ✅')).toBeVisible();
  await expect(page.locator('.oh .pill')).toHaveText('طلب جديد');
});
