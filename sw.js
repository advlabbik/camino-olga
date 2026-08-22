/* Buen Camino Olga — service worker.
   Rete-prima CON timeout: con segnale debole (lie-fi) la cache risponde entro ~3,5 s
   invece di aspettare minuti il timeout del browser. Install atomico: se anche un solo
   file del precache fallisce, l'aggiornamento viene rimandato e la cache buona resta. */
const V = 'bco-v10';
const SHELL = ['./', 'index.html', 'assets/style.css', 'assets/app.js', 'assets/map.js', 'assets/icon.svg',
  'assets/icon-512.png',
  'assets/vendor/leaflet.js', 'assets/vendor/leaflet.css', 'manifest.webmanifest',
  'data/track.json', 'data/phrases.json', 'data/alerts.json', 'data/sellos.json', 'data/status.json', 'data/pois.json', 'data/localities.json'];
const WKEY = 'https://api.open-meteo.com/__ultimo-meteo';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname === 'api.open-meteo.com') {
    /* meteo: rete prima; come paracadute l'ULTIMA risposta buona qualunque fossero le coordinate */
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(WKEY, cp)); }
      return r;
    }).catch(() => caches.match(WKEY)));
    return;
  }
  if (url.origin !== location.origin) return; /* tile mappa ecc.: lasciar fare al browser */
  const net = fetch(e.request).then(r => {
    if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); }
    return r;
  });
  e.respondWith(Promise.race([
    net.catch(() => null),
    new Promise(res => setTimeout(() => res(null), 3500))
  ]).then(r => r || caches.match(e.request).then(hit =>
    hit || (e.request.mode === 'navigate' ? caches.match('index.html') : net)
  )));
});
