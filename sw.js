/* Buen Camino Olga — service worker: shell+dati offline, meteo network-first */
const V = 'bco-v2';
const SHELL = ['./', 'index.html', 'assets/style.css', 'assets/app.js', 'assets/map.js', 'assets/icon.svg',
  'assets/vendor/leaflet.js', 'assets/vendor/leaflet.css', 'manifest.webmanifest',
  'data/track.json', 'data/phrases.json', 'data/alerts.json', 'data/sellos.json', 'data/status.json', 'data/pois.json', 'data/localities.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname === 'api.open-meteo.com') {
    /* meteo: rete prima, cache come paracadute */
    e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request)));
    return;
  }
  if (url.origin === location.origin) {
    /* shell e dati: cache prima, aggiorna in background */
    e.respondWith(caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); } return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
