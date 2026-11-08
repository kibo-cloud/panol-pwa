// Migraciones SQL versionadas: `server/migrations/NNN_nombre.sql`, aplicadas en orden y
// cada una en su transacción. Se registran en `schema_migrations` con su checksum: si un
// archivo ya aplicado cambió, se corta (nunca se edita una migración aplicada).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT_DIR } from '../../config.js';

export const MIGRATIONS_DIR = path.join(ROOT_DIR, 'server', 'migrations');
const FILE_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 74_201_633; // clave fija del advisory lock de migraciones

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const out = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) throw new Error(`Nombre de migración inválido: ${name} (se espera NNN_nombre.sql)`);
    const sql = (await fs.readFile(path.join(dir, name), 'utf8')).replace(/\r\n/g, '\n');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    out.push({ version: m[1], name, sql, checksum });
  }
  const seen = new Set();
  for (const m of out) {
    if (seen.has(m.version)) throw new Error(`Número de migración repetido: ${m.version}`);
    seen.add(m.version);
  }
  return out;
}

// Aplica las migraciones pendientes. Devuelve los nombres aplicados en esta corrida.
export async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const migrations = await listMigrations(dir);
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version, name, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new Error(`La migración ${m.name} ya fue aplicada y su contenido cambió. Agregá una migración nueva en lugar de editarla.`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `Falló la migración ${m.name}: ${err.message}`;
        throw err;
      }
      applied.push(m.name);
      log(`migración aplicada: ${m.name}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
