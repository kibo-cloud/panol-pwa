// Etapa 6: novedades.
// - GET /api/novedades?from&to&techId&plantillaId&lineaId&authorId&movementId&q&linked&archived&limit&before
//   (novedades_view; archived=include|only pide records_delete) -> { novedades, next, total }.
// - GET /api/novedades/:id (novedades_view) con ETag.
// - POST /api/novedades {comment, techId?, plantillaId?, lineaId?, movementId?} (novedades_create,
//   Idempotency-Key) -> 201 { novedad }.
// - PATCH /api/novedades/:id {comment?, techId?, plantillaId?, lineaId?} + If-Match: el autor
//   (con novedades_create) o novedades_edit.
// Eliminar, restaurar y eliminar definitivamente: records-routes.js (tipo `novedades`).
import * as novedades from '../../application/novedades.js';
import { S, obj, idParams, requireVersion, sendRow, actorOf, etag } from './rest.js';
import { idempotencyKey } from './operation-routes.js';
import { LIM, SCHEMA_LIM } from '../../domain/constants.js';

const comment = S.str(SCHEMA_LIM.text);
const subjects = { techId: S.idOrNull, plantillaId: S.idOrNull, lineaId: S.idOrNull };

export function registerNovedadesRoutes(app) {
  const { db } = app;
  const perm = (p) => ({ preHandler: app.requirePerm(p) });

  app.get('/api/novedades', {
    ...perm('novedades_view'),
    schema: {
      querystring: obj({
        from: S.day, to: S.day, techId: S.id, plantillaId: S.id, lineaId: S.id, authorId: S.id, movementId: S.id,
        q: S.str(LIM.name), linked: { type: 'string', enum: ['yes', 'no'] }, archived: { type: 'string', enum: ['exclude', 'include', 'only'] },
        limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' }, before: S.str(300),
      }),
    },
  }, async (req) => novedades.listNovedades(db, actorOf(req), req.query));

  app.get('/api/novedades/:id', { ...perm('novedades_view'), schema: { params: idParams } },
    async (req, reply) => sendRow(reply, 'novedad', await novedades.getNovedad(db, actorOf(req), req.params.id)));

  app.post('/api/novedades', {
    ...perm('novedades_create'),
    schema: { body: obj({ comment, ...subjects, movementId: S.idOrNull }, ['comment']) },
  }, async (req, reply) => {
    const r = await novedades.createNovedad(db, actorOf(req), req.body, { idempotencyKey: idempotencyKey(req), path: req.routeOptions.url });
    if (r.replayed) reply.header('Idempotent-Replayed', 'true');
    if (r.body.novedad) reply.header('ETag', etag(r.body.novedad));
    return reply.code(r.status).send(r.body);
  });

  // El permiso (autor con novedades_create, o novedades_edit) lo revisa el caso de uso.
  app.patch('/api/novedades/:id', {
    schema: { params: idParams, body: obj({ comment, ...subjects }, [], { minProperties: 1 }) },
  }, async (req, reply) => sendRow(reply, 'novedad', await novedades.updateNovedad(db, actorOf(req), req.params.id, req.body, requireVersion(req))));
}
