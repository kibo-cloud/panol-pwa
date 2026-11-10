// Anular un movimiento (etapa 5): registra el contramovimiento en una transacción, después de
// revisar con las filas bloqueadas que la reversión es posible (stock y asignaciones de hoy, y
// ningún movimiento posterior que dependa de este). El original no se toca.
// Bloqueos (orden global): poseedor FOR SHARE -> herramienta FOR UPDATE, como un movimiento.
import { loadPools, applyMovementPlan } from '../adapters/pg/inventory-repo.js';
import { planVoid, voidCheck } from '../domain/voids.js';
import { cleanReason } from '../domain/records.js';
import { notFoundError } from '../domain/errors.js';
import { newId } from './ids.js';
import { withTransaction, notifyChange, onUnique } from './common.js';
import { idempotent } from './idempotency.js';
import { lockName } from '../adapters/pg/catalog-repo.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const byId = (rows, map) => Object.fromEntries(rows.map((r) => [r.id, map(r)]));

// Arma la entrada de planVoid. lock: bloquea el poseedor y la herramienta antes de leer.
async function loadVoidInput(c, id, { lock = false } = {}) {
  const m = (await c.query('SELECT * FROM movements WHERE id = $1', [id])).rows[0];
  if (!m) throw notFoundError('No se encontró el movimiento.');
  if (lock) {
    if (m.caja_id) await c.query('SELECT 1 FROM cajas WHERE id = $1 FOR SHARE', [m.caja_id]);
    else if (m.tech_id) await c.query('SELECT 1 FROM techs WHERE id = $1 FOR SHARE', [m.tech_id]);
    if (m.tool_id) await c.query('SELECT id FROM tools WHERE id = $1 FOR UPDATE', [m.tool_id]);
  }
  const transfers = (await c.query('SELECT tool_id, qty, from_pool, to_pool, unit_id FROM movement_transfers WHERE movement_id = $1 ORDER BY seq', [id])).rows
    .map((t) => ({ toolId: t.tool_id, qty: t.qty, from: t.from_pool, to: t.to_pool, unitId: t.unit_id }));
  const mv = {
    id: m.id, type: m.type, techId: m.tech_id, cajaId: m.caja_id, toolId: m.tool_id, qty: m.qty, unitId: m.unit_id, oldUnitId: m.old_unit_id, newUnitId: m.new_unit_id,
    newAssignmentId: m.new_assignment_id, oldAssignmentId: m.old_assignment_id, condition: m.condition, oldDest: m.old_dest, at: iso(m.at), demo: m.demo, transfers,
  };
  const voidedBy = (await c.query('SELECT id FROM movements WHERE voids_movement_id = $1', [id])).rows[0]?.id ?? null;
  const asgIds = [m.new_assignment_id, m.old_assignment_id].filter(Boolean);
  const unitIds = [...new Set([m.unit_id, m.old_unit_id, m.new_unit_id, ...transfers.map((t) => t.unitId)].filter(Boolean))];
  const asgs = asgIds.length ? (await c.query('SELECT id, active, qty, tech_id, caja_id, tool_id, unit_id, end_movement_id FROM assignments WHERE id = ANY($1)', [asgIds])).rows : [];
  const units = unitIds.length ? (await c.query('SELECT id, code, status, tech_id, caja_id FROM units WHERE id = ANY($1)', [unitIds])).rows : [];
  // Movimientos posteriores (no anulados) que nombran sus asignaciones o unidades, o lo reciben.
  const dependents = (await c.query(
    `SELECT d.id, d.type, d.at FROM movements d
      WHERE d.id <> $1 AND d.type <> 'anulacion' AND (d.at, d.created_at) > ($2::timestamptz, $3::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM movements v WHERE v.voids_movement_id = d.id)
        AND (d.old_assignment_id = ANY($4) OR d.new_assignment_id = ANY($4) OR d.unit_id = ANY($5) OR d.old_unit_id = ANY($5) OR d.new_unit_id = ANY($5) OR d.resolves_movement_id = $1)
      ORDER BY d.at, d.id LIMIT 5`,
    [id, m.at, m.created_at, asgIds, unitIds],
  )).rows.map((d) => ({ id: d.id, type: d.type, at: iso(d.at) }));
  let holder = null;
  if (m.caja_id) {
    const k = (await c.query('SELECT name, archived_at FROM cajas WHERE id = $1', [m.caja_id])).rows[0];
    holder = k ? { name: k.name, active: !k.archived_at } : { name: 'La caja', active: false };
  } else if (m.tech_id) {
    const t = (await c.query('SELECT name, active, archived_at FROM techs WHERE id = $1', [m.tech_id])).rows[0];
    holder = t ? { name: t.name, active: t.active && !t.archived_at } : { name: 'El técnico', active: false };
  }
  const tool = m.tool_id ? (await c.query('SELECT name, active FROM tools WHERE id = $1', [m.tool_id])).rows[0] || null : null;
  const pools = await loadPools(c);
  return {
    mv, voidedBy, dependents, holder, tool, pools,
    assignments: byId(asgs, (a) => ({ active: a.active, qty: a.qty, techId: a.tech_id, cajaId: a.caja_id, toolId: a.tool_id, unitId: a.unit_id, endMovementId: a.end_movement_id })),
    units: byId(units, (u) => ({ code: u.code, status: u.status, techId: u.tech_id, cajaId: u.caja_id })),
  };
}

// Si se puede anular hoy y, si no, el motivo exacto (para la interfaz; no escribe nada).
export async function checkVoid(db, id) {
  return withTransaction(db, async (c) => ({ movementId: id, ...voidCheck(await loadVoidInput(c, id)) }));
}

export async function voidMovement(db, actor, id, input, { idempotencyKey, path } = {}) {
  const reason = cleanReason(input.reason);
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: { id, reason } }, async (c) => {
    // Etapa 6: el mismo bloqueo por nombre que vincular una novedad a este movimiento.
    await lockName(c, `movements.void:${id}`);
    const vi = await loadVoidInput(c, id, { lock: true });
    const plan = planVoid(vi, { at: new Date().toISOString(), newId, reason });
    // Una anulación de un movimiento de demostración también es de demostración (se borran juntas).
    await applyMovementPlan(c, plan, { actorId: actor.id, auditId: newId('l'), ip: actor.ip, demo: !!vi.mv.demo }).catch(onUnique('Este movimiento ya está anulado.', 'already_voided'));
    await notifyChange(c, { entity: 'movements', id: plan.movement.id, action: 'create' });
    return { status: 201, body: { movement: { ...plan.movement, transfers: plan.transfers }, voids: id } };
  });
}
