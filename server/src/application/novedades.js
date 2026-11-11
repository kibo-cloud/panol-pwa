// Novedades (etapa 6): alta (con Idempotency-Key), edición (el autor o novedades_edit, con
// If-Match y los valores anteriores en la auditoría), lectura y lista filtrada en el servidor.
// Eliminar, restaurar y la eliminación definitiva van por el modelo genérico (records.js).
// Bloqueos (orden global): vínculo del movimiento (nombre) -> plantilla -> técnico -> línea ->
// la novedad. El vínculo usa el mismo bloqueo por nombre que anular ese movimiento, así no se
// vincula uno que se está anulando.
import * as repo from '../adapters/pg/novedades-repo.js';
import { lockName } from '../adapters/pg/catalog-repo.js';
import { loadOverrides } from '../adapters/pg/auth-repo.js';
import { withSnapshot } from '../adapters/pg/state-repo.js';
import { can } from '../domain/permissions.js';
import { cleanNovedad, checkLinkable, canEditNovedad, editChanges, parseNovedadFilters } from '../domain/novedades.js';
import { DomainError, ConflictError, notFoundError } from '../domain/errors.js';
import { newId } from './ids.js';
import { withTransaction, record } from './common.js';
import { idempotent } from './idempotency.js';

const forbidden = () => new DomainError('Tu perfil no tiene permiso para esta acción.', 'forbidden', 403);
const rule = (msg, code, status = 422) => new DomainError(msg, code, status);
const notFound = () => notFoundError('No se encontró la novedad.');

// Bloqueo compartido con voidMovement (voids.js).
export const movementLinkLock = (c, movementId) => lockName(c, `movements.void:${movementId}`);

const SUBJECT = {
  plantillaId: { sql: 'SELECT id, name, archived_at, true AS active FROM plantillas WHERE id = $1 FOR SHARE', msg: 'Elegí una plantilla activa.', code: 'invalid_plantilla', label: 'plantilla' },
  techId: { sql: 'SELECT id, name, archived_at, active FROM techs WHERE id = $1 FOR SHARE', msg: 'Elegí un técnico activo.', code: 'invalid_tech', label: 'técnico' },
  lineaId: { sql: 'SELECT id, name, archived_at, true AS active FROM lineas WHERE id = $1 FOR SHARE', msg: 'Elegí una línea o sector activo.', code: 'invalid_linea', label: 'línea o sector' },
};
const SUBJECT_ORDER = ['plantillaId', 'techId', 'lineaId'];

// Bloquea (FOR SHARE) los temas nombrados, en el orden global. check: los que tienen que estar
// activos (los nuevos). Devuelve los nombres para la auditoría.
async function lockSubjects(c, values, check = SUBJECT_ORDER) {
  const names = {};
  for (const k of SUBJECT_ORDER) {
    const id = values[k];
    if (!id) continue;
    const r = (await c.query(SUBJECT[k].sql, [id])).rows[0];
    if (check.includes(k) && (!r || r.archived_at || !r.active)) throw rule(SUBJECT[k].msg, SUBJECT[k].code);
    names[k] = r ? r.name : id;
  }
  return names;
}

async function permsOf(db, actor) {
  const ov = await loadOverrides(db);
  return { create: can(actor.role, 'novedades_create', ov), edit: can(actor.role, 'novedades_edit', ov), deleted: can(actor.role, 'records_delete', ov) };
}

const short = (s) => (s.length > 120 ? s.slice(0, 117) + '…' : s);

// ---------------------------------------------------------------- alta
export async function createNovedad(db, actor, input, { idempotencyKey, path } = {}) {
  const v = cleanNovedad(input);
  const movementId = input.movementId || null;
  const purchaseRequestId = input.purchaseRequestId || null;
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: { ...v, movementId, ...(purchaseRequestId ? { purchaseRequestId } : {}) } }, async (c) => {
    if (movementId) {
      await movementLinkLock(c, movementId);
      const m = (await c.query('SELECT id, type, voids_movement_id FROM movements WHERE id = $1', [movementId])).rows[0];
      const voidedBy = m ? (await c.query('SELECT id FROM movements WHERE voids_movement_id = $1', [movementId])).rows[0]?.id ?? null : null;
      checkLinkable(m && { id: m.id, type: m.type, voidsMovementId: m.voids_movement_id }, voidedBy);
    }
    // Etapa 7: la solicitud de compra vinculada existe y no está eliminada (la clave foránea la
    // conserva; una solicitud nunca se borra).
    let purchase = null;
    if (purchaseRequestId) {
      purchase = (await c.query('SELECT id, name, archived_at FROM purchase_requests WHERE id = $1', [purchaseRequestId])).rows[0];
      if (!purchase || purchase.archived_at) throw rule('No se encontró la solicitud de compra a vincular.', 'invalid_purchase');
    }
    const names = await lockSubjects(c, v);
    const id = newId('nv');
    await repo.insertNovedad(c, { id, authorId: actor.id, ...v, movementId, purchaseRequestId });
    const row = await repo.getNovedad(c, id);
    const about = SUBJECT_ORDER.filter((k) => names[k]).map((k) => `${SUBJECT[k].label} ${names[k]}`);
    await record(c, actor, {
      action: 'novedad_create', entity: 'novedades', id, version: row.version, event: 'create',
      detail: `Alta de ${row.name}${about.length ? ` (${about.join(', ')})` : ''}${movementId ? ', vinculada a un movimiento' : ''}${purchase ? `, vinculada a ${purchase.name}` : ''}: ${short(v.comment)}`,
    });
    return { status: 201, body: { novedad: row } };
  });
}

// ---------------------------------------------------------------- edición
async function subjectName(c, k, id) {
  if (!id) return '(ninguno)';
  const table = { techId: 'techs', plantillaId: 'plantillas', lineaId: 'lineas' }[k];
  return (await c.query(`SELECT name FROM ${table} WHERE id = $1`, [id])).rows[0]?.name ?? id;
}

export async function updateNovedad(db, actor, id, input, version) {
  const next = cleanNovedad(input, { partial: true });
  const perms = await permsOf(db, actor);
  if (!perms.create && !perms.edit) throw forbidden();
  return withTransaction(db, async (c) => {
    // Los temas nuevos se bloquean antes que la novedad (orden global); se revisan después.
    const subjects = await lockSubjects(c, next, []);
    const cur = await repo.lockNovedad(c, id);
    // Eliminada sin records_delete, o ajena sin novedades_edit: 404 como en la lectura (antes de
    // revisar la versión, así un 409 no devuelve la fila ni confirma el id).
    if (!cur || (cur.archived_at && !perms.deleted)) throw notFound();
    const curApi = { authorId: cur.author_id, comment: cur.comment, techId: cur.tech_id, plantillaId: cur.plantilla_id, lineaId: cur.linea_id };
    if (!canEditNovedad(actor, curApi, perms)) throw notFound();
    if (cur.version !== version) throw new ConflictError(await repo.getNovedad(c, id));
    if (cur.archived_at) throw rule('La novedad está eliminada: restaurala antes de editarla.', 'archived', 409);
    const changes = editChanges(curApi, next);
    if (!Object.keys(changes).length) return repo.getNovedad(c, id);
    // Un tema que cambia tiene que estar activo; uno que queda igual conserva su referencia.
    await lockSubjects(c, Object.fromEntries(Object.keys(changes).filter((k) => k !== 'comment').map((k) => [k, next[k]])));
    await repo.updateNovedad(c, id, Object.fromEntries(Object.entries(changes).map(([k, x]) => [k, x.to])));
    const row = await repo.getNovedad(c, id);
    const parts = [];
    for (const [k, x] of Object.entries(changes)) {
      if (k === 'comment') parts.push(`comentario anterior: «${short(x.from)}»`);
      else parts.push(`${SUBJECT[k].label}: ${await subjectName(c, k, x.from)} → ${x.to ? subjects[k] || (await subjectName(c, k, x.to)) : '(ninguno)'}`);
    }
    await record(c, actor, { action: 'novedad_edit', entity: 'novedades', id, version: row.version, detail: `Edición de ${row.name}. ${parts.join('; ')}` });
    return row;
  });
}

// ---------------------------------------------------------------- lecturas
export async function getNovedad(db, actor, id) {
  const row = await repo.getNovedad(db, id);
  if (!row || (row.archived && !(await permsOf(db, actor)).deleted)) throw notFound();
  return row;
}

// Lista filtrada (las eliminadas solo con records_delete).
export async function listNovedades(db, actor, query) {
  const f = parseNovedadFilters(query);
  if (f.archived !== 'exclude' && !(await permsOf(db, actor)).deleted) throw forbidden();
  const r = await repo.queryNovedades(db, f);
  return { novedades: r.rows, next: r.next, total: r.total };
}

// Consulta por período para otros casos de uso (impresión de auditoría, etapa 10).
// filters: los de GET /api/novedades (from, to, techId…, archived). Devuelve todas, de a páginas
// sin contar el total, dentro de una sola instantánea (REPEATABLE READ, solo lectura): una
// novedad que se carga o elimina en el medio no se repite ni se saltea. Las eliminadas
// (archived=include|only) solo para quien tiene records_delete; el permiso propio del caso de
// uso que llama (p. ej. imprimir) lo revisa ese caso de uso.
export async function novedadesOfPeriod(db, actor, filters = {}) {
  const f = parseNovedadFilters({ ...filters, before: null });
  if (f.archived !== 'exclude' && !(await permsOf(db, actor)).deleted) throw forbidden();
  return withSnapshot(db, async (c) => {
    const out = [];
    let before = null;
    do {
      const r = await repo.queryNovedades(c, { ...f, limit: 200, before }, { withTotal: false });
      out.push(...r.rows);
      before = r.cursor;
    } while (before);
    return out;
  });
}
