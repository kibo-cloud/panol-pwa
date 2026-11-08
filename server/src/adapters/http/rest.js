// Piezas comunes de las rutas REST: esquemas, versión con If-Match/ETag y actor del pedido.
import { HttpError, badRequest } from './errors.js';
import { LIM, POOL_K } from '../../domain/constants.js';

export const ID_PATTERN = '^[A-Za-z0-9_.~:@+-]{1,200}$';
export const S = {
  id: { type: 'string', pattern: ID_PATTERN },
  idOrNull: { type: ['string', 'null'], pattern: ID_PATTERN },
  str: (max, min = 0) => ({ type: 'string', maxLength: max, minLength: min }),
  name: { type: 'string', maxLength: LIM.name },
  text: { type: 'string', maxLength: LIM.text },
  day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  dayOrNull: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  bool: { type: 'boolean' },
  int: (min, max) => ({ type: 'integer', minimum: min, maximum: max }),
  pool: { type: 'string', enum: POOL_K },
  period: {
    type: 'object', additionalProperties: false, required: ['y', 'm', 'w'],
    properties: { y: { type: 'integer', minimum: 2000, maximum: 9999 }, m: { type: 'integer', minimum: 1, maximum: 12 }, w: { type: 'integer', minimum: 1, maximum: 4 } },
  },
};

export const obj = (properties, required = [], extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra });
export const idParams = obj({ id: S.id }, ['id']);

// If-Match obligatorio en toda modificación de un registro editable.
export function requireVersion(req) {
  const h = req.headers['if-match'];
  if (h === undefined) throw new HttpError(428, 'precondition_required', 'Falta la versión del registro (If-Match). Recargá e intentá de nuevo.');
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(String(h).trim());
  if (!m) throw badRequest('If-Match inválido.', 'invalid_if_match');
  return Number(m[1]);
}

export const etag = (row) => `"${row.version}"`;

// Responde un registro con su ETag (la versión).
export function sendRow(reply, key, row, code = 200) {
  if (row && row.version != null) reply.header('ETag', etag(row));
  return reply.code(code).send({ [key]: row });
}

export const actorOf = (req) => ({ id: req.session.user.id, ip: req.ip, role: req.session.user.role });
