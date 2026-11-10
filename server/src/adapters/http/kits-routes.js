// Etapa 3: especialidades (techs_edit), kits (kits_edit; entregar con movements_do e
// Idempotency-Key) y orden personalizado de categorías y herramientas (tools_edit, If-Match con
// la versión del alcance).
import * as kits from '../../application/kits.js';
import * as orden from '../../application/orden.js';
import { listRows } from '../pg/catalog-repo.js';
import { S, obj, idParams, requireVersion, sendRow, actorOf } from './rest.js';
import { idempotencyKey, sendResult } from './operation-routes.js';
import { LIM } from '../../domain/constants.js';
import { KIT_MAX_ITEMS, KIT_MAX_QTY } from '../../domain/kits.js';

const ids = { type: 'array', maxItems: 2000, items: S.id };

export function registerKitsRoutes(app) {
  const { db } = app;
  const perm = (p) => ({ preHandler: app.requirePerm(p) });

  // ------------------------------------------------------------ especialidades
  app.get('/api/especialidades', async () => ({ especialidades: await listRows(db, 'especialidades', 'ORDER BY sort_order, name, id') }));
  app.post('/api/especialidades', { ...perm('techs_edit'), schema: { body: obj({ name: S.name, order: S.int(0, 1000) }, ['name']) } },
    async (req, reply) => sendRow(reply, 'especialidad', await kits.createEspecialidad(db, actorOf(req), req.body), 201));
  app.patch('/api/especialidades/:id', { ...perm('techs_edit'), schema: { params: idParams, body: obj({ name: S.name, order: S.int(0, 1000) }, [], { minProperties: 1 }) } },
    async (req, reply) => sendRow(reply, 'especialidad', await kits.updateEspecialidad(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
  // Archivar y eliminar especialidades y kits: records-routes.js (etapa 5).

  // ------------------------------------------------------------ kits
  const items = { type: 'array', maxItems: KIT_MAX_ITEMS, items: obj({ toolId: S.id, qty: S.int(1, KIT_MAX_QTY) }, ['toolId', 'qty']) };
  app.get('/api/kits', async () => ({ kits: await kits.loadKits(db) }));
  app.post('/api/kits', { ...perm('kits_edit'), schema: { body: obj({ especialidadId: S.id, name: S.name }, ['especialidadId']) } },
    async (req, reply) => sendRow(reply, 'kit', await kits.createKit(db, actorOf(req), req.body), 201));
  app.put('/api/kits/:id', { ...perm('kits_edit'), schema: { params: idParams, body: obj({ name: S.name, items }, [], { minProperties: 1 }) } },
    async (req, reply) => sendRow(reply, 'kit', await kits.updateKit(db, actorOf(req), req.params.id, req.body, requireVersion(req))));

  // Un poseedor exacto: { techId } o { cajaId }. unitIds: { toolId: [unitId] } (por código).
  const holder = { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1, properties: { techId: S.id, cajaId: S.id } };
  const unitIds = { type: 'object', maxProperties: KIT_MAX_ITEMS, propertyNames: { pattern: S.id.pattern }, additionalProperties: { type: 'array', minItems: 1, maxItems: 500, items: S.id } };
  app.post('/api/kits/:id/deliver', {
    ...perm('movements_do'),
    schema: { params: idParams, body: obj({ holder, unitIds, reason: S.str(LIM.text) }, ['holder']) },
  }, async (req, reply) => sendResult(reply, await kits.deliverKit(db, actorOf(req), req.params.id, req.body, {
    idempotencyKey: idempotencyKey(req), path: req.routeOptions.url, version: req.headers['if-match'] === undefined ? null : requireVersion(req),
  })));

  // ------------------------------------------------------------ orden
  const sendOrder = (reply, r) => reply.header('ETag', `"${r.version}"`).send(r);
  app.put('/api/categories/order', { ...perm('tools_edit'), schema: { body: obj({ ids }, ['ids']) } },
    async (req, reply) => sendOrder(reply, await orden.reorderCategories(db, actorOf(req), req.body.ids, requireVersion(req))));
  app.put('/api/tools/order', { ...perm('tools_edit'), schema: { body: obj({ categoryId: S.idOrNull, ids }, ['ids']) } },
    async (req, reply) => sendOrder(reply, await orden.reorderTools(db, actorOf(req), req.body.categoryId ?? null, req.body.ids, requireVersion(req))));
}
