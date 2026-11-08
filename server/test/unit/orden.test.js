// Etapa 3: orden personalizado de categorías y herramientas (puro).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolScope, CATEGORY_SCOPE, checkReorder, insertAt, sortByOrder, orderTools, toolRank } from '../../src/domain/orden.js';

const cats = [
  { id: 'g2', name: 'Medición', order: 2 },
  { id: 'g1', name: 'Eléctricas', order: 1 },
];
const tools = [
  { id: 'h1', name: 'Amperímetro', categoryId: 'g2', order: 2 },
  { id: 'h2', name: 'Taladro', categoryId: 'g1', order: 1 },
  { id: 'h3', name: 'Calibre', categoryId: 'g2', order: 1 },
  { id: 'h4', name: 'Cinta', categoryId: null, order: 1 },
  { id: 'h5', name: 'Amoladora', categoryId: 'g1', order: 1 },
];

test('alcance del orden: categorías y herramientas de cada categoría (sin categoría aparte)', () => {
  assert.equal(CATEGORY_SCOPE, 'categories');
  assert.equal(toolScope('g1'), 'tools:g1');
  assert.equal(toolScope(null), 'tools:');
  assert.equal(toolScope(''), 'tools:');
});

test('reordenar: la lista tiene que ser exactamente la actual, sin repetidos', () => {
  assert.deepEqual(checkReorder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
  assert.throws(() => checkReorder(['a', 'b', 'c'], ['c', 'a']), (e) => e.status === 409 && e.code === 'order_changed');
  assert.throws(() => checkReorder(['a', 'b'], ['a', 'b', 'x']), (e) => e.status === 409 && e.code === 'order_changed');
  assert.throws(() => checkReorder(['a', 'b'], ['a', 'a']), (e) => e.status === 422 && e.code === 'invalid_order');
});

test('insertar en una posición (desde 1, fuera de rango va al final o al principio)', () => {
  assert.deepEqual(insertAt(['a', 'b', 'c'], 'x', 1), ['x', 'a', 'b', 'c']);
  assert.deepEqual(insertAt(['a', 'b', 'c'], 'x', 2), ['a', 'x', 'b', 'c']);
  assert.deepEqual(insertAt(['a', 'b', 'c'], 'x', 4), ['a', 'b', 'c', 'x']);
  assert.deepEqual(insertAt(['a', 'b', 'c'], 'x', 99), ['a', 'b', 'c', 'x']);
  assert.deepEqual(insertAt(['a', 'b', 'c'], 'x', undefined), ['a', 'b', 'c', 'x']);
  assert.deepEqual(insertAt(['a', 'b', 'c'], 'x', 0), ['x', 'a', 'b', 'c']);
});

test('orden por posición y, si empatan, por nombre', () => {
  assert.deepEqual(sortByOrder(cats).map((c) => c.id), ['g1', 'g2']);
  assert.deepEqual(sortByOrder([{ id: 'b', name: 'B', order: 1 }, { id: 'a', name: 'A', order: 1 }]).map((x) => x.id), ['a', 'b']);
});

test('herramientas: por orden de su categoría, después su propio orden; sin categoría al final', () => {
  assert.deepEqual(orderTools(tools, cats).map((t) => t.id), ['h5', 'h2', 'h3', 'h1', 'h4']);
  const rank = toolRank(tools, cats);
  assert.ok(rank.h5 < rank.h2 && rank.h2 < rank.h3 && rank.h1 < rank.h4);
  // Una categoría que ya no existe cuenta como sin categoría.
  assert.deepEqual(orderTools([{ id: 'x', name: 'X', categoryId: 'gone', order: 1 }, tools[1]], cats).map((t) => t.id), ['h2', 'x']);
});
