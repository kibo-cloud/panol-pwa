// Servidor de Pañol 3 para las pruebas E2E:
// - Compila web/ si web/dist falta o es más vieja que el código (vite build).
// - Base: PostgreSQL de embedded-postgres en un directorio temporal, o una base nueva en
//   TEST_DATABASE_URL (CI, servicio postgres:16.14). Se migra, se habilita el rol de la app y
//   se cargan usuarios inventados en una base plantilla.
// - Cada prueba recibe una base clonada de la plantilla (CREATE DATABASE ... TEMPLATE, rápido)
//   y una app Fastify nueva conectada como `panol_app`, como en producción.
// - Delante hay un proxy HTTP con puerto fijo: el origen del navegador no cambia entre
//   pruebas y `srv.offline = true` corta todas las conexiones (servidor caído / sin red).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { ROOT } from './harness.mjs';
import { buildConfig } from '../../server/src/config.js';
import { createPool } from '../../server/src/adapters/pg/pool.js';
import { runMigrations } from '../../server/src/adapters/pg/migrate.js';
import { provisionAppRole, assertNotPrivileged } from '../../server/src/adapters/pg/app-role.js';
import { buildApp } from '../../server/src/app.js';
import { createTestDatabase, appUrlOf } from '../../server/test/integration/harness.js';
import { withDatabase } from '../../server/scripts/lib/dev-db.js';
import { seedUsers } from './seed.mjs';

export const WEB_DIST = path.join(ROOT, 'web', 'dist');

// Fecha de modificación más nueva de un árbol de archivos.
function newest(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = 0;
  for (const f of fs.readdirSync(p)) m = Math.max(m, newest(path.join(p, f)));
  return m;
}

export function ensureWebBuild(log = console.log) {
  const index = path.join(WEB_DIST, 'index.html');
  const src = Math.max(...['web/src', 'web/public', 'web/index.html', 'web/scripts', 'vite.config.js'].map((p) => newest(path.join(ROOT, p))));
  if (process.env.PANOL_E2E_BUILD !== '1' && fs.existsSync(index) && fs.statSync(index).mtimeMs >= src) return false;
  log('  compilando web/ (vite build)…');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit',
    // El runner corre con NODE_ENV=test: sin forzarlo, Vite compila con PROD=false y la app no registra el SW.
    env: { ...process.env, NODE_ENV: 'production' }
  });
  if (r.status !== 0) throw new Error('vite build falló');
  return true;
}

async function adminQuery(url, sql) {
  const c = new pg.Client({ connectionString: withDatabase(url, 'postgres') });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

export async function startE2EServer({ log = console.log } = {}) {
  ensureWebBuild(log);

  // Base plantilla: migraciones + rol de la app + usuarios inventados.
  const tpl = await createTestDatabase();
  const tplName = new URL(tpl.url).pathname.slice(1);
  {
    const owner = createPool(tpl.url, { max: 1 });
    try {
      await runMigrations(owner);
      await provisionAppRole(owner, appUrlOf(tpl.url));
      await seedUsers(owner);
    } finally { await owner.end(); }
  }

  const srv = { offline: false, db: null, app: null, dbUrl: null, backendPort: 0 };
  let n = 0;
  let current = null; // { app, appPool, owner, name, sockets }

  // ---------------------------------------------------------------- proxy de puerto fijo
  const browserSockets = new Set();
  const proxy = http.createServer((req, res) => {
    if (srv.offline || !current) { req.socket.destroy(); return; }
    const preq = http.request({ host: '127.0.0.1', port: srv.backendPort, method: req.method, path: req.url, headers: req.headers, agent: false }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    preq.on('error', () => res.destroy());
    res.on('close', () => preq.destroy());
    req.pipe(preq);
  });
  proxy.on('connection', (s) => {
    if (srv.offline) { s.destroy(); return; }
    browserSockets.add(s); s.on('close', () => browserSockets.delete(s));
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  srv.port = proxy.address().port;
  srv.base = `http://127.0.0.1:${srv.port}`;

  // Sin conexión: se cortan las conexiones abiertas (también el flujo SSE) y las nuevas.
  Object.defineProperty(srv, 'offline', {
    get() { return this._offline; },
    set(v) { this._offline = !!v; if (v) for (const s of browserSockets) s.destroy(); },
  });
  srv._offline = false;

  async function closeCurrent() {
    if (!current) return;
    const c = current; current = null;
    for (const s of browserSockets) s.destroy();
    for (const s of c.sockets) s.destroy();
    await c.app.close().catch(() => {});
    await c.appPool.end().catch(() => {});
    await c.owner.end().catch(() => {});
    await adminQuery(tpl.url, `DROP DATABASE IF EXISTS ${c.name} WITH (FORCE)`).catch(() => {});
  }

  // Base limpia (clon de la plantilla) y app nueva para la próxima prueba.
  srv.reset = async () => {
    await closeCurrent();
    srv.offline = false;
    const name = `${tplName}_s${++n}_${crypto.randomBytes(2).toString('hex')}`;
    await adminQuery(tpl.url, `CREATE DATABASE ${name} TEMPLATE ${tplName}`);
    const url = withDatabase(tpl.url, name);
    const config = buildConfig({ NODE_ENV: 'test', DATABASE_URL: appUrlOf(url), MIGRATION_DATABASE_URL: url, WEB_DIST, LOG_LEVEL: 'silent' });
    const appPool = createPool(appUrlOf(url), { max: 8 });
    const owner = createPool(url, { max: 2 });
    await assertNotPrivileged(appPool);
    const app = await buildApp({ config, pool: appPool, logger: false });
    const sockets = new Set();
    app.server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await app.listen({ host: '127.0.0.1', port: 0 });
    current = { app, appPool, owner, name, sockets };
    srv.backendPort = app.server.address().port;
    srv.app = app;
    srv.db = owner;
    srv.dbUrl = url;
  };

  srv.close = async () => {
    await closeCurrent();
    for (const s of browserSockets) s.destroy();
    await new Promise((r) => proxy.close(() => r()));
    await adminQuery(tpl.url, `DROP DATABASE IF EXISTS ${tplName} WITH (FORCE)`).catch(() => {});
    await tpl.cleanup();
  };
  return srv;
}
