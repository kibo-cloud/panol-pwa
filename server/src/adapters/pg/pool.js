// Conexión a PostgreSQL. Cada conexión fija la zona horaria de la empresa, así `now()`,
// los `date` y los `timestamptz` se interpretan siempre con la hora local.
import pg from 'pg';
import { TIME_ZONE } from '../../config.js';

// `date` se devuelve como texto ISO (YYYY-MM-DD), sin pasar por Date (evita corrimientos).
pg.types.setTypeParser(1082, (v) => v);
// bigint (count(*), bigserial): en este sistema entran siempre en un Number.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(connectionString, opts = {}) {
  const pool = new pg.Pool({
    connectionString,
    options: `-c timezone=${TIME_ZONE}`,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30000,
  });
  // Un error en una conexión ociosa no debe tirar el proceso.
  pool.on('error', (err) => opts.onError?.(err));
  return pool;
}

// Ejecuta fn dentro de una transacción con un cliente dedicado.
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
