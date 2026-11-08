// /api/auth: ingreso, salida, sesión actual y cambio de contraseña.
import * as auth from '../../application/auth.js';
import { cookieName, cookieOptions } from './auth.js';

const str = (max) => ({ type: 'string', maxLength: max });

export function registerAuthRoutes(app) {
  const { db, config } = app;

  app.post('/api/auth/login', {
    config: { public: true },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['username', 'password'],
        properties: { username: { ...str(200), minLength: 1 }, password: { ...str(200), minLength: 1 }, remember: { type: 'boolean' } },
      },
    },
  }, async (req, reply) => {
    const { username, password, remember = false } = req.body;
    const r = await auth.login(db, config, { username, password, remember, ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.setCookie(cookieName(config), r.token, cookieOptions(config, r));
    const session = { idHash: null, csrfToken: r.csrfToken, user: { id: r.user.id, username: r.user.username, name: r.user.name, role: r.user.role, mustChangePassword: r.user.must_change_password } };
    return auth.me(db, session);
  });

  app.post('/api/auth/logout', { config: { allowPasswordChange: true } }, async (req, reply) => {
    await auth.logout(db, req.session, req.ip);
    reply.clearCookie(cookieName(config), cookieOptions(config));
    return { ok: true };
  });

  app.get('/api/auth/me', { config: { allowPasswordChange: true } }, async (req) => auth.me(db, req.session));

  app.post('/api/auth/change-password', {
    config: { allowPasswordChange: true },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['currentPassword', 'newPassword'],
        properties: { currentPassword: { ...str(200), minLength: 1 }, newPassword: str(1000) },
      },
    },
  }, async (req) => {
    await auth.changePassword(db, req.session, { ...req.body, ip: req.ip });
    return auth.me(db, { ...req.session, user: { ...req.session.user, mustChangePassword: false } });
  });
}
