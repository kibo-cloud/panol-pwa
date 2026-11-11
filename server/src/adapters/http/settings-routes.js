// Etapa 8: umbral de la alerta "Sin control hace N días" (Administración › Configuración).
// Lo lee cualquier usuario con sesión; lo cambia quien administra la configuración
// (`plantillas_edit`, el mismo permiso de la lista de turnos), con If-Match.
import * as settings from '../../application/settings.js';
import { obj, requireVersion, actorOf } from './rest.js';

export function registerSettingsRoutes(app) {
  const { db } = app;
  const perm = (p) => ({ preHandler: app.requirePerm(p) });

  app.get('/api/settings/alerts', async (req, reply) => {
    const r = await settings.getAlertSettings(db);
    reply.header('ETag', `"${r.version}"`);
    return r;
  });
  app.put('/api/settings/alerts', {
    ...perm('plantillas_edit'),
    schema: { body: obj({ controlOverdueDays: { type: 'integer' } }, ['controlOverdueDays']) },
  }, async (req, reply) => {
    const r = await settings.setAlertSettings(db, actorOf(req), req.body, requireVersion(req));
    reply.header('ETag', `"${r.version}"`);
    return r;
  });
}
