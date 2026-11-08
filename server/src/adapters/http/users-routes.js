// /api/users y /api/permissions: solo administradores.
import * as users from '../../application/users.js';
import { badRequest } from './errors.js';
import { PERM_KEYS, ROLE_KEYS } from '../../domain/constants.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_.~:@+-]{1,200}$' } } };
const tempPw = { type: 'string', maxLength: 1000 };

// If-Match opcional con la versión (número, con o sin comillas).
function ifMatch(req) {
  const h = req.headers['if-match'];
  if (h === undefined) return undefined;
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(String(h).trim());
  if (!m) throw badRequest('If-Match inválido.', 'invalid_if_match');
  return Number(m[1]);
}

export function registerUserRoutes(app) {
  const { db } = app;
  const admin = { preHandler: app.requireAdmin };
  const actor = (req) => ({ id: req.session.user.id, ip: req.ip });

  app.get('/api/users', admin, async () => ({ users: await users.listUsers(db) }));

  app.post('/api/users', {
    ...admin,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['username', 'name', 'role'],
        properties: { username: { type: 'string', maxLength: 200 }, name: { type: 'string', maxLength: 1000 }, role: { type: 'string', enum: ROLE_KEYS }, temporaryPassword: tempPw },
      },
    },
  }, async (req, reply) => {
    const r = await users.createUser(db, actor(req), req.body);
    return reply.code(201).send(r);
  });

  app.patch('/api/users/:id', {
    ...admin,
    schema: {
      params: idParam,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: { type: 'string', maxLength: 1000 }, role: { type: 'string', enum: ROLE_KEYS } } },
    },
  }, async (req) => ({ user: await users.updateUser(db, actor(req), req.params.id, req.body, ifMatch(req)) }));

  app.post('/api/users/:id/deactivate', { ...admin, schema: { params: idParam } }, async (req) => ({ user: await users.setActive(db, actor(req), req.params.id, false, ifMatch(req)) }));
  app.post('/api/users/:id/reactivate', { ...admin, schema: { params: idParam } }, async (req) => ({ user: await users.setActive(db, actor(req), req.params.id, true, ifMatch(req)) }));

  app.post('/api/users/:id/reset-password', {
    ...admin,
    schema: { params: idParam, body: { type: ['object', 'null'], additionalProperties: false, properties: { temporaryPassword: tempPw } } },
  }, async (req) => users.resetPassword(db, actor(req), req.params.id, req.body || {}));

  const permsBody = {
    type: 'object',
    additionalProperties: false,
    required: ['overrides'],
    properties: {
      overrides: {
        type: 'object',
        additionalProperties: false,
        properties: Object.fromEntries(ROLE_KEYS.filter((r) => r !== 'admin').map((r) => [r, {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(PERM_KEYS.map((p) => [p, { type: 'boolean' }])),
        }])),
      },
    },
  };
  app.get('/api/permissions', admin, async () => users.getPermissions(db));
  app.put('/api/permissions', { ...admin, schema: { body: permsBody } }, async (req) => users.setPermissions(db, actor(req), req.body.overrides));
}
