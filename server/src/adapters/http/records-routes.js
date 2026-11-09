// Etapa 5: eliminar, restaurar, eliminación definitiva y anular movimientos.
// - POST /api/<tipo>/:id/archive {reason, resolutions?} + If-Match: baja lógica (técnicos y
//   cajas con herramientas: una resolución por asignación activa, en la misma transacción).
// - POST /api/<tipo>/:id/restore {reason} + If-Match.
// - DELETE /api/<tipo>/:id {reason, confirmName} + If-Match: definitiva, solo sin historial.
// - GET /api/<tipo>/:id/delete-check: impedimentos, asignaciones a resolver e historial.
// - GET /api/archived?type&q: Administración › Registros eliminados.
// - POST /api/movements/:id/void {reason} (Idempotency-Key) y GET /api/movements/:id/void-check.
// Permisos: records_delete y movements_void (solo admin por defecto). Los usuarios además
// solo los administra un administrador.
import * as records from '../../application/records.js';
import * as voids from '../../application/voids.js';
import { RECORD_TYPES, RECORD_TYPE_KEYS, RESOLUTION_ACTIONS, RESOLUTION_COND } from '../../domain/records.js';
import { S, obj, idParams, requireVersion, actorOf, etag } from './rest.js';
import { idempotencyKey, sendResult } from './operation-routes.js';
import { forbidden } from './errors.js';
import { LIM, SCHEMA_LIM } from '../../domain/constants.js';

const reason = S.str(LIM.text, 1);
const resolution = obj({ assignmentId: S.id, action: { type: 'string', enum: RESOLUTION_ACTIONS }, cond: { type: 'string', enum: RESOLUTION_COND } }, ['assignmentId', 'action']);

export function registerRecordsRoutes(app) {
  const { db } = app;
  const perm = (p) => app.requirePerm(p);
  const adminFor = (type) => async (req) => {
    if (type === 'users' && req.session?.user.role !== 'admin') throw forbidden();
  };

  for (const type of RECORD_TYPE_KEYS) {
    const { key } = RECORD_TYPES[type];
    const pre = { preHandler: [perm('records_delete'), adminFor(type)] };
    const send = (reply, r, code = 200) => {
      if (r.record && r.record.version != null) reply.header('ETag', etag(r.record));
      return reply.code(code).send({ [key]: r.record, ...(r.movements ? { movements: r.movements } : {}) });
    };
    app.get(`/api/${type}/:id/delete-check`, { ...pre, schema: { params: idParams } }, async (req) => records.deleteCheck(db, actorOf(req), type, req.params.id));
    app.post(`/api/${type}/:id/archive`, {
      ...pre, schema: { params: idParams, body: obj({ reason, resolutions: { type: 'array', maxItems: 1000, items: resolution } }, ['reason']) },
    }, async (req, reply) => send(reply, await records.archiveRecord(db, actorOf(req), type, req.params.id, req.body, requireVersion(req))));
    app.post(`/api/${type}/:id/restore`, { ...pre, schema: { params: idParams, body: obj({ reason }, ['reason']) } },
      async (req, reply) => send(reply, await records.restoreRecord(db, actorOf(req), type, req.params.id, req.body, requireVersion(req))));
    app.delete(`/api/${type}/:id`, { ...pre, schema: { params: idParams, body: obj({ reason, confirmName: S.str(SCHEMA_LIM.name, 1) }, ['reason', 'confirmName']) } },
      async (req) => records.purgeRecord(db, actorOf(req), type, req.params.id, req.body, requireVersion(req)));
  }

  app.get('/api/archived', {
    preHandler: perm('records_delete'),
    schema: { querystring: obj({ type: { type: 'string', enum: RECORD_TYPE_KEYS }, q: S.str(LIM.name) }) },
  }, async (req) => {
    const r = await records.listArchived(db, req.query);
    // Los usuarios eliminados solo los ve un administrador.
    if (req.session.user.role !== 'admin') r.records = r.records.filter((x) => x.type !== 'users');
    return r;
  });

  app.get('/api/movements/:id/void-check', { preHandler: perm('movements_void'), schema: { params: idParams } }, async (req) => voids.checkVoid(db, req.params.id));
  app.post('/api/movements/:id/void', {
    preHandler: perm('movements_void'),
    schema: { params: idParams, body: obj({ reason }, ['reason']) },
  }, async (req, reply) => sendResult(reply, await voids.voidMovement(db, actorOf(req), req.params.id, req.body, {
    idempotencyKey: idempotencyKey(req), path: req.routeOptions.url + ':' + req.params.id,
  })));
}
