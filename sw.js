// Service Worker：App 外殼離線可開；API 永遠走網路
const CACHE = 'fp-shell-v6';
const SHELL = ['./', './index.html', './styles.css', './app.js', './data/airports.js', './data/airlines.js', './data/holidays.js', './i18n.js', './manifest.json', './icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;                     // GAS／家中電腦 API 不快取
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
