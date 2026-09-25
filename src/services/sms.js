/* إرسال رسائل SMS (رمز التحقق). المزودات: console للتطوير، Unifonic، Taqnyat.
   تحقق من صيغة الـ API مع وثائق المزوّد عند فتح الحساب، لأنها قد تتغير. */
import { config } from '../config.js';

export async function sendSms(phone, text, log = console) {
  const intl = '966' + phone.slice(1); // 05xxxxxxxx → 9665xxxxxxxx
  const { provider, sender, unifonicAppSid, taqnyatToken } = config.sms;

  if (provider === 'unifonic') {
    const body = new URLSearchParams({ AppSid: unifonicAppSid, SenderID: sender, Recipient: intl, Body: text });
    const r = await fetch('https://el.cloud.unifonic.com/rest/SMS/messages', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false || j.success === 'false') throw new Error('Unifonic: ' + (j.message || r.status));
    return;
  }
  if (provider === 'taqnyat') {
    const r = await fetch('https://api.taqnyat.sa/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + taqnyatToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: [intl], body: text, sender }),
    });
    if (!r.ok) throw new Error('Taqnyat: ' + r.status + ' ' + (await r.text().catch(() => '')));
    return;
  }
  /* وضع التطوير: الرسالة تظهر في سجل الخادم فقط */
  log.info({ sms: { to: phone, text } }, 'SMS (console provider)');
}
