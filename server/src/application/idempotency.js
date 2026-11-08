// Idempotencia con `Idempotency-Key`: la clave se reserva dentro de la misma transacción que
// la escritura. Si el cliente reintenta, se devuelve la respuesta guardada sin repetir nada.
// Un pedido concurrente con la misma clave espera a que el primero confirme (índice único).
// Si la escritura falla, la transacción se deshace junto con la clave y se puede reintentar.
import crypto from 'node:crypto';
import { withTransaction } from '../adapters/pg/pool.js';
import { DomainError } from '../domain/errors.js';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

export const hashRequest = (method, path, body) => crypto.createHash('sha256').update(JSON.stringify([method, path, body ?? null])).digest('hex');

// fn(c) devuelve { status, body }. Resultado: { status, body, replayed }.
export async function idempotent(db, { userId, key, method, path, body }, fn) {
  if (!key) return { ...(await withTransaction(db, fn)), replayed: false };
  const hash = hashRequest(method, path, body);
  const out = await withTransaction(db, async (c) => {
    const ins = await c.query(
      'INSERT INTO idempotency_keys (user_id, key, method, path, request_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1',
      [userId, key, method, path.slice(0, 2000), hash],
    );
    if (!ins.rowCount) return null;
    const r = await fn(c);
    await c.query('UPDATE idempotency_keys SET status = $3, response = $4 WHERE user_id = $1 AND key = $2', [userId, key, r.status, JSON.stringify(r.body)]);
    return r;
  });
  if (out) return { ...out, replayed: false };
  const { rows } = await db.query('SELECT method, path, request_hash, status, response FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
  const row = rows[0];
  if (!row || row.status == null) throw new DomainError('El pedido anterior con esta clave todavía no terminó. Intentá de nuevo.', 'idempotency_pending', 409);
  if (row.request_hash !== hash) throw new DomainError('Esta clave de idempotencia ya se usó con otro pedido.', 'idempotency_mismatch', 422);
  return { status: row.status, body: row.response, replayed: true };
}
