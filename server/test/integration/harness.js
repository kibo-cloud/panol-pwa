// Base para pruebas de integración.
// - Con TEST_DATABASE_URL (CI, servicio `postgres:16`): crea una base nueva por archivo de prueba.
// - Sin ella: arranca un PostgreSQL de embedded-postgres en un directorio temporal y un puerto
//   libre, y lo borra al terminar.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import { buildConfig } from '../../src/config.js';
import { createPool } from '../../src/adapters/pg/pool.js';
import { runMigrations } from '../../src/adapters/pg/migrate.js';
import { buildApp } from '../../src/app.js';
import { ensureCluster, startCluster, stopCluster, freePort } from '../../scripts/lib/embedded-pg.js';
import { withDatabase } from '../../scripts/lib/dev-db.js';

const PASSWORD = 'panol-test';

async function adminQuery(url, sql) {
  const c = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

// Devuelve { url, cleanup } de una base vacía y exclusiva para quien la pide.
export async function createTestDatabase() {
  const name = `panol_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    await adminQuery(external, `CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`);
    const url = withDatabase(external, name);
    return { url, cleanup: () => adminQuery(external, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panol-pg-'));
  const port = await freePort();
  await ensureCluster({ dir, password: PASSWORD });
  await startCluster({ dir, port });
  const base = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`;
  await adminQuery(base, `CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`);
  return {
    url: withDatabase(base, name),
    cleanup: async () => {
      await stopCluster({ dir, mode: 'immediate' }).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

// Base migrada + pool + app lista para `inject`.
export async function setupApp({ migrate = true, env = {}, extend } = {}) {
  const db = await createTestDatabase();
  const pool = createPool(db.url, { max: 5 });
  if (migrate) await runMigrations(pool);
  const config = buildConfig({ NODE_ENV: 'test', DATABASE_URL: db.url, ...env });
  const app = await buildApp({ config, pool, logger: false, extend });
  await app.ready();
  return {
    app,
    pool,
    url: db.url,
    close: async () => {
      await app.close().catch(() => {});
      await pool.end().catch(() => {});
      await db.cleanup();
    },
  };
}
