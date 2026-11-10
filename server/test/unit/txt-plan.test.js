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

// E5.V1: un registro eliminado definitivamente en el servidor (marca propia) no vuelve a crearse
// desde un archivo que todavía lo tiene: se informa como conflicto.
test('combinar no revive lo eliminado definitivamente en el servidor', async () => {
  const { planImport } = await import('../../src/importers/txt-v2/plan.js');
  const admin = { name: 'Admin', role: 'admin', active: true, username: 'admin' };
  const sdoc = checkData({ users: { 'u-admin': admin } }).data;
  const file = checkData({
    users: { 'u-admin': admin, 'u-borrado': { name: 'Borrado', role: 'consulta', active: true } },
    techs: { 't-borrado': { name: 'Técnico borrado', legajo: 'B-1' }, 't-nuevo': { name: 'Nuevo', legajo: 'N-1' } },
    categories: { 'cat-borrada': { name: 'Borrada' } },
    tools: { 'tool-borrada': { name: 'Borrada', categoryId: null } },
  });
  const tombstones = { 'techs/t-borrado': '2026-01-01T00:00:00.000Z', 'tools/tool-borrada': '2026-01-01T00:00:00.000Z', 'categories/cat-borrada': '2026-01-01T00:00:00.000Z', 'users/u-borrado': '2026-01-01T00:00:00.000Z' };
  const p = planImport({ doc: sdoc, creds: { 'u-admin': { hasPassword: true } }, ledger: { movements: 0, controls: 0 }, tombstones }, { data: file.data, deleted: {} }, { mode: 'merge', actorId: 'u-admin' });
  assert.deepEqual(Object.keys(p.changes.techs.create), ['t-nuevo']);
  for (const c of ['tools', 'categories', 'users']) assert.deepEqual(Object.keys(p.changes[c].create), [], c);
  const ids = p.conflicts.filter((c) => /eliminado definitivamente/.test(c.message)).map((c) => `${c.collection}/${c.id}`).sort();
  assert.deepEqual(ids, Object.keys(tombstones).sort());
});
