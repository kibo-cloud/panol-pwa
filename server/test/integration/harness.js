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
import { provisionAppRole, APP_ROLE } from '../../src/adapters/pg/app-role.js';
import { buildApp } from '../../src/app.js';
import { ensureCluster, startCluster, stopCluster, freePort } from '../../scripts/lib/embedded-pg.js';
import { withDatabase } from '../../scripts/lib/dev-db.js';

const PASSWORD = 'panol-test';
const APP_PASSWORD = 'panol-app-test';

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

// URL de la misma base con el rol de la app.
export function appUrlOf(url) {
  const u = new URL(url);
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  return u.toString();
}

// Base migrada + app lista para `inject`.
// - `pool`: dueño de las tablas (preparar datos y mirar la base en las pruebas).
// - `appPool`: rol `panol_app`, el que usa la app (como en producción).
// Con migrate: false la app usa el pool del dueño (pruebas del propio migrador).
export async function setupApp({ migrate = true, env = {}, extend } = {}) {
  const db = await createTestDatabase();
  const pool = createPool(db.url, { max: 5 });
  let appPool = null;
  if (migrate) {
    await runMigrations(pool);
    await provisionAppRole(pool, appUrlOf(db.url));
    appPool = createPool(appUrlOf(db.url), { max: 5 });
  }
  const config = buildConfig({ NODE_ENV: 'test', DATABASE_URL: appUrlOf(db.url), MIGRATION_DATABASE_URL: db.url, ...env });
  const app = await buildApp({ config, pool: appPool || pool, logger: false, extend });
  await app.ready();
  return {
    app,
    pool,
    appPool,
    url: db.url,
    close: async () => {
      await app.close().catch(() => {});
      await appPool?.end().catch(() => {});
      await pool.end().catch(() => {});
      await db.cleanup();
    },
  };
}
