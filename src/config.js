import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* تحميل ملف .env البسيط بدون مكتبات خارجية */
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

export const config = {
  root: ROOT,
  isProd,
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  /* الرابط العام للتطبيق (مطلوب لروابط الدفع والإشعارات) مثل https://alhadar.sa */
  publicUrl: (env.PUBLIC_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  /* مفتاح توقيع الجلسات — لازم يكون سري وطويل في الإنتاج */
  secret: env.APP_SECRET || (isProd ? null : 'dev-only-secret-change-me'),
  /* رمز الإدارة الأولي إذا ما فيه رمز محفوظ بالقاعدة */
  initialAdminPin: env.INITIAL_ADMIN_PIN || '1234',

  sms: {
    provider: env.SMS_PROVIDER || 'console', // console | unifonic | taqnyat
    sender: env.SMS_SENDER || 'AlHadar',
    unifonicAppSid: env.UNIFONIC_APP_SID || '',
    taqnyatToken: env.TAQNYAT_TOKEN || '',
  },
  /* إظهار رمز التحقق في الرد (للتطوير والاختبارات فقط) */
  otpDevEcho: !isProd && env.OTP_DEV_ECHO !== '0',

  payments: {
    provider: env.PAYMENT_PROVIDER || '', // moyasar | ''
    moyasarSecretKey: env.MOYASAR_SECRET_KEY || '',
  },

  push: {
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
  },
};

if (!config.secret) {
  throw new Error('APP_SECRET مطلوب في وضع الإنتاج (NODE_ENV=production)');
}
