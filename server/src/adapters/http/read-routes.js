// Lecturas (cualquier usuario con sesión) y auditoría (solo admin).
import * as read from '../../application/read.js';
import { S, obj, idParams, etag } from './rest.js';
import { badRequest } from './errors.js';

export function registerReadRoutes(app) {
  const { db } = app;

  app.get('/api/state', async (req) => read.getState(db, { user: req.session.user }));
  app.get('/api/inventory', async () => read.getInventory(db));
  app.get('/api/alerts', async () => read.getAlerts(db));
  app.get('/api/integrity', async () => read.getIntegrity(db));

  app.get('/api/reports', {
    schema: {
      querystring: obj({
        ym: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
        w: { type: 'string', enum: ['all', '1', '2', '3', '4'] },
        shift: S.id,
        plantilla: S.id,
        tech: S.id,
        especialidad: S.id,
      }),
    },
  }, async (req) => read.getReport(db, req.query));

  app.get('/api/controls', {
    schema: { querystring: obj({ techId: S.id, cajaId: S.id, plantillaId: S.id, status: { type: 'string', enum: ['borrador', 'finalizado'] } }) },
  }, async (req) => ({ controls: await read.listControls(db, req.query) }));

  app.get('/api/controls/:id', { schema: { params: idParams } }, async (req, reply) => {
    const c = await read.getControl(db, req.params.id);
    reply.header('ETag', etag(c));
    return { control: c };
  });

  app.get('/api/audit', {
    preHandler: app.requireAdmin,
    schema: { querystring: obj({ limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' }, before: S.str(300) }) },
  }, async (req) => {
    const limit = Math.min(200, Number(req.query.limit || 50));
    let before = null;
    if (req.query.before) {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([A-Za-z0-9_.~:@+-]{1,200})$/.exec(req.query.before);
      if (!m) throw badRequest('Cursor de auditoría inválido.', 'invalid_cursor');
      before = { at: m[1], id: m[2] };
    }
    return read.listAudit(db, { limit, before });
  });
}
