// GET /api/events: flujo SSE para usuarios con sesión. Cada escritura confirmada manda
// `event: change` con { entity, id, version, action }; un comentario cada 25 s mantiene viva
// la conexión a través de proxies.
import { createEventHub } from '../sse/hub.js';

export function registerEventRoutes(app, { heartbeatMs } = {}) {
  const hub = createEventHub({
    connectionString: app.db.options?.connectionString || app.config.databaseUrl,
    log: (m) => app.log.warn(m),
    heartbeatMs,
  });
  app.decorate('events', hub);
  app.addHook('onClose', async () => hub.close());

  app.get('/api/events', async (req, reply) => {
    await hub.ready();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n: conectado\n\n');
    hub.add(res);
    const done = () => hub.remove(res);
    req.raw.on('close', done);
    res.on('error', done);
  });
}
