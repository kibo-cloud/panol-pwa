// Técnicos, cambios de turno, turnos, categorías, herramientas y unidades (equivalente a las
// acciones techNew/techEdit/techActive/shiftChange/shift*/cat*/tool* de 2.1).
import * as repo from '../adapters/pg/catalog-repo.js';
import { loadInventoryContext, applyMovementPlan } from '../adapters/pg/inventory-repo.js';
import { DomainError } from '../domain/errors.js';
import { cleanTech, cleanName, cleanCode, cleanDay, cleanText, legajoTaken } from '../domain/catalog.js';
import { planMovement } from '../domain/movements.js';
import { localDateISO } from '../domain/period.js';
import { newId } from './ids.js';
import { withTransaction, checkVersion, onUnique, record, notifyChange } from './common.js';

const rule = (msg, code = 'invalid_input', status = 422) => new DomainError(msg, code, status);
const changed = (set, cur) => Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== undefined && v !== cur[k]));

async function shiftNameOf(c, id) {
  const s = id ? await repo.getRow(c, 'shifts', id) : null;
  return s ? s.name : 'Sin turno';
}

// ---------------------------------------------------------------- técnicos
async function assertLegajoFree(c, legajo, exceptId) {
  const { rows } = await c.query('SELECT id, name FROM techs WHERE lower(btrim(legajo)) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1', [legajo, exceptId]);
  if (rows[0]) throw legajoTaken(legajo, rows[0].name);
}
const legajoUnique = (legajo) => (err) => {
  if (err && err.code === '23505') throw legajoTaken(legajo, 'otro técnico');
  throw err;
};

export async function createTech(db, actor, input) {
  const { name, legajo } = cleanTech(input);
  const alta = cleanDay(input.alta, 'La fecha de alta') || localDateISO();
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'techs.legajo');
    await assertLegajoFree(c, legajo, null);
    let shiftId = input.shiftId || null;
    if (shiftId && !(await repo.getRow(c, 'shifts', shiftId))) throw rule('Elegí un turno válido.', 'invalid_shift');
    if (!shiftId) shiftId = (await c.query('SELECT id FROM shifts ORDER BY sort_order, id LIMIT 1')).rows[0]?.id ?? null;
    const row = await repo.insertRow(c, 'techs', newId('t'), { name, legajo, shiftId, active: true, alta, by: actor.id }).catch(legajoUnique(legajo));
    await record(c, actor, { action: 'tech_create', entity: 'techs', id: row.id, version: row.version, event: 'create', detail: `Alta de técnico ${name} (legajo ${legajo}) en ${await shiftNameOf(c, shiftId)}` });
    return row;
  });
}

export async function updateTech(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'techs', id, { lock: true }), version, 'No se encontró el técnico.');
    const set = {};
    if (input.name !== undefined || input.legajo !== undefined) {
      const v = cleanTech({ name: input.name ?? cur.name, legajo: input.legajo ?? cur.legajo });
      Object.assign(set, v);
      if (v.legajo.toLowerCase() !== String(cur.legajo ?? '').trim().toLowerCase()) {
        await repo.lockName(c, 'techs.legajo');
        await assertLegajoFree(c, v.legajo, id);
      }
    }
    if (input.alta !== undefined) set.alta = cleanDay(input.alta, 'La fecha de alta');
    if (input.active !== undefined) set.active = input.active;
    const diff = changed(set, cur);
    if (!Object.keys(diff).length) return cur;
    const row = await repo.updateRow(c, 'techs', id, diff).catch(legajoUnique(set.legajo));
    if (diff.name !== undefined || diff.legajo !== undefined || diff.alta !== undefined) {
      await record(c, actor, { action: 'tech_edit', entity: 'techs', id, version: row.version, detail: `Edición de técnico ${row.name} (legajo ${row.legajo})` });
    }
    if (diff.active !== undefined) {
      await record(c, actor, { action: row.active ? 'tech_activate' : 'tech_deactivate', entity: 'techs', id, version: row.version, detail: `${row.active ? 'Reactivación' : 'Desactivación'} de técnico ${row.name}` });
    }
    return row;
  });
}

export async function changeShift(db, actor, techId, input, version) {
  return withTransaction(db, async (c) => {
    const t = checkVersion(await repo.getRow(c, 'techs', techId, { lock: true }), version, 'No se encontró el técnico.');
    if (t.active === false) throw rule('El técnico está inactivo.', 'inactive_tech');
    const to = input.to ? await repo.getRow(c, 'shifts', input.to) : null;
    if (!to) throw rule('Elegí el turno nuevo.', 'invalid_shift');
    const fromName = await shiftNameOf(c, t.shiftId);
    const sc = await repo.insertRow(c, 'shiftChanges', newId('s'), {
      techId, from: t.shiftId, to: to.id, fromName, toName: to.name,
      effectiveFrom: cleanDay(input.effectiveFrom, 'La fecha desde') || localDateISO(), note: cleanText(input.note, 'La nota'), at: new Date(), by: actor.id,
    });
    const tech = await repo.updateRow(c, 'techs', techId, { shiftId: to.id });
    await record(c, actor, { action: 'shift_change', entity: 'techs', id: techId, version: tech.version, detail: `Cambio de turno de ${t.name}: ${fromName} a ${to.name}` });
    return { tech, shiftChange: sc };
  });
}

// ---------------------------------------------------------------- turnos
async function assertUniqueName(c, name, table, exceptId, message) {
  const { rows } = await c.query(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1`, [name, exceptId]);
  if (rows[0]) throw rule(message, 'duplicate', 409);
}

export async function createShift(db, actor, input) {
  const name = cleanName(input.name);
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'shifts.name');
    await assertUniqueName(c, name, 'shifts', null, 'Ya existe ese turno.');
    const order = (await c.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM shifts')).rows[0].n;
    const row = await repo.insertRow(c, 'shifts', newId('r'), { name, order, by: actor.id });
    await record(c, actor, { action: 'shift_create', entity: 'shifts', id: row.id, version: row.version, event: 'create', detail: `Alta de turno ${name}` });
    return row;
  });
}

export async function updateShift(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'shifts', id, { lock: true }), version, 'No se encontró el turno.');
    const set = {};
    if (input.name !== undefined) {
      set.name = cleanName(input.name);
      await repo.lockName(c, 'shifts.name');
      await assertUniqueName(c, set.name, 'shifts', id, 'Ya existe ese turno.');
    }
    if (input.order !== undefined) set.order = input.order;
    const diff = changed(set, cur);
    if (!Object.keys(diff).length) return cur;
    const row = await repo.updateRow(c, 'shifts', id, diff);
    const detail = diff.name ? `Turno renombrado: ${cur.name} a ${row.name}` : `Orden del turno ${row.name}: ${row.order}`;
    await record(c, actor, { action: diff.name ? 'shift_rename' : 'shift_reorder', entity: 'shifts', id, version: row.version, detail });
    return row;
  });
}

export async function deleteShift(db, actor, id, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'shifts', id, { lock: true }), version, 'No se encontró el turno.');
    if ((await c.query('SELECT 1 FROM techs WHERE shift_id = $1 LIMIT 1', [id])).rows[0]) throw rule('El turno tiene técnicos.', 'shift_has_techs', 409);
    if ((await c.query('SELECT count(*)::int AS n FROM shifts')).rows[0].n <= 1) throw rule('Tiene que quedar al menos un turno.', 'last_shift', 409);
    await repo.deleteRow(c, 'shifts', id);
    await record(c, actor, { action: 'shift_delete', entity: 'shifts', id, event: 'delete', detail: `Baja de turno ${cur.name}` });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- categorías
export async function createCategory(db, actor, input) {
  const name = cleanName(input.name);
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'categories.name');
    await assertUniqueName(c, name, 'categories', null, 'Ya existe esa categoría.');
    const row = await repo.insertRow(c, 'categories', newId('g'), { name, by: actor.id });
    await record(c, actor, { action: 'category_create', entity: 'categories', id: row.id, version: row.version, event: 'create', detail: `Alta de categoría ${name}` });
    return row;
  });
}

export async function updateCategory(db, actor, id, input, version) {
  const name = cleanName(input.name);
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'categories', id, { lock: true }), version, 'No se encontró la categoría.');
    if (name === cur.name) return cur;
    await repo.lockName(c, 'categories.name');
    await assertUniqueName(c, name, 'categories', id, 'Ya existe esa categoría.');
    const row = await repo.updateRow(c, 'categories', id, { name });
    await record(c, actor, { action: 'category_edit', entity: 'categories', id, version: row.version, detail: `Categoría renombrada: ${cur.name} a ${name}` });
    return row;
  });
}

export async function deleteCategory(db, actor, id, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'categories', id, { lock: true }), version, 'No se encontró la categoría.');
    if ((await c.query('SELECT 1 FROM tools WHERE category_id = $1 LIMIT 1', [id])).rows[0]) throw rule('La categoría tiene herramientas.', 'category_has_tools', 409);
    await repo.deleteRow(c, 'categories', id);
    await record(c, actor, { action: 'category_delete', entity: 'categories', id, event: 'delete', detail: `Baja de categoría ${cur.name}` });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- herramientas
async function checkCategory(c, categoryId) {
  if (!categoryId) return null;
  if (!(await repo.getRow(c, 'categories', categoryId))) throw rule('Elegí una categoría válida.', 'invalid_category');
  return categoryId;
}

// Alta con stock inicial (por cantidad) o códigos iniciales (por código), como en 2.1.
export async function createTool(db, actor, input) {
  const name = cleanName(input.name, 'Ingresá el nombre.');
  const description = cleanText(input.description, 'La descripción');
  const serialized = !!input.serialized;
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'tools.name');
    await assertUniqueName(c, name, 'tools', null, 'Ya existe una herramienta con ese nombre.');
    const categoryId = await checkCategory(c, input.categoryId);
    const tool = await repo.insertRow(c, 'tools', newId('h'), { name, description, categoryId, serialized, active: true, by: actor.id });
    await record(c, actor, { action: 'tool_create', entity: 'tools', id: tool.id, version: tool.version, event: 'create', detail: `Alta de herramienta ${name}` });
    const codes = serialized ? String(input.codes ?? '').trim() : '';
    const stock = serialized ? 0 : input.stock || 0;
    if (codes || stock > 0) {
      await repo.lockName(c, 'units.code');
      await c.query('SELECT id FROM tools WHERE id = $1 FOR UPDATE', [tool.id]);
      const ctx = await loadInventoryContext(c);
      const m = codes ? { type: 'ingreso', toolId: tool.id, codes, notes: 'Carga inicial' } : { type: 'ingreso', toolId: tool.id, qty: stock, notes: 'Stock inicial' };
      const plan = planMovement(ctx, m, { at: new Date().toISOString(), newId });
      await applyMovementPlan(c, plan, { actorId: actor.id, auditId: newId('l'), ip: actor.ip }).catch(onUnique('Uno de los códigos ya existe.', 'code_taken'));
      // applyMovementPlan ya deja la auditoría del ingreso.
      await notifyChange(c, { entity: 'movements', id: plan.movement.id, action: 'create' });
    }
    return tool;
  });
}

export async function updateTool(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'tools', id, { lock: true }), version, 'No se encontró la herramienta.');
    const set = {};
    if (input.name !== undefined) {
      set.name = cleanName(input.name, 'Ingresá el nombre.');
      await repo.lockName(c, 'tools.name');
      await assertUniqueName(c, set.name, 'tools', id, 'Ya existe una herramienta con ese nombre.');
    }
    if (input.description !== undefined) set.description = cleanText(input.description, 'La descripción');
    if (input.categoryId !== undefined) set.categoryId = await checkCategory(c, input.categoryId);
    if (input.active !== undefined) set.active = input.active;
    if (input.serialized !== undefined && input.serialized !== cur.serialized) {
      const hasMov = (await c.query('SELECT 1 FROM movements WHERE tool_id = $1 LIMIT 1', [id])).rows[0];
      if (hasMov) throw rule('No se puede cambiar el seguimiento porque ya tiene movimientos.', 'tool_has_movements', 409);
      set.serialized = input.serialized;
    }
    const diff = changed(set, cur);
    if (!Object.keys(diff).length) return cur;
    const row = await repo.updateRow(c, 'tools', id, diff);
    const { active, ...rest } = diff;
    if (Object.keys(rest).length) await record(c, actor, { action: 'tool_edit', entity: 'tools', id, version: row.version, detail: `Edición de herramienta ${row.name}` });
    if (active !== undefined) await record(c, actor, { action: 'tool_toggle', entity: 'tools', id, version: row.version, detail: `${active ? 'Activación' : 'Desactivación'} de herramienta ${row.name}` });
    return row;
  });
}

// ---------------------------------------------------------------- unidades
// Las unidades se crean con un ingreso y cambian de estado con movimientos; acá solo se
// corrige el código (único sin distinguir mayúsculas).
export async function updateUnit(db, actor, id, input, version) {
  const code = cleanCode(input.code);
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'units', id, { lock: true }), version, 'No se encontró la unidad.');
    if (code === cur.code) return cur;
    await repo.lockName(c, 'units.code');
    const dup = (await c.query('SELECT 1 FROM units WHERE lower(code) = lower($1) AND id <> $2 LIMIT 1', [code, id])).rows[0];
    if (dup) throw rule(`El código ${code} ya existe.`, 'code_taken', 409);
    const row = await repo.updateRow(c, 'units', id, { code }).catch(onUnique(`El código ${code} ya existe.`, 'code_taken'));
    await record(c, actor, { action: 'unit_edit', entity: 'units', id, version: row.version, detail: `Código de unidad: ${cur.code} a ${code}` });
    return row;
  });
}
