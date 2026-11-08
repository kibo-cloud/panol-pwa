// Ids nuevos con el mismo formato que 2.1 (prefijo + tiempo en base 36 + azar), válidos para
// el dominio `panol_id`.
import crypto from 'node:crypto';

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}
