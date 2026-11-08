// Plantillas por supervisor: alta, edición, archivo, rotación del turno, cambio de supervisor,
// movimiento de técnicos (uno o varios en una sola transacción, con cobertura temporal
// opcional) e historiales. La pertenencia vive en tech_plantilla_history: nunca se borra,
// solo se cierra el rango abierto y se agrega uno nuevo.
import * as repo from '../adapters/pg/catalog-repo.js';
import * as prepo from '../adapters/pg/plantilla-repo.js';
import { loadOverrides } from '../adapters/pg/auth-repo.js';
import { DomainError, notFoundError } from '../domain/errors.js';
import { planMove, effectiveRange, planRotation, canRotate, cleanPlantillaName, cleanShiftLabels } from '../domain/plantillas.js';
import { validDay } from '../domain/catalog.js';
import { localDateISO } from '../domain/period.js';
import { newId } from './ids.js';
import { withTransaction, checkVersion, record, notifyChange, onUnique } from './common.js';
import { idempotent } from './idempotency.js';

const rule = (msg, code = 'invalid_input', status = 422) => new DomainError(msg, code, status);
const forbidden = () => rule('Tu perfil no tiene permiso para esta acción.', 'forbidden', 403);
const MAX_SELECTED = 200;
// Índice único parcial de la migración 008 (nombre de plantilla activa): la última defensa si
// dos altas o renombres simultáneos pasan el control previo.
const NAME_TAKEN = 'Ya existe una plantilla con ese nombre.';
const onNameTaken = onUnique(NAME_TAKEN, 'duplicate');

// Error de la base por superposición de rangos (restricción de exclusión): otro cambio
// simultáneo del mismo técnico ganó.
const onOverlap = (err) => {
  if (err && err.code === '23P01') throw rule('Otra persona cambió la plantilla de este técnico al mismo tiempo. Recargá para ver los cambios.', 'conflict', 409);
  throw err;
};

async function activePlantilla(c, id, { lock = false, msg = 'Elegí una plantilla válida.' } = {}) {
  const p = id ? await repo.getRow(c, 'plantillas', id, { lock }) : null;
  if (!p || p.archivedAt) throw rule(msg, 'invalid_plantilla');
  return p;
}

async function supervisorOf(c, userId) {
  if (userId == null) return null;
  const u = (await c.query('SELECT id, name, role, active FROM users WHERE id = $1', [userId])).rows[0];
  if (!u || u.role !== 'supervisor' || !u.active) throw rule('Elegí un usuario activo con perfil Supervisor.', 'invalid_supervisor');
  return u;
}

async function assertNameFree(c, name, exceptId) {
  await repo.lockName(c, 'plantillas.name');
  const { rows } = await c.query('SELECT 1 FROM plantillas WHERE lower(name) = lower($1) AND archived_at IS NULL AND id IS DISTINCT FROM $2 LIMIT 1', [name, exceptId]);
  if (rows[0]) throw rule(NAME_TAKEN, 'duplicate', 409);
}

const nameOf = async (c, id) => (id ? (await repo.getRow(c, 'plantillas', id))?.name ?? id : 'Sin plantilla');
const cleanFrom = (v, today, what = 'La fecha') => {
  const d = v == null || v === '' ? today : v;
  if (!validDay(d)) throw rule(`${what} no es válida.`, 'invalid_date');
  if (d > today) throw rule(`${what} no puede ser futura.`, 'invalid_date');
  return d;
};

// Técnico con su plantilla actual (`shiftId` se mantiene por compatibilidad con 2.1).
export async function withMembership(q, tech) {
  if (!tech) return tech;
  const p = (await prepo.currentMembership(q, [tech.id]))[tech.id] ?? null;
  return { ...tech, plantillaId: p, shiftId: p };
}

// ---------------------------------------------------------------- plantillas
export async function createPlantilla(db, actor, input) {
  return withTransaction(db, async (c) => {
    const sup = await supervisorOf(c, input.supervisorUserId ?? null);
    const name = cleanPlantillaName(input.name, sup?.name);
    await assertNameFree(c, name, null);
    let label = null;
    if (input.shiftLabel != null) {
      const { labels } = await prepo.loadShiftLabels(c);
      if (!labels.includes(input.shiftLabel)) throw rule('Elegí un turno de la lista.', 'invalid_shift_label');
      label = input.shiftLabel;
    }
    const order = input.order ?? (await c.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM plantillas')).rows[0].n;
    const row = await repo.insertRow(c, 'plantillas', newId('pl'), { name, supervisorUserId: sup?.id ?? null, currentShiftLabel: label, order, by: actor.id }).catch(onNameTaken);
    if (sup) await prepo.insertSupervisorChange(c, { id: newId('ps'), plantillaId: row.id, fromUserId: null, supervisorUserId: sup.id, from: localDateISO() }, actor.id);
    await record(c, actor, { action: 'plantilla_create', entity: 'plantillas', id: row.id, version: row.version, event: 'create', detail: `Alta de plantilla ${name}${sup ? `, supervisor ${sup.name}` : ''}` });
    return row;
  });
}

export async function updatePlantilla(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'plantillas', id, { lock: true }), version, 'No se encontró la plantilla.');
    if (cur.archivedAt) throw rule('La plantilla está archivada.', 'archived', 409);
    const set = {};
    if (input.name !== undefined) {
      set.name = cleanPlantillaName(input.name, null);
      if (set.name.toLowerCase() !== cur.name.toLowerCase()) await assertNameFree(c, set.name, id);
    }
    if (input.order !== undefined) set.order = input.order;
    const diff = Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== cur[k]));
    if (!Object.keys(diff).length) return cur;
    const row = await repo.updateRow(c, 'plantillas', id, diff).catch(onNameTaken);
    const detail = diff.name ? `Plantilla renombrada: ${cur.name} a ${row.name}` : `Orden de la plantilla ${row.name}: ${row.order}`;
    await record(c, actor, { action: diff.name ? 'plantilla_rename' : 'plantilla_reorder', entity: 'plantillas', id, version: row.version, detail });
    return row;
  });
}

// Baja lógica: solo sin técnicos actuales ni futuros, y tiene que quedar al menos una.
export async function archivePlantilla(db, actor, id, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'plantillas', id, { lock: true }), version, 'No se encontró la plantilla.');
    if (cur.archivedAt) throw rule('La plantilla ya está archivada.', 'archived', 409);
    const busy = (await c.query(
      "SELECT 1 FROM tech_plantilla_history WHERE plantilla_id = $1 AND (valid_to IS NULL OR valid_to > current_date) AND (valid_from IS NULL OR valid_to IS NULL OR valid_to > valid_from) LIMIT 1",
      [id],
    )).rows[0];
    if (busy) throw rule('La plantilla tiene técnicos.', 'plantilla_has_techs', 409);
    await repo.lockName(c, 'plantillas.archive');
    if ((await c.query('SELECT count(*)::int AS n FROM plantillas WHERE archived_at IS NULL')).rows[0].n <= 1) throw rule('Tiene que quedar al menos una plantilla.', 'last_plantilla', 409);
    const row = await repo.updateRow(c, 'plantillas', id, { archivedAt: new Date() });
    await record(c, actor, { action: 'plantilla_archive', entity: 'plantillas', id, version: row.version, event: 'delete', detail: `Plantilla archivada: ${cur.name}` });
    return row;
  });
}

export async function rotatePlantilla(db, actor, id, input, version) {
  const overrides = await loadOverrides(db);
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'plantillas', id, { lock: true }), version, 'No se encontró la plantilla.');
    if (!canRotate(actor, cur, overrides)) throw forbidden();
    if (cur.archivedAt) throw rule('La plantilla está archivada.', 'archived', 409);
    const { labels } = await prepo.loadShiftLabels(c);
    const p = planRotation({ labels, current: cur.currentShiftLabel, label: input.label, from: input.from, today: localDateISO() });
    const rotation = await prepo.insertRotation(c, { id: newId('ro'), plantillaId: id, fromLabel: cur.currentShiftLabel, label: p.label, from: p.from }, actor.id);
    const row = await repo.updateRow(c, 'plantillas', id, { currentShiftLabel: p.label });
    await record(c, actor, { action: 'plantilla_rotate', entity: 'plantillas', id, version: row.version, detail: `Rotación de ${row.name}: ${cur.currentShiftLabel || 'sin turno'} a ${p.label} desde ${p.from}` });
    return { plantilla: row, rotation };
  });
}

export async function changeSupervisor(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'plantillas', id, { lock: true }), version, 'No se encontró la plantilla.');
    if (cur.archivedAt) throw rule('La plantilla está archivada.', 'archived', 409);
    const sup = await supervisorOf(c, input.supervisorUserId ?? null);
    if ((sup?.id ?? null) === (cur.supervisorUserId ?? null)) throw rule(sup ? 'Ese usuario ya es el supervisor de la plantilla.' : 'La plantilla ya no tiene supervisor.', 'same_supervisor');
    const from = cleanFrom(input.from, localDateISO(), 'La fecha del cambio');
    const change = await prepo.insertSupervisorChange(c, { id: newId('ps'), plantillaId: id, fromUserId: cur.supervisorUserId ?? null, supervisorUserId: sup?.id ?? null, from }, actor.id);
    const row = await repo.updateRow(c, 'plantillas', id, { supervisorUserId: sup?.id ?? null });
    const prev = cur.supervisorUserId ? (await c.query('SELECT name FROM users WHERE id = $1', [cur.supervisorUserId])).rows[0]?.name ?? cur.supervisorUserId : 'sin supervisor';
    await record(c, actor, { action: 'plantilla_supervisor', entity: 'plantillas', id, version: row.version, detail: `Supervisor de ${row.name}: ${prev} a ${sup ? sup.name : 'sin supervisor'} desde ${from}` });
    return { plantilla: row, change };
  });
}

// ---------------------------------------------------------------- mover técnicos
// Dentro de la transacción `c`. `expectFrom`: la plantilla en la que tiene que estar ahora
// (mover seleccionados desde la vista de una plantilla); `version`: la del técnico (If-Match).
// Orden de bloqueo en todos los movimientos (evita bloqueos mutuos): primero la plantilla
// destino, después el técnico.
export async function applyMove(c, actor, techId, input, { expectFrom = null, today = localDateISO(), version = null } = {}) {
  const target = await activePlantilla(c, input.plantillaId, { lock: true, msg: 'Elegí la plantilla destino.' });
  const tech = await repo.getRow(c, 'techs', techId, { lock: true });
  if (!tech) throw notFoundError('No se encontró el técnico.');
  if (version != null) checkVersion(tech, version, 'No se encontró el técnico.');
  if (tech.active === false) throw rule('El técnico está inactivo.', 'inactive_tech');
  const ranges = await prepo.loadHistory(c, { techIds: [techId] });
  if (expectFrom) {
    // La plantilla en la que está hoy (durante una cobertura, la de la cobertura).
    const here = effectiveRange(ranges, today) || ranges.find((r) => r.validTo == null);
    if (!here || here.plantillaId !== expectFrom) throw rule(`${tech.name} no está en esta plantilla.`, 'not_member');
  }
  const plan = planMove(ranges, { techId, targetId: target.id, from: input.from || today, until: input.until ?? null, reason: input.reason, today }, { newId });
  const inserted = await prepo.applyMovePlan(c, plan, { actorId: actor.id, demo: !!tech.demo }).catch(onOverlap);
  // Sube la versión del técnico: quien lo tenga abierto para editar ve que cambió.
  const touched = repo.toApi('techs', (await c.query('UPDATE techs SET active = active WHERE id = $1 RETURNING *', [techId])).rows[0]);
  const fromName = await nameOf(c, plan.fromPlantillaId);
  const first = inserted[0];
  const detail = first.temporary
    ? `Cobertura temporal de ${tech.name}: ${fromName} a ${target.name} del ${first.validFrom} al ${first.validTo}. Motivo: ${first.reason}`
    : `Cambio de plantilla de ${tech.name}: ${fromName} a ${target.name} desde ${first.validFrom}${plan.cancelledReturn ? ` (termina la cobertura temporal y se cancela la vuelta a ${await nameOf(c, plan.cancelledReturn.plantillaId)} del ${plan.cancelledReturn.from})` : ''}. Motivo: ${first.reason}`;
  await record(c, actor, { action: first.temporary ? 'tech_coverage' : 'tech_move', entity: 'techs', id: techId, version: touched.version, detail });
  return { tech: await withMembership(c, touched), ranges: inserted, fromPlantillaId: plan.fromPlantillaId, toPlantillaId: target.id, fromName, toName: target.name };
}

export async function moveTech(db, actor, techId, input, { version = null, idempotencyKey, path } = {}) {
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: { input, version } }, async (c) => {
    const r = await applyMove(c, actor, techId, input, { version });
    return { status: 200, body: { tech: r.tech, ranges: r.ranges } };
  });
}

// Mover seleccionados: todos o ninguno (una sola transacción). Se bloquea la plantilla destino
// una vez antes que los técnicos (mismo orden que mover uno) y los técnicos en orden de id.
export async function moveSelected(db, actor, sourceId, input, { idempotencyKey, path } = {}) {
  const ids = [...new Set(input.techIds || [])].sort();
  if (!ids.length) throw rule('Elegí al menos un técnico.', 'invalid_input');
  if (ids.length > MAX_SELECTED) throw rule(`Se pueden mover hasta ${MAX_SELECTED} técnicos por vez.`, 'invalid_input');
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: input }, async (c) => {
    const source = await repo.getRow(c, 'plantillas', sourceId);
    if (!source) throw notFoundError('No se encontró la plantilla.');
    if (input.targetPlantillaId === sourceId) throw rule('Elegí una plantilla destino distinta.', 'same_plantilla');
    await activePlantilla(c, input.targetPlantillaId, { lock: true, msg: 'Elegí la plantilla destino.' });
    const moved = [];
    for (const techId of ids) {
      try {
        moved.push(await applyMove(c, actor, techId, { plantillaId: input.targetPlantillaId, from: input.from, until: input.until, reason: input.reason }, { expectFrom: sourceId }));
      } catch (err) {
        if (err instanceof DomainError && !String(err.message).includes(techId)) {
          const name = (await c.query('SELECT name FROM techs WHERE id = $1', [techId]).catch(() => ({ rows: [] }))).rows[0]?.name;
          const e = new DomainError(name && !err.message.startsWith(name) ? `${name}: ${err.message}` : err.message, err.code, err.status);
          e.extra = { ...(err.extra || {}), techId };
          throw e;
        }
        throw err;
      }
    }
    await notifyChange(c, { entity: 'plantillas', id: sourceId, action: 'move' });
    return { status: 200, body: { moved: moved.map((m) => ({ techId: m.tech.id, version: m.tech.version, ranges: m.ranges })) } };
  });
}

// ---------------------------------------------------------------- lecturas
export async function listPlantillas(db) {
  const rows = await repo.listRows(db, 'plantillas', 'ORDER BY sort_order, id');
  const members = await prepo.currentMembership(db);
  const count = {};
  for (const p of Object.values(members)) count[p] = (count[p] || 0) + 1;
  return rows.map((p) => ({ ...p, members: count[p.id] || 0 }));
}

export async function plantillaHistory(db, id) {
  const plantilla = await repo.getRow(db, 'plantillas', id);
  if (!plantilla) throw notFoundError('No se encontró la plantilla.');
  return {
    plantilla,
    members: await prepo.loadHistory(db, { plantillaId: id }),
    rotations: await prepo.loadRotations(db, id),
    supervisors: await prepo.loadSupervisorHistory(db, id),
  };
}

export async function techPlantillaHistory(db, techId) {
  const tech = await repo.getRow(db, 'techs', techId);
  if (!tech) throw notFoundError('No se encontró el técnico.');
  const ranges = await prepo.loadHistory(db, { techIds: [techId] });
  return { techId, current: (await prepo.currentMembership(db, [techId]))[techId] ?? null, ranges };
}

// ---------------------------------------------------------------- turnos configurables
export const getShiftLabels = (db) => prepo.loadShiftLabels(db);

export async function setShiftLabels(db, actor, list, version) {
  const labels = cleanShiftLabels(list);
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'settings:shift_labels');
    const cur = await prepo.loadShiftLabels(c);
    if (cur.version !== version) throw new DomainError('Otra persona modificó la lista de turnos. Recargá para ver los cambios.', 'conflict', 409);
    const out = await prepo.saveShiftLabels(c, labels, actor.id);
    await record(c, actor, { action: 'shift_labels', entity: 'app_settings', id: prepo.SHIFT_LABELS_KEY, version: out.version, detail: `Turnos de las plantillas: ${labels.join(', ')}` });
    return out;
  });
}
