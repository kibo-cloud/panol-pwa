import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSeconds, LOCK_AFTER, lockMessage } from '../../src/domain/lockout.js';

test('curva de bloqueo de 2.1: 5 fallos -> 30 s, doble cada vez, máximo 15 min', () => {
  assert.equal(LOCK_AFTER, 5);
  assert.deepEqual([1, 2, 3, 4].map(lockSeconds), [0, 0, 0, 0]);
  assert.deepEqual([5, 6, 7, 8, 9, 10, 11, 20].map(lockSeconds), [30, 60, 120, 240, 480, 900, 900, 900]);
});

test('mensaje de espera', () => {
  assert.match(lockMessage(30), /30 s/);
  assert.match(lockMessage(240), /4 min/);
});
