// Base de desarrollo: si DATABASE_URL apunta a este equipo y no responde, se usa el cluster
// local de `.pgdata/` (embedded-postgres), creándolo y arrancándolo si hace falta.
import path from 'node:path';
import pg from 'pg';
import { ROOT_DIR } from '../../src/config.js';
import { ensureCluster, startCluster, stopCluster, isRunning } from './embedded-pg.js';

export const PGDATA = path.join(ROOT_DIR, '.pgdata');
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function parseDbUrl(url) {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  if (!IDENT.test(database)) throw new Error(`Nombre de base inválido en DATABASE_URL: ${database}`);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    database,
    isLocal: ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname),
  };
}

export function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = '/' + database;
  return u.toString();
}

async function reachable(url) {
  const c = new pg.Client({ connectionString: withDatabase(url, 'postgres'), connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    await c.end().catch(() => {});
    return false;
  }
}

// Arranca el cluster local si hace falta. Devuelve si lo arrancó esta llamada.
export async function ensureServer(url, log = console.log) {
  if (await reachable(url)) return false;
  const p = parseDbUrl(url);
  if (!p.isLocal) throw new Error(`No se pudo conectar a ${p.host}:${p.port}.`);
  if (await ensureCluster({ dir: PGDATA, user: p.user, password: p.password })) log(`cluster creado en ${PGDATA}`);
  await startCluster({ dir: PGDATA, port: p.port });
  log(`PostgreSQL local escuchando en 127.0.0.1:${p.port}`);
  return true;
}

export async function stopLocalServer() {
  if (await isRunning(PGDATA)) await stopCluster({ dir: PGDATA });
}

export async function createDatabaseIfMissing(url) {
  const { database } = parseDbUrl(url);
  const c = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await c.connect();
  try {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!rowCount) await c.query(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`);
    return !rowCount;
  } finally {
    await c.end();
  }
}

export async function recreateDatabase(url) {
  const { database } = parseDbUrl(url);
  if (database === 'postgres') throw new Error('No se recrea la base `postgres`.');
  const c = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await c.end();
  }
}

// Ejecuta fn con el servidor disponible; si se arrancó solo para esto, se detiene al final.
export async function withDevServer(url, fn, log = console.log) {
  const started = await ensureServer(url, log);
  try {
    return await fn();
  } finally {
    if (started) {
      await stopLocalServer();
      log('PostgreSQL local detenido (se había arrancado solo para este comando).');
    }
  }
}
