/* أدوات عامة للواجهة */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => { n = Number(n) || 0; return (Math.round(n * 100) / 100).toLocaleString('en-US') + ' ر.س'; };

export function lsg(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
export function lss(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* تخزين غير متاح */ } }

export function ago(t) {
  if (!t) return '';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return 'قبل ' + m + ' د';
  const h = Math.floor(m / 60);
  if (h < 24) return 'قبل ' + h + ' س';
  return new Date(t).toLocaleDateString('ar-SA-u-nu-latn', { day: 'numeric', month: 'short' });
}
export const clock = (t) => (t ? new Date(t).toLocaleTimeString('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit' }) : '');
export const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function toast(m) {
  const t = document.getElementById('toast');
  t.innerHTML = '<div>' + esc(m) + '</div>';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.innerHTML = ''), 2600);
}
let audioCtx = null;
export function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const c = audioCtx;
    [0, 0.18].forEach((d) => {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(0.12, c.currentTime + d);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + d + 0.15);
      o.start(c.currentTime + d); o.stop(c.currentTime + d + 0.16);
    });
  } catch { /* الصوت غير متاح */ }
}

/* بحث عربي يتجاهل الهمزات والتاء المربوطة والتشكيل */
export const norm = (t) => String(t || '').toLowerCase().replace(/[ً-ٟـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/\s+/g, ' ').trim();
export const has = (a, q) => norm(a).includes(q);

export const waLink = (t) => {
  let n = String(t || '').replace(/[\s-]/g, '').replace(/^\+/, '');
  if (/^05\d{8}$/.test(n)) n = '966' + n.slice(1); else if (/^5\d{8}$/.test(n)) n = '966' + n;
  return 'https://wa.me/' + n;
};
export const secsOf = (s) => { const o = []; (s.products || []).forEach((p) => { const k = (p.sec || '').trim() || 'منتجات أخرى'; if (!o.includes(k)) o.push(k); }); return o; };

/* تصغير الصور قبل الرفع (أقصى بُعد 1000 بكسل) */
export function shrink(file, max = 1000) {
  return new Promise((res) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => { URL.revokeObjectURL(url); res(b || file); }, 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(file); };
    img.src = url;
  });
}

/* شعار الهدار درايف: نخلة فوق طويق، ووادي الهدار يتحول طريقاً */
export function emblem(n) { return `<svg class="emb" width="${n}" height="${n}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#A65A2A"/><circle cx="46" cy="18" r="7" fill="#F6C46A"/><path d="M0 43L9 35H25L31 39L45 32L64 37V64H0Z" fill="#7A3D19"/><path d="M0 47L12 42H22L30 45L46 40L64 44" stroke="#C98552" stroke-width="1.5" fill="none"/><path d="M23 52C24 43 23 34 25 25" stroke="#1E5B43" stroke-width="3.2" fill="none" stroke-linecap="round"/><g fill="#1E5B43"><path d="M25 25C19 19 12 19 8 24C14 22 20 23 25 25Z"/><path d="M25 25C21 17 23 11 29 9C26 14 26 20 25 25Z"/><path d="M25 25C31 18 38 18 41 22C35 21 30 22 25 25Z"/><path d="M25 25C18 25 13 29 12 35C16 30 20 27 25 25Z"/><path d="M25 25C32 25 36 29 37 35C33 30 29 27 25 25Z"/></g><path d="M44 64C44 57 33 55 37 48" stroke="#F6C46A" stroke-width="3" stroke-dasharray="4 3" fill="none" stroke-linecap="round"/></svg>`; }

/* مشهد الهدار: جبال طويق، النخيل، والبيت النجدي بشرفاته */
export function skyline() {
  const palm = '<path d="M0 0C-7-6-15-6-19 0C-12-2-6-1 0 0Z"/><path d="M0 0C-4-9-2-15 5-17C2-12 2-6 0 0Z"/><path d="M0 0C7-8 15-8 18-3C12-4 6-3 0 0Z"/><path d="M0 0C-8 0-13 4-14 11C-9 6-5 3 0 0Z"/><path d="M0 0C8 0 12 4 13 11C9 6 5 3 0 0Z"/>';
  return `<svg class="sky" viewBox="0 0 400 92" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
 <path d="M0 58L40 40H120L150 50L210 30H300L330 44L400 36V92H0Z" fill="#8A4520" opacity=".55"/>
 <path d="M0 70L60 60H140L180 66L260 56H340L400 62V92H0Z" fill="#6E3416" opacity=".7"/>
 <g transform="translate(236 34)"><rect x="0" y="16" width="70" height="42" fill="#C98552"/><rect x="18" y="4" width="34" height="14" fill="#C98552"/>
  <path d="M0 16l4-5 4 5 4-5 4 5 4-5 4 5M52 16l4-5 4 5 4-5 4 5" fill="#C98552"/><path d="M18 4l4-5 4 5 4-5 4 5 4-5 4 5 4-5 4 5" fill="#C98552"/>
  <g fill="#7A3D19"><path d="M10 30l4-6 4 6z"/><path d="M52 30l4-6 4 6z"/><path d="M31 12l4-6 4 6z"/><rect x="30" y="38" width="10" height="20" rx="5"/></g></g>
 <g stroke="#1B4A36" stroke-width="3" fill="none" stroke-linecap="round"><path d="M50 92C51 76 50 62 53 50"/><path d="M96 92C97 80 96 70 98 60"/><path d="M356 92C357 78 356 66 358 56"/></g>
 <g fill="#1E5B43"><g transform="translate(53 50)">${palm}</g><g transform="translate(98 60) scale(.75)">${palm}</g><g transform="translate(358 56) scale(.85)">${palm}</g></g>
 <path class="skyroad" d="M150 92C170 84 190 86 210 80S250 74 268 70" stroke="#F6C46A" stroke-width="3" stroke-dasharray="8 6" fill="none" stroke-linecap="round"/>
</svg>`;
}
