// `npm run admin:create`: crea un administrador con contraseña temporal y cambio obligatorio,
// conectado como la app (panol_app), y queda en la auditoría.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setupApp, appUrlOf } from './harness.js';
import { ROOT_DIR } from '../../src/config.js';

const run = promisify(execFile);
const SCRIPT = path.join(ROOT_DIR, 'server', 'scripts', 'admin-create.js');
let ctx;
before(async () => { ctx = await setupApp(); });
after(async () => { await ctx?.close(); });

const create = (...args) => run(process.execPath, [SCRIPT, ...args], { env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: appUrlOf(ctx.url) } });

test('crea un administrador que entra con la contraseña temporal y tiene que cambiarla', async () => {
  const { stdout } = await create('jefa', 'Jefa', 'de', 'Pañol');
  const pw = /Contraseña temporal: (\S+)/.exec(stdout)?.[1];
  assert.ok(pw && pw.length >= 10, stdout);
  const { rows } = await ctx.pool.query("SELECT name, role, must_change_password, password_hash LIKE '$argon2id$%' AS argon FROM users WHERE username = 'jefa'");
  assert.deepEqual(rows, [{ name: 'Jefa de Pañol', role: 'admin', must_change_password: true, argon: true }]);
  const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'jefa', password: pw } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().mustChangePassword, true);
  const audit = await ctx.pool.query("SELECT actor_id FROM audit_log WHERE action = 'user_create'");
  assert.equal(audit.rowCount, 1);
});

test('sin argumentos muestra el uso; usuario repetido o inválido falla sin crear nada', async () => {
  await assert.rejects(create(), (e) => e.code === 2 && /Uso: npm run admin:create/.test(e.stderr));
  await assert.rejects(create('jefa', 'Otra Persona'), (e) => e.code === 1 && /Ya existe un usuario/.test(e.stderr));
  await assert.rejects(create('A B', 'Nombre'), (e) => e.code === 1 && /El usuario tiene que tener/.test(e.stderr));
  const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM users');
  assert.equal(rows[0].n, 1);
});
