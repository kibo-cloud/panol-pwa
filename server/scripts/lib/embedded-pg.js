// PostgreSQL local para desarrollo y pruebas, con los binarios del paquete `embedded-postgres`
// (misma versión que la imagen del Compose, ver server/pg-version.json).
//
// Se usan `initdb` y `pg_ctl` del paquete en lugar de `EmbeddedPostgres.start()`: en Windows,
// `postgres.exe` se niega a arrancar desde una consola con permisos de administrador, y
// `pg_ctl` lo resuelve arrancando el servidor con un token restringido.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { TIME_ZONE } from '../../src/config.js';

const PLATFORM_PKG = {
  'win32-x64': '@embedded-postgres/windows-x64',
  'linux-x64': '@embedded-postgres/linux-x64',
  'linux-arm64': '@embedded-postgres/linux-arm64',
  'darwin-x64': '@embedded-postgres/darwin-x64',
  'darwin-arm64': '@embedded-postgres/darwin-arm64',
};

export async function binaries() {
  const pkg = PLATFORM_PKG[`${os.platform()}-${os.arch()}`];
  if (!pkg) throw new Error(`embedded-postgres no tiene binarios para ${os.platform()}-${os.arch()}`);
  const mod = await import(pkg);
  return { initdb: mod.initdb, pgCtl: mod.pg_ctl, postgres: mod.postgres };
}

// Ejecuta un binario. stdio 'ignore' en `pg_ctl start`: el servidor hereda los descriptores y
// un pipe abierto dejaría colgado el proceso que espera.
function run(cmd, args, { capture = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore', windowsHide: true });
    let out = '';
    if (capture) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
    }
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
  });
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Crea el cluster si el directorio todavía no tiene uno.
export async function ensureCluster({ dir, user = 'postgres', password }) {
  if (existsSync(path.join(dir, 'PG_VERSION'))) return false;
  const { initdb } = await binaries();
  await fs.mkdir(dir, { recursive: true });
  const pwfile = path.join(os.tmpdir(), `panol-pw-${process.pid}-${Date.now()}`);
  await fs.writeFile(pwfile, password + '\n', { mode: 0o600 });
  try {
    const r = await run(initdb, [`--pgdata=${dir}`, `--username=${user}`, `--pwfile=${pwfile}`, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
    if (r.code !== 0) throw new Error(`initdb falló (${r.code}):\n${r.out}`);
  } finally {
    await fs.rm(pwfile, { force: true });
  }
  return true;
}

export async function isRunning(dir) {
  if (!existsSync(path.join(dir, 'PG_VERSION'))) return false;
  const { pgCtl } = await binaries();
  const r = await run(pgCtl, ['status', '-D', dir]);
  return r.code === 0;
}

export async function startCluster({ dir, port }) {
  if (await isRunning(dir)) return false;
  const { pgCtl } = await binaries();
  const log = path.join(dir, 'server.log');
  const opts = `-p ${port} -c listen_addresses=127.0.0.1 -c timezone=${TIME_ZONE} -c log_timezone=${TIME_ZONE}`;
  const r = await run(pgCtl, ['start', '-D', dir, '-o', opts, '-l', log, '-w', '-t', '60'], { capture: false });
  if (r.code !== 0) {
    const tail = existsSync(log) ? (await fs.readFile(log, 'utf8')).split('\n').slice(-15).join('\n') : '';
    throw new Error(`pg_ctl start falló (${r.code}). Últimas líneas del log:\n${tail}`);
  }
  return true;
}

export async function stopCluster({ dir, mode = 'fast' }) {
  if (!(await isRunning(dir))) return false;
  const { pgCtl } = await binaries();
  const r = await run(pgCtl, ['stop', '-D', dir, '-m', mode, '-w', '-t', '60']);
  if (r.code !== 0) throw new Error(`pg_ctl stop falló (${r.code}):\n${r.out}`);
  return true;
}
