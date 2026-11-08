// Etapa 2: el poseedor de una asignación, un movimiento o un control es un técnico o una caja
// compartida (nunca los dos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMovement } from '../../src/domain/movements.js';
import { poolsFromTransfers } from '../../src/domain/pools.js';
import { effectiveControls, buildControlDoc } from '../../src/domain/controls.js';
import { deriveAlerts } from '../../src/domain/alerts.js';
import { deriveState } from '../../src/domain/derive.js';
import { integrityIssues } from '../../src/domain/integrity.js';
import { holderKey, cleanLinea, cleanCaja } from '../../src/domain/lineas.js';

const AT = '2026-03-10T12:00:00.000Z';
let n = 0;
const opts = { at: AT, newId: (p) => `${p}${++n}` };
function ctx(extra = {}) {
  return {
    techs: { tA: { name: 'Ana Prueba', active: true } },
    cajas: { k1: { name: 'Caja Línea 1', archivedAt: null }, kOld: { name: 'Caja vieja', archivedAt: '2026-01-01T00:00:00Z' } },
    tools: { pinza: { name: 'Pinza', serialized: false, active: true }, taladro: { name: 'Taladro', serialized: true, active: true } },
    units: { u1: { toolId: 'taladro', code: 'TAL-001', status: 'disponible', techId: null, cajaId: null } },
    assignments: {},
    pools: poolsFromTransfers([{ toolId: 'pinza', qty: 5, from: 'externo', to: 'disponible' }], ['pinza', 'taladro']),
    stateOf: {},
    pendingReturns: [],
    ...extra,
  };
}

test('clave del poseedor: el técnico tal cual, la caja con prefijo', () => {
  assert.equal(holderKey({ techId: 'tA' }), 'tA');
  assert.equal(holderKey({ techId: null, cajaId: 'k1' }), 'caja:k1');
});

test('entrega a una caja: asignación y movimiento de la caja, stock validado', () => {
  const plan = planMovement(ctx(), { type: 'entrega_inicial', cajaId: 'k1', toolId: 'pinza', qty: 2 }, opts);
  assert.equal(plan.movement.cajaId, 'k1');
  assert.equal(plan.movement.techId, null);
  assert.deepEqual(plan.transfers, [{ toolId: 'pinza', qty: 2, from: 'disponible', to: 'asignado', unitId: null }]);
  assert.equal(plan.newAssignments[0].cajaId, 'k1');
  assert.equal(plan.newAssignments[0].techId, null);
  assert.match(plan.audit.detail, /a Caja Línea 1$/);
  assert.throws(() => planMovement(ctx(), { type: 'entrega_inicial', cajaId: 'k1', toolId: 'pinza', qty: 9 }, opts), /Solo hay 5 disponibles/);
  assert.throws(() => planMovement(ctx(), { type: 'entrega_inicial', cajaId: 'kOld', toolId: 'pinza', qty: 1 }, opts), /caja activa/);
  assert.throws(() => planMovement(ctx(), { type: 'entrega_inicial', techId: 'tA', cajaId: 'k1', toolId: 'pinza', qty: 1 }, opts), /técnico o una caja/);
});

test('unidad entregada a una caja; la caja y el técnico tienen asignaciones separadas', () => {
  const plan = planMovement(ctx(), { type: 'entrega_inicial', cajaId: 'k1', toolId: 'taladro', unitId: 'u1' }, opts);
  assert.deepEqual(plan.unitUpdates, [{ id: 'u1', set: { status: 'asignado', techId: null, cajaId: 'k1' } }]);
  const assignments = { a1: { techId: null, cajaId: 'k1', toolId: 'pinza', qty: 2, active: true } };
  // El técnico no tiene la pinza de la caja: entrega inicial al técnico sí; adicional a la caja sí.
  assert.ok(planMovement(ctx({ assignments }), { type: 'entrega_inicial', techId: 'tA', toolId: 'pinza', qty: 1 }, opts));
  assert.ok(planMovement(ctx({ assignments }), { type: 'adicional', cajaId: 'k1', toolId: 'pinza', qty: 1 }, opts));
  assert.throws(() => planMovement(ctx({ assignments }), { type: 'devolucion', techId: 'tA', asgId: 'a1', cond: 'disponible' }, opts), /asignada al técnico/);
  const dev = planMovement(ctx({ assignments }), { type: 'devolucion', cajaId: 'k1', asgId: 'a1', qty: 1, cond: 'disponible' }, opts);
  assert.equal(dev.movement.cajaId, 'k1');
  assert.deepEqual(dev.assignmentUpdates, [{ id: 'a1', set: { qty: 1 } }]);
});

const fin = (id, holder, pkey, finishedAt, items) => ({ id, ...holder, pkey, pnum: Number(pkey.replace(/-/g, '')), period: { y: 2026, m: 3, w: Number(pkey.slice(-1)) }, status: 'finalizado', finishedAt, items });

test('controles efectivos por poseedor: un técnico y una caja no se pisan', () => {
  const { eff } = effectiveControls([
    fin('c1', { techId: 'k1' }, '2026-03-2', '2026-03-09T10:00:00Z', {}),
    fin('c2', { techId: null, cajaId: 'k1' }, '2026-03-2', '2026-03-09T11:00:00Z', {}),
  ]);
  assert.equal(eff['k1|2026-03-2'].id, 'c1');
  assert.equal(eff['caja:k1|2026-03-2'].id, 'c2');
});

test('documento de control de una caja', () => {
  const doc = buildControlDoc({
    caja: { id: 'k1', name: 'Caja Línea 1' }, period: { y: 2026, m: 3, w: 2 },
    assignments: [{ id: 'a1', toolId: 'pinza', qty: 2 }], items: { a1: { state: 'bueno' } },
    tools: { pinza: { name: 'Pinza' } }, units: {}, categories: {}, status: 'borrador',
  });
  assert.deepEqual([doc.techId, doc.cajaId, doc.techName, doc.plantillaId], [null, 'k1', 'Caja Línea 1', null]);
  assert.deepEqual(doc.counts, { bueno: 2, cambio: 0, faltante: 0 });
});

test('alertas de cajas: control pendiente y herramienta faltante', () => {
  const a = deriveAlerts({
    now: new Date('2026-03-10T12:00:00-03:00'),
    techs: {}, cajas: { k1: { name: 'Caja Línea 1' }, kOld: { name: 'Vieja', archivedAt: '2026-01-01T00:00:00Z' } },
    tools: { pinza: { name: 'Pinza' } }, units: {},
    assignments: { a1: { cajaId: 'k1', techId: null, toolId: 'pinza', active: true, qty: 1 }, a2: { cajaId: 'kOld', techId: null, toolId: 'pinza', active: true, qty: 1 } },
    controls: [fin('c1', { techId: null, cajaId: 'k1' }, '2026-03-1', '2026-03-02T10:00:00Z', { a1: { state: 'faltante', note: 'no está' } })],
    movements: [],
    alertRes: {},
  });
  assert.deepEqual(a.map((x) => x.key).sort(), ['falt-a1-c1', 'pend-caja:k1-2026-03-2']);
  const f = a.find((x) => x.type === 'faltante');
  assert.equal(f.cajaId, 'k1');
  assert.equal(f.text, 'Pinza, Caja Línea 1. no está');
});

test('estado e integridad: resumen por caja; una asignación de caja no es "sin técnico"', () => {
  const S = {
    techs: {}, cajas: { k1: { name: 'Caja Línea 1', lineaId: 'l1' } }, tools: { pinza: { name: 'Pinza' } }, units: {},
    assignments: { a1: { cajaId: 'k1', techId: null, toolId: 'pinza', active: true, qty: 2 } },
    controls: {}, movements: { m1: { type: 'ingreso', at: AT, transfers: [{ toolId: 'pinza', qty: 5, from: 'externo', to: 'disponible' }, { toolId: 'pinza', qty: 2, from: 'disponible', to: 'asignado' }] } },
  };
  const d = deriveState(S, { now: new Date(AT) });
  assert.equal(d.cajaInfo.k1.total, 2);
  assert.equal(d.cajaInfo.k1.curStatus, 'pend');
  assert.equal(d.asgByCaja.k1.length, 1);
  assert.equal(d.asgByTech.null, undefined);
  assert.deepEqual(integrityIssues(d), []);
});

test('líneas y cajas: nombre y tipo', () => {
  assert.deepEqual(cleanLinea({ name: ' Línea 1 ', kind: 'linea' }), { name: 'Línea 1', kind: 'linea' });
  assert.throws(() => cleanLinea({ name: 'L', kind: 'linea' }), /Ingresá un nombre/);
  assert.throws(() => cleanLinea({ name: 'Línea 1', kind: 'otra' }), /una línea o un sector/);
  assert.deepEqual(cleanCaja({ name: ' Caja A ' }), { name: 'Caja A' });
});
