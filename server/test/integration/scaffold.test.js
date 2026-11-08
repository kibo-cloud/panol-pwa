import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupApp } from './harness.js';
import { runMigrations } from '../../src/adapters/pg/migrate.js';

let ctx;
before(async () => {
  ctx = await setupApp({ migrate: false });
});
after(async () => {
  await ctx?.close();
});

test('GET /api/health responde ok y db', async () => {
  const r = await ctx.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, db: true });
});

test('ruta inexistente da 404 con código estable', async () => {
  const r = await ctx.app.inject({ method: 'GET', url: '/api/nada' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().error, 'route_not_found');
});

test('la sesión de la base usa la zona horaria de la empresa', async () => {
  const { rows } = await ctx.pool.query('SHOW timezone');
  assert.equal(rows[0].TimeZone, 'America/Argentina/Buenos_Aires');
});

test('runner: aplica en orden, es idempotente y detecta una migración editada', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panol-mig-'));
  try {
    await fs.writeFile(path.join(dir, '001_a.sql'), 'CREATE TABLE t_a (id int primary key);');
    await fs.writeFile(path.join(dir, '002_b.sql'), 'INSERT INTO t_a VALUES (1);');
    assert.deepEqual(await runMigrations(ctx.pool, { dir }), ['001_a.sql', '002_b.sql']);
    assert.deepEqual(await runMigrations(ctx.pool, { dir }), []);
    const { rows } = await ctx.pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(rows.map((r) => r.version), ['001', '002']);

    // Una migración que falla no deja nada a medias.
    await fs.writeFile(path.join(dir, '003_c.sql'), 'INSERT INTO t_a VALUES (2); INSERT INTO t_a VALUES (1);');
    await assert.rejects(runMigrations(ctx.pool, { dir }), /003_c\.sql/);
    const n = await ctx.pool.query('SELECT count(*)::int AS n FROM t_a');
    assert.equal(n.rows[0].n, 1);
    await fs.rm(path.join(dir, '003_c.sql'));

    await fs.writeFile(path.join(dir, '001_a.sql'), 'CREATE TABLE t_a (id bigint primary key);');
    await assert.rejects(runMigrations(ctx.pool, { dir }), /cambió/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
