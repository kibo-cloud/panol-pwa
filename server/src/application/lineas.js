// Líneas de producción, sectores y cajas compartidas (etapa 2), y el alta de una asignación
// en un solo formulario: a un técnico o a una caja, por cantidad o con varias unidades, todo
// en una transacción (reemplaza los ~10 pasos del Excel).
import * as repo from '../adapters/pg/catalog-repo.js';
import { DomainError } from '../domain/errors.js';
import { cleanLinea, cleanCaja } from '../domain/lineas.js';
import { newId } from './ids.js';
import { withTransaction, checkVersion, record } from './common.js';
import { idempotent } from './idempotency.js';
import { applyMovement } from './movements.js';

const rule = (msg, code = 'invalid_input', status = 422) => new DomainError(msg, code, status);
const changed = (set, cur) => Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== undefined && v !== cur[k]));

async function assertNameFree(c, table, name, exceptId, message) {
  await repo.lockName(c, `${table}.name`);
  const { rows } = await c.query(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND archived_at IS NULL AND id IS DISTINCT FROM $2 LIMIT 1`, [name, exceptId]);
  if (rows[0]) throw rule(message, 'duplicate', 409);
}

// ---------------------------------------------------------------- líneas y sectores
const LINEA_DUP = 'Ya existe una línea o sector con ese nombre.';
const kindLabel = (k) => (k === 'sector' ? 'sector' : 'línea');

export async function createLinea(db, actor, input) {
  const v = cleanLinea(input);
  return withTransaction(db, async (c) => {
    await assertNameFree(c, 'lineas', v.name, null, LINEA_DUP);
    const order = input.order ?? (await c.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM lineas')).rows[0].n;
    const row = await repo.insertRow(c, 'lineas', newId('ln'), { ...v, order, by: actor.id });
    await record(c, actor, { action: 'linea_create', entity: 'lineas', id: row.id, version: row.version, event: 'create', detail: `Alta de ${kindLabel(v.kind)} ${v.name}` });
    return row;
  });
}

export async function updateLinea(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'lineas', id, { lock: true }), version, 'No se encontró la línea.');
    if (cur.archivedAt) throw rule('La línea está archivada.', 'archived', 409);
    const set = { ...cleanLinea(input, { partial: true }), order: input.order };
    if (set.name && set.name.toLowerCase() !== cur.name.toLowerCase()) await assertNameFree(c, 'lineas', set.name, id, LINEA_DUP);
    const diff = changed(set, cur);
    if (!Object.keys(diff).length) return cur;
    const row = await repo.updateRow(c, 'lineas', id, diff);
    await record(c, actor, { action: 'linea_edit', entity: 'lineas', id, version: row.version, detail: `Edición de ${kindLabel(row.kind)} ${row.name}` });
    return row;
  });
}

export async function archiveLinea(db, actor, id, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'lineas', id, { lock: true }), version, 'No se encontró la línea.');
    if (cur.archivedAt) throw rule('La línea ya está archivada.', 'archived', 409);
    if ((await c.query('SELECT 1 FROM cajas WHERE linea_id = $1 AND archived_at IS NULL LIMIT 1', [id])).rows[0]) throw rule('La línea tiene cajas activas.', 'linea_has_cajas', 409);
    const row = await repo.updateRow(c, 'lineas', id, { archivedAt: new Date() });
    await record(c, actor, { action: 'linea_archive', entity: 'lineas', id, version: row.version, event: 'delete', detail: `Baja de ${kindLabel(row.kind)} ${row.name}` });
    return row;
  });
}

// ---------------------------------------------------------------- cajas
const CAJA_DUP = 'Ya existe una caja con ese nombre.';

async function checkLinea(c, id) {
  const l = id ? await repo.getRow(c, 'lineas', id) : null;
  if (!l || l.archivedAt) throw rule('Elegí una línea o sector activo.', 'invalid_linea');
  return l;
}
async function checkReferente(c, id) {
  if (id == null) return null;
  const t = (await c.query('SELECT id, active FROM techs WHERE id = $1', [id])).rows[0];
  if (!t || !t.active) throw rule('Elegí un técnico activo como referente.', 'invalid_referente');
  return t.id;
}

export async function createCaja(db, actor, input) {
  const v = cleanCaja(input);
  return withTransaction(db, async (c) => {
    const linea = await checkLinea(c, input.lineaId);
    const referenteTechId = await checkReferente(c, input.referenteTechId ?? null);
    await assertNameFree(c, 'cajas', v.name, null, CAJA_DUP);
    const row = await repo.insertRow(c, 'cajas', newId('cj'), { ...v, lineaId: linea.id, referenteTechId, by: actor.id });
    await record(c, actor, { action: 'caja_create', entity: 'cajas', id: row.id, version: row.version, event: 'create', detail: `Alta de caja ${v.name} en ${linea.name}` });
    return row;
  });
}

export async function updateCaja(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'cajas', id, { lock: true }), version, 'No se encontró la caja.');
    if (cur.archivedAt) throw rule('La caja está archivada.', 'archived', 409);
    const set = cleanCaja(input, { partial: true });
    if (set.name && set.name.toLowerCase() !== cur.name.toLowerCase()) await assertNameFree(c, 'cajas', set.name, id, CAJA_DUP);
    if (input.lineaId !== undefined) set.lineaId = (await checkLinea(c, input.lineaId)).id;
    if (input.referenteTechId !== undefined) set.referenteTechId = await checkReferente(c, input.referenteTechId);
    const diff = changed(set, cur);
    if (!Object.keys(diff).length) return cur;
    const row = await repo.updateRow(c, 'cajas', id, diff);
    await record(c, actor, { action: 'caja_edit', entity: 'cajas', id, version: row.version, detail: `Edición de caja ${row.name}` });
    return row;
  });
}

// Baja lógica, solo sin herramientas asignadas (el historial de controles y movimientos queda).
export async function archiveCaja(db, actor, id, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'cajas', id, { lock: true }), version, 'No se encontró la caja.');
    if (cur.archivedAt) throw rule('La caja ya está archivada.', 'archived', 409);
    if ((await c.query('SELECT 1 FROM assignments WHERE caja_id = $1 AND active LIMIT 1', [id])).rows[0]) throw rule('La caja tiene herramientas asignadas.', 'caja_has_tools', 409);
    const row = await repo.updateRow(c, 'cajas', id, { archivedAt: new Date() });
    await record(c, actor, { action: 'caja_archive', entity: 'cajas', id, version: row.version, event: 'delete', detail: `Baja de caja ${row.name}` });
    return row;
  });
}

// ---------------------------------------------------------------- alta de asignación
// holder: { techId } o { cajaId }. Por cantidad: un movimiento (entrega inicial, o adicional
// si el poseedor ya tiene la herramienta). Por código: un movimiento por unidad. Si una
// falla, no queda ninguna.
export async function createAssignment(db, actor, input, { idempotencyKey, path } = {}) {
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: input }, async (c) => {
    const h = input.holder || {};
    const col = h.cajaId ? 'caja_id' : 'tech_id';
    const hid = h.cajaId || h.techId;
    const tool = (await c.query('SELECT id, serialized FROM tools WHERE id = $1', [input.toolId])).rows[0];
    if (!tool) throw rule('Elegí una herramienta activa.');
    let list;
    if (tool.serialized) {
      if (!input.unitIds || !input.unitIds.length) throw rule('Elegí al menos una unidad.');
      if (new Set(input.unitIds).size !== input.unitIds.length) throw rule('Hay unidades repetidas.');
      list = input.unitIds.map((unitId) => ({ unitId }));
    } else {
      if (input.unitIds) throw rule('Esta herramienta es por cantidad: indicá la cantidad.');
      list = [{ qty: input.qty }];
    }
    const movements = [];
    const assignments = [];
    for (const x of list) {
      const has = (await c.query(`SELECT 1 FROM assignments WHERE ${col} = $1 AND tool_id = $2 AND active LIMIT 1`, [hid, tool.id])).rows[0];
      const m = { type: has ? 'adicional' : 'entrega_inicial', ...(h.cajaId ? { cajaId: h.cajaId } : { techId: h.techId }), toolId: tool.id, ...x, reason: input.reason ?? '' };
      const plan = await applyMovement(c, actor, m);
      movements.push({ ...plan.movement, transfers: plan.transfers });
      assignments.push(...plan.newAssignments.map((a) => a.id));
    }
    return { status: 201, body: { movements, assignments } };
  });
}
