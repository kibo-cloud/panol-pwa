import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poolsFromTransfers, emptyPool } from '../../src/domain/pools.js';
import { POOL_K, validId } from '../../src/domain/constants.js';

test('pools: claves de 2.1', () => {
  assert.deepEqual(POOL_K, ['disponible', 'asignado', 'reparacion', 'retirado', 'pendiente', 'baja', 'externo']);
  assert.deepEqual(Object.keys(emptyPool()), POOL_K);
});

test('pools se calculan sumando transferencias', () => {
  const p = poolsFromTransfers(
    [
      { toolId: 't1', qty: 10, from: 'externo', to: 'disponible' },
      { toolId: 't1', qty: 3, from: 'disponible', to: 'asignado' },
      { toolId: 't1', qty: 1, from: 'asignado', to: 'reparacion' },
      { toolId: 't2', qty: 1, from: 'externo', to: 'disponible' },
    ],
    ['t1', 't2', 't3'],
  );
  assert.deepEqual(p.t1, { disponible: 7, asignado: 2, reparacion: 1, retirado: 0, pendiente: 0, baja: 0, externo: -10 });
  assert.equal(p.t2.disponible, 1);
  assert.equal(p.t3.disponible, 0);
});

test('validId como en 2.1', () => {
  for (const ok of ['a', 'c-t1-2026-03-2', 'u_1.x~:@+']) assert.equal(validId(ok), true, ok);
  for (const bad of ['', '.', '..', '__proto__', 'constructor', 'a b', 'a/b', '<x>', 'x'.repeat(201), 5, null]) assert.equal(validId(bad), false, String(bad));
});
