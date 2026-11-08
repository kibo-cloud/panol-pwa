// Sesión, CSRF y permisos para todas las rutas.
// - Cada ruta exige sesión salvo `config: { public: true }`.
// - Todo pedido que modifica (no GET/HEAD/OPTIONS) verifica Origin/Sec-Fetch-Site y, si hay
//   sesión, el token CSRF en `X-CSRF-Token` (token sincronizador por sesión).
// - Con `must_change_password`, solo se permiten las rutas con `config: { allowPasswordChange: true }`.
import crypto from 'node:crypto';
import { resolveSession } from '../../application/auth.js';
import { loadOverrides } from '../pg/auth-repo.js';
import { can } from '../../domain/permissions.js';
import { forbidden, unauthorized, HttpError } from './errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function cookieName(config) {
  // __Host- exige Secure, Path=/ y sin Domain: impide que un subdominio pise la cookie.
  return config.cookieSecure ? '__Host-panol_sid' : 'panol_sid';
}

export function cookieOptions(config, { remember, expiresAt } = {}) {
  const o = { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' };
  if (remember && expiresAt) o.maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return o;
}

const csrfError = () => forbidden('La solicitud no es válida. Recargá la página e intentá de nuevo.', 'csrf');

function expectedOrigin(req, config) {
  if (config.appOrigin) return config.appOrigin.replace(/\/$/, '');
  return `${req.protocol}://${req.headers.host}`;
}

// Defensa por origen: los navegadores mandan Origin y Sec-Fetch-Site en pedidos que modifican.
export function checkSameOrigin(req, config) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') throw csrfError();
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== expectedOrigin(req, config)) throw csrfError();
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function registerAuth(app) {
  const { config, db } = app;
  app.decorateRequest('session', null);

  // onRequest: antes de leer y validar el cuerpo, así nadie sin sesión llega a la validación.
  app.addHook('onRequest', async (req, reply) => {
    if (req.is404) return;
    const rc = req.routeOptions?.config || {};
    const writing = !SAFE.has(req.method);
    if (writing) checkSameOrigin(req, config);
    const token = req.cookies?.[cookieName(config)];
    if (token) {
      req.session = await resolveSession(db, config, token);
      if (!req.session) reply.clearCookie(cookieName(config), cookieOptions(config));
    }
    if (rc.public) return;
    if (!req.session) throw unauthorized();
    if (writing && !sameToken(req.headers['x-csrf-token'], req.session.csrfToken)) throw csrfError();
    if (req.session.user.mustChangePassword && !rc.allowPasswordChange) {
      throw new HttpError(403, 'password_change_required', 'Tenés que cambiar tu contraseña antes de seguir.');
    }
  });

  // Guardas para usar en `preHandler` de cada ruta.
  app.decorate('requireAdmin', async (req) => {
    if (req.session?.user.role !== 'admin') throw forbidden();
  });
  app.decorate('requirePerm', (perm) => async (req) => {
    const overrides = await loadOverrides(db);
    if (!can(req.session?.user.role, perm, overrides)) throw forbidden();
  });
}
