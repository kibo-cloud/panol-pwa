// Los roles, permisos y límites de la app coinciden con los del servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as web from '../src/state/constants.js';
import * as server from '../../server/src/domain/constants.js';

test('roles, permisos, límites y tipos de movimiento iguales al servidor', () => {
  assert.deepEqual(web.ROLE_KEYS, server.ROLE_KEYS);
  assert.deepEqual(web.PERMS.map(([k]) => k), server.PERMS.map(([k]) => k));
  assert.deepEqual(web.LIM, server.LIM);
  assert.deepEqual(web.MV, server.MV);
});
