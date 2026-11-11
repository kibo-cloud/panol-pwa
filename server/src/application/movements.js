// Registro de movimientos (entregas, devoluciones, reposiciones, retiros, recepciones e
// inventario) con el planificador del dominio. Todo en una transacción: se bloquea la fila de
// la herramienta (FOR UPDATE) antes de leer el stock, así dos pedidos concurrentes sobre la
// misma herramienta se aplican uno después del otro y nunca se entrega más de lo que hay.
import { loadInventoryContext, applyMovementPlan } from '../adapters/pg/inventory-repo.js';
import { loadOverrides } from '../adapters/pg/auth-repo.js';
import { lockName } from '../adapters/pg/catalog-repo.js';
import { planMovement, requiredPermission } from '../domain/movements.js';
import { can } from '../domain/permissions.js';
import { DomainError } from '../domain/errors.js';
import { newId } from './ids.js';
import { notifyChange, onUnique } from './common.js';
import { idempotent } from './idempotency.js';
import { checkReposicionLink, linkReposicion } from './compras.js';

const forbidden = () => new DomainError('Tu perfil no tiene permiso para esta acción.', 'forbidden', 403);

// Herramienta afectada por el movimiento, para bloquearla antes de planificar.
async function toolOf(c, m) {
  if (m.asgId && !['entrega_inicial', 'adicional'].includes(m.type)) {
    return (await c.query('SELECT tool_id FROM assignments WHERE id = $1', [m.asgId])).rows[0]?.tool_id ?? null;
  }
  if (m.type === 'recepcion') {
    return (await c.query('SELECT tool_id FROM movements WHERE id = $1', [m.resolvesMovementId ?? null])).rows[0]?.tool_id ?? null;
  }
  return m.toolId ?? null;
}

// Poseedor del movimiento FOR SHARE antes que la herramienta (orden global: poseedor -> filas ->
// herramientas): eliminar un técnico o una caja lo bloquea FOR UPDATE, así una entrega en curso
// espera y después ve el poseedor dado de baja.
async function lockHolder(c, m) {
  if (m.cajaId) await c.query('SELECT 1 FROM cajas WHERE id = $1 FOR SHARE', [m.cajaId]);
  else if (m.techId) await c.query('SELECT 1 FROM techs WHERE id = $1 FOR SHARE', [m.techId]);
}

// Aplica un movimiento dentro de la transacción `c`. Devuelve el plan guardado.
// inactiveHolder: devolución o retiro de un poseedor ya desactivado (al eliminarlo).
export async function applyMovement(c, actor, input, { demo = false, inactiveHolder = false } = {}) {
  await lockHolder(c, input);
  const toolId = await toolOf(c, input);
  if (toolId) await c.query('SELECT id FROM tools WHERE id = $1 FOR UPDATE', [toolId]);
  if (input.type === 'ingreso') await lockName(c, 'units.code');
  const ctx = await loadInventoryContext(c);
  const plan = planMovement(ctx, input, { at: new Date().toISOString(), newId, inactiveHolder });
  await applyMovementPlan(c, plan, { actorId: actor.id, auditId: newId('l'), ip: actor.ip, demo }).catch(onUnique('Ya existe un registro igual. Recargá para ver los cambios.', 'duplicate'));
  await notifyChange(c, { entity: 'movements', id: plan.movement.id, action: 'create' });
  return plan;
}

export async function registerMovement(db, actor, input, { idempotencyKey, path } = {}) {
  if (!can(actor.role, requiredPermission(input.type), await loadOverrides(db))) throw forbidden();
  const { purchaseRequestId, ...mv } = input;
  if (purchaseRequestId && mv.type !== 'reposicion') throw new DomainError('Solo una reposición se vincula a una compra recibida.', 'invalid_purchase', 422);
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: input }, async (c) => {
    // Etapa 7: reposición vinculada a una compra recibida (se revisa antes y, bloqueada, después).
    if (purchaseRequestId) {
      const a = (await c.query('SELECT tool_id, unit_id FROM assignments WHERE id = $1', [mv.asgId ?? null])).rows[0];
      await checkReposicionLink(c, purchaseRequestId, { toolId: a ? a.tool_id : mv.toolId, techId: mv.cajaId ? null : mv.techId, cajaId: mv.cajaId, asgId: mv.asgId ?? null, unitId: a ? a.unit_id : null });
    }
    const plan = await applyMovement(c, actor, mv);
    if (purchaseRequestId) {
      const h = plan.movement.cajaId ? (await c.query('SELECT name FROM cajas WHERE id = $1', [plan.movement.cajaId])).rows[0] : (await c.query('SELECT name FROM techs WHERE id = $1', [plan.movement.techId])).rows[0];
      await linkReposicion(c, actor, purchaseRequestId, { id: plan.movement.id, toolId: plan.movement.toolId, techId: plan.movement.cajaId ? null : plan.movement.techId, cajaId: plan.movement.cajaId || null, asgId: plan.movement.oldAssignmentId || null, unitId: plan.movement.oldUnitId || null, holderName: h && h.name });
    }
    return {
      status: 201,
      body: {
        movement: { ...plan.movement, transfers: plan.transfers },
        assignments: plan.newAssignments.map((a) => a.id),
        units: plan.newUnits.map((u) => u.id),
        ...(purchaseRequestId ? { purchaseRequestId } : {}),
      },
    };
  });
}
