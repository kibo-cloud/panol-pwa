// Fábrica de la aplicación Fastify. Arma la app sin escuchar en un puerto, así las pruebas
// la usan con `app.inject()`.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { errorHandler, notFound } from './adapters/http/errors.js';
import { registerAuth } from './adapters/http/auth.js';
import { registerAuthRoutes } from './adapters/http/auth-routes.js';
import { registerUserRoutes } from './adapters/http/users-routes.js';
import { registerCatalogRoutes } from './adapters/http/catalog-routes.js';
import { registerReadRoutes } from './adapters/http/read-routes.js';
import { registerOperationRoutes } from './adapters/http/operation-routes.js';
import { registerEventRoutes } from './adapters/http/events-routes.js';
import { registerTxtRoutes } from './adapters/http/txt-routes.js';
import { registerPlantillaRoutes } from './adapters/http/plantilla-routes.js';
import { registerSecurityHeaders, registerWeb, spaFallback } from './adapters/http/web-routes.js';

// extend(app): permite a las pruebas registrar rutas antes de `ready()`.
// events: opciones del flujo SSE (p. ej. heartbeatMs en pruebas).
export async function buildApp({ config, pool, logger, extend, events } = {}) {
  if (!config) throw new Error('buildApp necesita config');
  if (!pool) throw new Error('buildApp necesita pool');
  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Validación estricta: sin conversión de tipos ni campos extra descartados en silencio.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: false } },
  });
  app.decorate('config', config);
  app.decorate('db', pool);
  app.setErrorHandler(errorHandler);
  let web = false;
  app.setNotFoundHandler((req, reply) => {
    // Rutas de la app web (por hash): se responde index.html.
    if (web && spaFallback(req, reply, web)) return;
    const e = notFound('No existe esa ruta.', 'route_not_found');
    reply.code(e.status).send({ error: e.code, message: e.message });
  });
  app.addHook('onSend', async (req, reply, payload) => {
    // Las respuestas de la API nunca se guardan en cachés intermedias.
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  registerSecurityHeaders(app);
  await app.register(cookie);
  registerAuth(app);

  // Salud: el servidor responde y la base contesta un `select 1`.
  app.get('/api/health', { config: { public: true } }, async (req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, db: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  registerAuthRoutes(app);
  registerUserRoutes(app);
  registerCatalogRoutes(app);
  registerPlantillaRoutes(app);
  registerReadRoutes(app);
  registerOperationRoutes(app);
  registerEventRoutes(app, events);
  registerTxtRoutes(app);
  web = await registerWeb(app);
  if (extend) await extend(app);
  return app;
}
