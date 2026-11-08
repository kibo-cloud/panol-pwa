/* Pañol 3 · service worker: guarda solo la cáscara de la app (nunca /api). */
const VERSION = 'panol-v3.0.0-dev';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];
const OWN = /^panol-v/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
// Solo se borran las cachés propias de versiones anteriores.
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => OWN.test(k) && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Solo se guarda una respuesta correcta y sin redirección (nunca una página de error).
const cacheable = (r) => r && r.ok && !r.redirected && r.type === 'basic';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Páginas: primero la red (para recibir actualizaciones); sin conexión, la copia guardada.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (cacheable(r)) { const copy = r.clone(); e.waitUntil(caches.open(VERSION).then((c) => c.put('/index.html', copy)).catch(() => {})); }
      return r;
    }).catch(() => caches.match('/index.html')));
    return;
  }
  // Archivos con hash (assets/) y librerías (vendor/): no cambian, primero la copia guardada.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (cacheable(r)) await c.put(req, r.clone()).catch(() => {});
      return r;
    }));
    return;
  }
  // Resto de la cáscara (manifiesto, íconos): copia guardada y actualización en segundo plano.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req);
    const net = fetch(req).then((r) => (cacheable(r) ? c.put(req, r.clone()).catch(() => {}).then(() => r) : r)).catch(() => hit || Response.error());
    e.waitUntil(net);
    return hit || net;
  }));
});
