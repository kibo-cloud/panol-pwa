import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveUsername, stamp } from '../../src/importers/txt-v2/plan.js';
import { parseTxt, checkData } from '../../src/importers/txt-v2/validate.js';

test('nombre de usuario derivado: minúsculas, sin acentos, puntos y sufijo único', () => {
  const taken = new Set(['ana.admin']);
  assert.equal(deriveUsername('Ana Admin', taken), 'ana.admin2');
  assert.equal(deriveUsername('Ana Admin', taken), 'ana.admin3');
  assert.equal(deriveUsername('  Rocío Núñez-Peña ', taken), 'rocio.nunez.pena');
  assert.equal(deriveUsername('Jo', taken), 'jo.usuario');
  assert.equal(deriveUsername('!!!', taken), 'usuario');
  assert.match(deriveUsername('x'.repeat(80), taken), /^x{55}$/);
});

test('la fecha de un registro es la de 2.1: updatedAt, finishedAt, at o createdAt', () => {
  assert.equal(stamp({ updatedAt: '2026-01-02T00:00:00.000Z', createdAt: '2025-01-01T00:00:00.000Z' }), Date.parse('2026-01-02T00:00:00.000Z'));
  assert.equal(stamp({ at: '2026-01-03T00:00:00Z' }), Date.parse('2026-01-03T00:00:00Z'));
  assert.equal(stamp({}), -Infinity);
});

test('lector: solo versión 2 y fechas vacías solo en campos opcionales', () => {
  const file = (version, data) => 'PAÑOL\r\n' + JSON.stringify({ app: 'panol', version, data });
  assert.throws(() => parseTxt(file(1, { techs: { t1: { name: 'A' } } })), { code: 'unsupported_version' });
  const p = parseTxt(file(2, { techs: { t1: { name: 'A', alta: '' } }, movements: { m1: { type: 'ingreso', at: '' } } }));
  const r = checkData(p.data);
  assert.equal(r.data.techs.t1.alta, null);
  assert.deepEqual(r.errors.map((e) => [e.collection, e.id, e.field]), [['movements', 'm1', 'at']]);
});
