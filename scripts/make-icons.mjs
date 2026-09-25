/* توليد أيقونات PNG من الشعار (يتطلب Playwright). الاستخدام: node scripts/make-icons.mjs */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const svg = fs.readFileSync(new URL('../public/icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-180', 180, 0], ['icon-192', 192, 0], ['icon-512', 512, 0], ['icon-maskable-512', 512, 0.12]]) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(`<html><body style="margin:0;background:#A65A2A;display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</body></html>`);
  await page.screenshot({ path: new URL(`../public/icons/${name}.png`, import.meta.url).pathname, omitBackground: false });
}
await browser.close();
console.log('icons done');
