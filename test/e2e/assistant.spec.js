import { test, expect } from '@playwright/test';
import { seed, adminToken } from './helpers.js';

test.beforeAll(async ({ request }) => { await seed(request); });

test('المساعد الذكي: سؤال يجاوبه من بيانات التطبيق، وشكوى توصل للإدارة، والإدارة تقفلها', async ({ browser, request }) => {
  const mk = async () => (await browser.newContext({ locale: 'ar-SA' })).newPage();
  const [c, adm] = await Promise.all([mk(), mk()]);
  await adm.goto('/admin');
  await adm.locator('#ad_pin').fill('1234');
  await adm.getByRole('button', { name: 'دخول' }).click();
  await adm.locator('.nav [data-go="tickets"]').click();
  await expect(adm.getByRole('heading', { name: 'البلاغات والملاحظات' })).toBeVisible();

  await c.goto('/');
  await c.getByRole('button', { name: 'المساعد الذكي' }).click();
  await expect(c.locator('.aiwelcome')).toContainText('مساعد الهدار درايف');
  await c.getByRole('button', { name: 'كم رسوم التوصيل؟' }).click();
  await expect(c.locator('.ailist')).toContainText('رسوم التوصيل 10 ر.س', { timeout: 10000 }); // من الإعدادات الحقيقية
  await expect(c.locator('.ailist')).toContainText('• حي الطرف');

  await c.locator('#aiInput').fill('أبي أرفع شكوى');
  await c.getByRole('button', { name: 'إرسال' }).click();
  await expect(c.locator('.ailist')).toContainText('اكتب اسمك وجوالك');
  await c.locator('#aiInput').fill('الطلب وصل ناقص، جوالي 0551239999');
  await c.locator('#aiInput').press('Enter');
  const card = c.locator('.tkcard');
  await expect(card).toContainText('تم رفع شكوى برقم');
  const num = (await card.locator('b').textContent()).replace('#', '').trim();

  // المحادثة محفوظة بعد إعادة فتح الصفحة
  await c.reload();
  await c.getByRole('button', { name: 'المساعد الذكي' }).click();
  await expect(c.locator('.tkcard')).toContainText(num);

  // الإدارة تشوفها فوراً مع المحادثة
  await expect(adm.locator('#toast')).toContainText('شكوى جديدة #' + num, { timeout: 10000 });
  const tk = adm.locator('.card', { hasText: '#' + num });
  await expect(tk).toContainText('0551239999');
  await tk.getByRole('button', { name: /المحادثة/ }).click();
  await expect(adm.locator('#chatList')).toContainText('الطلب وصل ناقص');
  await adm.locator('[data-act="close"]').click();
  await tk.locator('textarea').fill('تواصلنا مع العميل وعوّضناه');
  await tk.getByRole('button', { name: /تم الحل وإقفال/ }).click();
  await expect(adm.locator('#toast')).toContainText('تم إقفال البلاغ');
  await expect(adm.locator('.card', { hasText: '#' + num })).toHaveCount(0);
});

test('نموذج البلاغ المباشر يشتغل للزائر', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'المساعد الذكي' }).click();
  await page.getByRole('button', { name: /رفع بلاغ مباشرة/ }).click();
  await page.locator('#tk_cat').selectOption('suggestion');
  await page.locator('#tk_subject').fill('اقتراح');
  await page.locator('#tk_details').fill('ياليت تضيفون متجر ورود');
  await page.locator('#tk_name').fill('نورة');
  await page.locator('#tk_phone').fill('0551230000');
  await page.getByRole('button', { name: 'إرسال للإدارة' }).click();
  await expect(page.locator('#toast')).toContainText('وصل بلاغك للإدارة برقم');
});
