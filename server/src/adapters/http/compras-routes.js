// Etapa 7: solicitudes de compra (apartado de Gerencia).
// - GET /api/compras?status&month&plantillaId&techId&cajaId&toolId&reason&q&archived&scope&limit&before
//   (purchases_view; con solo purchases_receive, scope=receive) -> { compras, next, total }.
// - GET /api/compras/totals?from&to (AAAA-MM) + filtros (purchases_view) -> { from, to, months, pending }.
// - GET /api/compras/:id (purchases_view, _receive o _create) con ETag: controles vinculados, línea
//   de tiempo (auditoría) y novedades.
// - POST /api/compras {toolId, assignmentId?, reason, qty, estimatedCost?, supplier?, observation?,
//   origin?, alertKey?} (purchases_create, Idempotency-Key) -> 201 { compra }.
// - PATCH /api/compras/:id {estimatedCost?, supplier?, observation?, qty?} + If-Match.
// - POST /api/compras/:id/approve|reject|purchase|receive + If-Match e Idempotency-Key.
// Eliminar (cancelar) y restaurar: records-routes.js (tipo `compras`, solo mientras está pendiente).
import * as compras from '../../application/compras.js';
import { S, obj, idParams, requireVersion, sendRow, actorOf, etag } from './rest.js';
import { idempotencyKey } from './operation-routes.js';
import { LIM, SCHEMA_LIM } from '../../domain/constants.js';
import { PURCHASE_STATUSES, PURCHASE_REASON_KEYS } from '../../domain/compras.js';

const MONTH = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' };
const cost = { anyOf: [{ type: 'number', minimum: 0 }, { type: 'string', maxLength: 20 }, { type: 'null' }] };
const text = S.str(LIM.text);
const filters = {
  plantillaId: S.id, techId: S.id, cajaId: S.id, toolId: S.id, reason: { type: 'string', enum: PURCHASE_REASON_KEYS }, q: S.str(LIM.name),
};

export function registerComprasRoutes(app) {
  const { db } = app;
  const perm = (p) => ({ preHandler: app.requirePerm(p) });
  const send = (reply, r) => {
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    if (r.body.compra) reply.header('ETag', etag(r.body.compra));
    return reply.code(r.status).send(r.body);
  };
  const ctx = (req) => ({ idempotencyKey: idempotencyKey(req), path: req.routeOptions.url + ':' + (req.params?.id || '') });

  // El permiso (ver, o recibir con scope=receive) lo revisa el caso de uso.
  app.get('/api/compras', {
    schema: {
      querystring: obj({
        ...filters, status: { type: 'string', enum: [...PURCHASE_STATUSES, 'open'] }, month: MONTH,
        archived: { type: 'string', enum: ['exclude', 'include', 'only'] }, scope: { type: 'string', enum: ['receive'] },
        limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' }, before: S.str(300),
      }),
    },
  }, async (req) => compras.listPurchases(db, actorOf(req), req.query));

  app.get('/api/compras/totals', { ...perm('purchases_view'), schema: { querystring: obj({ ...filters, from: MONTH, to: MONTH }) } },
    async (req) => compras.purchaseTotals(db, actorOf(req), req.query));

  app.get('/api/compras/:id', { schema: { params: idParams } },
    async (req, reply) => sendRow(reply, 'compra', await compras.getPurchaseDetail(db, actorOf(req), req.params.id)));

  app.post('/api/compras', {
    ...perm('purchases_create'),
    schema: {
      body: obj({
        toolId: S.id, assignmentId: S.idOrNull, reason: { type: 'string', enum: PURCHASE_REASON_KEYS }, qty: S.int(1, 100000),
        estimatedCost: cost, supplier: S.str(SCHEMA_LIM.name), observation: text, origin: { type: 'string', enum: ['tool', 'alert'] }, alertKey: S.str(500),
      }, ['toolId', 'reason', 'qty']),
    },
  }, async (req, reply) => send(reply, await compras.createPurchase(db, actorOf(req), req.body, ctx(req))));

  // El permiso (crear o decidir) lo revisa el caso de uso.
  app.patch('/api/compras/:id', {
    schema: { params: idParams, body: obj({ estimatedCost: cost, supplier: S.str(SCHEMA_LIM.name), observation: text, qty: S.int(1, 100000) }, [], { minProperties: 1 }) },
  }, async (req, reply) => sendRow(reply, 'compra', await compras.updatePurchase(db, actorOf(req), req.params.id, req.body, requireVersion(req))));

  const BODY = {
    approve: obj({ comment: text, estimatedCost: cost, supplier: S.str(SCHEMA_LIM.name) }),
    reject: obj({ comment: S.str(LIM.text, 1) }, ['comment']),
    purchase: obj({ note: text, estimatedCost: cost, supplier: S.str(SCHEMA_LIM.name) }),
    receive: obj({ qty: S.int(1, 100000), codes: S.str(SCHEMA_LIM.text), note: text }),
  };
  for (const action of Object.keys(BODY)) {
    app.post(`/api/compras/:id/${action}`, { schema: { params: idParams, body: { ...BODY[action], type: ['object', 'null'] } } },
      async (req, reply) => send(reply, await compras.transitionPurchase(db, actorOf(req), req.params.id, action, req.body || {}, requireVersion(req), ctx(req))));
  }
}
