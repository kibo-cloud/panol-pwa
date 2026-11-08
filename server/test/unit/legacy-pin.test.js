import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyLegacyPin, pbkdf2Hash, sha256Hash, fnvHash, isLegacyPinHash } from '../../src/application/legacy-pin.js';

test('PIN de 2.1: pbkdf2$210000', async () => {
  const h = await pbkdf2Hash('salt-a', '1234', 210000);
  // Mismo cálculo que crypto.subtle.deriveBits(PBKDF2, SHA-256, 256 bits) de 2.1.
  assert.equal(h, `pbkdf2$210000$${crypto.pbkdf2Sync('1234', 'salt-a', 210000, 32, 'sha256').toString('hex')}`);
  assert.equal(await verifyLegacyPin('1234', 'salt-a', h), true);
  assert.equal(await verifyLegacyPin('1235', 'salt-a', h), false);
  assert.equal(await verifyLegacyPin('1234', 'salt-b', h), false);
});

test('pbkdf2 con iteraciones fuera de rango: no se acepta', async () => {
  const h = await pbkdf2Hash('s', '1234', 9999);
  assert.equal(await verifyLegacyPin('1234', 's', h.replace('$9999$', '$09999$')), false);
});

test('PIN de 2.0.0: sha256 y fnv', async () => {
  const s = sha256Hash('salt1', '1234');
  assert.match(s, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await verifyLegacyPin('1234', 'salt1', s), true);
  assert.equal(await verifyLegacyPin('4321', 'salt1', s), false);
  const f = fnvHash('fnvsalt', '9999');
  assert.equal(await verifyLegacyPin('9999', 'fnvsalt', f), true);
  assert.equal(await verifyLegacyPin('9998', 'fnvsalt', f), false);
  assert.equal(isLegacyPinHash(s) && isLegacyPinHash(f), true);
  assert.equal(isLegacyPinHash('md5:abc'), false);
});
