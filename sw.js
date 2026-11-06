/* Pañol · service worker: funciona sin conexión */
const VERSION = 'panol-v2.1.0';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Páginas: primero la red (para recibir actualizaciones), si no hay conexión, la copia guardada.
  // Solo se guarda como app una respuesta correcta y sin redirección (nunca una página de error).
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => {
      if (r.ok && !r.redirected && r.type === 'basic') { const copy = r.clone(); e.waitUntil(caches.open(VERSION).then(c => c.put('./index.html', copy)).catch(() => {})); }
      return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  // Archivos de la app y librerías externas: copia guardada y actualización en segundo plano.
  // Las librerías de cdnjs se piden con CORS (por su verificación de integridad), así que se guardan como respuestas legibles.
  if (url.origin === location.origin || RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => {
        if (r && (r.ok || r.type === 'opaque')) return c.put(req, r.clone()).catch(() => {}).then(() => r);
        return r;
      }).catch(() => hit || Response.error());
      e.waitUntil(net);
      return hit || net;
    }));
  }
});
