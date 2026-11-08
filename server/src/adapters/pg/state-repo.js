// Lectura del estado completo con la forma de `S` de 2.1 (colecciones por id), en una sola
// instantánea (REPEATABLE READ) para que todas las colecciones sean coherentes entre sí.
import { listRows, toApi } from './catalog-repo.js';
import { loadControls } from './inventory-repo.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const byId = (list) => Object.fromEntries(list.map(({ id, ...x }) => [id, x]));

const MOVEMENT = (r) => ({
  id: r.id, type: r.type, techId: r.tech_id, toolId: r.tool_id, qty: r.qty, unitId: r.unit_id, newAssignmentId: r.new_assignment_id,
  oldAssignmentId: r.old_assignment_id, oldUnitId: r.old_unit_id, newUnitId: r.new_unit_id, oldState: r.old_state, returned: r.returned,
  oldDest: r.old_dest, condition: r.condition, linkedControlId: r.linked_control_id, resolvesMovementId: r.resolves_movement_id,
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

export async function readState(q) {
  const shifts = (await listRows(q, 'shifts', 'ORDER BY sort_order, id')).map(({ createdAt, updatedAt, by, ...s }) => s);
  const techs = await listRows(q, 'techs', 'ORDER BY id');
  const shiftChanges = await listRows(q, 'shiftChanges', 'ORDER BY at, id');
  const categories = await listRows(q, 'categories', 'ORDER BY id');
  const tools = await listRows(q, 'tools', 'ORDER BY id');
  const units = await listRows(q, 'units', 'ORDER BY id');
  const assignments = await listRows(q, 'assignments', 'ORDER BY id');
  const controls = await loadControls(q);
  const movements = await loadMovementsFull(q);
  const alertRes = await listRows(q, 'alertRes', 'ORDER BY at');
  const users = (await q.query('SELECT id, name, role, active FROM users ORDER BY id')).rows;
  return {
    shifts,
    techs: byId(techs),
    shiftChanges: byId(shiftChanges),
    categories: byId(categories),
    tools: byId(tools),
    units: byId(units),
    assignments: byId(assignments),
    controls: byId(controls),
    movements: byId(movements),
    alertRes: byId(alertRes),
    users: byId(users),
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
