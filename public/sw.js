/* Service Worker: تشغيل سريع للواجهة + استقبال إشعارات Push */
const CACHE = 'hd-shell-v2';
const SHELL = ['/', '/app.css', '/js/app.js', '/js/api.js', '/js/util.js', '/shared/constants.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/fonts/fonts.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

/* ملفات الواجهة: من الشبكة أولاً (لتصل التحديثات فوراً)، ومن الذاكرة عند انقطاع الإنترنت.
   طلبات الـ API والبث والملفات الخاصة لا تُخزَّن أبداً. */
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/files/')) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok && (SHELL.includes(u.pathname) || u.pathname.startsWith('/fonts/'))) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match('/')))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'الهدار درايف', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'الهدار درايف', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, dir: 'rtl', lang: 'ar',
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: d.url || '/' }, vibrate: [120, 60, 120],
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ('focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
