// /api/lineas, /api/cajas (permiso lineas_edit, bajas lógicas, If-Match en toda edición) y
// /api/assignments: alta de una asignación a un técnico o a una caja en un solo formulario
// (movements_do, acepta Idempotency-Key).
import * as lineas from '../../application/lineas.js';
import { listRows } from '../pg/catalog-repo.js';
import { S, obj, idParams, requireVersion, sendRow, actorOf } from './rest.js';
import { idempotencyKey, sendResult } from './operation-routes.js';
import { LIM } from '../../domain/constants.js';
import { LINEA_KINDS } from '../../domain/lineas.js';

export function registerLineasRoutes(app) {
  const { db } = app;
  const perm = (p) => ({ preHandler: app.requirePerm(p) });
  const kind = { type: 'string', enum: LINEA_KINDS };

  app.get('/api/lineas', async () => ({ lineas: await listRows(db, 'lineas', 'ORDER BY sort_order, id') }));
  app.post('/api/lineas', { ...perm('lineas_edit'), schema: { body: obj({ name: S.name, kind, order: S.int(0, 1000) }, ['name', 'kind']) } },
    async (req, reply) => sendRow(reply, 'linea', await lineas.createLinea(db, actorOf(req), req.body), 201));
  app.patch('/api/lineas/:id', { ...perm('lineas_edit'), schema: { params: idParams, body: obj({ name: S.name, kind, order: S.int(0, 1000) }, [], { minProperties: 1 }) } },
    async (req, reply) => sendRow(reply, 'linea', await lineas.updateLinea(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
  app.post('/api/lineas/:id/archive', { ...perm('lineas_edit'), schema: { params: idParams } },
    async (req, reply) => sendRow(reply, 'linea', await lineas.archiveLinea(db, actorOf(req), req.params.id, requireVersion(req))));

  app.get('/api/cajas', async () => ({ cajas: await listRows(db, 'cajas', 'ORDER BY name, id') }));
  const cajaBody = { name: S.name, lineaId: S.id, referenteTechId: S.idOrNull };
  app.post('/api/cajas', { ...perm('lineas_edit'), schema: { body: obj(cajaBody, ['name', 'lineaId']) } },
    async (req, reply) => sendRow(reply, 'caja', await lineas.createCaja(db, actorOf(req), req.body), 201));
  app.patch('/api/cajas/:id', { ...perm('lineas_edit'), schema: { params: idParams, body: obj(cajaBody, [], { minProperties: 1 }) } },
    async (req, reply) => sendRow(reply, 'caja', await lineas.updateCaja(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
  app.post('/api/cajas/:id/archive', { ...perm('lineas_edit'), schema: { params: idParams } },
    async (req, reply) => sendRow(reply, 'caja', await lineas.archiveCaja(db, actorOf(req), req.params.id, requireVersion(req))));

  // Un poseedor exacto: { techId } o { cajaId }.
  const holder = { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1, properties: { techId: S.id, cajaId: S.id } };
  app.post('/api/assignments', {
    ...perm('movements_do'),
    schema: {
      body: obj({ holder, toolId: S.id, qty: S.int(1, 1000000), unitIds: { type: 'array', minItems: 1, maxItems: 500, items: S.id }, reason: S.str(LIM.text) }, ['holder', 'toolId']),
    },
  }, async (req, reply) => sendResult(reply, await lineas.createAssignment(db, actorOf(req), req.body, {
    idempotencyKey: idempotencyKey(req), path: req.routeOptions.url,
  })));
}
