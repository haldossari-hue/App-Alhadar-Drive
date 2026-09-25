/* إشعارات Push حقيقية (Web Push / VAPID) تصل للجوال حتى لو التطبيق مقفل،
   على أندرويد، وعلى آيفون (iOS 16.4+) بعد إضافة التطبيق للشاشة الرئيسية. */
import webpush from 'web-push';
import { config } from '../config.js';

export function createPush(db, log) {
  /* مفاتيح VAPID: من متغيرات البيئة، وإلا تُولَّد مرة وتُحفظ بالقاعدة */
  let keys = config.push.publicKey && config.push.privateKey
    ? { publicKey: config.push.publicKey, privateKey: config.push.privateKey }
    : db.kvGet('vapid');
  if (!keys) { keys = webpush.generateVAPIDKeys(); db.kvSet('vapid', keys); }
  webpush.setVapidDetails(config.push.subject, keys.publicKey, keys.privateKey);

  function subscribe(role, subject, sub) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return false;
    db.run(`INSERT INTO push_subs(endpoint, role, subject, sub, created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET role=excluded.role, subject=excluded.subject, sub=excluded.sub`,
      sub.endpoint, role, String(subject), JSON.stringify(sub), Date.now());
    return true;
  }
  function unsubscribe(endpoint) { db.run('DELETE FROM push_subs WHERE endpoint = ?', endpoint); }

  async function deliver(rows, payload) {
    const body = JSON.stringify(payload);
    await Promise.all(rows.map(async (r) => {
      try { await webpush.sendNotification(JSON.parse(r.sub), body, { TTL: 3600 }); }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(r.endpoint);
        else log.warn({ err: e.message }, 'push failed');
      }
    }));
  }
  const to = (role, subject, payload) =>
    deliver(db.all('SELECT * FROM push_subs WHERE role = ? AND subject = ?', role, String(subject)), payload).catch(() => {});

  return {
    publicKey: keys.publicKey,
    subscribe,
    unsubscribe,
    customer: (phone, p) => to('customer', phone, p),
    driver: (id, p) => to('driver', id, p),
    admins: (p) => deliver(db.all("SELECT * FROM push_subs WHERE role = 'admin'"), p).catch(() => {}),
    onlineDrivers: (p) => deliver(db.all(
      `SELECT ps.* FROM push_subs ps JOIN drivers d ON d.id = ps.subject
       WHERE ps.role = 'driver' AND d.active = 1 AND d.online = 1`), p).catch(() => {}),
  };
}
