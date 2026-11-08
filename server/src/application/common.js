// Ayudas comunes de los casos de uso que escriben: versión (If-Match), auditoría y avisos.
import { withTransaction } from '../adapters/pg/pool.js';
import { notifyChange } from '../adapters/pg/notify.js';
import { DomainError, ConflictError, notFoundError } from '../domain/errors.js';
import { audit } from './auth.js';

export { withTransaction, notifyChange, audit };

// `cur` es el registro vigente (bloqueado con FOR UPDATE); `version` la que mandó el cliente.
export function checkVersion(cur, version, missing = 'No se encontró el registro.') {
  if (!cur) throw notFoundError(missing);
  if (cur.version !== version) throw new ConflictError(cur);
  return cur;
}

// Convierte una violación de unicidad de PostgreSQL en un 409 con mensaje claro.
export const onUnique = (message, code = 'duplicate') => (err) => {
  if (err && err.code === '23505') throw new DomainError(message, code, 409);
  throw err;
};

// Registra auditoría y aviso en vivo de una escritura (dentro de la transacción).
export async function record(c, actor, { action, entity, id, version = null, detail, event = 'update' }) {
  await audit(c, { action, entity, entityId: id, detail, actorId: actor.id, ip: actor.ip });
  await notifyChange(c, { entity, id, version, action: event });
}
