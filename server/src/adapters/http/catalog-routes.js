// /api/techs, /api/shifts, /api/categories, /api/tools, /api/units: altas y ediciones con el
// permiso de 2.1 correspondiente. Toda edición o baja exige If-Match.
// /api/shifts y /api/techs/:id/shift-change son las rutas de 2.1: delegan en las plantillas
// (permiso plantillas_edit para los turnos, shift_change para mover). Eliminar un turno archiva la
// plantilla con el mismo permiso que el resto de las bajas (records_delete, etapa 5).
import * as catalog from '../../application/catalog.js';
import { S, obj, idParams, requireVersion, sendRow, actorOf } from './rest.js';
import { LIM, SCHEMA_LIM } from '../../domain/constants.js';

export function registerCatalogRoutes(app) {
  const { db } = app;
  const perm = (p) => ({ preHandler: app.requirePerm(p) });

  // ------------------------------------------------------------ técnicos
  const techBody = { name: S.name, legajo: S.str(LIM.legajo), alta: S.dayOrNull, especialidadId: S.idOrNull };
  app.post('/api/techs', { ...perm('techs_edit'), schema: { body: obj({ ...techBody, shiftId: S.idOrNull, plantillaId: S.idOrNull }, ['name', 'legajo']) } },
    async (req, reply) => sendRow(reply, 'tech', await catalog.createTech(db, actorOf(req), req.body), 201));
  app.patch('/api/techs/:id', { ...perm('techs_edit'), schema: { params: idParams, body: obj({ ...techBody, active: S.bool }, [], { minProperties: 1 }) } },
    async (req, reply) => sendRow(reply, 'tech', await catalog.updateTech(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
  app.post('/api/techs/:id/shift-change', {
    ...perm('shift_change'),
    schema: { params: idParams, body: obj({ to: S.id, effectiveFrom: S.dayOrNull, note: S.text }, ['to']) },
  }, async (req, reply) => {
    const r = await catalog.changeShift(db, actorOf(req), req.params.id, req.body, requireVersion(req));
    reply.header('ETag', `"${r.tech.version}"`);
    return r;
  });

  // ------------------------------------------------------------ turnos
  app.post('/api/shifts', { ...perm('plantillas_edit'), schema: { body: obj({ name: S.name }, ['name']) } },
    async (req, reply) => sendRow(reply, 'shift', await catalog.createShift(db, actorOf(req), req.body), 201));
  app.patch('/api/shifts/:id', { ...perm('plantillas_edit'), schema: { params: idParams, body: obj({ name: S.name, order: S.int(0, 1000) }, [], { minProperties: 1 }) } },
    async (req, reply) => sendRow(reply, 'shift', await catalog.updateShift(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
  app.delete('/api/shifts/:id', { ...perm('records_delete'), schema: { params: idParams, body: { anyOf: [{ type: 'null' }, obj({ reason: S.str(LIM.text, 1) })] } } },
    async (req) => catalog.deleteShift(db, actorOf(req), req.params.id, requireVersion(req), req.body?.reason));

  // ------------------------------------------------------------ categorías
  app.post('/api/categories', { ...perm('tools_edit'), schema: { body: obj({ name: S.name }, ['name']) } },
    async (req, reply) => sendRow(reply, 'category', await catalog.createCategory(db, actorOf(req), req.body), 201));
  app.patch('/api/categories/:id', { ...perm('tools_edit'), schema: { params: idParams, body: obj({ name: S.name }, ['name']) } },
    async (req, reply) => sendRow(reply, 'category', await catalog.updateCategory(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
  // Eliminar categorías: records-routes.js (etapa 5: baja lógica o definitiva sin historial).

  // ------------------------------------------------------------ herramientas y unidades
  const toolBody = { name: S.name, description: S.text, categoryId: S.idOrNull, serialized: S.bool };
  app.post('/api/tools', {
    ...perm('tools_edit'),
    schema: { body: obj({ ...toolBody, codes: S.str(SCHEMA_LIM.text), stock: S.int(0, 1000000), position: S.int(1, 100000) }, ['name']) },
  }, async (req, reply) => sendRow(reply, 'tool', await catalog.createTool(db, actorOf(req), req.body), 201));
  app.patch('/api/tools/:id', { ...perm('tools_edit'), schema: { params: idParams, body: obj({ ...toolBody, active: S.bool }, [], { minProperties: 1 }) } },
    async (req, reply) => sendRow(reply, 'tool', await catalog.updateTool(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
  app.patch('/api/units/:id', { ...perm('tools_edit'), schema: { params: idParams, body: obj({ code: S.str(LIM.code) }, ['code']) } },
    async (req, reply) => sendRow(reply, 'unit', await catalog.updateUnit(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
}
