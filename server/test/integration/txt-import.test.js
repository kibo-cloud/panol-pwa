// Importador y exportación del .txt v2 (E1.T5), contra PostgreSQL y con el rol de la app.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupApp } from './harness.js';
import { hashPassword } from '../../src/application/passwords.js';
import { ROOT_DIR } from '../../src/config.js';
import { buildV21, toTxt, HEAD } from '../fixtures/v21.js';

const PW = 'clave-importador-1';
const FIX = path.join(ROOT_DIR, 'tests', 'e2e', 'fixtures');
const legacy = () => fs.readFileSync(path.join(FIX, 'legacy-2.0.0.txt'), 'utf8');
let ctx;
let app;
const q = async (sql, p) => (await ctx.pool.query(sql, p)).rows;
const sessions = {};

function cookieOf(res) {
  const c = [].concat(res.headers['set-cookie'] || []).find((x) => x.startsWith('panol_sid='));
  return c ? c.split(';')[0] : null;
}
const login = (username, password) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
async function as(username, password = PW) {
  if (sessions[username]) return sessions[username];
  const r = await login(username, password);
  assert.equal(r.statusCode, 200, `${username}: ${r.body}`);
  return (sessions[username] = { cookie: cookieOf(r), csrf: r.json().csrfToken });
}
const H = (s) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf });
async function importTxt(text, { mode = 'merge', dryRun = false, token, user = 'importador', type = 'text/plain' } = {}) {
  const s = await as(user);
  const qs = new URLSearchParams({ mode, ...(dryRun ? { dryRun: '1' } : {}), ...(token ? { token } : {}) });
  return app.inject({ method: 'POST', url: `/api/import/txt?${qs}`, headers: { ...H(s), 'content-type': type }, payload: text });
}
async function dryRun(text, mode = 'merge') {
  const r = await importTxt(text, { mode, dryRun: true });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function apply(text, mode = 'merge') {
  const rep = await dryRun(text, mode);
  assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
  const r = await importTxt(text, { mode, token: rep.token });
  assert.equal(r.statusCode, 200, r.body);
  return { dry: rep, res: r.json() };
}
async function exportTxt(user = 'importador') {
  const s = await as(user);
  return app.inject({ method: 'GET', url: '/api/export/txt', headers: { cookie: s.cookie } });
}
const fileWith = (mut) => {
  const p = buildV21();
  mut(p.data, p);
  return toTxt(p);
};
const count = async (table, where = 'true') => (await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n;

before(async () => {
  ctx = await setupApp({ env: { APP_ORIGIN: 'http://localhost' } });
  app = ctx.app;
  const hash = await hashPassword(PW);
  await q("INSERT INTO users (id, username, name, role, password_hash, must_change_password) VALUES ('u-imp', 'importador', 'Quien Importa', 'admin', $1, false), ('u-con', 'consulta1', 'Consulta Uno', 'consulta', $1, false)", [hash]);
});
after(async () => {
  await ctx?.close();
});

describe('permisos y formato', () => {
  test('solo un administrador importa o exporta', async () => {
    assert.equal((await importTxt(toTxt(buildV21()), { dryRun: true, user: 'consulta1' })).statusCode, 403);
    assert.equal((await exportTxt('consulta1')).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/export/txt' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/import/txt?mode=merge&dryRun=1', headers: { 'content-type': 'text/plain' }, payload: 'x' })).statusCode, 401);
  });

  test('solo versión 2: otras versiones, sin versión, basura y claves prohibidas se rechazan', async () => {
    for (const v of [1, 3, '2', undefined]) {
      const r = await importTxt(fileWith((d, p) => { p.version = v; }), { dryRun: true });
      assert.equal(r.statusCode, 422, String(v));
      assert.equal(r.json().error, 'unsupported_version');
      assert.match(r.json().message, /versión 2/);
    }
    const proto = await importTxt(fs.readFileSync(path.join(FIX, 'proto-key.txt'), 'utf8'), { dryRun: true });
    assert.equal(proto.statusCode, 422);
    assert.match(proto.json().message, /formato no válido/);
    for (const f of ['garbage.txt', 'data-array.txt', 'data-empty.txt']) {
      assert.equal((await importTxt(fs.readFileSync(path.join(FIX, f), 'utf8') || ' ', { dryRun: true })).statusCode, 422, f);
    }
    assert.equal((await importTxt(JSON.stringify(buildV21()), { dryRun: true, type: 'application/json' })).statusCode, 415);
  });

  test('límite de tamaño de 2.1 (20 MB)', async () => {
    const big = toTxt(buildV21()) + ' '.repeat(20 * 1024 * 1024);
    const r = await importTxt(big, { dryRun: true });
    assert.equal(r.statusCode, 413);
    assert.equal(r.json().error, 'too_large');
  });
});

describe('reemplazar (migración inicial)', () => {
  test('informe sin escribir nada: conteos, usuarios generados, fechas vacías opcionales', async () => {
    const rep = await dryRun(toTxt(buildV21()), 'replace');
    assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
    assert.match(rep.token, /^[0-9a-f]{64}$/);
    assert.equal(rep.counts.techs.create, 2);
    assert.equal(rep.counts.users.create, 3);
    assert.equal(rep.counts.users.delete, 1); // consulta1 no está en el archivo
    assert.equal(rep.counts.movements.create, 4);
    assert.equal(rep.counts.controls.create, 2);
    assert.deepEqual(rep.changes.shifts.create.ids, ['rotativo']);
    assert.deepEqual(rep.changes.shifts.delete.ids, ['noche']);
    assert.equal(rep.permissionsChange, true);
    assert.deepEqual(rep.newUsers.map((u) => [u.id, u.username, u.pin]).sort(), [['u21admin', 'ana.admin', 'pbkdf2'], ['u21cons', 'ana.admin2', 'pbkdf2'], ['u21resp', 'rocio.nunez', 'pbkdf2']]);
    assert.ok(rep.assumptions.some((a) => a.collection === 'users' && a.field === 'username'));
    assert.doesNotMatch(JSON.stringify(rep), /pbkdf2\$|salt-u21/);
    assert.equal(await count('techs'), 0);
    assert.equal(await count('movements'), 0);
  });

  test('confirmar exige el token del informe y que siga vigente', async () => {
    assert.equal((await importTxt(toTxt(buildV21()), { mode: 'replace' })).statusCode, 400);
    const r = await importTxt(toTxt(buildV21()), { mode: 'replace', token: 'a'.repeat(64) });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'import_changed');
    assert.ok(r.json().report.token);
    assert.equal(await count('techs'), 0);
  });

  test('sin administrador activo en el archivo: no se puede', async () => {
    const rep = await dryRun(fileWith((d) => { d.users.u21admin.active = false; }), 'replace');
    assert.equal(rep.canApply, false);
    assert.match(rep.errors[0].message, /administrador activo/);
  });

  test('aplica en una transacción: ids de 2.1, libro con fecha original, fechas vacías nulas', async () => {
    const { res } = await apply(toTxt(buildV21()), 'replace');
    assert.equal(res.applied, true);
    assert.equal(await count('techs'), 2);
    assert.equal(await count('movements', 'imported'), 4);
    assert.equal(await count('movement_transfers'), 5);
    const [m] = await q("SELECT at FROM movements WHERE id = 'm21e1'");
    assert.equal(m.at.toISOString(), '2026-09-02T09:00:00.000Z');
    const [t] = await q("SELECT alta, legajo, plantilla_on(id, current_date) AS plantilla FROM techs WHERE id = 't21b'");
    assert.deepEqual(t, { alta: null, legajo: '2102', plantilla: 'rotativo' });
    // Etapa 2: los turnos son plantillas y el cambio de turno sc21 pasa al historial.
    const h = await q("SELECT id, plantilla_id, valid_from::text AS f, valid_to::text AS t, created_at FROM tech_plantilla_history WHERE tech_id = 't21b' ORDER BY valid_from NULLS FIRST");
    assert.deepEqual(h.map((r) => [r.plantilla_id, r.f, r.t]), [['manana', null, '2026-09-01'], ['rotativo', '2026-09-01', null]]);
    assert.equal(h[1].id, 'sc21');
    assert.equal(await count('shift_changes'), 0);
    assert.equal((await q("SELECT until FROM assignments WHERE id = 'a21m'"))[0].until, null);
    const ctl = await q("SELECT id, status, imported, started_at FROM controls ORDER BY id");
    assert.deepEqual(ctl.map((c) => [c.id, c.status, c.imported]), [['c21d', 'borrador', true], ['c21f', 'finalizado', true]]);
    assert.equal(ctl[0].started_at, null);
    assert.equal(await count('control_items', "control_id = 'c21f'"), 2);
    assert.deepEqual((await q('SELECT id FROM plantillas WHERE archived_at IS NULL ORDER BY sort_order')).map((s) => s.id), ['manana', 'tarde', 'rotativo']);
    assert.equal(await count('plantillas', "id = 'noche' AND archived_at IS NOT NULL"), 1);
    // Foto de la plantilla en los controles importados (c21f: t21a en manana).
    assert.equal((await q("SELECT plantilla_id_snapshot AS p FROM controls WHERE id = 'c21f'"))[0].p, 'manana');
    assert.deepEqual(await q('SELECT role, perm, allowed FROM role_permissions ORDER BY role'), [{ role: 'consulta', perm: 'reports_export', allowed: false }, { role: 'responsable', perm: 'shift_change', allowed: true }]);
    const users = await q('SELECT id, username, password_hash, must_change_password, legacy_pin_hash FROM users ORDER BY id COLLATE "C"');
    assert.deepEqual(users.map((u) => u.id), ['u-imp', 'u21admin', 'u21cons', 'u21resp']);
    for (const u of users.filter((x) => x.id.startsWith('u21'))) {
      assert.equal(u.password_hash, null);
      assert.equal(u.must_change_password, true);
      assert.match(u.legacy_pin_hash, /^pbkdf2\$210000\$/);
    }
    assert.equal(await count('audit_log', "id = 'l21a' AND imported"), 1);
    const [a] = await q("SELECT detail FROM audit_log WHERE action = 'import_txt'");
    assert.match(a.detail, /reemplazar/);
    // La sesión de quien importó sigue.
    assert.equal((await app.inject({ method: 'GET', url: '/api/state', headers: { cookie: sessions.importador.cookie } })).statusCode, 200);
  });

  test('con movimientos en el servidor, reemplazar se rechaza', async () => {
    const rep = await dryRun(toTxt(buildV21()), 'replace');
    assert.equal(rep.canApply, false);
    assert.match(rep.errors.map((e) => e.message).join(' '), /migración inicial/);
  });
});

describe('usuarios con PIN', () => {
  test('pbkdf2: el PIN sirve como contraseña temporal y obliga a cambiarla', async () => {
    assert.equal((await login('ana.admin', '9999')).statusCode, 401);
    const r = await login('ana.admin', '1234');
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().mustChangePassword, true);
    const s = { cookie: cookieOf(r), csrf: r.json().csrfToken };
    assert.equal((await app.inject({ method: 'GET', url: '/api/state', headers: { cookie: s.cookie } })).statusCode, 403);
    const ch = await app.inject({ method: 'POST', url: '/api/auth/change-password', headers: H(s), payload: { currentPassword: '1234', newPassword: 'clave-nueva-ana-1' } });
    assert.equal(ch.statusCode, 200, ch.body);
    const [u] = await q("SELECT password_hash, legacy_salt, legacy_pin_hash, must_change_password FROM users WHERE id = 'u21admin'");
    assert.match(u.password_hash, /^\$argon2id\$/);
    assert.equal(u.legacy_salt, null);
    assert.equal(u.legacy_pin_hash, null);
    assert.equal(u.must_change_password, false);
    assert.equal((await login('ana.admin', '1234')).statusCode, 401);
    assert.equal((await login('ana.admin', 'clave-nueva-ana-1')).statusCode, 200);
  });

  test('el bloqueo progresivo vale igual con el PIN', async () => {
    let last;
    for (let i = 0; i < 5; i++) last = await login('rocio.nunez', '0001');
    assert.equal(last.statusCode, 429);
    assert.equal((await login('rocio.nunez', '5678')).statusCode, 429);
    await q("UPDATE login_locks SET locked_until = now() - interval '1 second' WHERE username = 'rocio.nunez'");
    assert.equal((await login('rocio.nunez', '5678')).statusCode, 200);
  });

  test('2.0.0: PIN sha256 y fnv (Combinar el archivo legado)', async () => {
    const { dry } = await apply(legacy());
    assert.equal(dry.counts.users.create, 3);
    const names = Object.fromEntries(dry.newUsers.map((u) => [u.name, [u.username, u.pin]]));
    assert.deepEqual(names, { 'Ana Admin': ['ana.admin3', 'sha256'], 'Rita Resp': ['rita.resp', 'sha256'], 'Fede Fnv': ['fede.fnv', 'fnv'] });
    for (const [u, pin] of [['ana.admin3', '1234'], ['rita.resp', '5678'], ['fede.fnv', '9999']]) {
      assert.equal((await login(u, pin + '0')).statusCode, 401, u);
      const r = await login(u, pin);
      assert.equal(r.statusCode, 200, `${u}: ${r.body}`);
      assert.equal(r.json().mustChangePassword, true);
    }
    // Datos del archivo legado con el flag demo, libro con su fecha original.
    assert.ok((await count('movements', 'demo AND imported')) > 0);
  });
});

describe('combinar', () => {
  // Parte del estado actual exportado, para tener las fechas del servidor.
  async function current() {
    const r = await exportTxt();
    const t = r.body;
    return JSON.parse(t.slice(t.indexOf('{')));
  }
  const soon = () => new Date(Date.now() + 3600e3).toISOString();

  test('gana lo más nuevo, el empate queda como está, lo viejo no pisa', async () => {
    const p = await current();
    const d = p.data;
    d.techs.t21a = { ...d.techs.t21a, name: 'Tomás Nuevo', updatedAt: soon() };
    d.techs.t21b = { ...d.techs.t21b, name: 'Berta Empate' };
    d.categories.g21 = { ...d.categories.g21, name: 'Vieja', updatedAt: '2020-01-01T00:00:00.000Z' };
    const { dry } = await apply(toTxt(p));
    assert.deepEqual(dry.changes.techs.update.ids, ['t21a']);
    assert.equal(dry.counts.categories.update, 0);
    assert.equal((await q("SELECT name FROM techs WHERE id = 't21a'"))[0].name, 'Tomás Nuevo');
    assert.equal((await q("SELECT name FROM techs WHERE id = 't21b'"))[0].name, 'Berta Dos');
    assert.equal((await q("SELECT name FROM categories WHERE id = 'g21'"))[0].name, 'Manuales');
  });

  test('borrados: el más nuevo elimina, el más viejo no; el libro y lo finalizado no se borran', async () => {
    const p = await current();
    const res = p.data.alertRes['cambio-a21m-c21f'];
    p.data.deleted = {
      'alertRes/cambio-a21m-c21f': soon(),
      'shiftChanges/sc21': '2020-01-01T00:00:00.000Z',
      'movements/m21i1': soon(),
      'controls/c21f': soon(),
    };
    delete p.data.alertRes['cambio-a21m-c21f'];
    assert.ok(res);
    const { dry } = await apply(toTxt(p));
    assert.deepEqual(dry.changes.alertRes.delete.ids, ['cambio-a21m-c21f']);
    assert.deepEqual(dry.conflicts.map((c) => c.collection + '/' + c.id).sort(), ['controls/c21f', 'movements/m21i1']);
    assert.equal(await count('alert_resolutions', "key = 'cambio-a21m-c21f'"), 0);
    // Etapa 2: el cambio de turno vive en el historial de pertenencia (nunca se borra).
    assert.equal(await count('tech_plantilla_history', "id = 'sc21'"), 1);
    assert.equal(await count('movements', "id = 'm21i1'"), 1);
  });

  test('libro de solo agregar: un movimiento o un control finalizado distinto es un conflicto', async () => {
    const p = await current();
    p.data.movements.m21i1 = { ...p.data.movements.m21i1, qty: 50, notes: 'Cambiado' };
    p.data.controls.c21f = { ...p.data.controls.c21f, updatedAt: soon(), counts: { bueno: 0, cambio: 2, faltante: 0 } };
    p.data.movements.m21new = { type: 'ingreso', toolId: 'h21p', qty: 1, transfers: [{ toolId: 'h21p', qty: 1, from: 'externo', to: 'disponible', unitId: null }], at: '2026-10-03T09:00:00.000Z' };
    const { dry } = await apply(toTxt(p));
    assert.deepEqual(dry.conflicts.map((c) => c.collection + '/' + c.id).sort(), ['controls/c21f', 'movements/m21i1']);
    assert.deepEqual(dry.changes.movements.create.ids, ['m21new']);
    assert.equal((await q("SELECT qty FROM movements WHERE id = 'm21i1'"))[0].qty, 5);
    assert.equal((await q("SELECT at FROM movements WHERE id = 'm21new'"))[0].at.toISOString(), '2026-10-03T09:00:00.000Z');
  });

  test('fechas más de un día en el futuro cuentan como ahora', async () => {
    const p = await current();
    p.data.categories.g21fut = { name: 'Del futuro', createdAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
    await apply(toTxt(p));
    const [g] = await q("SELECT updated_at FROM categories WHERE id = 'g21fut'");
    assert.ok(g.updated_at.getTime() < Date.now() + 864e5, g.updated_at.toISOString());
  });
});

describe('fechas vacías', () => {
  test('una fecha obligatoria vacía es un error del informe y no se aplica nada', async () => {
    const text = fileWith((d) => {
      d.movements.m21bad = { type: 'ingreso', toolId: 'h21p', qty: 1, transfers: [], at: '' };
      d.audit.l21bad = { action: 'x', at: '' };
      d.techs.t21c = { name: 'Fecha vacía opcional', alta: '' };
    });
    const rep = await dryRun(text);
    assert.equal(rep.canApply, false);
    assert.equal(rep.token, null);
    const e = rep.errors.map((x) => [x.collection, x.id, x.field]);
    assert.deepEqual(e.sort(), [['audit', 'l21bad', 'at'], ['movements', 'm21bad', 'at']]);
    assert.match(rep.errors[0].message, /obligatoria/);
    const r = await importTxt(text, { token: 'b'.repeat(64) });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error, 'import_invalid');
    assert.equal(await count('techs', "id = 't21c'"), 0);
  });

  test('un control finalizado sin fecha de cierre es un error', async () => {
    const rep = await dryRun(fileWith((d) => { d.controls.c21f.finishedAt = ''; }));
    assert.deepEqual(rep.errors.map((x) => [x.collection, x.id, x.field]), [['controls', 'c21f', 'finishedAt']]);
  });
});

describe('exportar', () => {
  test('.txt v2 compatible con 2.1, sin credenciales, y auditado', async () => {
    const r = await exportTxt();
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-type'], /^text\/plain/);
    assert.match(r.headers['content-disposition'], /attachment; filename="panol-\d{4}-\d{2}-\d{2}\.txt"/);
    assert.ok(r.body.startsWith(HEAD));
    const p = JSON.parse(r.body.slice(r.body.indexOf('{')));
    assert.deepEqual([p.app, p.format, p.version], ['panol', 'panol-txt', 2]);
    assert.deepEqual(p.data.deleted, {});
    for (const c of ['techs', 'shiftChanges', 'categories', 'tools', 'units', 'assignments', 'controls', 'movements', 'alertRes', 'audit', 'users', 'config']) assert.ok(p.data[c], c);
    for (const u of Object.values(p.data.users)) {
      assert.deepEqual(Object.keys(u).filter((k) => /salt|hash|pin|password/i.test(k)), []);
    }
    assert.doesNotMatch(r.body, /argon2|pbkdf2\$|sha256:[0-9a-f]|fnv:[0-9a-f]|legacy_|legacyPin|pinHash|"salt"/);
    assert.equal(await count('audit_log', "action = 'export_txt'") > 0, true);
  });

  test('ida y vuelta: exportar y revisar la importación no da cambios', async () => {
    const r = await exportTxt();
    const rep = await dryRun(r.body);
    assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
    assert.equal(rep.totalChanges, 0, JSON.stringify(rep.changes));
    assert.equal(rep.conflictCount, 0, JSON.stringify(rep.conflicts));
  });
});
