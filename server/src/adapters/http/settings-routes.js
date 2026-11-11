// Etapa 8: umbral de la alerta "Sin control hace N días" (Administración › Configuración).
// Lo lee cualquier usuario con sesión; lo cambia quien administra la configuración
// (`plantillas_edit`, el mismo permiso de la lista de turnos), con If-Match.
import * as settings from '../../application/settings.js';
import { obj, requireVersion, actorOf } from './rest.js';
import { badRequest, notFound } from './errors.js';
import { MAX_LOGO_BYTES } from '../../domain/empresa.js';

// Etapa 10: el logo viaja en base64 dentro del JSON (como el Excel); se decodifica y se revisa por
// sus primeros bytes. Se sirve desde el mismo origen con su tipo y nosniff (cabecera común).
// Hasta el doble del límite llega al dominio, que responde 413 con un mensaje claro.
const LOGO_B64_MAX = Math.ceil((2 * MAX_LOGO_BYTES) / 3) * 4;
function decodeLogo(s) {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw badRequest('El archivo no llegó bien (base64 inválido).', 'invalid_base64');
  return Buffer.from(s, 'base64');
}

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

  app.get('/api/settings/empresa', async (req, reply) => {
    const r = await settings.getEmpresa(db);
    reply.header('ETag', `"${r.version}"`);
    return r;
  });
  app.put('/api/settings/empresa', {
    ...perm('plantillas_edit'),
    schema: { body: obj({ name: { type: 'string', maxLength: 500 } }, ['name']) },
  }, async (req, reply) => {
    const r = await settings.setEmpresaName(db, actorOf(req), req.body, requireVersion(req));
    reply.header('ETag', `"${r.version}"`);
    return r;
  });
  app.put('/api/settings/empresa/logo', {
    ...perm('plantillas_edit'),
    bodyLimit: LOGO_B64_MAX + 64 * 1024,
    schema: { body: obj({ file: { type: 'string', minLength: 1, maxLength: LOGO_B64_MAX } }, ['file']) },
  }, async (req, reply) => {
    const r = await settings.setLogo(db, actorOf(req), decodeLogo(req.body.file), requireVersion(req));
    reply.header('ETag', `"${r.version}"`);
    return r;
  });
  app.delete('/api/settings/empresa/logo', perm('plantillas_edit'), async (req, reply) => {
    const r = await settings.removeLogo(db, actorOf(req), requireVersion(req));
    reply.header('ETag', `"${r.version}"`);
    return r;
  });
  // La imagen: solo PNG o JPEG (tipo guardado tras revisar los bytes), nunca como HTML ni SVG.
  app.get('/api/empresa/logo', { schema: { querystring: obj({ v: { type: 'string', pattern: '^[0-9a-f]{1,64}$' } }) } }, async (req, reply) => {
    const logo = await settings.getLogo(db);
    if (!logo) throw notFound('La empresa no tiene logo cargado.');
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header('Content-Disposition', `inline; filename="logo.${logo.contentType === 'image/png' ? 'png' : 'jpg'}"`);
    reply.header('ETag', `"${logo.sha256}"`);
    return reply.type(logo.contentType).send(logo.data);
  });
}
