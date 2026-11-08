import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMovement, requiredPermission } from '../../src/domain/movements.js';
import { poolsFromTransfers } from '../../src/domain/pools.js';

const AT = '2026-03-10T12:00:00.000Z';

// Contexto inventado: un técnico activo, una herramienta por cantidad y una serializada.
function ctx(extra = {}) {
  const base = {
    techs: { tA: { name: 'Ana Prueba', active: true }, tB: { name: 'Beto Baja', active: false } },
    tools: {
      pinza: { name: 'Pinza', serialized: false, active: true },
      taladro: { name: 'Taladro', serialized: true, active: true },
      vieja: { name: 'Vieja', serialized: false, active: false },
    },
    units: {
      u1: { toolId: 'taladro', code: 'TAL-001', status: 'disponible', techId: null },
      u2: { toolId: 'taladro', code: 'TAL-002', status: 'asignado', techId: 'tA' },
    },
    assignments: {},
    pools: poolsFromTransfers([{ toolId: 'pinza', qty: 5, from: 'externo', to: 'disponible' }], ['pinza', 'taladro']),
    stateOf: {},
    pendingReturns: [],
  };
  return { ...base, ...extra };
}
let n = 0;
const opts = { at: AT, newId: (p) => `${p}${++n}` };

test('permiso requerido por tipo', () => {
  assert.equal(requiredPermission('entrega_inicial'), 'movements_do');
  assert.equal(requiredPermission('recepcion'), 'movements_do');
  assert.equal(requiredPermission('ingreso'), 'inventory_edit');
  assert.equal(requiredPermission('baja'), 'inventory_edit');
  assert.throws(() => requiredPermission('otro'));
});

test('entrega inicial por cantidad: valida stock y crea asignación', () => {
  const plan = planMovement(ctx(), { type: 'entrega_inicial', techId: 'tA', toolId: 'pinza', qty: '3', reason: ' Nueva asignación ' }, opts);
  assert.deepEqual(plan.transfers, [{ toolId: 'pinza', qty: 3, from: 'disponible', to: 'asignado', unitId: null }]);
  assert.equal(plan.newAssignments.length, 1);
  assert.equal(plan.newAssignments[0].qty, 3);
  assert.equal(plan.movement.newAssignmentId, plan.newAssignments[0].id);
  assert.equal(plan.movement.reason, 'Nueva asignación');
  assert.equal(plan.movement.at, AT);
  assert.throws(() => planMovement(ctx(), { type: 'entrega_inicial', techId: 'tA', toolId: 'pinza', qty: 6 }, opts), /Solo hay 5 disponibles/);
  assert.throws(() => planMovement(ctx(), { type: 'entrega_inicial', techId: 'tA', toolId: 'pinza', qty: 0 }, opts), /cantidad válida/);
});

test('entrega: técnico y herramienta activos', () => {
  assert.throws(() => planMovement(ctx(), { type: 'entrega_inicial', techId: 'tB', toolId: 'pinza', qty: 1 }, opts), /técnico activo/);
  assert.throws(() => planMovement(ctx(), { type: 'entrega_inicial', techId: 'tA', toolId: 'vieja', qty: 1 }, opts), /herramienta activa/);
});

test('entrega serializada: unidad disponible y cambia a asignada', () => {
  const plan = planMovement(ctx(), { type: 'entrega_inicial', techId: 'tA', toolId: 'taladro', unitId: 'u1' }, opts);
  assert.deepEqual(plan.unitUpdates, [{ id: 'u1', set: { status: 'asignado', techId: 'tA' } }]);
  assert.equal(plan.transfers[0].unitId, 'u1');
  assert.throws(() => planMovement(ctx(), { type: 'entrega_inicial', techId: 'tA', toolId: 'taladro', unitId: 'u2' }, opts), /unidad disponible/);
});

test('entrega inicial vs adicional según si ya la tiene', () => {
  const c = ctx({ assignments: { a1: { techId: 'tA', toolId: 'pinza', qty: 1, active: true } } });
  assert.throws(() => planMovement(c, { type: 'entrega_inicial', techId: 'tA', toolId: 'pinza', qty: 1 }, opts), /Usá Entrega adicional/);
  assert.throws(() => planMovement(ctx(), { type: 'adicional', techId: 'tA', toolId: 'pinza', qty: 1 }, opts), /Usá Entrega inicial/);
  assert.equal(planMovement(c, { type: 'adicional', techId: 'tA', toolId: 'pinza', qty: 1 }, opts).newAssignments.length, 1);
});

test('reposición: cierra la asignación, crea la nueva y manda la anterior a destino', () => {
  const c = ctx({ assignments: { a1: { techId: 'tA', toolId: 'pinza', qty: 2, active: true } }, stateOf: { a1: { state: 'cambio', controlId: 'k1' } } });
  const plan = planMovement(c, { type: 'reposicion', techId: 'tA', asgId: 'a1', returned: true, oldDest: 'reparacion' }, opts);
  assert.deepEqual(plan.transfers.map((t) => [t.from, t.to, t.qty]), [['asignado', 'reparacion', 2], ['disponible', 'asignado', 2]]);
  const na = plan.newAssignments[0];
  assert.equal(na.replaces, 'a1');
  assert.deepEqual(plan.assignmentUpdates, [{ id: 'a1', set: { active: false, until: AT, endReason: 'reposicion', replacedBy: na.id, endMovementId: plan.movement.id } }]);
  assert.equal(plan.movement.oldState, 'cambio');
  assert.equal(plan.movement.linkedControlId, 'k1');
  // Sin devolver: queda pendiente de devolución.
  const p2 = planMovement(c, { type: 'reposicion', techId: 'tA', asgId: 'a1', returned: false }, opts);
  assert.equal(p2.transfers[0].to, 'pendiente');
  assert.equal(p2.movement.returned, false);
  // Stock insuficiente.
  const c3 = ctx({ assignments: { a1: { techId: 'tA', toolId: 'pinza', qty: 6, active: true } } });
  assert.throws(() => planMovement(c3, { type: 'reposicion', techId: 'tA', asgId: 'a1', returned: true }, opts), /se necesitan 6 y hay 5/);
  assert.throws(() => planMovement(c, { type: 'reposicion', techId: 'tA', asgId: 'a1', returned: true, oldDest: 'disponible' }, opts), /destino/);
});

test('reposición serializada: unidad vieja y nueva', () => {
  const c = ctx({ assignments: { a2: { techId: 'tA', toolId: 'taladro', unitId: 'u2', qty: 1, active: true } } });
  const plan = planMovement(c, { type: 'reposicion', techId: 'tA', asgId: 'a2', newUnitId: 'u1', returned: false }, opts);
  assert.deepEqual(plan.unitUpdates, [{ id: 'u2', set: { status: 'pendiente', techId: 'tA' } }, { id: 'u1', set: { status: 'asignado', techId: 'tA' } }]);
  assert.throws(() => planMovement(c, { type: 'reposicion', techId: 'tA', asgId: 'a2', newUnitId: 'u2', returned: true }, opts), /unidad nueva/);
});

test('devolución parcial y retiro', () => {
  const c = ctx({ assignments: { a1: { techId: 'tA', toolId: 'pinza', qty: 3, active: true } } });
  const p = planMovement(c, { type: 'devolucion', techId: 'tA', asgId: 'a1', qty: 2, cond: 'reparacion' }, opts);
  assert.deepEqual(p.transfers, [{ toolId: 'pinza', qty: 2, from: 'asignado', to: 'reparacion', unitId: null }]);
  assert.deepEqual(p.assignmentUpdates, [{ id: 'a1', set: { qty: 1 } }]);
  assert.throws(() => planMovement(c, { type: 'devolucion', techId: 'tA', asgId: 'a1', qty: 4 }, opts), /entre 1 y 3/);
  const r = planMovement(c, { type: 'retiro', techId: 'tA', asgId: 'a1' }, opts);
  assert.equal(r.transfers[0].to, 'retirado');
  assert.equal(r.transfers[0].qty, 3);
  assert.equal(r.assignmentUpdates[0].set.active, false);
  assert.throws(() => planMovement(c, { type: 'devolucion', techId: 'tA', asgId: 'zz' }, opts), /asignada al técnico/);
});

test('recepción de devolución pendiente', () => {
  const pend = { id: 'm9', type: 'reposicion', techId: 'tA', toolId: 'taladro', qty: 1, oldUnitId: 'u2', returned: false };
  const c = ctx({ pendingReturns: [pend] });
  const p = planMovement(c, { type: 'recepcion', resolvesMovementId: 'm9', cond: 'disponible' }, opts);
  assert.deepEqual(p.transfers, [{ toolId: 'taladro', qty: 1, from: 'pendiente', to: 'disponible', unitId: 'u2' }]);
  assert.deepEqual(p.unitUpdates, [{ id: 'u2', set: { status: 'disponible', techId: null } }]);
  assert.throws(() => planMovement(ctx(), { type: 'recepcion', resolvesMovementId: 'm9' }, opts), /Ya fue registrada/);
});

test('inventario por cantidad: ingreso, reparado, baja y recupero', () => {
  const c = ctx({ pools: { pinza: { disponible: 5, asignado: 0, reparacion: 2, retirado: 1, pendiente: 0, baja: 0, externo: -8 } } });
  assert.deepEqual(planMovement(c, { type: 'ingreso', toolId: 'pinza', qty: 4 }, opts).transfers[0], { toolId: 'pinza', qty: 4, from: 'externo', to: 'disponible', unitId: null });
  assert.throws(() => planMovement(c, { type: 'reparado', toolId: 'pinza', qty: 3 }, opts), /Solo hay 2 en en reparación/);
  assert.equal(planMovement(c, { type: 'baja', toolId: 'pinza', qty: 2, from: 'reparacion' }, opts).transfers[0].from, 'reparacion');
  assert.equal(planMovement(c, { type: 'recupero', toolId: 'pinza', qty: 1 }, opts).transfers[0].from, 'retirado');
  assert.throws(() => planMovement(c, { type: 'baja', toolId: 'pinza', qty: 1, from: 'asignado' }, opts), /origen/);
});

test('alta de unidades serializadas: códigos únicos sin distinguir mayúsculas', () => {
  const p = planMovement(ctx(), { type: 'ingreso', toolId: 'taladro', codes: 'TAL-003\nTAL-004; TAL-005' }, opts);
  assert.deepEqual(p.newUnits.map((u) => u.code), ['TAL-003', 'TAL-004', 'TAL-005']);
  assert.equal(p.transfers.length, 3);
  assert.equal(p.movement.qty, 3);
  assert.throws(() => planMovement(ctx(), { type: 'ingreso', toolId: 'taladro', codes: 'tal-001' }, opts), /ya existe/);
  assert.throws(() => planMovement(ctx(), { type: 'ingreso', toolId: 'taladro', codes: 'X1,x1' }, opts), /repetido/);
  assert.throws(() => planMovement(ctx(), { type: 'ingreso', toolId: 'taladro', codes: ' ' }, opts), /al menos un código/);
  assert.throws(() => planMovement(ctx(), { type: 'ingreso', toolId: 'taladro', codes: 'x'.repeat(61) }, opts), /hasta 60/);
});

test('inventario serializado: la unidad tiene que estar en el estado de origen', () => {
  const c = ctx({ units: { u3: { toolId: 'taladro', code: 'TAL-003', status: 'reparacion', techId: null } } });
  const p = planMovement(c, { type: 'reparado', toolId: 'taladro', unitId: 'u3' }, opts);
  assert.deepEqual(p.unitUpdates, [{ id: 'u3', set: { status: 'disponible', techId: null } }]);
  assert.throws(() => planMovement(c, { type: 'recupero', toolId: 'taladro', unitId: 'u3' }, opts), /unidad válida/);
});
