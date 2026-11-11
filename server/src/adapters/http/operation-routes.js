// Operaciones: movimientos, controles, alertas y datos de demostración.
// - POST /api/movements, POST /api/controls, PATCH /api/controls/:id y
//   POST /api/controls/:id/finalize aceptan `Idempotency-Key`: un reintento devuelve la misma
//   respuesta (con `Idempotent-Replayed: true`) sin volver a aplicar nada.
import * as movements from '../../application/movements.js';
import * as controls from '../../application/controls.js';
import * as alerts from '../../application/alerts.js';
import * as demo from '../../application/demo.js';
import { IDEMPOTENCY_KEY_RE } from '../../application/idempotency.js';
import { S, obj, idParams, requireVersion, sendRow, actorOf, etag } from './rest.js';
import { badRequest } from './errors.js';
import { MV_TYPES, ITEM_STATES, SCHEMA_LIM, LIM } from '../../domain/constants.js';
import { CLEANING } from '../../domain/controls.js';

export function idempotencyKey(req) {
  const k = req.headers['idempotency-key'];
  if (k === undefined) return undefined;
  if (!IDEMPOTENCY_KEY_RE.test(String(k))) throw badRequest('Idempotency-Key inválida (8 a 200 caracteres: letras, números, punto, guion, dos puntos o guion bajo).', 'invalid_idempotency_key');
  return String(k);
}

export function sendResult(reply, r) {
  if (r.replayed) reply.header('Idempotent-Replayed', 'true');
  const row = r.body && (r.body.control || r.body.tech);
  if (row && row.version != null) reply.header('ETag', etag(row));
  return reply.code(r.status).send(r.body);
}

// Ítem de un control (etapa 4): `state` (los tres botones, o un atajo para todas las unidades)
// o `good` y `change` (las unidades que faltan son el resto; `missing`, si viene, tiene que
// coincidir). `expected` es la cantidad con la que se contó: si ya no es la asignada, el ítem
// queda pendiente. `lineaId`: línea o sector (opcional) de un faltante o recambio.
const COUNT = S.int(0, 1000000);
const itemSchema = obj(
  { state: { type: 'string', enum: ITEM_STATES }, good: COUNT, change: COUNT, missing: COUNT, expected: S.int(1, 1000000), note: S.text, lineaId: S.idOrNull },
  [],
  { anyOf: [{ required: ['state'] }, { required: ['good', 'change'] }] },
);
const itemsSchema = {
  type: 'object',
  maxProperties: 1000,
  propertyNames: { pattern: S.id.pattern },
  additionalProperties: { anyOf: [{ type: 'null' }, itemSchema] },
};
// Limpieza de herramientas y caja: null la borra (queda sin indicar).
const cleaningSchema = {
  anyOf: [{ type: 'null' }, obj({ status: { type: ['string', 'null'], enum: [...CLEANING, null] }, note: S.text }, ['status'])],
};

export function registerOperationRoutes(app) {
  const { db } = app;
  const perm = (p) => ({ preHandler: app.requirePerm(p) });
  const ctx = (req) => ({ idempotencyKey: idempotencyKey(req), path: req.routeOptions.url + ':' + JSON.stringify(req.params || {}) });

  // ------------------------------------------------------------ movimientos
  // El permiso depende del tipo (movements_do o inventory_edit); lo verifica el caso de uso.
  app.post('/api/movements', {
    schema: {
      body: obj({
        type: { type: 'string', enum: MV_TYPES },
        techId: S.id, cajaId: S.id, toolId: S.id, unitId: S.id, asgId: S.id, newUnitId: S.id, resolvesMovementId: S.id,
        qty: S.int(1, 1000000), returned: S.bool, oldDest: S.pool, cond: S.pool, from: S.pool,
        codes: S.str(SCHEMA_LIM.text), reason: S.str(LIM.text), notes: S.str(LIM.text),
        // Etapa 7: una reposición vinculada a una compra recibida.
        purchaseRequestId: S.id,
      }, ['type']),
    },
  }, async (req, reply) => sendResult(reply, await movements.registerMovement(db, actorOf(req), req.body, ctx(req))));

  // ------------------------------------------------------------ controles
  app.post('/api/controls', {
    ...perm('controls_do'),
    schema: { body: obj({ techId: S.id, cajaId: S.id, period: S.period, correctionOf: S.id, items: itemsSchema, cleaning: cleaningSchema }) },
  }, async (req, reply) => sendResult(reply, await controls.createControl(db, actorOf(req), req.body, ctx(req))));

  app.patch('/api/controls/:id', {
    ...perm('controls_do'),
    schema: { params: idParams, body: obj({ items: itemsSchema, cleaning: cleaningSchema }, [], { minProperties: 1 }) },
  }, async (req, reply) => sendResult(reply, await controls.saveDraft(db, actorOf(req), req.params.id, req.body, requireVersion(req), ctx(req))));

  // Cuerpo opcional: los últimos ítems y la limpieza se guardan y se finaliza en un paso.
  app.post('/api/controls/:id/finalize', {
    ...perm('controls_do'),
    schema: { params: idParams, body: { ...obj({ items: itemsSchema, cleaning: cleaningSchema }), type: ['object', 'null'] } },
  }, async (req, reply) => sendResult(reply, await controls.finalizeControl(db, actorOf(req), req.params.id, requireVersion(req), req.body || {}, ctx(req))));

  // ------------------------------------------------------------ alertas
  const keyParams = obj({ key: S.id }, ['key']);
  app.post('/api/alerts/:key/resolution', {
    ...perm('alerts_resolve'),
    schema: { params: keyParams, body: { ...obj({ note: S.text }), type: ['object', 'null'] } },
  }, async (req, reply) => sendRow(reply, 'resolution', await alerts.resolveAlert(db, actorOf(req), req.params.key, req.body || {}), 201));

  app.delete('/api/alerts/:key/resolution', {
    ...perm('alerts_resolve'),
    schema: { params: keyParams },
  }, async (req) => alerts.unresolveAlert(db, actorOf(req), req.params.key, requireVersion(req)));

  // ------------------------------------------------------------ demostración
  app.post('/api/demo', perm('demo_manage'), async (req, reply) => reply.code(201).send(await demo.loadDemo(db, actorOf(req))));
  app.delete('/api/demo', perm('demo_manage'), async (req) => demo.clearDemo(db, actorOf(req)));
}

