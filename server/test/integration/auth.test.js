import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp } from './harness.js';
import { hashPassword } from '../../src/application/passwords.js';
import { buildApp } from '../../src/app.js';

const PW = 'clave-de-prueba-1';
let ctx;
let app;
let q;

// Rutas solo de prueba, protegidas con las mismas guardas que usarán las rutas reales.
function extend(a) {
  a.get('/api/test/shift', { preHandler: a.requirePerm('shift_change') }, async () => ({ ok: true }));
  a.post('/api/test/control', { preHandler: a.requirePerm('controls_do') }, async () => ({ ok: true }));
  a.get('/api/test/any', async () => ({ ok: true }));
}

async function addUser(id, username, role, { active = true, mustChange = false } = {}) {
  await q('INSERT INTO users (id, username, name, role, active, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, username, `Usuario ${username}`, role, active, await hashPassword(PW), mustChange]);
}

function cookieOf(res) {
  const sc = [].concat(res.headers['set-cookie'] || []);
  const c = sc.find((x) => x.startsWith('panol_sid='));
  return c ? { header: c, value: c.split(';')[0] } : null;
}

async function login(username, password = PW, extra = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, ...extra.body }, headers: extra.headers });
  const c = cookieOf(res);
  return { res, cookie: c?.value, setCookie: c?.header, csrf: res.statusCode === 200 ? res.json().csrfToken : null };
}

// If-Match con la versión vigente del usuario.
const ver = async (id) => ({ 'if-match': `"${(await q('SELECT version FROM users WHERE id = $1', [id])).rows[0].version}"` });
const as = (s) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf });
const get = (url, s) => app.inject({ method: 'GET', url, headers: s ? { cookie: s.cookie } : {} });
const send = (method, url, s, payload, headers = {}) => app.inject({ method, url, headers: { ...as(s), ...headers }, ...(payload !== undefined ? { payload } : {}) });

before(async () => {
  ctx = await setupApp({ extend, env: { APP_ORIGIN: 'http://localhost' } });
  app = ctx.app;
  q = (sql, p) => ctx.pool.query(sql, p);
  await addUser('u-adm', 'admin1', 'admin');
  await addUser('u-adm2', 'admin2', 'admin');
  await addUser('u-res', 'resp1', 'responsable');
  await addUser('u-sup', 'sup1', 'supervisor');
  await addUser('u-ger', 'ger1', 'gerencia');
  await addUser('u-con', 'cons1', 'consulta');
  await addUser('u-off', 'baja1', 'responsable', { active: false });
  await addUser('u-lock', 'lock1', 'responsable');
});
after(async () => {
  await ctx?.close();
});

describe('ingreso', () => {
  test('correcto: cookie httpOnly/Lax de sesión, csrf, permisos y sin hashes', async () => {
    const s = await login('ADMIN1');
    assert.equal(s.res.statusCode, 200);
    assert.match(s.setCookie, /HttpOnly/);
    assert.match(s.setCookie, /SameSite=Lax/);
    assert.match(s.setCookie, /Path=\//);
    assert.doesNotMatch(s.setCookie, /Max-Age|Expires/);
    const body = s.res.json();
    assert.equal(body.user.username, 'admin1');
    assert.equal(body.role, 'admin');
    assert.equal(body.mustChangePassword, false);
    assert.equal(typeof body.csrfToken, 'string');
    assert.equal(body.permissions.demo_manage, true);
    assert.doesNotMatch(s.res.body, /argon2|password_hash|passwordHash/);
    const me = await get('/api/auth/me', s);
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().csrfToken, body.csrfToken);
    assert.equal(me.headers['cache-control'], 'no-store');
    // Solo se guarda el hash del identificador de sesión.
    const { rows } = await q('SELECT encode(id_hash, $1) AS h FROM sessions', ['hex']);
    assert.ok(rows.every((r) => !s.cookie.includes(r.h)));
  });

  test('"Mantener la sesión" da una cookie persistente', async () => {
    const s = await login('resp1', PW, { body: { remember: true } });
    assert.equal(s.res.statusCode, 200);
    const age = Number(/Max-Age=(\d+)/.exec(s.setCookie)[1]);
    assert.ok(age > 29 * 86400 && age <= 30 * 86400, String(age));
  });

  test('error genérico: contraseña mala, usuario inexistente o inactivo', async () => {
    const msgs = [];
    for (const [u, p] of [['resp1', 'otra-clave-xx'], ['nadie', PW], ['baja1', PW]]) {
      const r = (await login(u, p)).res;
      assert.equal(r.statusCode, 401, u);
      msgs.push(r.json().message);
    }
    assert.deepEqual(new Set(msgs), new Set(['Usuario o contraseña incorrectos.']));
    const { rows } = await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'login_fail'");
    assert.ok(rows[0].n >= 3);
  });

  test('cuerpo inválido o tipos convertidos: 400', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'resp1' } });
    assert.equal(r1.statusCode, 400);
    const r2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'resp1', password: PW, remember: 'true' } });
    assert.equal(r2.statusCode, 400);
    const r3 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'resp1', password: PW, extra: 1 } });
    assert.equal(r3.statusCode, 400);
  });
});

describe('bloqueo progresivo', () => {
  test('5 fallos bloquean 30 s, se duplica y persiste en la base', async () => {
    for (let i = 1; i <= 4; i++) assert.equal((await login('lock1', 'mala-clave-0')).res.statusCode, 401, `intento ${i}`);
    const fifth = (await login('lock1', 'mala-clave-0')).res;
    assert.equal(fifth.statusCode, 429);
    assert.equal(fifth.json().error, 'locked');
    assert.equal(fifth.headers['retry-after'], '30');
    assert.match(fifth.json().message, /Esperá 30 s/);
    // Bloqueado: ni la contraseña correcta entra.
    assert.equal((await login('lock1')).res.statusCode, 429);
    // El bloqueo está en la base: otra instancia de la app (reinicio) lo respeta.
    const app2 = await buildApp({ config: app.config, pool: ctx.pool, logger: false });
    const r = await app2.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lock1', password: PW } });
    assert.equal(r.statusCode, 429);
    await app2.close();
    const { rows } = await q("SELECT fails, last_ip FROM login_locks WHERE username = 'lock1'");
    assert.equal(rows[0].fails, 5);
    assert.ok(rows[0].last_ip);
    const audit = await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'login_lockout' AND entity_id = 'u-lock'");
    assert.equal(audit.rows[0].n, 1);
    // Pasa el tiempo: el próximo fallo bloquea el doble.
    await q("UPDATE login_locks SET locked_until = now() - interval '1 second' WHERE username = 'lock1'");
    const sixth = (await login('lock1', 'mala-clave-0')).res;
    assert.equal(sixth.statusCode, 429);
    assert.equal(sixth.json().retryAfter, 60);
    // Vence otra vez y entra con la correcta: el contador se limpia.
    await q("UPDATE login_locks SET locked_until = now() - interval '1 second' WHERE username = 'lock1'");
    assert.equal((await login('lock1')).res.statusCode, 200);
    assert.equal((await q("SELECT count(*)::int AS n FROM login_locks WHERE username = 'lock1'")).rows[0].n, 0);
  });

  test('máximo 15 minutos', async () => {
    await q("INSERT INTO login_locks (username, fails) VALUES ('lock-max', 20)");
    const r = (await login('lock-max', 'x')).res;
    assert.equal(r.json().retryAfter, 900);
    assert.match(r.json().message, /15 min/);
  });

  test('también se bloquea un usuario inexistente (no revela cuáles existen)', async () => {
    let last;
    for (let i = 0; i < 5; i++) last = (await login('fantasma', 'x')).res;
    assert.equal(last.statusCode, 429);
    const { rows } = await q("SELECT count(*)::int AS n FROM login_attempts WHERE username = 'fantasma' AND outcome = 'fail'");
    assert.equal(rows[0].n, 5);
  });
});

describe('CSRF y origen', () => {
  test('sin token, con token ajeno, o desde otro origen: 403', async () => {
    const s = await login('cons1');
    const other = await login('cons1');
    const noTok = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: s.cookie } });
    assert.equal(noTok.statusCode, 403);
    assert.equal(noTok.json().error, 'csrf');
    assert.equal((await send('POST', '/api/auth/logout', { cookie: s.cookie, csrf: other.csrf })).statusCode, 403);
    assert.equal((await send('POST', '/api/auth/logout', s, undefined, { origin: 'https://malo.example' })).statusCode, 403);
    assert.equal((await send('POST', '/api/auth/logout', s, undefined, { 'sec-fetch-site': 'cross-site' })).statusCode, 403);
    assert.equal((await send('POST', '/api/auth/logout', s, undefined, { 'sec-fetch-site': 'same-site' })).statusCode, 403);
    const evil = await login('cons1', PW, { headers: { origin: 'https://malo.example' } });
    assert.equal(evil.res.statusCode, 403);
    // Mismo origen y token correcto: sale.
    const ok = await send('POST', '/api/auth/logout', s, undefined, { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' });
    assert.equal(ok.statusCode, 200);
    assert.equal((await get('/api/auth/me', s)).statusCode, 401);
    assert.equal((await get('/api/auth/me', other)).statusCode, 200);
  });

  test('un GET no exige token pero sí sesión', async () => {
    assert.equal((await get('/api/test/any')).statusCode, 401);
    const s = await login('cons1');
    assert.equal((await get('/api/test/any', s)).statusCode, 200);
  });
});

describe('cambio de contraseña obligatorio', () => {
  test('usuario nuevo con temporal: todo da 403 hasta que la cambia', async () => {
    const adm = await login('admin1');
    const c = await send('POST', '/api/users', adm, { username: 'Nuevo.Uno', name: '  Nuevo Uno ', role: 'responsable' });
    assert.equal(c.statusCode, 201);
    const { user, temporaryPassword } = c.json();
    assert.equal(user.username, 'nuevo.uno');
    assert.equal(user.name, 'Nuevo Uno');
    assert.equal(user.mustChangePassword, true);
    assert.equal(typeof temporaryPassword, 'string');
    const s = await login('nuevo.uno', temporaryPassword);
    const s2 = await login('nuevo.uno', temporaryPassword);
    assert.equal(s.res.json().mustChangePassword, true);
    const blocked = await get('/api/test/any', s);
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error, 'password_change_required');
    assert.equal((await get('/api/auth/me', s)).statusCode, 200);
    // Contraseña actual mala, nueva corta o igual: 400.
    assert.equal((await send('POST', '/api/auth/change-password', s, { currentPassword: 'mala-clave-1', newPassword: 'nueva-clave-segura' })).json().error, 'bad_current_password');
    assert.equal((await send('POST', '/api/auth/change-password', s, { currentPassword: temporaryPassword, newPassword: 'corta' })).json().error, 'weak_password');
    assert.equal((await send('POST', '/api/auth/change-password', s, { currentPassword: temporaryPassword, newPassword: temporaryPassword })).json().error, 'same_password');
    const ok = await send('POST', '/api/auth/change-password', s, { currentPassword: temporaryPassword, newPassword: 'nueva-clave-segura' });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().mustChangePassword, false);
    // La sesión se renueva: la cookie nueva sirve, la anterior y la otra sesión ya no.
    const renewed = { cookie: cookieOf(ok).value, csrf: ok.json().csrfToken };
    assert.equal((await get('/api/test/any', renewed)).statusCode, 200);
    assert.equal((await get('/api/auth/me', s)).statusCode, 401);
    assert.equal((await get('/api/auth/me', s2)).statusCode, 401);
    assert.equal((await login('nuevo.uno', temporaryPassword)).res.statusCode, 401);
    assert.equal((await login('nuevo.uno', 'nueva-clave-segura')).res.statusCode, 200);
    const a = await q("SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at, id", [user.id]);
    const actions = a.rows.map((r) => r.action);
    for (const x of ['user_create', 'password_change', 'login_ok']) assert.ok(actions.includes(x), x);
  });
});

describe('administración de usuarios', () => {
  test('solo admin', async () => {
    for (const u of ['resp1', 'sup1', 'ger1', 'cons1']) {
      const s = await login(u);
      assert.equal((await get('/api/users', s)).statusCode, 403, u);
      assert.equal((await send('POST', '/api/users', s, { username: 'xxx', name: 'X', role: 'admin' })).statusCode, 403, u);
      assert.equal((await send('POST', '/api/users/u-res/reset-password', s)).statusCode, 403, u);
      assert.equal((await get('/api/permissions', s)).statusCode, 403, u);
    }
    assert.equal((await get('/api/users')).statusCode, 401);
  });

  test('listar sin hashes, editar con versión, desactivar, reactivar y restablecer', async () => {
    const adm = await login('admin1');
    const list = await get('/api/users', adm);
    assert.equal(list.statusCode, 200);
    assert.doesNotMatch(list.body, /argon2|password_hash|passwordHash|legacy/);
    const target = list.json().users.find((u) => u.username === 'sup1');

    const dup = await send('POST', '/api/users', adm, { username: 'sup1', name: 'Otro', role: 'consulta' });
    assert.equal(dup.statusCode, 409);
    assert.equal((await send('POST', '/api/users', adm, { username: 'x', name: 'X', role: 'consulta' })).statusCode, 400);
    assert.equal((await send('POST', '/api/users', adm, { username: 'xyz', name: 'X', role: 'jefe' })).statusCode, 400);

    const upd = await send('PATCH', `/api/users/${target.id}`, adm, { name: 'Supervisora Uno' }, { 'if-match': `"${target.version}"` });
    assert.equal(upd.statusCode, 200);
    assert.equal(upd.json().user.version, target.version + 1);
    const stale = await send('PATCH', `/api/users/${target.id}`, adm, { role: 'consulta' }, { 'if-match': `"${target.version}"` });
    assert.equal(stale.statusCode, 409);

    const victim = await login('sup1');
    const off = await send('POST', `/api/users/${target.id}/deactivate`, adm, undefined, await ver(target.id));
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().user.active, false);
    assert.equal((await get('/api/auth/me', victim)).statusCode, 401);
    assert.equal((await login('sup1')).res.statusCode, 401);
    assert.equal((await send('POST', `/api/users/${target.id}/reactivate`, adm, undefined, await ver(target.id))).statusCode, 200);
    assert.equal((await login('sup1')).res.statusCode, 200);

    const rs = await send('POST', `/api/users/${target.id}/reset-password`, adm, { temporaryPassword: 'temporal-12345' }, await ver(target.id));
    assert.equal(rs.statusCode, 200);
    assert.equal(rs.json().temporaryPassword, undefined);
    assert.equal(rs.json().user.mustChangePassword, true);
    assert.equal((await login('sup1')).res.statusCode, 401);
    const t = await login('sup1', 'temporal-12345');
    assert.equal(t.res.json().mustChangePassword, true);
    const gen = await send('POST', `/api/users/${target.id}/reset-password`, adm, undefined, await ver(target.id));
    assert.equal(gen.statusCode, 200);
    assert.ok(gen.json().temporaryPassword.length >= 10);
    assert.equal((await get('/api/auth/me', t)).statusCode, 401);

    const acts = (await q('SELECT action FROM audit_log WHERE entity_id = $1', [target.id])).rows.map((r) => r.action);
    for (const x of ['user_update', 'user_deactivate', 'user_reactivate', 'password_reset']) assert.ok(acts.includes(x), x);
    assert.equal((await send('POST', '/api/users/no-existe/deactivate', adm, undefined, { 'if-match': '"1"' })).statusCode, 404);
  });

  test('no se puede quedar sin administradores ni desactivarse a sí mismo', async () => {
    const adm = await login('admin1');
    assert.equal((await send('POST', '/api/users/u-adm/deactivate', adm, undefined, await ver('u-adm'))).json().error, 'self_deactivate');
    assert.equal((await send('POST', '/api/users/u-adm2/deactivate', adm, undefined, await ver('u-adm2'))).statusCode, 200);
    const demote = await send('PATCH', '/api/users/u-adm', adm, { role: 'consulta' }, await ver('u-adm'));
    assert.equal(demote.statusCode, 409);
    assert.equal(demote.json().error, 'last_admin');
    assert.equal((await send('POST', '/api/users/u-adm2/reactivate', adm, undefined, await ver('u-adm2'))).statusCode, 200);
  });
});

describe('permisos', () => {
  test('valores por defecto en las guardas', async () => {
    const res = await login('resp1');
    const ger = await login('ger1');
    const con = await login('cons1');
    const adm = await login('admin1');
    assert.equal((await get('/api/test/shift', res)).statusCode, 403);
    assert.equal((await get('/api/test/shift', adm)).statusCode, 200);
    assert.equal((await send('POST', '/api/test/control', res)).statusCode, 200);
    assert.equal((await send('POST', '/api/test/control', ger)).statusCode, 403);
    assert.equal((await send('POST', '/api/test/control', con)).statusCode, 403);
    assert.deepEqual(ger.res.json().permissions, { controls_do: false, movements_do: false, techs_edit: false, shift_change: false, tools_edit: false, inventory_edit: false, alerts_resolve: false, shifts_edit: false, reports_export: true, demo_manage: false, plantillas_edit: false, plantilla_rotate: false, lineas_edit: false, kits_edit: false, records_delete: false, movements_void: false, novedades_view: true, novedades_create: false, novedades_edit: false });
  });

  test('supervisor puede cambiar de turno; un override lo cambia para responsable', async () => {
    await q("UPDATE users SET must_change_password = false, password_hash = $1 WHERE username = 'sup1'", [await hashPassword(PW)]);
    const sup = await login('sup1');
    assert.equal((await get('/api/test/shift', sup)).statusCode, 200);
    const res = await login('resp1');
    const adm = await login('admin1');
    const bad = await send('PUT', '/api/permissions', adm, { overrides: { responsable: { volar: true } } });
    assert.equal(bad.statusCode, 400);
    assert.equal((await send('PUT', '/api/permissions', adm, { overrides: { admin: { controls_do: false } } })).statusCode, 400);
    const put = await send('PUT', '/api/permissions', adm, { overrides: { responsable: { shift_change: true }, consulta: { reports_export: false } } });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().effective.responsable.shift_change, true);
    assert.equal(put.json().effective.consulta.reports_export, false);
    assert.equal((await get('/api/test/shift', res)).statusCode, 200);
    assert.equal((await get('/api/auth/me', res)).json().permissions.shift_change, true);
    assert.equal((await send('PUT', '/api/permissions', res, { overrides: {} })).statusCode, 403);
    // Volver a los valores por defecto.
    assert.equal((await send('PUT', '/api/permissions', adm, { overrides: {} })).statusCode, 200);
    assert.equal((await get('/api/test/shift', res)).statusCode, 403);
    const n = await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'permissions_update'");
    assert.equal(n.rows[0].n, 2);
  });
});

describe('vencimiento de sesión', () => {
  test('por inactividad, por duración máxima y "Mantener la sesión"', async () => {
    const s = await login('cons1');
    const keep = await login('cons1', PW, { body: { remember: true } });
    await q("UPDATE sessions SET last_seen_at = now() - interval '13 hours'");
    assert.equal((await get('/api/auth/me', s)).statusCode, 401);
    assert.equal((await get('/api/auth/me', keep)).statusCode, 200);
    await q("UPDATE sessions SET expires_at = now() - interval '1 second'");
    assert.equal((await get('/api/auth/me', keep)).statusCode, 401);
    // Las sesiones vencidas que se intentaron usar se borran.
    const tok = (x) => x.cookie.split('=')[1];
    const left = await q("SELECT count(*)::int AS n FROM sessions WHERE id_hash IN (sha256(convert_to($1, 'UTF8')), sha256(convert_to($2, 'UTF8')))", [tok(s), tok(keep)]);
    assert.equal(left.rows[0].n, 0);
    // Cookie inventada o mal formada: sin sesión.
    assert.equal((await get('/api/auth/me', { cookie: 'panol_sid=abc' })).statusCode, 401);
  });
});
