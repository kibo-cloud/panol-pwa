// Especialidades del técnico y kits (etapa 3).
// - Especialidades: catálogo configurable (techs_edit), baja lógica.
// - Kits (kits_edit): el kit base y un kit opcional por especialidad, cada uno una lista
//   ordenada de herramientas con cantidad; se guarda la lista completa con If-Match.
// - Entregar kit (movements_do, Idempotency-Key): un movimiento por herramienta en una sola
//   transacción, todo o nada. Bloqueos: kit, poseedor (técnico o caja) y después las
//   herramientas por id, como el resto de los movimientos (plantilla -> técnico -> herramienta).
import * as repo from '../adapters/pg/catalog-repo.js';
import { loadInventoryContext, applyMovementPlan } from '../adapters/pg/inventory-repo.js';
import { loadKits } from '../adapters/pg/kits-repo.js';
import { lockActiveEspecialidad } from './catalog.js';

export { loadKits };
import { DomainError, notFoundError } from '../domain/errors.js';
import { cleanName } from '../domain/catalog.js';
import { cleanKitName, cleanKitItems, planKitDelivery } from '../domain/kits.js';
import { newId } from './ids.js';
import { withTransaction, checkVersion, record, notifyChange, onUnique } from './common.js';
import * as records from './records.js';
import { idempotent } from './idempotency.js';

const rule = (msg, code = 'invalid_input', status = 422) => new DomainError(msg, code, status);
const changed = (set, cur) => Object.fromEntries(Object.entries(set).filter(([k, v]) => v !== undefined && v !== cur[k]));

// ---------------------------------------------------------------- especialidades
const ESP_DUP = 'Ya existe una especialidad con ese nombre.';
async function assertEspFree(c, name, exceptId) {
  await repo.lockName(c, 'especialidades.name');
  const { rows } = await c.query('SELECT 1 FROM especialidades WHERE lower(name) = lower($1) AND archived_at IS NULL AND id IS DISTINCT FROM $2 LIMIT 1', [name, exceptId]);
  if (rows[0]) throw rule(ESP_DUP, 'duplicate', 409);
}

export async function createEspecialidad(db, actor, input) {
  const name = cleanName(input.name);
  return withTransaction(db, async (c) => {
    await assertEspFree(c, name, null);
    const order = input.order ?? (await c.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM especialidades')).rows[0].n;
    const row = await repo.insertRow(c, 'especialidades', newId('esp'), { name, order, by: actor.id }).catch(onUnique(ESP_DUP));
    await record(c, actor, { action: 'especialidad_create', entity: 'especialidades', id: row.id, version: row.version, event: 'create', detail: `Alta de especialidad ${name}` });
    return row;
  });
}

export async function updateEspecialidad(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'especialidades', id, { lock: true }), version, 'No se encontró la especialidad.');
    if (cur.archivedAt) throw rule('La especialidad está archivada.', 'archived', 409);
    const set = { order: input.order };
    if (input.name !== undefined) {
      set.name = cleanName(input.name);
      if (set.name.toLowerCase() !== cur.name.toLowerCase()) await assertEspFree(c, set.name, id);
    }
    const diff = changed(set, cur);
    if (!Object.keys(diff).length) return cur;
    const row = await repo.updateRow(c, 'especialidades', id, diff).catch(onUnique(ESP_DUP));
    await record(c, actor, { action: 'especialidad_edit', entity: 'especialidades', id, version: row.version, detail: diff.name ? `Especialidad renombrada: ${cur.name} a ${row.name}` : `Edición de especialidad ${row.name}` });
    return row;
  });
}

// Baja lógica (etapa 5: records.js, con motivo), solo si ningún técnico activo la tiene y no tiene
// un kit activo (el historial queda). Se bloquea FOR UPDATE antes de contar: espera a quien la
// está asignando (FOR SHARE).
export const archiveEspecialidad = (db, actor, id, version, reason = 'Especialidad archivada') => records.archiveRecord(db, actor, 'especialidades', id, { reason }, version).then((r) => r.record);

// ---------------------------------------------------------------- kits
const kitOr404 = (k) => {
  if (!k) throw notFoundError('No se encontró el kit.');
  return k;
};

export async function createKit(db, actor, input) {
  return withTransaction(db, async (c) => {
    // FOR SHARE: no se crea un kit para una especialidad que se está archivando.
    const esp = await lockActiveEspecialidad(c, input.especialidadId);
    if (!esp) throw rule('Elegí una especialidad activa.', 'invalid_especialidad');
    if ((await c.query('SELECT 1 FROM kits WHERE especialidad_id = $1 AND archived_at IS NULL', [esp.id])).rows[0]) throw rule(`Ya hay un kit para ${esp.name}.`, 'duplicate', 409);
    const name = input.name !== undefined ? cleanKitName(input.name) : `Kit ${esp.name}`;
    const row = await repo.insertRow(c, 'kits', newId('kit'), { name, especialidadId: esp.id, by: actor.id }).catch(onUnique(`Ya hay un kit para ${esp.name}.`));
    await record(c, actor, { action: 'kit_create', entity: 'kits', id: row.id, version: row.version, event: 'create', detail: `Alta del kit ${name} (${esp.name})` });
    return { ...row, items: [] };
  });
}

// Guarda el nombre y/o la lista completa de herramientas (el orden es el de la lista).
export async function updateKit(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion((await loadKits(c, { id, lock: 'UPDATE' }))[0], version, 'No se encontró el kit.');
    if (cur.archivedAt) throw rule('El kit está eliminado. Restauralo desde Administración › Registros eliminados.', 'archived', 409);
    const name = input.name !== undefined ? cleanKitName(input.name) : cur.name;
    let items = cur.items;
    if (input.items !== undefined) {
      const ids = input.items.map((it) => it.toolId);
      const tools = Object.fromEntries((await c.query('SELECT id, name FROM tools WHERE id = ANY($1)', [ids])).rows.map((t) => [t.id, t]));
      items = cleanKitItems(input.items, tools);
    }
    const same = name === cur.name && JSON.stringify(items) === JSON.stringify(cur.items);
    if (same) return cur;
    await c.query('DELETE FROM kit_items WHERE kit_id = $1', [id]);
    for (const [i, it] of items.entries()) await c.query('INSERT INTO kit_items (kit_id, tool_id, qty, sort_order) VALUES ($1,$2,$3,$4)', [id, it.toolId, it.qty, i + 1]);
    // El UPDATE sube la versión del kit (trigger) aunque solo cambien los ítems.
    const row = await repo.updateRow(c, 'kits', id, { name });
    const n = items.reduce((a, it) => a + it.qty, 0);
    await record(c, actor, { action: 'kit_edit', entity: 'kits', id, version: row.version, detail: `Edición del kit ${name}: ${items.length} ${items.length === 1 ? 'herramienta' : 'herramientas'} (${n} en total)` });
    return { ...row, items };
  });
}

// Eliminar un kit: records.js (etapa 5; el kit base no se elimina).

// input: { holder: { techId } | { cajaId }, unitIds?: { toolId: [unitId] }, reason? }.
// `version` (If-Match, opcional): la versión del kit que vio quien confirma la entrega.
export async function deliverKit(db, actor, kitId, input, { idempotencyKey, path, version = null } = {}) {
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: { kitId, version, ...input } }, async (c) => {
    const kit = kitOr404((await loadKits(c, { id: kitId, lock: 'SHARE' }))[0]);
    if (kit.archivedAt) throw rule('El kit está eliminado.', 'archived', 409);
    if (version != null && kit.version !== version) throw new DomainError('El kit cambió mientras preparabas la entrega. Revisá la lista y confirmá de nuevo.', 'conflict', 409);
    const h = input.holder || {};
    const holderName = h.cajaId
      ? (await c.query('SELECT name FROM cajas WHERE id = $1 FOR SHARE', [h.cajaId])).rows[0]?.name
      : (await c.query('SELECT name FROM techs WHERE id = $1 FOR SHARE', [h.techId])).rows[0]?.name;
    const toolIds = kit.items.map((it) => it.toolId).sort();
    if (toolIds.length) await c.query('SELECT id FROM tools WHERE id = ANY($1) ORDER BY id FOR UPDATE', [toolIds]);
    const ctx = await loadInventoryContext(c);
    const at = new Date().toISOString();
    const { plans, problems } = planKitDelivery(ctx, { items: kit.items, holder: h, unitIds: input.unitIds, kitName: kit.name, reason: input.reason }, { at, newId });
    if (problems.length) {
      const err = new DomainError(`No se entregó nada. ${problems.map((p) => p.message).join(' ')}`, 'kit_stock', 422);
      err.extra = { problems };
      throw err;
    }
    for (const plan of plans) {
      await applyMovementPlan(c, plan, { actorId: actor.id, auditId: newId('l'), ip: actor.ip }).catch(onUnique('Ya existe un registro igual. Recargá para ver los cambios.', 'duplicate'));
      await notifyChange(c, { entity: 'movements', id: plan.movement.id, action: 'create' });
    }
    await record(c, actor, {
      action: 'kit_deliver', entity: 'kits', id: kit.id, version: kit.version, event: 'update',
      detail: `Entrega del kit ${kit.name} a ${holderName || 'poseedor'}: ${kit.items.length} ${kit.items.length === 1 ? 'herramienta' : 'herramientas'}, ${plans.length} ${plans.length === 1 ? 'movimiento' : 'movimientos'}`,
    });
    return {
      status: 201,
      body: {
        kit: { id: kit.id, version: kit.version },
        movements: plans.map((p) => ({ ...p.movement, transfers: p.transfers })),
        assignments: plans.flatMap((p) => p.newAssignments.map((a) => a.id)),
      },
    };
  });
}
