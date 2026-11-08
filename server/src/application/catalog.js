// Técnicos, cambios de turno, turnos, categorías, herramientas y unidades (equivalente a las
// acciones techNew/techEdit/techActive/shiftChange/shift*/cat*/tool* de 2.1).
// Desde la etapa 2 los turnos son plantillas: las rutas de turnos y el cambio de turno de 2.1
// siguen funcionando y delegan en las plantillas (application/plantillas.js).
import * as repo from '../adapters/pg/catalog-repo.js';
import { loadInventoryContext, applyMovementPlan } from '../adapters/pg/inventory-repo.js';
import { DomainError } from '../domain/errors.js';
import { cleanTech, cleanName, cleanCode, cleanDay, cleanText, legajoTaken } from '../domain/catalog.js';
import { planMovement } from '../domain/movements.js';
import { localDateISO } from '../domain/period.js';
import { newId } from './ids.js';
import { withTransaction, checkVersion, onUnique, record, notifyChange } from './common.js';
import * as plantillas from './plantillas.js';
import { insertRange } from '../adapters/pg/plantilla-repo.js';

const rule = (msg, code = 'invalid_input', status = 422) => new DomainError(msg, code, status);
const changed = (set, cur) => Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== undefined && v !== cur[k]));

async function plantillaNameOf(c, id) {
  const s = id ? await repo.getRow(c, 'plantillas', id) : null;
  return s ? s.name : 'Sin plantilla';
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
    // Plantilla pedida (`plantillaId`, o `shiftId` de 2.1) o la primera activa.
    let pid = input.plantillaId || input.shiftId || null;
    if (pid) {
      const p = await repo.getRow(c, 'plantillas', pid);
      if (!p || p.archivedAt) throw rule('Elegí una plantilla válida.', 'invalid_plantilla');
    } else pid = (await c.query('SELECT id FROM plantillas WHERE archived_at IS NULL ORDER BY sort_order, id LIMIT 1')).rows[0]?.id ?? null;
    const row = await repo.insertRow(c, 'techs', newId('t'), { name, legajo, active: true, alta, by: actor.id }).catch(legajoUnique(legajo));
    // Primer rango de pertenencia: desde siempre (la plantilla vale para todos sus controles).
    if (pid) await insertRange(c, { id: newId('ph'), techId: row.id, plantillaId: pid, validFrom: null, validTo: null, reason: 'Alta del técnico' }, { actorId: actor.id });
    await record(c, actor, { action: 'tech_create', entity: 'techs', id: row.id, version: row.version, event: 'create', detail: `Alta de técnico ${name} (legajo ${legajo}) en ${await plantillaNameOf(c, pid)}` });
    return plantillas.withMembership(c, row);
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
    if (!Object.keys(diff).length) return plantillas.withMembership(c, cur);
    const row = await repo.updateRow(c, 'techs', id, diff).catch(legajoUnique(set.legajo));
    if (diff.name !== undefined || diff.legajo !== undefined || diff.alta !== undefined) {
      await record(c, actor, { action: 'tech_edit', entity: 'techs', id, version: row.version, detail: `Edición de técnico ${row.name} (legajo ${row.legajo})` });
    }
    if (diff.active !== undefined) {
      await record(c, actor, { action: row.active ? 'tech_activate' : 'tech_deactivate', entity: 'techs', id, version: row.version, detail: `${row.active ? 'Reactivación' : 'Desactivación'} de técnico ${row.name}` });
    }
    return plantillas.withMembership(c, row);
  });
}

// Cambio de turno de 2.1 = mover de plantilla desde la fecha indicada (hoy si falta). La
// respuesta conserva la forma de 2.1 (`shiftChange`) y agrega el rango nuevo.
export async function changeShift(db, actor, techId, input, version) {
  return withTransaction(db, async (c) => {
    // applyMove bloquea la plantilla destino y después el técnico, y controla la versión.
    const r = await plantillas.applyMove(c, actor, techId, {
      plantillaId: input.to, from: cleanDay(input.effectiveFrom, 'La fecha desde') || localDateISO(), reason: cleanText(input.note, 'La nota') || 'Cambio de turno',
    }, { version });
    const range = r.ranges[0];
    const shiftChange = { id: range.id, techId, from: r.fromPlantillaId, to: r.toPlantillaId, fromName: r.fromName, toName: r.toName, effectiveFrom: range.validFrom, note: range.reason, at: range.createdAt, by: range.by };
    return { tech: r.tech, shiftChange, range };
  });
}

// ---------------------------------------------------------------- turnos (= plantillas)
async function assertUniqueName(c, name, table, exceptId, message) {
  const { rows } = await c.query(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1`, [name, exceptId]);
  if (rows[0]) throw rule(message, 'duplicate', 409);
}

// Forma de un turno de 2.1 (id, nombre, orden, versión) a partir de una plantilla.
const asShift = (p) => ({ id: p.id, name: p.name, order: p.order, version: p.version, createdAt: p.createdAt, updatedAt: p.updatedAt, by: p.by });

export const createShift = async (db, actor, input) => asShift(await plantillas.createPlantilla(db, actor, { name: cleanName(input.name) }));
export const updateShift = async (db, actor, id, input, version) => asShift(await plantillas.updatePlantilla(db, actor, id, input, version));
export async function deleteShift(db, actor, id, version) {
  await plantillas.archivePlantilla(db, actor, id, version);
  return { ok: true };
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
