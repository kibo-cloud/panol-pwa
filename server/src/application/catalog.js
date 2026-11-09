// Técnicos, cambios de turno, turnos, categorías, herramientas y unidades (equivalente a las
// acciones techNew/techEdit/techActive/shiftChange/shift*/cat*/tool* de 2.1).
// Desde la etapa 2 los turnos son plantillas: las rutas de turnos y el cambio de turno de 2.1
// siguen funcionando y delegan en las plantillas (application/plantillas.js).
import * as repo from '../adapters/pg/catalog-repo.js';
import { loadInventoryContext, applyMovementPlan } from '../adapters/pg/inventory-repo.js';
import { DomainError, ConflictError } from '../domain/errors.js';
import { cleanTech, cleanName, cleanCode, cleanDay, cleanText, legajoTaken } from '../domain/catalog.js';
import { planMovement } from '../domain/movements.js';
import { localDateISO } from '../domain/period.js';
import { newId } from './ids.js';
import { withTransaction, checkVersion, onUnique, record, notifyChange } from './common.js';
import * as plantillas from './plantillas.js';
import { insertRange } from '../adapters/pg/plantilla-repo.js';
import { CATEGORY_SCOPE, toolScope, insertAt } from '../domain/orden.js';
import { lockScope, lockScopes, bumpScope, toolIdsOf, writeOrder } from './orden.js';

const rule = (msg, code = 'invalid_input', status = 422) => new DomainError(msg, code, status);
const changed = (set, cur) => Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== undefined && v !== cur[k]));

async function plantillaNameOf(c, id) {
  const s = id ? await repo.getRow(c, 'plantillas', id) : null;
  return s ? s.name : 'Sin plantilla';
}

// ---------------------------------------------------------------- técnicos
// Especialidad (etapa 3): opcional; al cambiarla tiene que estar activa. Se lee FOR SHARE: si
// alguien la está archivando (FOR UPDATE) se espera y se ve el resultado; y archivarla espera a
// esta transacción antes de contar sus técnicos.
export async function lockActiveEspecialidad(c, id) {
  const e = (await c.query('SELECT id, name, archived_at FROM especialidades WHERE id = $1 FOR SHARE', [id])).rows[0];
  return e && !e.archived_at ? { id: e.id, name: e.name } : null;
}
async function checkEspecialidad(c, id) {
  if (id == null || id === '') return null;
  const e = await lockActiveEspecialidad(c, id);
  if (!e) throw rule('Elegí una especialidad válida.', 'invalid_especialidad');
  return e.id;
}
// El legajo sigue siendo único también entre los técnicos eliminados (etapa 5): volver a dar de
// alta a la misma persona es restaurarla desde Registros eliminados.
async function assertLegajoFree(c, legajo, exceptId) {
  const { rows } = await c.query('SELECT id, name, archived_at FROM techs WHERE lower(btrim(legajo)) = lower($1) AND id IS DISTINCT FROM $2 LIMIT 1', [legajo, exceptId]);
  if (rows[0]) throw legajoTaken(legajo, rows[0].archived_at ? `${rows[0].name} (eliminado; restauralo desde Administración › Registros eliminados)` : rows[0].name);
}
const ARCHIVED_MSG = (what) => `${what} está eliminado. Restauralo desde Administración › Registros eliminados.`;
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
    const especialidadId = await checkEspecialidad(c, input.especialidadId);
    const row = await repo.insertRow(c, 'techs', newId('t'), { name, legajo, active: true, alta, especialidadId, by: actor.id }).catch(legajoUnique(legajo));
    // Primer rango de pertenencia: desde siempre (la plantilla vale para todos sus controles).
    if (pid) await insertRange(c, { id: newId('ph'), techId: row.id, plantillaId: pid, validFrom: null, validTo: null, reason: 'Alta del técnico' }, { actorId: actor.id });
    await record(c, actor, { action: 'tech_create', entity: 'techs', id: row.id, version: row.version, event: 'create', detail: `Alta de técnico ${name} (legajo ${legajo}) en ${await plantillaNameOf(c, pid)}` });
    return plantillas.withMembership(c, row);
  });
}

export async function updateTech(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'techs', id, { lock: true }), version, 'No se encontró el técnico.');
    if (cur.archivedAt) throw rule(ARCHIVED_MSG('El técnico'), 'archived', 409);
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
    if (input.especialidadId !== undefined && (input.especialidadId || null) !== (cur.especialidadId ?? null)) set.especialidadId = await checkEspecialidad(c, input.especialidadId);
    const diff = changed(set, cur);
    if (!Object.keys(diff).length) return plantillas.withMembership(c, cur);
    const row = await repo.updateRow(c, 'techs', id, diff).catch(legajoUnique(set.legajo));
    if (diff.name !== undefined || diff.legajo !== undefined || diff.alta !== undefined || diff.especialidadId !== undefined) {
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
// Nombre único entre los registros activos (los eliminados pueden repetirlo; al restaurarlos se
// controla de nuevo).
async function assertUniqueName(c, name, table, exceptId, message) {
  const { rows } = await c.query(`SELECT 1 FROM ${table} WHERE lower(name) = lower($1) AND archived_at IS NULL AND id IS DISTINCT FROM $2 LIMIT 1`, [name, exceptId]);
  if (rows[0]) throw rule(message, 'duplicate', 409);
}

// Forma de un turno de 2.1 (id, nombre, orden, versión) a partir de una plantilla.
const asShift = (p) => ({ id: p.id, name: p.name, order: p.order, version: p.version, createdAt: p.createdAt, updatedAt: p.updatedAt, by: p.by });

export const createShift = async (db, actor, input) => asShift(await plantillas.createPlantilla(db, actor, { name: cleanName(input.name) }));
export const updateShift = async (db, actor, id, input, version) => asShift(await plantillas.updatePlantilla(db, actor, id, input, version));
export async function deleteShift(db, actor, id, version) {
  await plantillas.archivePlantilla(db, actor, id, version, 'Turno eliminado');
  return { ok: true };
}

// ---------------------------------------------------------------- categorías
export async function createCategory(db, actor, input) {
  const name = cleanName(input.name);
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'categories.name');
    await assertUniqueName(c, name, 'categories', null, 'Ya existe esa categoría.');
    // Va al final del orden (trigger de la migración 009).
    await lockScope(c, CATEGORY_SCOPE);
    const row = await repo.insertRow(c, 'categories', newId('g'), { name, by: actor.id });
    await bumpScope(c, CATEGORY_SCOPE);
    await record(c, actor, { action: 'category_create', entity: 'categories', id: row.id, version: row.version, event: 'create', detail: `Alta de categoría ${name}` });
    return row;
  });
}

export async function updateCategory(db, actor, id, input, version) {
  const name = cleanName(input.name);
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'categories', id, { lock: true }), version, 'No se encontró la categoría.');
    if (cur.archivedAt) throw rule('La categoría está eliminada. Restaurala desde Administración › Registros eliminados.', 'archived', 409);
    if (name === cur.name) return cur;
    await repo.lockName(c, 'categories.name');
    await assertUniqueName(c, name, 'categories', id, 'Ya existe esa categoría.');
    const row = await repo.updateRow(c, 'categories', id, { name });
    await record(c, actor, { action: 'category_edit', entity: 'categories', id, version: row.version, detail: `Categoría renombrada: ${cur.name} a ${name}` });
    return row;
  });
}

// Eliminar una categoría: records.js (etapa 5: baja lógica, o definitiva sin historial).

// ---------------------------------------------------------------- herramientas
async function checkCategory(c, categoryId) {
  if (!categoryId) return null;
  const cat = (await c.query('SELECT id, archived_at FROM categories WHERE id = $1 FOR SHARE', [categoryId])).rows[0];
  if (!cat || cat.archived_at) throw rule('Elegí una categoría válida.', 'invalid_category');
  return categoryId;
}

// Alta con stock inicial (por cantidad) o códigos iniciales (por código), como en 2.1.
// `position` (desde 1) la inserta en ese lugar de su categoría; sin posición va al final.
export async function createTool(db, actor, input) {
  const name = cleanName(input.name, 'Ingresá el nombre.');
  const description = cleanText(input.description, 'La descripción');
  const serialized = !!input.serialized;
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'tools.name');
    await assertUniqueName(c, name, 'tools', null, 'Ya existe una herramienta con ese nombre.');
    const categoryId = await checkCategory(c, input.categoryId);
    const scope = toolScope(categoryId);
    await lockScope(c, scope);
    const tool0 = await repo.insertRow(c, 'tools', newId('h'), { name, description, categoryId, serialized, active: true, by: actor.id });
    if (input.position != null) await writeOrder(c, 'tools', insertAt(await toolIdsOf(c, categoryId), tool0.id, input.position));
    await bumpScope(c, scope);
    const tool = await repo.getRow(c, 'tools', tool0.id);
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
    // Cambio de categoría: el orden de las dos categorías se bloquea antes que la herramienta
    // (orden global: alcance -> filas, como reordenar y el alta en una posición). Los alcances
    // salen de una lectura sin bloqueo; si después de bloquear la fila la categoría ya no es esa,
    // otra persona la cambió en el medio: 409, sin bloquear nada más ni subir ninguna versión.
    let scopes = [];
    let from;
    if (input.categoryId !== undefined) {
      const before = (await c.query('SELECT category_id FROM tools WHERE id = $1', [id])).rows[0];
      from = before ? before.category_id ?? null : undefined;
      if (before && from !== (input.categoryId || null)) scopes = [...new Set([toolScope(from), toolScope(input.categoryId)])].sort();
      await lockScopes(c, scopes);
    }
    const cur = checkVersion(await repo.getRow(c, 'tools', id, { lock: true }), version, 'No se encontró la herramienta.');
    if (cur.archivedAt) throw rule('La herramienta está eliminada. Restaurala desde Administración › Registros eliminados.', 'archived', 409);
    if (from !== undefined && (cur.categoryId ?? null) !== from) throw new ConflictError(cur);
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
    // Los dos alcances ya están bloqueados (scopes): se suben en el mismo orden.
    if (diff.categoryId !== undefined) for (const sc of scopes) await bumpScope(c, sc);
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
