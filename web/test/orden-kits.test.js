// Etapa 3: cuentas del reordenar (flechas, arrastrar, insertar en posición) y vista previa de
// "Entregar kit".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveTo, moveBy, insertAt, orderTools, sortByOrder, toolScope, sameOrder } from '../src/state/orden.js';
import { kitPreview, deliverBody } from '../src/state/kits.js';

test('mover con flechas y arrastrando', () => {
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveBy(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveTo(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveTo(['a', 'b'], 0, 99), ['b', 'a']);
  assert.ok(sameOrder(['a', 'b'], ['a', 'b']) && !sameOrder(['a', 'b'], ['b', 'a']));
});

test('insertar en posición', () => {
  assert.deepEqual(insertAt(['a', 'b'], 'x', 1), ['x', 'a', 'b']);
  assert.deepEqual(insertAt(['a', 'b'], 'x', 2), ['a', 'x', 'b']);
  assert.deepEqual(insertAt(['a', 'b'], 'x', null), ['a', 'b', 'x']);
});

test('orden de herramientas igual que el servidor', () => {
  const cats = [{ id: 'g2', name: 'B', order: 1 }, { id: 'g1', name: 'A', order: 2 }];
  const tools = [{ id: 't1', name: 'Z', categoryId: 'g1', order: 1 }, { id: 't2', name: 'Y', categoryId: 'g2', order: 2 }, { id: 't3', name: 'X', categoryId: 'g2', order: 1 }, { id: 't4', name: 'W', categoryId: null, order: 1 }];
  assert.deepEqual(orderTools(tools, cats).map((t) => t.id), ['t3', 't2', 't1', 't4']);
  assert.deepEqual(sortByOrder(cats).map((c) => c.id), ['g2', 'g1']);
  assert.equal(toolScope(null), 'tools:');
});

const ctx = (held = []) => ({
  tools: { p: { name: 'Pinza', serialized: false, active: true }, t: { name: 'Taladro', serialized: true, active: true }, v: { name: 'Vieja', active: false } },
  units: [{ id: 'u2', toolId: 't', code: 'T-2', status: 'disponible' }, { id: 'u1', toolId: 't', code: 'T-1', status: 'disponible' }, { id: 'u3', toolId: 't', code: 'T-3', status: 'asignado' }],
  pools: { p: { disponible: 3 } },
  held: new Set(held),
});

test('vista previa: inicial o adicional, unidades sugeridas por código, sin problemas', () => {
  const pv = kitPreview({ items: [{ toolId: 'p', qty: 2 }, { toolId: 't', qty: 1 }] }, ctx(['p']));
  assert.equal(pv.ok, true);
  assert.deepEqual(pv.rows.map((r) => [r.toolId, r.kind, r.available, r.chosen]), [['p', 'adicional', 3, []], ['t', 'entrega_inicial', 2, ['u1']]]);
  assert.equal(pv.movements, 2);
  assert.deepEqual(deliverBody('t9', pv), { holder: { techId: 't9' }, unitIds: { t: ['u1'] } });
  assert.deepEqual(deliverBody('caja:k1', pv, ' Ingreso '), { holder: { cajaId: 'k1' }, unitIds: { t: ['u1'] }, reason: 'Ingreso' });
  // Unidad elegida por el usuario.
  assert.deepEqual(kitPreview({ items: [{ toolId: 't', qty: 1 }] }, ctx(), { t: ['u2'] }).rows[0].chosen, ['u2']);
});

test('vista previa: problemas de stock nombrados, nada se puede confirmar', () => {
  const pv = kitPreview({ items: [{ toolId: 'p', qty: 5 }, { toolId: 't', qty: 3 }, { toolId: 'v', qty: 1 }] }, ctx());
  assert.equal(pv.ok, false);
  assert.deepEqual(pv.problems, ['Pinza: se necesitan 5 y hay 3 disponibles.', 'Taladro: se necesitan 3 unidades y hay 2 disponibles.', 'Vieja: está inactiva.']);
  assert.equal(kitPreview({ items: [] }, ctx()).ok, false);
  assert.match(kitPreview({ items: [{ toolId: 't', qty: 2 }] }, ctx(), { t: ['u1'] }).problems[0], /elegí 2 unidades/);
});

test('vista previa: las unidades se sugieren solo al abrir; si el usuario desmarca todas, hay que elegir', () => {
  const kit = { items: [{ toolId: 't', qty: 2 }] };
  // Al abrir (autoPick) se toman las primeras por código.
  assert.deepEqual(kitPreview(kit, ctx(), {}, { autoPick: true }).rows[0].chosen, ['u1', 'u2']);
  // Después de tocar las casillas, ninguna marcada no es "Listo": se pide elegir y no se confirma.
  const pv = kitPreview(kit, ctx(), {}, { autoPick: false });
  assert.deepEqual(pv.rows[0].chosen, []);
  assert.equal(pv.ok, false);
  assert.deepEqual(pv.problems, ['Taladro: elegí 2 unidades.']);
  assert.equal(deliverBody('t9', pv).unitIds, undefined);
});
