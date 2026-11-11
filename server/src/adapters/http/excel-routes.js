// Etapa 9: importar el Excel anterior de herramientas (permiso import_excel, solo admin por
// defecto).
// - POST /api/import/excel/preview {fileName, file (base64), decisions?} -> informe sin escribir
//   nada: casos con su id, totales y `token` (hash del archivo + versión del plan).
// - POST /api/import/excel/confirm {fileName, file, token, decisions?} -> aplica en una
//   transacción; 409 `import_changed` si el plan ya no coincide (volver a previsualizar) y
//   409 `already_imported` si ese archivo ya se importó.
// - GET /api/import/excel/batches -> los últimos lotes importados (sin datos de las hojas).
// El archivo viaja en base64 dentro del JSON: se decodifica y se lee como datos (nunca se
// guarda en disco ni se ejecutan sus macros).
import * as excel from '../../application/excel-import.js';
import { MAX_EXCEL_BYTES } from '../../importers/excel-v1/index.js';
import { HttpError, badRequest } from './errors.js';
import { obj, actorOf } from './rest.js';

const B64_MAX = Math.ceil(MAX_EXCEL_BYTES / 3) * 4;
const decisions = {
  type: 'object', maxProperties: 20000,
  propertyNames: { pattern: '^[a-z0-9:._-]{1,120}$' },
  additionalProperties: { type: 'string', enum: ['accept', 'skip'] },
};
const body = (withToken) => obj({
  fileName: { type: 'string', minLength: 1, maxLength: 255 },
  // Se valida al decodificar (un patrón sobre 13 MB de texto no hace falta).
  file: { type: 'string', minLength: 1, maxLength: B64_MAX + 4 },
  decisions,
  ...(withToken ? { token: { type: 'string', pattern: '^[0-9a-f]{64}$' } } : {}),
}, withToken ? ['fileName', 'file', 'token'] : ['fileName', 'file']);

function decode(s) {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw badRequest('El archivo no llegó bien (base64 inválido).', 'invalid_base64');
  const buf = Buffer.from(s, 'base64');
  if (buf.length > MAX_EXCEL_BYTES) throw new HttpError(413, 'too_large', `El archivo supera ${MAX_EXCEL_BYTES / 1024 / 1024} MB.`);
  return buf;
}

export function registerExcelRoutes(app) {
  const { db } = app;
  const perm = { preHandler: app.requirePerm('import_excel') };
  // JSON con el archivo en base64: el límite general de 1 MB no alcanza.
  const bodyLimit = B64_MAX + 512 * 1024;

  app.post('/api/import/excel/preview', { ...perm, bodyLimit, schema: { body: body(false) } }, async (req) => {
    const { fileName, file, decisions: d = {} } = req.body;
    return excel.previewExcel(db, actorOf(req), { fileName, file: decode(file), decisions: d });
  });

  app.post('/api/import/excel/confirm', { ...perm, bodyLimit, schema: { body: body(true) } }, async (req) => {
    const { fileName, file, token, decisions: d = {} } = req.body;
    return excel.applyExcel(db, actorOf(req), { fileName, file: decode(file), token, decisions: d });
  });

  app.get('/api/import/excel/batches', perm, async () => excel.listBatches(db));
}
