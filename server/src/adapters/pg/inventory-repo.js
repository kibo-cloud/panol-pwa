// Lectura del estado de inventario y escritura de planes de movimiento y controles.
// `q` es un pool o un cliente dentro de una transacción.
import { emptyPool } from '../../domain/pools.js';
import { effectiveControls, controlHistory } from '../../domain/controls.js';
import { pendingReturns } from '../../domain/alerts.js';
import { pkeyOf, pnumOf } from '../../domain/period.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const byId = (rows, map) => Object.fromEntries(rows.map((r) => [r.id, map(r)]));

export async function loadPools(q) {
  const { rows } = await q.query(`
    SELECT tool_id, pool, sum(q)::int AS n FROM (
      SELECT tool_id, from_pool AS pool, -qty AS q FROM movement_transfers
      UNION ALL
      SELECT tool_id, to_pool AS pool, qty AS q FROM movement_transfers
    ) t GROUP BY tool_id, pool`);
  const pools = {};
  for (const r of rows) (pools[r.tool_id] ||= emptyPool())[r.pool] = r.n;
  return pools;
}

// Controles con sus ítems, en la forma que usa el dominio (como en 2.1).
export async function loadControls(q, { status } = {}) {
  const where = status ? 'WHERE status = $1' : '';
  const { rows } = await q.query(`SELECT * FROM controls ${where}`, status ? [status] : []);
  const ids = rows.map((r) => r.id);
  const items = ids.length ? (await q.query('SELECT * FROM control_items WHERE control_id = ANY($1)', [ids])).rows : [];
  const byCtl = {};
  for (const it of items) {
    (byCtl[it.control_id] ||= {})[it.assignment_id] = {
      state: it.state, note: it.note || '', toolId: it.tool_id, toolName: it.tool_name, category: it.category, unitId: it.unit_id, unitCode: it.unit_code, qty: it.qty,
    };
  }
  return rows.map((r) => {
    const period = { y: r.period_y, m: r.period_m, w: r.period_w };
    return {
      id: r.id, techId: r.tech_id, techName: r.tech_name, shiftId: r.shift_id, period, pkey: pkeyOf(period), pnum: pnumOf(period), status: r.status,
      items: byCtl[r.id] || {}, counts: { bueno: r.count_bueno, cambio: r.count_cambio, faltante: r.count_faltante },
      correction: r.correction, supersedes: r.supersedes_id, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), updatedAt: iso(r.updated_at), version: r.version,
    };
  });
}

export async function loadMovements(q) {
  const { rows } = await q.query('SELECT * FROM movements ORDER BY at');
  return rows.map((r) => ({
    id: r.id, type: r.type, techId: r.tech_id, toolId: r.tool_id, qty: r.qty, unitId: r.unit_id, oldUnitId: r.old_unit_id,
    returned: r.returned, resolvesMovementId: r.resolves_movement_id, at: iso(r.at),
  }));
}

// Contexto que necesita planMovement().
export async function loadInventoryContext(q) {
  // En secuencia: un mismo cliente de pg no admite consultas en paralelo.
  const techs = await q.query('SELECT id, name, active FROM techs');
  const tools = await q.query('SELECT id, name, serialized, active, category_id FROM tools');
  const units = await q.query('SELECT id, tool_id, code, status, tech_id FROM units');
  const asgs = await q.query('SELECT id, tech_id, tool_id, unit_id, qty, active FROM assignments WHERE active');
  const pools = await loadPools(q);
  const ctls = await loadControls(q, { status: 'finalizado' });
  const movs = await loadMovements(q);
  const { effList } = effectiveControls(ctls);
  return {
    techs: byId(techs.rows, (r) => ({ name: r.name, active: r.active })),
    tools: byId(tools.rows, (r) => ({ name: r.name, serialized: r.serialized, active: r.active, categoryId: r.category_id })),
    units: byId(units.rows, (r) => ({ toolId: r.tool_id, code: r.code, status: r.status, techId: r.tech_id })),
    assignments: byId(asgs.rows, (r) => ({ techId: r.tech_id, toolId: r.tool_id, unitId: r.unit_id, qty: r.qty, active: r.active })),
    pools,
    stateOf: controlHistory(effList).stateOf,
    pendingReturns: pendingReturns(movs),
  };
}

const ASG_COLS = { active: 'active', until: 'until', endReason: 'end_reason', replacedBy: 'replaced_by', endMovementId: 'end_movement_id', qty: 'qty' };
const UNIT_COLS = { status: 'status', techId: 'tech_id' };

function updateSql(table, id, set, cols) {
  const keys = Object.keys(set);
  for (const k of keys) if (!cols[k]) throw new Error(`Campo no permitido en ${table}: ${k}`);
  const sets = keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ');
  return { text: `UPDATE ${table} SET ${sets} WHERE id = $1`, values: [id, ...keys.map((k) => set[k])] };
}

// Guarda un plan de planMovement(). Llamar dentro de una transacción.
export async function applyMovementPlan(client, plan, { actorId = null, auditId, ip = null } = {}) {
  const m = plan.movement;
  await client.query(
    `INSERT INTO movements (id, type, tech_id, tool_id, qty, unit_id, new_assignment_id, old_assignment_id, old_unit_id, new_unit_id,
       old_state, returned, old_dest, condition, linked_control_id, resolves_movement_id, reason, notes, at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [m.id, m.type, m.techId ?? null, m.toolId ?? null, m.qty ?? null, m.unitId ?? null, m.newAssignmentId ?? null, m.oldAssignmentId ?? null,
      m.oldUnitId ?? null, m.newUnitId ?? null, m.oldState ?? null, m.returned ?? null, m.oldDest ?? null, m.condition ?? null,
      m.linkedControlId ?? null, m.resolvesMovementId ?? null, m.reason || null, m.notes || null, m.at, actorId],
  );
  // Unidades nuevas antes de las transferencias y asignaciones que las nombran.
  for (const u of plan.newUnits) {
    await client.query('INSERT INTO units (id, tool_id, code, status, tech_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [u.id, u.toolId, u.code, u.status, u.techId, actorId]);
  }
  for (const [seq, t] of plan.transfers.entries()) {
    await client.query('INSERT INTO movement_transfers (movement_id, seq, tool_id, qty, from_pool, to_pool, unit_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [m.id, seq, t.toolId, t.qty, t.from, t.to, t.unitId ?? null]);
  }
  for (const u of plan.assignmentUpdates) await client.query(updateSql('assignments', u.id, u.set, ASG_COLS));
  for (const a of plan.newAssignments) {
    await client.query(
      'INSERT INTO assignments (id, tech_id, tool_id, unit_id, qty, active, since, movement_id, replaces, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [a.id, a.techId, a.toolId, a.unitId, a.qty, a.active, a.since, a.movementId, a.replaces, actorId],
    );
  }
  for (const u of plan.unitUpdates) await client.query(updateSql('units', u.id, u.set, UNIT_COLS));
  if (plan.audit && auditId) {
    await client.query('INSERT INTO audit_log (id, action, entity, entity_id, detail, at, actor_id, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [auditId, plan.audit.action, 'movements', m.id, plan.audit.detail, m.at, actorId, ip]);
  }
}

// Guarda un control como borrador con sus ítems y, si corresponde, lo finaliza. Los ítems
// solo se pueden escribir mientras el control es borrador (lo exige un trigger).
export async function saveControl(client, id, doc, { actorId = null, startedAt, finishedAt } = {}) {
  await client.query(
    `INSERT INTO controls (id, tech_id, tech_name, shift_id, period_y, period_m, period_w, status, count_bueno, count_cambio, count_faltante,
       correction, supersedes_id, started_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'borrador',$8,$9,$10,$11,$12,$13,$14)`,
    [id, doc.techId, doc.techName, doc.shiftId, doc.period.y, doc.period.m, doc.period.w, doc.counts.bueno, doc.counts.cambio, doc.counts.faltante,
      doc.correction, doc.supersedes, startedAt ?? null, actorId],
  );
  for (const [aid, it] of Object.entries(doc.items)) {
    await client.query(
      'INSERT INTO control_items (control_id, assignment_id, state, note, tool_id, tool_name, category, unit_id, unit_code, qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, aid, it.state, it.note || null, it.toolId, it.toolName, it.category, it.unitId, it.unitCode, it.qty],
    );
  }
  if (doc.status === 'finalizado') {
    await client.query("UPDATE controls SET status = 'finalizado', finished_at = $2 WHERE id = $1", [id, finishedAt]);
  }
}
