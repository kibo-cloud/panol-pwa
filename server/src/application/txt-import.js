// Importar y exportar el `.txt` v2 de Pañol 2.x (solo administradores).
// Importar es en dos pasos: con dryRun se devuelve el informe (sin escribir nada) con un
// token; para aplicar se manda el mismo archivo con ese token y todo se aplica en una sola
// transacción. Si el estado del servidor cambió entre medio, el plan ya no coincide con el
// token y se pide revisar el informe nuevo.
import { withSnapshot } from '../adapters/pg/state-repo.js';
import { loadTxtState, applyImportPlan } from '../adapters/pg/txt-repo.js';
import { parseTxt, checkData, ImportFileError } from '../importers/txt-v2/validate.js';
import { planImport, reportOf } from '../importers/txt-v2/plan.js';
import { DomainError } from '../domain/errors.js';
import { record, audit } from './common.js';
import { lockAdmins } from './users.js';
import { lockName } from '../adapters/pg/catalog-repo.js';

export const TXT_HEAD = 'PAÑOL · archivo de datos\r\nGuardalo, compartilo o abrilo desde la app Pañol. No lo edites a mano.\r\n';

function readFile(text) {
  try {
    const p = parseTxt(text);
    const chk = checkData(p.data);
    return { savedAt: p.savedAt, data: chk.data, deleted: chk.deleted, errors: chk.errors };
  } catch (err) {
    if (err instanceof ImportFileError) throw new DomainError(err.message, err.code, err.code === 'too_large' ? 413 : 422);
    throw err;
  }
}

async function plan(q, file, mode, actor, now) {
  const s = await loadTxtState(q);
  const server = { doc: canonical(s.data), creds: s.creds, ledger: s.ledger };
  return planImport(server, file, { mode, actorId: actor.id, now });
}

// El estado del servidor pasa por el mismo lector que el archivo: así ambos quedan en la
// misma forma canónica y se comparan campo a campo.
function canonical(data) {
  const chk = checkData(data);
  if (chk.errors.length) throw new Error(`Estado del servidor no exportable: ${JSON.stringify(chk.errors.slice(0, 3))}`);
  return chk.data;
}

export async function previewImport(db, actor, text, { mode }) {
  const file = readFile(text);
  const p = await withSnapshot(db, (q) => plan(q, file, mode, actor, new Date()));
  return reportOf(p, { savedAt: file.savedAt, fileErrors: file.errors });
}

async function withSerializable(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    if (err.code === '40001' || err.code === '40P01') throw new DomainError('Otra persona modificó datos mientras se importaba. Revisá el informe de nuevo.', 'import_retry', 409);
    if (err.code === '23505' || err.code === '23503') throw new DomainError('La importación choca con datos del servidor (registro repetido o referencia rota). Revisá el informe de nuevo.', 'import_conflict', 409);
    throw err;
  } finally {
    c.release();
  }
}

export async function applyImport(db, actor, text, { mode, token }) {
  const file = readFile(text);
  if (file.errors.length) {
    const p = await withSnapshot(db, (q) => plan(q, file, mode, actor, new Date()));
    throw withExtra(new DomainError('El archivo tiene errores: no se importó nada.', 'import_invalid', 422), { report: reportOf(p, { savedAt: file.savedAt, fileErrors: file.errors }) });
  }
  return withSerializable(db, async (c) => {
    await lockName(c, 'import:txt');
    await lockAdmins(c);
    const p = await plan(c, file, mode, actor, new Date());
    const report = reportOf(p, { savedAt: file.savedAt });
    if (p.errors.length) throw withExtra(new DomainError('El archivo no se puede importar así: revisá los errores del informe.', 'import_invalid', 422), { report });
    if (!token || token !== p.token) throw withExtra(new DomainError('Los datos cambiaron desde la revisión. Revisá el informe nuevo antes de confirmar.', 'import_changed', 409), { report });
    await applyImportPlan(c, p, { actorId: actor.id });
    const n = Object.entries(p.counts).filter(([, x]) => x.create + x.update + x.delete).map(([k, x]) => `${k} +${x.create} ~${x.update} -${x.delete}`).join(', ');
    await record(c, actor, {
      action: 'import_txt', entity: 'system', id: 'import', event: 'reload',
      detail: `Importación .txt (${mode === 'replace' ? 'reemplazar' : 'combinar'}): ${n || 'sin cambios'}; ${p.conflicts.length} conflictos${file.savedAt ? `; archivo del ${file.savedAt}` : ''}`,
    });
    return { applied: true, report };
  });
}

function withExtra(err, extra) {
  err.extra = extra;
  return err;
}

// ---------------------------------------------------------------- exportar
// `.txt` v2 compatible con 2.1. Los usuarios salen sin ningún hash: las contraseñas y los PIN
// nunca salen del servidor, así que esta copia no restaura contraseñas (después de importarla,
// un administrador las restablece).
export async function exportTxt(db, actor) {
  const s = await withSnapshot(db, (q) => loadTxtState(q));
  const payload = { app: 'panol', format: 'panol-txt', version: 2, savedAt: new Date().toISOString(), data: { ...s.data, deleted: {} } };
  const text = TXT_HEAD + JSON.stringify(payload);
  const counts = Object.entries(s.data).filter(([k]) => k !== 'config').map(([k, v]) => `${k} ${Object.keys(v).length}`).join(', ');
  await audit(db, { action: 'export_txt', entity: 'system', entityId: 'export', detail: `Descarga del .txt: ${counts}`, actorId: actor.id, ip: actor.ip });
  return { text, savedAt: payload.savedAt };
}
