// Correcciones de seguridad (E1.V1): carreras en la base, rol de la app sin privilegios de
// dueño, sesión al ingresar y al cambiar la contraseña, If-Match en usuarios.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { DEV_PASSWORD } from '../../scripts/seed.js';

let api;
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (p) => p.then(() => 'ok', (e) => e.code);

function cookieOf(res) {
  const c = [].concat(res.headers['set-cookie'] || []).find((x) => x.startsWith('panol_sid='));
  return c ? c.split(';')[0] : null;
}
const rawLogin = (username, password = DEV_PASSWORD, cookie) =>
  api.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, headers: cookie ? { cookie } : {} });

describe('carreras en la base', () => {
  test('un ítem no entra en un control que otra transacción está finalizando', async () => {
    const [draft] = await api.q("SELECT id FROM controls WHERE status = 'borrador' LIMIT 1");
    const a = await api.pool.connect();
    const b = await api.pool.connect();
    try {
      await a.query('BEGIN');
      await a.query("UPDATE controls SET status = 'finalizado', finished_at = now() WHERE id = $1", [draft.id]);
      const insert = codeOf(b.query("INSERT INTO control_items (control_id, assignment_id, state, qty) VALUES ($1, 'a-carrera', 'bueno', 1)", [draft.id]));
      await sleep(300);
      await a.query('COMMIT');
      assert.equal(await insert, '23001');
    } finally {
      a.release();
      b.release();
    }
  });

  test('un borrador no cambia de técnico, período ni tipo', async () => {
    await api.q("INSERT INTO controls (id, tech_id, period_y, period_m, period_w, status) VALUES ('c-guard', 't-ana', 2030, 1, 1, 'borrador')");
    const [orig] = await api.q("SELECT id FROM controls WHERE status = 'finalizado' LIMIT 1");
    const upd = (set, p = []) => codeOf(api.pool.query(`UPDATE controls SET ${set} WHERE id = 'c-guard'`, p));
    assert.equal(await upd("tech_id = 't-bruno'"), '23001');
    assert.equal(await upd('period_w = 2'), '23001');
    assert.equal(await upd('period_m = 2'), '23001');
    assert.equal(await upd('period_y = 2031'), '23001');
    assert.equal(await upd('correction = true, supersedes_id = $1', [orig.id]), '23001');
    assert.equal(await upd("tech_name = 'Otro nombre'"), 'ok');
  });

  test('ingresos fallidos en paralelo: a lo sumo 5 verificaciones antes del bloqueo', async () => {
    const res = await Promise.all(Array.from({ length: 12 }, () => rawLogin('responsable2', 'clave-incorrecta-1')));
    for (const r of res) assert.ok([401, 429].includes(r.statusCode), String(r.statusCode));
    const [n] = await api.q("SELECT count(*)::int AS n FROM login_attempts WHERE username = 'responsable2' AND outcome = 'fail'");
    assert.ok(n.n <= 5, `verificaciones: ${n.n}`);
    const [lock] = await api.q("SELECT fails FROM login_locks WHERE username = 'responsable2'");
    assert.equal(lock.fails, 5);
  });
});

describe('rol de la aplicación', () => {
  test('la app se conecta con un rol sin privilegios de dueño', async () => {
    assert.ok(api.appPool, 'el harness expone el pool de la app');
    const [{ u }] = (await api.appPool.query('SELECT current_user AS u')).rows;
    assert.equal(u, 'panol_app');
    const denied = { code: '42501' };
    await assert.rejects(api.appPool.query("UPDATE movements SET notes = 'x'"), denied);
    await assert.rejects(api.appPool.query('DELETE FROM movement_transfers'), denied);
    await assert.rejects(api.appPool.query("UPDATE audit_log SET detail = 'x'"), denied);
    await assert.rejects(api.appPool.query('DELETE FROM audit_log'), denied);
    await assert.rejects(api.appPool.query('TRUNCATE movements'), denied);
    await assert.rejects(api.appPool.query('SELECT * FROM schema_migrations'), denied);
    const c = await api.appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('panol.demo_clear', 'on', true)");
      await assert.rejects(c.query('DELETE FROM movements WHERE demo'), denied);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  test('cargar y borrar la demostración sigue funcionando con el rol de la app', async () => {
    assert.equal((await api.call('admin', 'POST', '/api/demo')).statusCode, 201);
    const del = await api.call('admin', 'DELETE', '/api/demo');
    assert.equal(del.statusCode, 200, del.body);
    assert.ok(del.json().deleted.movements > 0);
    const [n] = await api.q('SELECT count(*)::int AS n FROM movements WHERE demo');
    assert.equal(n.n, 0);
    // Los movimientos reales siguen ahí.
    const [r] = await api.q('SELECT count(*)::int AS n FROM movements');
    assert.ok(r.n > 0);
  });
});

describe('sesiones', () => {
  test('ingresar con una cookie previa cierra esa sesión', async () => {
    const first = await rawLogin('supervisor');
    const c1 = cookieOf(first);
    const second = await rawLogin('supervisor', DEV_PASSWORD, c1);
    const c2 = cookieOf(second);
    assert.notEqual(c1, c2);
    assert.equal((await api.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c1 } })).statusCode, 401);
    assert.equal((await api.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c2 } })).statusCode, 200);
  });

  test('cambiar la contraseña renueva el identificador de sesión', async () => {
    const r = await rawLogin('consulta');
    const old = cookieOf(r);
    const csrf = r.json().csrfToken;
    const ch = await api.app.inject({
      method: 'POST', url: '/api/auth/change-password', headers: { cookie: old, 'x-csrf-token': csrf },
      payload: { currentPassword: DEV_PASSWORD, newPassword: 'otra-clave-segura-1' },
    });
    assert.equal(ch.statusCode, 200, ch.body);
    const fresh = cookieOf(ch);
    assert.ok(fresh && fresh !== old);
    assert.notEqual(ch.json().csrfToken, csrf);
    assert.equal((await api.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: old } })).statusCode, 401);
    assert.equal((await api.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: fresh } })).statusCode, 200);
  });
});

describe('usuarios', () => {
  test('las rutas que modifican un usuario exigen If-Match', async () => {
    for (const [method, url, body] of [
      ['PATCH', '/api/users/u-responsable', { name: 'Sin versión' }],
      ['POST', '/api/users/u-responsable/deactivate'],
      ['POST', '/api/users/u-responsable/reactivate'],
      ['POST', '/api/users/u-responsable/reset-password'],
    ]) {
      const r = await api.call('admin', method, url, body);
      assert.equal(r.statusCode, 428, `${method} ${url}`);
    }
    const [u] = await api.q("SELECT version FROM users WHERE id = 'u-responsable'");
    const stale = await api.call('admin', 'POST', '/api/users/u-responsable/reset-password', undefined, ifMatch(u.version + 5));
    assert.equal(stale.statusCode, 409);
    const ok = await api.call('admin', 'POST', '/api/users/u-responsable/reset-password', undefined, ifMatch(u.version));
    assert.equal(ok.statusCode, 200, ok.body);
  });

  test('dos bajas de administrador en paralelo no dejan el sistema sin administradores', async () => {
    await api.q("INSERT INTO users (id, username, name, role, password_hash, must_change_password) SELECT 'u-admin2', 'admin2', 'Admin Dos', 'admin', password_hash, false FROM users WHERE id = 'u-admin'");
    await api.login('admin');
    const vers = Object.fromEntries((await api.q("SELECT id, version FROM users WHERE id IN ('u-admin', 'u-admin2')")).map((r) => [r.id, r.version]));
    const t = await api.pool.connect();
    try {
      await t.query('BEGIN');
      await t.query("SELECT 1 FROM users WHERE id = 'u-admin' FOR UPDATE");
      const r1 = api.call('admin', 'PATCH', '/api/users/u-admin', { role: 'consulta' }, ifMatch(vers['u-admin']));
      await sleep(300);
      const r2 = api.call('admin', 'PATCH', '/api/users/u-admin2', { role: 'consulta' }, ifMatch(vers['u-admin2']));
      await sleep(300);
      await t.query('COMMIT');
      const codes = (await Promise.all([r1, r2])).map((r) => r.statusCode).sort();
      assert.deepEqual(codes, [200, 409]);
      const [n] = await api.q("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active");
      assert.equal(n.n, 1);
    } finally {
      t.release();
      await api.q("UPDATE users SET role = 'admin' WHERE id IN ('u-admin', 'u-admin2')");
    }
  });
});
