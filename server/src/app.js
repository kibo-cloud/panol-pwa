// Fábrica de la aplicación Fastify. Arma la app sin escuchar en un puerto, así las pruebas
// la usan con `app.inject()`.
import Fastify from 'fastify';
import { errorHandler, notFound } from './adapters/http/errors.js';

export async function buildApp({ config, pool, logger } = {}) {
  if (!config) throw new Error('buildApp necesita config');
  if (!pool) throw new Error('buildApp necesita pool');
  const app = Fastify({
    logger: logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  app.decorate('config', config);
  app.decorate('db', pool);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => {
    const e = notFound('No existe esa ruta.', 'route_not_found');
    reply.code(e.status).send({ error: e.code, message: e.message });
  });

  // Salud: el servidor responde y la base contesta un `select 1`.
  app.get('/api/health', async (req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, db: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ ok: false, db: false });
    }
  });

  return app;
}
