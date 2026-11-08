// Manejador común de errores HTTP: bloqueo mutuo o choque de serialización -> 409 reintentar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from '../../src/adapters/http/errors.js';

const fakeReply = () => {
  const r = { status: null, body: null, headers: {} };
  r.code = (s) => ((r.status = s), r);
  r.send = (b) => ((r.body = b), r);
  r.header = (k, v) => ((r.headers[k] = v), r);
  return r;
};
const req = { log: { error() {} } };

test('bloqueo mutuo (40P01) y choque de serialización (40001) de PostgreSQL: 409 retry', () => {
  for (const code of ['40P01', '40001']) {
    const err = Object.assign(new Error('deadlock detected'), { code });
    const r = errorHandler(err, req, fakeReply());
    assert.equal(r.status, 409, code);
    assert.equal(r.body.error, 'retry');
    assert.match(r.body.message, /al mismo tiempo\. Probá de nuevo/);
    assert.doesNotMatch(r.body.message, /deadlock/);
  }
});

test('otro error de la base sigue siendo 500 sin detalles', () => {
  const r = errorHandler(Object.assign(new Error('boom'), { code: '23502' }), req, fakeReply());
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'internal');
});
