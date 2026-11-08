// /api/import/txt y /api/export/txt: migración y copia de seguridad en el formato .txt v2.
// - POST /api/import/txt?mode=merge|replace&dryRun=1  cuerpo: el archivo (text/plain)
//   -> informe sin escribir nada (con `token` si se puede aplicar).
// - POST /api/import/txt?mode=...&token=<token>  mismo archivo -> aplica en una transacción.
// - GET /api/export/txt -> .txt v2 compatible con 2.1, sin credenciales de usuarios.
import * as txt from '../../application/txt-import.js';
import { MAX_IMPORT } from '../../importers/txt-v2/validate.js';
import { HttpError } from './errors.js';
import { obj, actorOf } from './rest.js';

const query = obj({
  mode: { type: 'string', enum: ['merge', 'replace'] },
  dryRun: { type: 'string', enum: ['1', 'true', '0', 'false'] },
  token: { type: 'string', pattern: '^[0-9a-f]{64}$' },
}, ['mode']);

export function registerTxtRoutes(app) {
  const { db } = app;
  const admin = { preHandler: app.requireAdmin };

  app.post('/api/import/txt', {
    ...admin,
    // Como 2.1: hasta 20 MB de texto (en bytes UTF-8 puede ocupar más; el límite de
    // caracteres lo revisa el lector).
    bodyLimit: MAX_IMPORT * 2,
    schema: { querystring: query },
  }, async (req, reply) => {
    if (typeof req.body !== 'string') throw new HttpError(415, 'unsupported_media_type', 'Mandá el archivo .txt tal cual (Content-Type: text/plain).');
    const { mode, dryRun, token } = req.query;
    if (dryRun === '1' || dryRun === 'true') return txt.previewImport(db, actorOf(req), req.body, { mode });
    if (!token) throw new HttpError(400, 'token_required', 'Primero revisá el informe (dryRun=1) y confirmá con su token.');
    const r = await txt.applyImport(db, actorOf(req), req.body, { mode, token });
    return reply.code(200).send(r);
  });

  app.get('/api/export/txt', admin, async (req, reply) => {
    const r = await txt.exportTxt(db, actorOf(req));
    const day = r.savedAt.slice(0, 10);
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="panol-${day}.txt"`);
    return reply.send(r.text);
  });
}
