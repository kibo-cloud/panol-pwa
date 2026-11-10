// Etapa 5: planificación de la anulación de un movimiento (contramovimiento puro).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planVoid, voidCheck } from '../../src/domain/voids.js';

const AT = '2026-03-12T12:00:00.000Z';
let n = 0;
const opts = { at: AT, newId: (p) => `${p}${++n}`, reason: 'Cargado por error' };

const entrega = {
  id: 'm1', type: 'entrega_inicial', techId: 'tA', toolId: 'pinza', qty: 2, newAssignmentId: 'a1', at: '2026-03-10T12:00:00.000Z',
  transfers: [{ toolId: 'pinza', qty: 2, from: 'disponible', to: 'asignado', unitId: null }],
};
const base = (extra = {}) => ({
  mv: entrega,
  voidedBy: null,
  dependents: [],
  assignments: { a1: { active: true, qty: 2, techId: 'tA', toolId: 'pinza', unitId: null, endMovementId: null } },
  units: {},
  pools: { pinza: { disponible: 3, asignado: 2 } },
  holder: { active: true, name: 'Ana Prueba' },
  tool: { name: 'Pinza', active: true },
  ...extra,
});

test('anular una entrega: transferencias invertidas y la asignación se cierra', () => {
  const p = planVoid(base(), opts);
  assert.equal(p.movement.type, 'anulacion');
  assert.equal(p.movement.voidsMovementId, 'm1');
  assert.equal(p.movement.reason, 'Cargado por error');
  assert.deepEqual(p.transfers, [{ toolId: 'pinza', qty: 2, from: 'asignado', to: 'disponible', unitId: null }]);
  assert.deepEqual(p.assignmentUpdates, [{ id: 'a1', set: { active: false, until: AT, endReason: 'anulacion', endMovementId: p.movement.id } }]);
  assert.match(p.audit.detail, /^Anulación de Entrega inicial: Pinza ×2 \(Ana Prueba\)\. Motivo: Cargado por error$/);
});

test('una anulación no se anula y un movimiento se anula una sola vez', () => {
  assert.throws(() => planVoid(base({ mv: { ...entrega, type: 'anulacion' } }), opts), /Una anulación no se anula/);
  assert.throws(() => planVoid(base({ voidedBy: 'm9' }), opts), /ya está anulado/);
  assert.equal(voidCheck(base({ voidedBy: 'm9' })).ok, false);
  assert.equal(voidCheck(base()).ok, true);
});

test('un movimiento posterior que depende de este impide anularlo, con el motivo', () => {
  const r = voidCheck(base({ dependents: [{ id: 'm2', type: 'devolucion', at: '2026-03-11T15:00:00.000Z' }] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'No se puede anular: después se registró una Devolución (11/03/2026) que depende de este movimiento. Anulá primero ese movimiento.');
});

test('entrega: la asignación tiene que seguir igual', () => {
  assert.match(voidCheck(base({ assignments: { a1: { active: false, qty: 2, endMovementId: 'm5' } } })).reason, /la asignación ya no está activa/);
  assert.match(voidCheck(base({ assignments: { a1: { active: true, qty: 1 } } })).reason, /la cantidad asignada cambió/);
});

test('devolución total: vuelve la asignación y el stock tiene que estar', () => {
  const dev = { id: 'm3', type: 'devolucion', techId: 'tA', toolId: 'pinza', qty: 2, oldAssignmentId: 'a1', condition: 'disponible', at: '2026-03-11T12:00:00.000Z', transfers: [{ toolId: 'pinza', qty: 2, from: 'asignado', to: 'disponible', unitId: null }] };
  const ctx = base({ mv: dev, assignments: { a1: { active: false, qty: 2, techId: 'tA', toolId: 'pinza', endMovementId: 'm3' } }, pools: { pinza: { disponible: 2, asignado: 0 } } });
  const p = planVoid(ctx, opts);
  assert.deepEqual(p.transfers, [{ toolId: 'pinza', qty: 2, from: 'disponible', to: 'asignado', unitId: null }]);
  assert.deepEqual(p.assignmentUpdates, [{ id: 'a1', set: { active: true, until: null, endReason: null, endMovementId: null } }]);
  // Sin stock disponible (se entregó a otro después): no se puede.
  assert.equal(voidCheck({ ...ctx, pools: { pinza: { disponible: 1 } } }).reason, 'No se puede anular: se necesitan 2 en «Disponibles» y hay 1.');
  // El técnico ya no está activo.
  assert.match(voidCheck({ ...ctx, holder: { active: false, name: 'Ana Prueba' } }).reason, /Ana Prueba ya no está activo/);
});

test('devolución parcial: suma la cantidad a la asignación que sigue activa', () => {
  const dev = { id: 'm4', type: 'devolucion', techId: 'tA', toolId: 'pinza', qty: 1, oldAssignmentId: 'a1', condition: 'reparacion', at: '2026-03-11T12:00:00.000Z', transfers: [{ toolId: 'pinza', qty: 1, from: 'asignado', to: 'reparacion', unitId: null }] };
  const p = planVoid(base({ mv: dev, assignments: { a1: { active: true, qty: 1, techId: 'tA', toolId: 'pinza' } }, pools: { pinza: { reparacion: 1 } } }), opts);
  assert.deepEqual(p.assignmentUpdates, [{ id: 'a1', set: { qty: 2 } }]);
  assert.deepEqual(p.transfers, [{ toolId: 'pinza', qty: 1, from: 'reparacion', to: 'asignado', unitId: null }]);
});

test('unidad: tiene que seguir donde la dejó el movimiento y vuelve con su poseedor', () => {
  const dev = { id: 'm5', type: 'retiro', cajaId: 'k1', toolId: 'taladro', qty: 1, unitId: 'u1', oldAssignmentId: 'a2', condition: 'retirado', at: '2026-03-11T12:00:00.000Z', transfers: [{ toolId: 'taladro', qty: 1, from: 'asignado', to: 'retirado', unitId: 'u1' }] };
  const ctx = base({ mv: dev, assignments: { a2: { active: false, qty: 1, cajaId: 'k1', toolId: 'taladro', unitId: 'u1', endMovementId: 'm5' } }, units: { u1: { code: 'TAL-001', status: 'retirado', techId: null, cajaId: null } }, pools: { taladro: { retirado: 1 } }, tool: { name: 'Taladro', active: true } });
  const p = planVoid(ctx, opts);
  assert.deepEqual(p.unitUpdates, [{ id: 'u1', set: { status: 'asignado', techId: null, cajaId: 'k1' } }]);
  assert.equal(voidCheck({ ...ctx, units: { u1: { code: 'TAL-001', status: 'disponible' } } }).reason, 'No se puede anular: la unidad TAL-001 ya no está en «Retiradas».');
});

test('ingreso por cantidad y por código; recepción no se anula', () => {
  const ing = { id: 'm6', type: 'ingreso', toolId: 'pinza', qty: 5, at: '2026-03-11T12:00:00.000Z', transfers: [{ toolId: 'pinza', qty: 5, from: 'externo', to: 'disponible', unitId: null }] };
  const p = planVoid(base({ mv: ing, holder: null, pools: { pinza: { disponible: 5 } } }), opts);
  assert.equal(voidCheck(base({ mv: ing, holder: null, pools: { pinza: { disponible: 3 } } })).ok, false);
  assert.deepEqual(p.transfers, [{ toolId: 'pinza', qty: 5, from: 'disponible', to: 'externo', unitId: null }]);
  const codes = { ...ing, toolId: 'taladro', qty: 1, transfers: [{ toolId: 'taladro', qty: 1, from: 'externo', to: 'disponible', unitId: 'u9' }] };
  const pc = planVoid(base({ mv: codes, holder: null, units: { u9: { code: 'TAL-009', status: 'disponible' } }, pools: { taladro: { disponible: 1 } } }), opts);
  assert.deepEqual(pc.unitUpdates, [{ id: 'u9', set: { status: 'externo', techId: null, cajaId: null } }]);
  assert.match(voidCheck(base({ mv: { ...ing, type: 'recepcion' } })).reason, /no se anula/);
});

test('reposición: vuelve la asignación anterior y se cierra la nueva', () => {
  const rep = {
    id: 'm7', type: 'reposicion', techId: 'tA', toolId: 'taladro', qty: 1, oldAssignmentId: 'a3', newAssignmentId: 'a4', oldUnitId: 'u1', newUnitId: 'u2', oldDest: 'reparacion', at: '2026-03-11T12:00:00.000Z',
    transfers: [{ toolId: 'taladro', qty: 1, from: 'asignado', to: 'reparacion', unitId: 'u1' }, { toolId: 'taladro', qty: 1, from: 'disponible', to: 'asignado', unitId: 'u2' }],
  };
  const ctx = base({
    mv: rep,
    assignments: { a3: { active: false, qty: 1, techId: 'tA', endMovementId: 'm7' }, a4: { active: true, qty: 1, techId: 'tA' } },
    units: { u1: { code: 'TAL-001', status: 'reparacion' }, u2: { code: 'TAL-002', status: 'asignado', techId: 'tA' } },
    pools: { taladro: { reparacion: 1, asignado: 1 } },
    tool: { name: 'Taladro', active: true },
  });
  const p = planVoid(ctx, opts);
  assert.deepEqual(p.assignmentUpdates, [
    { id: 'a4', set: { active: false, until: AT, endReason: 'anulacion', endMovementId: p.movement.id } },
    { id: 'a3', set: { active: true, until: null, endReason: null, replacedBy: null, endMovementId: null } },
  ]);
  assert.deepEqual(p.unitUpdates, [{ id: 'u2', set: { status: 'disponible', techId: null, cajaId: null } }, { id: 'u1', set: { status: 'asignado', techId: 'tA', cajaId: null } }]);
});
