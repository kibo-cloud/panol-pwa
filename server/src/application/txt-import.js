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
import { CATEGORY_SCOPE, toolScope } from '../domain/orden.js';
import { lockScopes, bumpScope } from './orden.js';

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
  const server = { doc: canonical(s.data), creds: s.creds, ledger: s.ledger, archived: s.archived, hidden: s.hidden };
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
    if (err.code === '23505' && err.constraint === 'plantillas_active_name_key') throw new DomainError('La importación deja dos plantillas activas con el mismo nombre. Revisá el informe de nuevo.', 'duplicate_plantilla_name', 409);
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
    // Orden (etapa 3): los alcances que la importación puede tocar se bloquean antes que las filas;
    // los que cambian de integrantes suben su versión (una pantalla de orden abierta recibe 409).
    await lockScopes(c, await orderScopesOf(c, p.changes));
    const members0 = await orderMembers(c);
    const applied = await applyImportPlan(c, p, { actorId: actor.id });
    const members1 = await orderMembers(c);
    for (const scope of [...new Set([...members0.keys(), ...members1.keys()])].sort()) {
      if (members0.get(scope) !== members1.get(scope)) await lockScopes(c, [scope]).then(() => bumpScope(c, scope));
    }
    const n = Object.entries(p.counts).filter(([, x]) => x.create + x.update + x.delete).map(([k, x]) => `${k} +${x.create} ~${x.update} -${x.delete}`).join(', ');
    await record(c, actor, {
      action: 'import_txt', entity: 'system', id: 'import', event: 'reload',
      detail: `Importación .txt (${mode === 'replace' ? 'reemplazar' : 'combinar'}): ${n || 'sin cambios'}; ${p.conflicts.length} conflictos${applied.membershipSkipped ? `; ${applied.membershipSkipped} cambios de plantilla omitidos (anteriores al historial o durante una cobertura)` : ''}${file.savedAt ? `; archivo del ${file.savedAt}` : ''}`,
    });
    return { applied: true, report: { ...report, membershipSkipped: applied.membershipSkipped } };
  });
}

// Alcances de orden que el plan puede cambiar: el de categorías, y el de la categoría actual y la
// del archivo de cada herramienta que se crea, edita o borra (y el de "sin categoría" cuando se
// borra una categoría: sus herramientas quedan sin categoría).
async function orderScopesOf(c, ch) {
  const scopes = new Set();
  const cats = ch.categories;
  if (Object.keys(cats.create).length || Object.keys(cats.update).length || cats.delete.length) scopes.add(CATEGORY_SCOPE);
  for (const id of cats.delete) scopes.add(toolScope(id)).add(toolScope(null));
  const tools = ch.tools;
  const ids = [...Object.keys(tools.create), ...Object.keys(tools.update), ...tools.delete];
  for (const r of [...Object.values(tools.create), ...Object.values(tools.update)]) scopes.add(toolScope(r.categoryId || null));
  if (ids.length) for (const r of (await c.query('SELECT category_id FROM tools WHERE id = ANY($1)', [ids])).rows) scopes.add(toolScope(r.category_id));
  return [...scopes];
}

// Integrantes de cada alcance de orden (ids ordenados), para ver cuáles cambió la importación.
async function orderMembers(c) {
  const m = new Map([[CATEGORY_SCOPE, (await c.query('SELECT id FROM categories ORDER BY id')).rows.map((r) => r.id).join(',')]]);
  const rows = (await c.query("SELECT coalesce(category_id, '') AS cat, string_agg(id, ',' ORDER BY id) AS ids FROM tools GROUP BY 1")).rows;
  for (const r of rows) m.set(toolScope(r.cat || null), r.ids);
  return m;
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
  // Etapa 5: los técnicos, herramientas y usuarios eliminados salen con active = false (campo del
  // v2); las categorías eliminadas no salen y van como marca de borrado en `data.deleted`, igual
  // que lo eliminado definitivamente, así una combinación en 2.1 no los vuelve a traer.
  const categories = Object.fromEntries(Object.entries(s.data.categories).filter(([id]) => !s.archived[`categories/${id}`]));
  const deleted = { ...s.tombstones };
  for (const [k, at] of Object.entries(s.archived)) if (k.startsWith('categories/')) deleted[k] = at;
  const payload = { app: 'panol', format: 'panol-txt', version: 2, savedAt: new Date().toISOString(), data: { ...s.data, categories, deleted } };
  const text = TXT_HEAD + JSON.stringify(payload);
  const counts = Object.entries(s.data).filter(([k]) => k !== 'config').map(([k, v]) => `${k} ${Object.keys(v).length}`).join(', ');
  await audit(db, { action: 'export_txt', entity: 'system', entityId: 'export', detail: `Descarga del .txt: ${counts}`, actorId: actor.id, ip: actor.ip });
  return { text, savedAt: payload.savedAt };
}
