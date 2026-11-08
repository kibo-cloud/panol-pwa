// La app web compilada (web/dist) y las cabeceras de seguridad de todas las respuestas.
// - CSP estricta como cabecera HTTP (la app no tiene código ni estilos en línea).
// - Archivos con hash (assets/, vendor/ con versión en el nombre): caché larga e inmutable.
// - index.html y sw.js: sin caché, para que una versión nueva llegue enseguida.
// - Cualquier GET que no sea /api ni un archivo existente devuelve index.html (rutas por hash).
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';

export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "connect-src 'self'",
  "font-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
].join('; ');
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function registerSecurityHeaders(app) {
  const production = app.config.nodeEnv === 'production';
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    // HSTS solo en producción (detrás de HTTPS); en local se usa http://localhost.
    if (production) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
}

const isApi = (url) => url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');

// Devuelve la ruta de index.html si hay app compilada para servir (si no, false).
export async function registerWeb(app) {
  const root = app.config.webDist;
  if (!root || !fs.existsSync(path.join(root, 'index.html'))) {
    app.log.info(`sin app web compilada en ${root || '(no configurado)'}: corré npm run build`);
    return false;
  }
  // En su propio contexto: las rutas de archivos estáticos son públicas (la sesión se pide en /api).
  await app.register(async (web) => {
    web.addHook('onRoute', (r) => { r.config = { ...(r.config || {}), public: true }; });
    await web.register(fastifyStatic, {
      root,
      prefix: '/',
      cacheControl: false,
      // Los archivos que empiezan con punto nunca se sirven.
      dotfiles: 'deny',
      allowedPath: (pathName) => !isApi(pathName),
      setHeaders(reply, filePath) {
        const rel = path.relative(root, filePath).split(path.sep).join('/');
        reply.header('Cache-Control', rel.startsWith('assets/') || rel.startsWith('vendor/') ? IMMUTABLE : 'no-cache');
      },
    });
  });
  return path.join(root, 'index.html');
}

// Para el manejador de "no encontrado": GET de una ruta de la app (sin extensión) -> index.html.
export function spaFallback(req, reply, indexFile) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = req.url.split('?')[0];
  if (isApi(url) || /\.[A-Za-z0-9]+$/.test(url)) return false;
  reply.header('Cache-Control', 'no-cache');
  reply.type('text/html; charset=utf-8');
  reply.send(fs.createReadStream(indexFile));
  return true;
}
