/* بوابة الدفع الإلكتروني (مدى، Apple Pay، STC Pay، البطاقات).
   المزوّد الافتراضي Moyasar عبر "الفواتير" (صفحة دفع مستضافة لديهم تدعم كل الطرق).
   'fake' مزوّد تجريبي للتطوير والاختبارات فقط، ومعطّل في الإنتاج.
   تأكيد الدفع يكون دائماً بسؤال البوابة مباشرة من الخادم (لا نثق بأي بيانات يرسلها المتصفح). */
import { config } from '../config.js';

const MOYASAR = 'https://api.moyasar.com/v1';

function moyasarAuth() {
  return 'Basic ' + Buffer.from(config.payments.moyasarSecretKey + ':').toString('base64');
}

export function paymentsProvider() {
  const p = config.payments.provider;
  if (p === 'moyasar' && config.payments.moyasarSecretKey) return 'moyasar';
  if (p === 'fake' && !config.isProd) return 'fake';
  return null;
}

/* ينشئ جلسة دفع ويرجع {ref, url} */
export async function createPayment({ paymentId, amount, description }) {
  const provider = paymentsProvider();
  if (provider === 'moyasar') {
    const r = await fetch(MOYASAR + '/invoices', {
      method: 'POST',
      headers: { Authorization: moyasarAuth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // بالهللة
        currency: 'SAR',
        description,
        callback_url: `${config.publicUrl}/api/payments/webhook`,
        success_url: `${config.publicUrl}/api/payments/return/${paymentId}`,
        back_url: `${config.publicUrl}/api/payments/return/${paymentId}`,
        metadata: { payment_id: paymentId },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id || !j.url) throw new Error('Moyasar invoice failed: ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
    return { ref: j.id, url: j.url };
  }
  if (provider === 'fake') return { ref: 'fake_' + paymentId, url: `/api/payments/fake/${paymentId}` };
  throw new Error('no payment provider');
}

/* يسأل البوابة عن حالة الدفع: 'paid' | 'failed' | 'pending' مع المبلغ المدفوع */
export async function fetchPaymentStatus(payment) {
  if (payment.provider === 'moyasar') {
    const r = await fetch(`${MOYASAR}/invoices/${encodeURIComponent(payment.provider_ref)}`, { headers: { Authorization: moyasarAuth() } });
    if (!r.ok) return { status: 'pending' };
    const j = await r.json();
    if (j.status === 'paid') return { status: 'paid', amount: Number(j.amount) / 100 };
    if (j.status === 'expired' || j.status === 'canceled' || j.status === 'failed') return { status: 'failed' };
    return { status: 'pending' };
  }
  if (payment.provider === 'fake') return { status: payment._fakeResult || 'pending', amount: payment.amount };
  return { status: 'pending' };
}
