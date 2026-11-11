// Lectura del estado completo con la forma de `S` de 2.1 (colecciones por id), en una sola
// instantánea (REPEATABLE READ) para que todas las colecciones sean coherentes entre sí.
import { listRows, toApi } from './catalog-repo.js';
import { loadControls } from './inventory-repo.js';
import { loadHistory, groupByTech, currentMembership, loadRotations, loadSupervisorHistory, loadShiftLabels } from './plantilla-repo.js';
import { shiftChangesFromHistory } from '../../domain/plantillas.js';
import { loadKits, loadOrderVersions } from './kits-repo.js';
import { loadPurchaseSummary } from './compras-repo.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const byId = (list) => Object.fromEntries(list.map(({ id, ...x }) => [id, x]));

const MOVEMENT = (r) => ({
  id: r.id, type: r.type, techId: r.tech_id, cajaId: r.caja_id, toolId: r.tool_id, qty: r.qty, unitId: r.unit_id, newAssignmentId: r.new_assignment_id,
  oldAssignmentId: r.old_assignment_id, oldUnitId: r.old_unit_id, newUnitId: r.new_unit_id, oldState: r.old_state, returned: r.returned,
  oldDest: r.old_dest, condition: r.condition, linkedControlId: r.linked_control_id, resolvesMovementId: r.resolves_movement_id, voidsMovementId: r.voids_movement_id,
  reason: r.reason || '', notes: r.notes || '', at: iso(r.at), by: r.created_by, demo: r.demo, transfers: [],
});

export async function loadMovementsFull(q) {
  const { rows } = await q.query('SELECT * FROM movements ORDER BY at, id');
  const movs = rows.map(MOVEMENT);
  const idx = Object.fromEntries(movs.map((m) => [m.id, m]));
  const tr = await q.query('SELECT * FROM movement_transfers ORDER BY movement_id, seq');
  for (const t of tr.rows) idx[t.movement_id]?.transfers.push({ toolId: t.tool_id, qty: t.qty, from: t.from_pool, to: t.to_pool, unitId: t.unit_id });
  return movs;
}

// Plantillas, pertenencia y cambios de plantilla. `shifts` (plantillas activas con la forma de
// los turnos de 2.1), `techs[].shiftId` (plantilla actual) y `shiftChanges` (derivados del
// historial) se mantienen por compatibilidad con 2.1.
export async function readPlantillas(q) {
  const plantillas = await listRows(q, 'plantillas', 'ORDER BY sort_order, id');
  const techs = await listRows(q, 'techs', 'ORDER BY id');
  const membership = await currentMembership(q);
  for (const t of techs) {
    t.plantillaId = membership[t.id] ?? null;
    t.shiftId = t.plantillaId;
  }
  const techIds = new Set(techs.map((t) => t.id));
  const history = (await loadHistory(q)).filter((r) => techIds.has(r.techId));
  const names = Object.fromEntries(plantillas.map((p) => [p.id, p.name]));
  return {
    plantillas,
    shifts: plantillas.filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name, order: p.order, version: p.version })),
    techs,
    history,
    shiftChanges: shiftChangesFromHistory(groupByTech(history), names),
  };
}

export async function readState(q) {
  const P = await readPlantillas(q);
  const { shifts, techs, shiftChanges } = P;
  const lineas = await listRows(q, 'lineas', 'ORDER BY sort_order, id');
  const cajas = await listRows(q, 'cajas', 'ORDER BY id');
  const categories = await listRows(q, 'categories', 'ORDER BY sort_order, name, id');
  const tools = await listRows(q, 'tools', 'ORDER BY category_id, sort_order, name, id');
  const especialidades = await listRows(q, 'especialidades', 'ORDER BY sort_order, name, id');
  const kits = await loadKits(q);
  const units = await listRows(q, 'units', 'ORDER BY id');
  const assignments = await listRows(q, 'assignments', 'ORDER BY id');
  const controls = await loadControls(q);
  const movements = await loadMovementsFull(q);
  const alertRes = await listRows(q, 'alertRes', 'ORDER BY at');
  // Los usuarios eliminados quedan para resolver nombres en el historial (con `archived`).
  const users = (await q.query('SELECT id, name, role, active, archived_at IS NOT NULL AS archived FROM users ORDER BY id')).rows;
  return {
    shifts,
    techs: byId(techs),
    shiftChanges,
    plantillas: byId(P.plantillas),
    plantillaHistory: groupByTech(P.history),
    plantillaRotations: await loadRotations(q),
    plantillaSupervisors: await loadSupervisorHistory(q),
    shiftLabels: (await loadShiftLabels(q)).labels,
    lineas: byId(lineas),
    cajas: byId(cajas),
    categories: byId(categories),
    especialidades: byId(especialidades),
    kits: byId(kits),
    orderVersions: await loadOrderVersions(q),
    tools: byId(tools),
    units: byId(units),
    assignments: byId(assignments),
    controls: byId(controls),
    movements: byId(movements),
    alertRes: byId(alertRes),
    users: byId(users),
    // Etapa 7: estado de las compras abiertas, rechazadas sin resolver y recibidas sin reposición
    // (sin costos): fichas, alertas y la reposición vinculada.
    purchases: await loadPurchaseSummary(q),
  };
}

// Ejecuta fn con un cliente en una transacción de solo lectura con instantánea fija.
export async function withSnapshot(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export { toApi };
