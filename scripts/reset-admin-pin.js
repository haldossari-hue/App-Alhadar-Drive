/* إعادة ضبط رمز الإدارة من الخادم (لو ضاع الرمز ورمز الاسترجاع معاً).
   الاستخدام: node scripts/reset-admin-pin.js 123456 */
import path from 'node:path';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { hashSecret } from '../src/auth.js';

const pin = process.argv[2];
if (!/^\d{4,8}$/.test(pin || '')) { console.error('الرمز من 4 إلى 8 أرقام'); process.exit(1); }
const db = openDb(path.join(config.dataDir, 'alhadar.db'));
const a = db.kvGet('admin', { v: 0, recoveryHash: null });
db.kvSet('admin', { ...a, pinHash: hashSecret(pin), v: (a.v || 0) + 1 });
console.log('تم تعيين رمز الإدارة الجديد، وتم تسجيل خروج كل الأجهزة.');
