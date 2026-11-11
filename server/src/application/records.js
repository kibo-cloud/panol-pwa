// Eliminar (baja lógica), restaurar y eliminación definitiva de registros (etapa 5).
// - Eliminar archiva: el registro queda oculto en listas y selectores y sigue en el historial,
//   los informes y la auditoría. Un técnico o una caja con herramientas asignadas se elimina
//   resolviendo cada asignación (devolución o retiro) en la misma transacción.
// - Restaurar lo vuelve a mostrar; si su nombre ya lo usa otro registro activo, 409.
// - La eliminación definitiva solo vale sin historial (se revisa de nuevo con la fila bloqueada)
//   y pide el nombre exacto; la auditoría conserva el nombre.
// Orden de los bloqueos (global): alcances de orden -> plantilla -> poseedor -> filas por id ->
// herramientas por id.
import * as repo from '../adapters/pg/catalog-repo.js';
import { publicUser, deleteUserSessions, countActiveAdmins } from '../adapters/pg/auth-repo.js';
import { loadKits } from '../adapters/pg/kits-repo.js';
import { getNovedad } from '../adapters/pg/novedades-repo.js';
import { getPurchase } from '../adapters/pg/compras-repo.js';
import { OPEN_STATUSES } from '../domain/compras.js';
import { RECORD_TYPES, cleanReason, checkConfirmName, planResolutions, isHistoryAction } from '../domain/records.js';
import { DomainError, ConflictError, notFoundError } from '../domain/errors.js';
import { CATEGORY_SCOPE, toolScope } from '../domain/orden.js';
import { localDateISO } from '../domain/period.js';
import { withTransaction, record } from './common.js';
import { lockScope, bumpScope } from './orden.js';
import { applyMovement } from './movements.js';
import { lockAdmins } from './users.js';

const rule = (msg, code, status = 409) => new DomainError(msg, code, status);
const exists = async (c, sql, params) => !!(await c.query(sql, params)).rows[0];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Tipo -> tabla (lista cerrada: nunca se arma SQL con nombres que vengan de afuera).
const TABLE = { techs: 'techs', cajas: 'cajas', tools: 'tools', categories: 'categories', plantillas: 'plantillas', lineas: 'lineas', especialidades: 'especialidades', kits: 'kits', users: 'users', novedades: 'novedades', compras: 'purchase_requests' };

export function typeInfo(type) {
  const t = RECORD_TYPES[type];
  if (!t) throw notFoundError('Tipo de registro desconocido.');
  return { ...t, type, table: TABLE[type] };
}

async function lockRow(c, T, id) {
  return (await c.query(`SELECT * FROM ${T.table} WHERE id = $1 FOR UPDATE`, [id])).rows[0] || null;
}

// Registro en la forma de la API.
async function view(c, T, id) {
  if (T.type === 'users') {
    const r = (await c.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
    return r ? publicUser(r) : null;
  }
  if (T.type === 'kits') return (await loadKits(c, { id }))[0] || null;
  if (T.type === 'novedades') return getNovedad(c, id);
  if (T.type === 'compras') return getPurchase(c, id);
  return repo.getRow(c, T.table, id);
}

// ---------------------------------------------------------------- historial
// Un registro tiene historial si una referencia operativa lo nombra: el libro, los controles, las
// asignaciones, los rangos de pertenencia, el historial de supervisores y turnos, los kits, una
// referencia vigente o una acción de ciclo de vida en su auditoría (E5.V1: una edición no cuenta).
const HISTORY = {
  techs: [
    ['SELECT 1 FROM movements WHERE tech_id = $1 LIMIT 1', 'Tiene movimientos.'],
    ['SELECT 1 FROM assignments WHERE tech_id = $1 LIMIT 1', 'Tuvo herramientas asignadas.'],
    ['SELECT 1 FROM controls WHERE tech_id = $1 LIMIT 1', 'Tiene controles.'],
    ['SELECT 1 FROM units WHERE tech_id = $1 LIMIT 1', 'Tiene unidades a su nombre.'],
    ['SELECT 1 FROM shift_changes WHERE tech_id = $1 LIMIT 1', 'Tiene cambios de turno.'],
    ['SELECT 1 FROM cajas WHERE referente_tech_id = $1 LIMIT 1', 'Es o fue referente de una caja.'],
    ['SELECT 1 FROM alert_resolutions WHERE tech_id = $1 LIMIT 1', 'Tiene alertas resueltas.'],
    ['SELECT 1 FROM tech_plantilla_history WHERE tech_id = $1 ORDER BY id OFFSET 1 LIMIT 1', 'Tiene cambios de plantilla.'],
    ['SELECT 1 FROM novedades WHERE tech_id = $1 LIMIT 1', 'Tiene novedades.'],
    ['SELECT 1 FROM purchase_requests WHERE tech_id = $1 LIMIT 1', 'Tiene solicitudes de compra.'],
  ],
  cajas: [
    ['SELECT 1 FROM movements WHERE caja_id = $1 LIMIT 1', 'Tiene movimientos.'],
    ['SELECT 1 FROM assignments WHERE caja_id = $1 LIMIT 1', 'Tuvo herramientas asignadas.'],
    ['SELECT 1 FROM controls WHERE caja_id = $1 LIMIT 1', 'Tiene controles.'],
    ['SELECT 1 FROM units WHERE caja_id = $1 LIMIT 1', 'Tiene unidades.'],
    ['SELECT 1 FROM alert_resolutions WHERE caja_id = $1 LIMIT 1', 'Tiene alertas resueltas.'],
    ['SELECT 1 FROM purchase_requests WHERE caja_id = $1 LIMIT 1', 'Tiene solicitudes de compra.'],
  ],
  tools: [
    ['SELECT 1 FROM movement_transfers WHERE tool_id = $1 LIMIT 1', 'Tiene movimientos de inventario.'],
    ['SELECT 1 FROM movements WHERE tool_id = $1 LIMIT 1', 'Tiene movimientos.'],
    ['SELECT 1 FROM assignments WHERE tool_id = $1 LIMIT 1', 'Tuvo asignaciones.'],
    ['SELECT 1 FROM control_items WHERE tool_id = $1 LIMIT 1', 'Aparece en controles.'],
    ['SELECT 1 FROM units WHERE tool_id = $1 LIMIT 1', 'Tiene unidades.'],
    ['SELECT 1 FROM kit_items WHERE tool_id = $1 LIMIT 1', 'Está en un kit.'],
    ['SELECT 1 FROM purchase_requests WHERE tool_id = $1 LIMIT 1', 'Tiene solicitudes de compra.'],
  ],
  categories: [['SELECT 1 FROM tools WHERE category_id = $1 LIMIT 1', 'Tiene o tuvo herramientas.']],
  plantillas: [
    ['SELECT 1 FROM tech_plantilla_history WHERE plantilla_id = $1 LIMIT 1', 'Tiene o tuvo técnicos.'],
    ['SELECT 1 FROM plantilla_rotations WHERE plantilla_id = $1 LIMIT 1', 'Tiene cambios de turno.'],
    // Cualquier fila (también la del alta con supervisor): el historial es de solo agregar.
    ['SELECT 1 FROM plantilla_supervisor_history WHERE plantilla_id = $1 LIMIT 1', 'Tiene historial de supervisores.'],
    ['SELECT 1 FROM controls WHERE plantilla_id_snapshot = $1 OR shift_id = $1 LIMIT 1', 'Tiene controles.'],
    ['SELECT 1 FROM novedades WHERE plantilla_id = $1 LIMIT 1', 'Tiene novedades.'],
    ['SELECT 1 FROM purchase_requests WHERE plantilla_id = $1 LIMIT 1', 'Tiene solicitudes de compra.'],
  ],
  lineas: [
    ['SELECT 1 FROM cajas WHERE linea_id = $1 LIMIT 1', 'Tiene o tuvo cajas.'],
    ['SELECT 1 FROM control_items WHERE linea_id = $1 LIMIT 1', 'Aparece en controles.'],
    ['SELECT 1 FROM novedades WHERE linea_id = $1 LIMIT 1', 'Tiene novedades.'],
  ],
  especialidades: [
    ['SELECT 1 FROM techs WHERE especialidad_id = $1 LIMIT 1', 'Tiene o tuvo técnicos.'],
    ['SELECT 1 FROM kits WHERE especialidad_id = $1 LIMIT 1', 'Tiene o tuvo un kit.'],
  ],
  kits: [],
  // Una novedad no tiene historial operativo: se puede eliminar definitivamente.
  novedades: [],
  // Etapa 7: una solicitud de compra siempre es historial (se cancela archivándola, nunca se borra).
  compras: [['SELECT 1 FROM purchase_requests WHERE id = $1', 'Es una solicitud de compra: queda en el historial.']],
  users: [
    ['SELECT 1 FROM audit_log WHERE actor_id = $1 LIMIT 1', 'Hizo acciones en el sistema.'],
    ['SELECT 1 FROM users WHERE id = $1 AND last_login_at IS NOT NULL', 'Ya ingresó al sistema.'],
    ['SELECT 1 FROM plantillas WHERE supervisor_user_id = $1 LIMIT 1', 'Es supervisor de una plantilla.'],
    ['SELECT 1 FROM plantilla_supervisor_history WHERE supervisor_user_id = $1 OR from_user_id = $1 LIMIT 1', 'Fue supervisor de una plantilla.'],
    ['SELECT 1 FROM novedades WHERE author_id = $1 LIMIT 1', 'Escribió novedades.'],
    ['SELECT 1 FROM purchase_requests WHERE created_by = $1 OR decided_by = $1 OR received_by = $1 LIMIT 1', 'Tiene solicitudes de compra.'],
  ],
};

export async function historyOf(c, T, id) {
  const out = [];
  for (const [sql, msg] of HISTORY[T.type]) if (await exists(c, sql, [id])) out.push(msg);
  const actions = (await c.query('SELECT DISTINCT action FROM audit_log WHERE entity = $1 AND entity_id = $2', [T.table, id])).rows.map((r) => r.action);
  if (actions.some((a) => isHistoryAction(T.type, a))) out.push('Tiene acciones registradas en la auditoría.');
  if (T.type === 'kits' && (await exists(c, 'SELECT 1 FROM kits WHERE id = $1 AND especialidad_id IS NULL', [id]))) out.push('Es el kit base.');
  return out;
}

// ---------------------------------------------------------------- impedimentos para eliminar
// Lo que impide archivar (y eliminar definitivamente un registro activo). Las herramientas
// asignadas de un técnico o una caja no impiden: se resuelven en el mismo paso.
async function blockersOf(c, T, row, actor) {
  const id = row.id;
  const out = [];
  const add = (code, message) => out.push({ code, message });
  if (T.type === 'techs') {
    const k = (await c.query('SELECT name FROM cajas WHERE referente_tech_id = $1 AND archived_at IS NULL ORDER BY name LIMIT 1', [id])).rows[0];
    if (k) add('tech_is_referente', `Es referente de la caja ${k.name}. Cambiá el referente antes de eliminarlo.`);
  } else if (T.type === 'tools') {
    const p = (await c.query(`SELECT coalesce(sum(CASE WHEN to_pool = 'asignado' THEN qty WHEN from_pool = 'asignado' THEN -qty ELSE 0 END), 0)::int AS asignado,
        coalesce(sum(CASE WHEN to_pool = 'pendiente' THEN qty WHEN from_pool = 'pendiente' THEN -qty ELSE 0 END), 0)::int AS pendiente
      FROM movement_transfers WHERE tool_id = $1`, [id])).rows[0];
    if (p.asignado > 0) add('tool_assigned', `Tiene ${plural(p.asignado, 'unidad asignada', 'unidades asignadas')}: registrá la devolución o el retiro antes de eliminarla.`);
    if (p.pendiente > 0) add('tool_pending', `Tiene ${plural(p.pendiente, 'unidad pendiente', 'unidades pendientes')} de devolución: registrá la recepción antes de eliminarla.`);
  } else if (T.type === 'categories') {
    const n = (await c.query('SELECT count(*)::int AS n FROM tools WHERE category_id = $1 AND archived_at IS NULL', [id])).rows[0].n;
    if (n) add('category_has_tools', `La categoría tiene ${plural(n, 'herramienta', 'herramientas')}. Eliminalas o movelas a otra categoría antes.`);
  } else if (T.type === 'plantillas') {
    const busy = await exists(c, `SELECT 1 FROM tech_plantilla_history h JOIN techs t ON t.id = h.tech_id AND t.archived_at IS NULL
       WHERE h.plantilla_id = $1 AND (h.valid_to IS NULL OR h.valid_to > current_date) AND (h.valid_from IS NULL OR h.valid_to IS NULL OR h.valid_to > h.valid_from) LIMIT 1`, [id]);
    if (busy) add('plantilla_has_techs', 'La plantilla tiene técnicos.');
    if (!row.archived_at) {
      await repo.lockName(c, 'plantillas.archive');
      if ((await c.query('SELECT count(*)::int AS n FROM plantillas WHERE archived_at IS NULL')).rows[0].n <= 1) add('last_plantilla', 'Tiene que quedar al menos una plantilla.');
    }
  } else if (T.type === 'lineas') {
    if (await exists(c, 'SELECT 1 FROM cajas WHERE linea_id = $1 AND archived_at IS NULL LIMIT 1', [id])) add('linea_has_cajas', 'La línea tiene cajas activas.');
  } else if (T.type === 'especialidades') {
    const n = (await c.query('SELECT count(*)::int AS n FROM techs WHERE especialidad_id = $1 AND active', [id])).rows[0].n;
    if (n) add('especialidad_in_use', `La especialidad tiene ${n} ${n === 1 ? 'técnico activo' : 'técnicos activos'}. Cambiales la especialidad antes de archivarla.`);
    if (await exists(c, 'SELECT 1 FROM kits WHERE especialidad_id = $1 AND archived_at IS NULL', [id])) add('especialidad_has_kit', 'La especialidad tiene un kit. Eliminalo antes de archivarla.');
  } else if (T.type === 'kits') {
    if (!row.especialidad_id) add('kit_base', 'El kit base no se elimina: podés dejarlo vacío.');
  } else if (T.type === 'compras') {
    if (row.status !== 'pendiente') add('purchase_not_pending', 'Solo se cancela una solicitud pendiente: esta ya tiene una decisión.');
  } else if (T.type === 'users') {
    if (actor && row.id === actor.id) add('self_deactivate', 'No podés eliminar tu propio usuario.');
    if (row.role === 'admin' && row.active && (await countActiveAdmins(c, row.id)) === 0) add('last_admin', 'Tiene que quedar al menos un administrador activo.');
  }
  return out;
}

function throwBlockers(list) {
  if (!list.length) return;
  const err = rule(list[0].message, list[0].code);
  err.extra = { blockers: list };
  throw err;
}

// Asignaciones activas de un técnico o una caja, para resolverlas al eliminarlo.
async function activeAssignments(c, T, id) {
  const col = T.type === 'cajas' ? 'caja_id' : 'tech_id';
  const { rows } = await c.query(
    `SELECT a.id, a.tool_id, a.qty, a.unit_id, t.name AS tool_name, t.serialized, u.code AS unit_code
       FROM assignments a JOIN tools t ON t.id = a.tool_id LEFT JOIN units u ON u.id = a.unit_id
      WHERE a.${col} = $1 AND a.active ORDER BY t.sort_order, t.name, a.id`,
    [id],
  );
  return rows.map((r) => ({ id: r.id, toolId: r.tool_id, toolName: r.tool_name, qty: r.qty, unitId: r.unit_id, unitCode: r.unit_code, serialized: r.serialized }));
}

// Lo que la interfaz necesita antes de eliminar: impedimentos, asignaciones a resolver y si
// se puede eliminar definitivamente (sin historial).
export async function deleteCheck(db, actor, type, id) {
  const T = typeInfo(type);
  return withTransaction(db, async (c) => {
    const row = (await c.query(`SELECT * FROM ${T.table} WHERE id = $1`, [id])).rows[0];
    if (!row) throw notFoundError();
    const history = await historyOf(c, T, id);
    const blockers = row.archived_at ? [] : await blockersOf(c, T, row, actor);
    const assignments = ['techs', 'cajas'].includes(type) && !row.archived_at ? await activeAssignments(c, T, id) : [];
    return { type, id, name: row.name, version: row.version, archived: !!row.archived_at, hasHistory: history.length > 0, history, blockers, assignments, canPurge: history.length === 0 && (row.archived_at ? true : !blockers.length) };
  });
}

// ---------------------------------------------------------------- eliminar (archivar)
// Alcances de orden de una categoría o herramienta: se bloquean antes que la fila.
async function lockOrderScope(c, T, id) {
  if (T.type === 'categories') return [await lockScopeOf(c, CATEGORY_SCOPE)];
  if (T.type !== 'tools') return [];
  const before = (await c.query('SELECT category_id FROM tools WHERE id = $1', [id])).rows[0];
  if (!before) return [];
  return [await lockScopeOf(c, toolScope(before.category_id ?? null), before.category_id ?? null)];
}
async function lockScopeOf(c, scope, categoryId) {
  await lockScope(c, scope);
  return { scope, categoryId };
}
function checkScope(T, row, scopes) {
  if (T.type === 'tools' && scopes[0] && (row.category_id ?? null) !== scopes[0].categoryId) throw new ConflictError(null);
}
const bumpAll = async (c, scopes) => {
  for (const s of scopes) await bumpScope(c, s.scope);
};

async function lockKitsOf(c, toolId) {
  const ids = (await c.query('SELECT DISTINCT kit_id FROM kit_items WHERE tool_id = $1', [toolId])).rows.map((r) => r.kit_id);
  if (!ids.length) return [];
  return (await c.query('SELECT id FROM kits WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids])).rows.map((r) => r.id);
}

function checkVersionOf(row, version) {
  if (!row) throw notFoundError();
  if (row.version !== version) throw new ConflictError(row);
}

export async function archiveRecord(db, actor, type, id, input, version) {
  const T = typeInfo(type);
  const reason = cleanReason(input.reason);
  return withTransaction(db, async (c) => {
    if (T.type === 'users') await lockAdmins(c);
    const scopes = await lockOrderScope(c, T, id);
    // Los kits de una herramienta se bloquean antes que ella (filas por id -> herramientas), como
    // en entregar y editar un kit: si no, archivar y entregar el kit se bloquean mutuamente.
    const kitIds = T.type === 'tools' ? await lockKitsOf(c, id) : [];
    const row = await lockRow(c, T, id);
    checkVersionOf(row, version);
    checkScope(T, row, scopes);
    if (row.archived_at) throw rule(`${cap(T.the)} ya está eliminado.`, 'archived');
    throwBlockers(await blockersOf(c, T, row, actor));
    const movements = [];
    if (T.type === 'techs' || T.type === 'cajas') {
      const active = await activeAssignments(c, T, id);
      const plan = planResolutions(active, input.resolutions);
      // Herramientas por id antes de registrar (orden global); applyMovement las vuelve a pedir.
      const toolIds = [...new Set(active.map((a) => a.toolId))].sort();
      if (toolIds.length) await c.query('SELECT id FROM tools WHERE id = ANY($1) ORDER BY id FOR UPDATE', [toolIds]);
      const holder = T.type === 'cajas' ? { cajaId: id } : { techId: id };
      for (const r of plan) {
        const p = await applyMovement(c, actor, { type: r.action, ...holder, asgId: r.assignmentId, qty: r.qty, cond: r.cond, reason: `Eliminación de ${row.name}: ${reason}` }, { inactiveHolder: true });
        movements.push(p.movement.id);
      }
    }
    const extra = ['techs', 'tools', 'users'].includes(T.type) ? ', active = false' : '';
    await c.query(`UPDATE ${T.table} SET archived_at = now(), archived_by = $2, archive_reason = $3${extra} WHERE id = $1`, [id, actor.id, reason]);
    let detail = '';
    if (T.type === 'tools') {
      // Sus unidades (todas fuera de manos de un poseedor) quedan archivadas con ella, y deja los kits.
      await c.query('UPDATE units SET archived_at = now(), archived_by = $2, archive_reason = $3 WHERE tool_id = $1 AND archived_at IS NULL', [id, actor.id, reason]);
      const kits = (await c.query('DELETE FROM kit_items WHERE tool_id = $1 RETURNING kit_id', [id])).rows.map((r) => r.kit_id);
      // Un kit que la sumó después de leer la lista no está bloqueado: bloquearlo ahora rompería el
      // orden. Se pide repetir (la transacción se deshace).
      if (kits.some((k) => !kitIds.includes(k))) throw rule('Un kit cambió mientras se eliminaba la herramienta. Probá de nuevo.', 'conflict');
      for (const k of [...new Set(kits)].sort()) await c.query('UPDATE kits SET updated_at = now() WHERE id = $1', [k]);
      if (kits.length) detail = ` Se quitó de ${plural(kits.length, 'kit', 'kits')}.`;
    }
    if (T.type === 'users') await deleteUserSessions(c, id);
    await bumpAll(c, scopes);
    const out = await view(c, T, id);
    const res = movements.length ? ` Herramientas resueltas: ${movements.length}.` : '';
    await record(c, actor, { action: `${T.audit}_archive`, entity: T.table, id, version: out.version, event: 'update', detail: `Eliminación de ${T.label} ${row.name}. Motivo: ${reason}.${res}${detail}` });
    return { record: out, movements };
  });
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- restaurar
const NAME_TAKEN = (T, name) => rule(`Ya hay otro registro activo con el nombre ${name}. Renombralo antes de restaurar este registro.`, 'duplicate');
const PURCHASE_TAKEN = (name) => rule(`Ya hay otra solicitud abierta para esa herramienta y motivo${name ? ` (${name})` : ''}.`, 'duplicate');
const UNIQUE_NAME = new Set(['tools', 'categories', 'cajas', 'plantillas', 'lineas', 'especialidades']);

async function restoreChecks(c, T, row) {
  if (UNIQUE_NAME.has(T.type)) {
    await repo.lockName(c, `${T.table}.name`);
    if (await exists(c, `SELECT 1 FROM ${T.table} WHERE lower(name) = lower($1) AND archived_at IS NULL AND id <> $2 LIMIT 1`, [row.name, row.id])) throw NAME_TAKEN(T, row.name);
  }
  if (T.type === 'tools' && row.category_id) {
    const cat = (await c.query('SELECT name, archived_at FROM categories WHERE id = $1 FOR SHARE', [row.category_id])).rows[0];
    if (cat && cat.archived_at) throw rule(`Restaurá antes la categoría ${cat.name}.`, 'parent_archived');
  }
  if (T.type === 'cajas') {
    const l = (await c.query('SELECT name, archived_at FROM lineas WHERE id = $1 FOR SHARE', [row.linea_id])).rows[0];
    if (l && l.archived_at) throw rule(`Restaurá antes la línea o sector ${l.name}.`, 'parent_archived');
  }
  if (T.type === 'compras') {
    // E7.V1: la asignación (y su poseedor) tiene que seguir vigente.
    if (row.assignment_id) {
      const a = (await c.query(
        `SELECT a.active, coalesce(t.active AND t.archived_at IS NULL, k.archived_at IS NULL, false) AS holder_ok
           FROM assignments a LEFT JOIN techs t ON t.id = a.tech_id LEFT JOIN cajas k ON k.id = a.caja_id WHERE a.id = $1`,
        [row.assignment_id],
      )).rows[0];
      if (!a || !a.active || !a.holder_ok) throw rule('La herramienta de esta solicitud ya no está asignada a ese poseedor: no se restaura. Creá una solicitud nueva si hace falta.', 'assignment_inactive');
    }
    // Una sola abierta por asignación (o unidad) y motivo: si ya hay otra, no se restaura. El
    // nombre por asignación ya se tomó antes que la fila (restoreRecord), como en el alta.
    const other = (await c.query(`SELECT name FROM purchase_requests WHERE id <> $1 AND archived_at IS NULL AND status = ANY($2) AND reason = $3
        AND (($4::text IS NOT NULL AND assignment_id = $4::text) OR ($5::text IS NOT NULL AND unit_id = $5::text)) LIMIT 1`, [row.id, OPEN_STATUSES, row.reason, row.assignment_id, row.unit_id])).rows[0];
    if (other) throw PURCHASE_TAKEN(other.name);
  }
  if (T.type === 'kits') {
    const e = (await c.query('SELECT name, archived_at FROM especialidades WHERE id = $1 FOR SHARE', [row.especialidad_id])).rows[0];
    if (e && e.archived_at) throw rule(`Restaurá antes la especialidad ${e.name}.`, 'parent_archived');
    if (await exists(c, 'SELECT 1 FROM kits WHERE especialidad_id = $1 AND archived_at IS NULL AND id <> $2', [row.especialidad_id, row.id])) throw rule(`Ya hay un kit activo para ${e ? e.name : 'esa especialidad'}.`, 'duplicate');
  }
}

export async function restoreRecord(db, actor, type, id, input, version) {
  const T = typeInfo(type);
  const reason = cleanReason(input.reason);
  return withTransaction(db, async (c) => {
    if (T.type === 'users') await lockAdmins(c);
    const scopes = await lockOrderScope(c, T, id);
    // Compras: el nombre por asignación antes que la fila (orden del alta y de finalizar un
    // control); la asignación de una solicitud no cambia nunca (trigger de 015).
    if (T.type === 'compras') {
      const a = (await c.query('SELECT assignment_id FROM purchase_requests WHERE id = $1', [id])).rows[0];
      if (a && a.assignment_id) await repo.lockName(c, `purchases.asg:${a.assignment_id}`);
    }
    const row = await lockRow(c, T, id);
    checkVersionOf(row, version);
    checkScope(T, row, scopes);
    if (!row.archived_at) throw rule(`${cap(T.the)} no está eliminado.`, 'not_archived');
    await restoreChecks(c, T, row);
    // Técnicos y herramientas vuelven activos; un usuario vuelve desactivado (un administrador lo
    // reactiva para que pueda ingresar).
    const extra = ['techs', 'tools'].includes(T.type) ? ', active = true' : '';
    await c.query(`UPDATE ${T.table} SET archived_at = NULL, archived_by = NULL, archive_reason = NULL${extra} WHERE id = $1`, [id]).catch((err) => {
      // Compras: el índice único parcial de las abiertas (otra solicitud por la misma unidad).
      if (err && err.code === '23505') throw T.type === 'compras' ? PURCHASE_TAKEN() : NAME_TAKEN(T, row.name);
      throw err;
    });
    if (T.type === 'tools') await c.query('UPDATE units SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE tool_id = $1 AND archived_at IS NOT NULL', [id]);
    await bumpAll(c, scopes);
    const out = await view(c, T, id);
    await record(c, actor, { action: `${T.audit}_restore`, entity: T.table, id, version: out.version, event: 'update', detail: `Restauración de ${T.label} ${row.name}. Motivo: ${reason}${T.type === 'users' ? '. Queda desactivado hasta que un administrador lo reactive' : ''}` });
    return { record: out };
  });
}

// ---------------------------------------------------------------- eliminación definitiva
export async function purgeRecord(db, actor, type, id, input, version) {
  const T = typeInfo(type);
  const reason = cleanReason(input.reason);
  return withTransaction(db, async (c) => {
    if (T.type === 'users') await lockAdmins(c);
    const scopes = await lockOrderScope(c, T, id);
    const row = await lockRow(c, T, id);
    checkVersionOf(row, version);
    checkScope(T, row, scopes);
    checkConfirmName(row.name, input.confirmName);
    // "Sin historial" se revisa acá, con la fila bloqueada: nada nuevo la puede nombrar.
    const history = await historyOf(c, T, id);
    if (history.length) {
      const err = rule(`No se puede eliminar definitivamente: tiene historial. ${history.join(' ')} Podés eliminarlo (queda archivado y se puede restaurar).`, 'has_history');
      err.extra = { history };
      throw err;
    }
    if (!row.archived_at || T.type === 'users' || T.type === 'kits') throwBlockers(await blockersOf(c, T, row, actor));
    // El rango del alta se borra solo por la función del dueño (migración 013), que vuelve a
    // revisar que el técnico no tenga historial.
    if (T.type === 'techs') await c.query('SELECT purge_tech_ranges($1)', [id]);
    await c.query(`DELETE FROM ${T.table} WHERE id = $1`, [id]);
    await bumpAll(c, scopes);
    await record(c, actor, { action: `${T.audit}_delete`, entity: T.table, id, event: 'delete', detail: `Eliminación definitiva de ${T.label} ${row.name}. Motivo: ${reason}` });
    return { ok: true, type, id, name: row.name };
  });
}

// ---------------------------------------------------------------- registros eliminados
export async function listArchived(db, { type = null, q = '' } = {}) {
  const types = type ? [typeInfo(type).type] : Object.keys(TABLE);
  const needle = String(q || '').trim().toLowerCase();
  const out = [];
  await withTransaction(db, async (c) => {
    for (const t of types) {
      const T = typeInfo(t);
      const extra = t === 'users' ? ', username' : t === 'techs' ? ', legajo' : t === 'lineas' ? ', kind' : t === 'novedades' ? ', comment' : t === 'compras' ? ", concat_ws(' · ', tool_name, holder_name) AS comment" : '';
      const { rows } = await c.query(`SELECT id, name, version, archived_at, archived_by, archive_reason${extra} FROM ${T.table} WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id LIMIT 500`);
      for (const r of rows) {
        const hay = [r.name, r.legajo, r.username, r.comment, r.archive_reason].filter(Boolean).join(' ').toLowerCase();
        if (needle && !hay.includes(needle)) continue;
        out.push({
          type: t, id: r.id, name: r.name, legajo: r.legajo ?? null, username: r.username ?? null, kind: r.kind ?? null, comment: r.comment ?? null, version: r.version,
          archivedAt: r.archived_at.toISOString(), archivedBy: r.archived_by, reason: r.archive_reason || '', hasHistory: (await historyOf(c, T, r.id)).length > 0,
        });
      }
    }
    const by = [...new Set(out.map((r) => r.archivedBy).filter(Boolean))];
    const names = by.length ? Object.fromEntries((await c.query('SELECT id, name FROM users WHERE id = ANY($1)', [by])).rows.map((u) => [u.id, u.name])) : {};
    for (const r of out) r.archivedByName = names[r.archivedBy] || null;
  });
  out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || a.id.localeCompare(b.id));
  return { records: out, today: localDateISO() };
}
