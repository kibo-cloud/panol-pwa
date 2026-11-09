// Etapa 3: kits (lista de herramientas con cantidades) y "Entregar kit" en un paso: un
// movimiento por herramienta (entrega inicial, o adicional si ya la tiene), todo o nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanKitItems, cleanKitName, planKitDelivery } from '../../src/domain/kits.js';
import { poolsFromTransfers } from '../../src/domain/pools.js';

const AT = '2026-03-10T12:00:00.000Z';
let n = 0;
const opts = { at: AT, newId: (p) => `${p}${++n}` };
const TOOLS = {
  pinza: { name: 'Pinza', serialized: false, active: true },
  llave: { name: 'Llave', serialized: false, active: true },
  taladro: { name: 'Taladro', serialized: true, active: true },
  vieja: { name: 'Vieja', serialized: false, active: false },
};
function ctx(extra = {}) {
  return {
    techs: { tA: { name: 'Ana Prueba', active: true } },
    cajas: { k1: { name: 'Caja Línea 1', archivedAt: null } },
    tools: TOOLS,
    units: {
      u1: { toolId: 'taladro', code: 'TAL-002', status: 'disponible', techId: null, cajaId: null },
      u2: { toolId: 'taladro', code: 'TAL-001', status: 'disponible', techId: null, cajaId: null },
      u3: { toolId: 'taladro', code: 'TAL-003', status: 'asignado', techId: 'tX', cajaId: null },
    },
    assignments: { a0: { techId: 'tA', toolId: 'llave', qty: 1, active: true } },
    pools: poolsFromTransfers([
      { toolId: 'pinza', qty: 5, from: 'externo', to: 'disponible' },
      { toolId: 'llave', qty: 2, from: 'externo', to: 'disponible' },
    ], Object.keys(TOOLS)),
    stateOf: {},
    pendingReturns: [],
    ...extra,
  };
}

test('ítems del kit: herramienta existente, cantidad entera, sin repetidos', () => {
  assert.deepEqual(cleanKitItems([{ toolId: 'pinza', qty: 2 }, { toolId: 'llave', qty: 1 }], TOOLS), [{ toolId: 'pinza', qty: 2 }, { toolId: 'llave', qty: 1 }]);
  assert.throws(() => cleanKitItems([{ toolId: 'pinza', qty: 1 }, { toolId: 'pinza', qty: 2 }], TOOLS), /repetida/);
  assert.throws(() => cleanKitItems([{ toolId: 'nada', qty: 1 }], TOOLS), /herramienta/);
  assert.throws(() => cleanKitItems([{ toolId: 'pinza', qty: 0 }], TOOLS), /cantidad/);
  assert.throws(() => cleanKitItems([{ toolId: 'pinza', qty: 1.5 }], TOOLS), /cantidad/);
  assert.deepEqual(cleanKitItems([], TOOLS), []);
  assert.equal(cleanKitName('  Kit eléctrico '), 'Kit eléctrico');
  assert.throws(() => cleanKitName(' '), /nombre/);
});

test('entregar kit: un movimiento por herramienta, inicial o adicional según lo que ya tiene', () => {
  const items = [{ toolId: 'pinza', qty: 2 }, { toolId: 'llave', qty: 1 }];
  const r = planKitDelivery(ctx(), { items, holder: { techId: 'tA' }, kitName: 'Kit base' }, opts);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.plans.map((p) => [p.movement.type, p.movement.toolId, p.movement.qty]), [['entrega_inicial', 'pinza', 2], ['adicional', 'llave', 1]]);
  assert.ok(r.plans.every((p) => p.movement.techId === 'tA' && p.movement.reason === 'Entrega del kit Kit base'));
});

test('entregar kit a una caja', () => {
  const r = planKitDelivery(ctx(), { items: [{ toolId: 'pinza', qty: 1 }], holder: { cajaId: 'k1' }, kitName: 'Kit base' }, opts);
  assert.deepEqual(r.problems, []);
  assert.equal(r.plans[0].movement.cajaId, 'k1');
  assert.equal(r.plans[0].movement.techId, null);
});

test('herramienta por código: una unidad por movimiento; sin elegir, toma las disponibles por código', () => {
  const r = planKitDelivery(ctx(), { items: [{ toolId: 'taladro', qty: 2 }], holder: { techId: 'tA' }, kitName: 'K' }, opts);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.plans.map((p) => [p.movement.type, p.movement.unitId]), [['entrega_inicial', 'u2'], ['adicional', 'u1']]);
  const chosen = planKitDelivery(ctx(), { items: [{ toolId: 'taladro', qty: 1 }], holder: { techId: 'tA' }, unitIds: { taladro: ['u1'] }, kitName: 'K' }, opts);
  assert.deepEqual(chosen.plans.map((p) => p.movement.unitId), ['u1']);
});

test('todo o nada: cada herramienta con problema queda nombrada y no se planifica nada', () => {
  const items = [{ toolId: 'pinza', qty: 9 }, { toolId: 'llave', qty: 1 }, { toolId: 'taladro', qty: 3 }, { toolId: 'vieja', qty: 1 }];
  const r = planKitDelivery(ctx(), { items, holder: { techId: 'tA' }, kitName: 'K' }, opts);
  assert.deepEqual(r.plans, []);
  assert.deepEqual(r.problems.map((p) => p.toolId), ['pinza', 'taladro', 'vieja']);
  assert.match(r.problems[0].message, /Pinza: se necesitan 9 y hay 5 disponibles/);
  assert.match(r.problems[1].message, /Taladro: se necesitan 3 unidades y hay 2 disponibles/);
  assert.match(r.problems[2].message, /Vieja: está inactiva/);
});

test('unidades elegidas: cantidad exacta, de la herramienta y disponibles', () => {
  const base = { items: [{ toolId: 'taladro', qty: 2 }], holder: { techId: 'tA' }, kitName: 'K' };
  assert.match(planKitDelivery(ctx(), { ...base, unitIds: { taladro: ['u1'] } }, opts).problems[0].message, /elegí 2 unidades/);
  assert.match(planKitDelivery(ctx(), { ...base, unitIds: { taladro: ['u1', 'u3'] } }, opts).problems[0].message, /TAL-003 no está disponible/);
  assert.match(planKitDelivery(ctx(), { ...base, unitIds: { taladro: ['u1', 'u1'] } }, opts).problems[0].message, /repetida/);
  assert.match(planKitDelivery(ctx(), { ...base, items: [{ toolId: 'pinza', qty: 1 }], unitIds: { pinza: ['u1'] } }, opts).problems[0].message, /por cantidad/);
});

test('kit vacío o poseedor inválido: error claro', () => {
  assert.throws(() => planKitDelivery(ctx(), { items: [], holder: { techId: 'tA' }, kitName: 'K' }, opts), /no tiene herramientas/);
  assert.throws(() => planKitDelivery(ctx(), { items: [{ toolId: 'pinza', qty: 1 }], holder: { techId: 'nadie' }, kitName: 'K' }, opts), /técnico activo/);
});
