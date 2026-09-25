/* استيراد بيانات النسخة القديمة (Claude Artifact) إلى قاعدة البيانات الجديدة.
   الاستخدام:
     npm run import:artifact -- <مجلد_التصدير أو ملف_حزمة.json> [--replace]
     npm run import:artifact -- <مجلد_التصدير> --bundle <ملف_الناتج.json>   (تجهيز ملف واحد للرفع من لوحة الإدارة)
   المجلد يحتوي: stores/ settings/ coupons/ drivers/ pimg/ واختيارياً customers/ orders/ (ملف JSON لكل مستند) */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { bundleFromDir, importBundle } from '../src/importer.js';

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('حدد مجلد التصدير أو ملف الحزمة'); process.exit(1); }
const bundle = fs.statSync(src).isDirectory() ? bundleFromDir(src) : JSON.parse(fs.readFileSync(src, 'utf8'));

const bi = process.argv.indexOf('--bundle');
if (bi > -1) {
  const out = process.argv[bi + 1];
  if (!out) { console.error('حدد مسار ملف الناتج'); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(bundle));
  console.log(`تم تجهيز الحزمة: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} ميجا)`);
  process.exit(0);
}

const db = openDb(path.join(config.dataDir, 'alhadar.db'));
for (const line of importBundle(db, path.join(config.dataDir, 'uploads'), bundle, { replace: process.argv.includes('--replace') })) console.log(line);
console.log('تم الاستيراد ✅');
