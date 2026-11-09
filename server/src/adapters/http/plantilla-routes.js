// /api/plantillas, mover técnicos de plantilla y la lista de turnos de las plantillas.
// - Alta, edición, supervisor y archivo: plantillas_edit. Rotar: plantilla_rotate o el
//   supervisor de esa plantilla (lo verifica el caso de uso). Mover: shift_change.
// - Toda edición de una plantilla exige If-Match. Mover acepta Idempotency-Key; mover un
//   técnico acepta If-Match (versión del técnico) opcional.
import * as plantillas from '../../application/plantillas.js';
import { S, obj, idParams, requireVersion, sendRow, actorOf } from './rest.js';
import { idempotencyKey, sendResult } from './operation-routes.js';
import { LIM } from '../../domain/constants.js';

const optionalVersion = (req) => (req.headers['if-match'] === undefined ? null : requireVersion(req));

export function registerPlantillaRoutes(app) {
  const { db } = app;
  const perm = (p) => ({ preHandler: app.requirePerm(p) });
  const ctx = (req) => ({ idempotencyKey: idempotencyKey(req), path: req.routeOptions.url + ':' + JSON.stringify(req.params || {}) });
  const moveBody = { from: S.day, reason: S.text, until: S.dayOrNull };

  app.get('/api/plantillas', async () => ({ plantillas: await plantillas.listPlantillas(db) }));

  app.post('/api/plantillas', {
    ...perm('plantillas_edit'),
    schema: { body: obj({ name: S.name, supervisorUserId: S.idOrNull, shiftLabel: S.str(LIM.name), order: S.int(0, 1000) }) },
  }, async (req, reply) => sendRow(reply, 'plantilla', await plantillas.createPlantilla(db, actorOf(req), req.body), 201));

  app.patch('/api/plantillas/:id', {
    ...perm('plantillas_edit'),
    schema: { params: idParams, body: obj({ name: S.name, order: S.int(0, 1000) }, [], { minProperties: 1 }) },
  }, async (req, reply) => sendRow(reply, 'plantilla', await plantillas.updatePlantilla(db, actorOf(req), req.params.id, req.body, requireVersion(req))));

  // Archivar: POST /api/plantillas/:id/archive en records-routes.js (etapa 5, con motivo).

  app.post('/api/plantillas/:id/rotate', {
    schema: { params: idParams, body: obj({ label: S.str(LIM.name, 1), from: S.dayOrNull }, ['label']) },
  }, async (req, reply) => {
    const r = await plantillas.rotatePlantilla(db, actorOf(req), req.params.id, req.body, requireVersion(req));
    reply.header('ETag', `"${r.plantilla.version}"`);
    return r;
  });

  app.post('/api/plantillas/:id/supervisor', {
    ...perm('plantillas_edit'),
    schema: { params: idParams, body: obj({ supervisorUserId: S.idOrNull, from: S.dayOrNull }, ['supervisorUserId']) },
  }, async (req, reply) => {
    const r = await plantillas.changeSupervisor(db, actorOf(req), req.params.id, req.body, requireVersion(req));
    reply.header('ETag', `"${r.plantilla.version}"`);
    return r;
  });

  app.post('/api/plantillas/:id/move-selected', {
    ...perm('shift_change'),
    schema: {
      params: idParams,
      body: obj({ techIds: { type: 'array', minItems: 1, maxItems: 200, items: S.id }, targetPlantillaId: S.id, ...moveBody }, ['techIds', 'targetPlantillaId', 'from', 'reason']),
    },
  }, async (req, reply) => sendResult(reply, await plantillas.moveSelected(db, actorOf(req), req.params.id, req.body, ctx(req))));

  app.get('/api/plantillas/:id/history', { schema: { params: idParams } }, async (req) => plantillas.plantillaHistory(db, req.params.id));

  app.post('/api/techs/:id/move', {
    ...perm('shift_change'),
    schema: { params: idParams, body: obj({ plantillaId: S.id, ...moveBody }, ['plantillaId', 'from', 'reason']) },
  }, async (req, reply) => sendResult(reply, await plantillas.moveTech(db, actorOf(req), req.params.id, req.body, { version: optionalVersion(req), ...ctx(req) })));

  app.get('/api/techs/:id/plantilla-history', { schema: { params: idParams } }, async (req) => plantillas.techPlantillaHistory(db, req.params.id));

  // Lista de turnos (rótulos) para la rotación de las plantillas.
  app.get('/api/settings/shift-labels', async (req, reply) => {
    const r = await plantillas.getShiftLabels(db);
    reply.header('ETag', `"${r.version}"`);
    return r;
  });
  app.put('/api/settings/shift-labels', {
    ...perm('plantillas_edit'),
    schema: { body: obj({ labels: { type: 'array', minItems: 1, maxItems: 20, items: S.str(LIM.name) } }, ['labels']) },
  }, async (req, reply) => {
    const r = await plantillas.setShiftLabels(db, actorOf(req), req.body.labels, requireVersion(req));
    reply.header('ETag', `"${r.version}"`);
    return r;
  });
}
