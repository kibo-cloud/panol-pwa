// Casos de uso de ingreso, sesión y contraseña.
import crypto from 'node:crypto';
import * as repo from '../adapters/pg/auth-repo.js';
import { withTransaction } from '../adapters/pg/pool.js';
import { DomainError } from '../domain/errors.js';
import { lockMessage } from '../domain/lockout.js';
import { effectivePermissions } from '../domain/permissions.js';
import { verifyPassword, verifyDummy, hashPassword, needsRehash, checkPasswordPolicy } from './passwords.js';
import { verifyLegacyPin } from './legacy-pin.js';
import { newId } from './ids.js';

export const BAD_LOGIN = 'Usuario o contraseña incorrectos.';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const lockKey = (username) => String(username).trim().toLowerCase().slice(0, 200);

export function audit(q, { action, entity = null, entityId = null, detail = null, actorId = null, ip = null }) {
  return repo.insertAudit(q, { id: newId('l'), action, entity, entityId, detail: detail && String(detail).slice(0, 2000), actorId, ip });
}

class LockedError extends DomainError {
  constructor(seconds) {
    super(lockMessage(seconds), 'locked', 429);
    this.retryAfter = seconds;
  }
}
export { LockedError };

// Verifica la contraseña del usuario. Un usuario migrado de 2.x sin contraseña todavía usa su
// PIN (algoritmos de 2.1). Sin usuario usable se verifica contra un hash al azar (mismo tiempo).
// Devuelve { ok, legacy }.
export async function verifyUserSecret(user, password) {
  if (user && user.active && user.password_hash) return { ok: await verifyPassword(user.password_hash, password), legacy: false };
  if (user && user.active && user.legacy_pin_hash) return { ok: await verifyLegacyPin(password, user.legacy_salt, user.legacy_pin_hash), legacy: true };
  await verifyDummy(password);
  return { ok: false, legacy: false };
}

// Un intento de ingreso (o de confirmar la contraseña actual) contra el bloqueo progresivo.
// La fila de bloqueo se crea y se toma con FOR UPDATE antes de verificar, en la misma
// transacción que registra el resultado: los intentos en paralelo del mismo usuario se
// verifican de a uno y nunca hay más verificaciones que las permitidas antes del bloqueo.
// check(c) devuelve { ok, user, ... }; onFail(c, f) registra el fallo; onOk(c, r) lo que sigue.
async function guardedAttempt(db, key, ip, { check, onFail, onOk }) {
  const r = await withTransaction(db, async (c) => {
    const lock = await repo.lockForAttempt(c, key);
    if (lock.seconds_left > 0) {
      await onFail(c, null, lock);
      return { locked: lock.seconds_left };
    }
    const v = await check(c);
    if (!v.ok) {
      const f = await repo.registerFailure(c, key, ip);
      await onFail(c, f, v);
      return { fail: f };
    }
    await repo.clearLock(c, key);
    return { ok: await onOk(c, v) };
  });
  if (r.locked) throw new LockedError(r.locked);
  if (r.fail && r.fail.seconds_left > 0) throw new LockedError(r.fail.seconds_left);
  return r;
}

// Devuelve { token, session, user } o lanza DomainError (401 genérico o 429 bloqueado).
// previousToken: cookie de sesión que traía el navegador; esa sesión se cierra al ingresar.
export async function login(db, config, { username, password, remember, ip, userAgent, previousToken }) {
  const key = lockKey(username);
  const r = await guardedAttempt(db, key, ip, {
    check: async (c) => {
      const user = key ? await repo.findUserByUsername(c, key) : null;
      return { ...(await verifyUserSecret(user, password)), user };
    },
    onFail: async (c, f, v) => {
      if (!f) return repo.recordAttempt(c, key, ip, 'locked');
      const user = v.user;
      await repo.recordAttempt(c, key, ip, 'fail');
      await audit(c, { action: 'login_fail', entity: 'users', entityId: user ? user.id : null, detail: `Ingreso fallido: ${key.slice(0, 60)}`, ip });
      if (f.seconds_left > 0) {
        await audit(c, { action: 'login_lockout', entity: 'users', entityId: user ? user.id : null, detail: `Bloqueo de ${f.seconds_left} s tras ${f.fails} intentos: ${key.slice(0, 60)}`, ip });
      }
    },
    onOk: async (c, { user, legacy }) => {
      const set = { lastLoginAt: new Date() };
      // El PIN de 2.x sirve solo como contraseña temporal: obliga a crear una nueva.
      if (legacy) set.mustChangePassword = true;
      else if (needsRehash(user.password_hash)) set.passwordHash = await hashPassword(password);
      await repo.updateUser(c, user.id, set);
      if (typeof previousToken === 'string' && TOKEN_RE.test(previousToken)) await repo.deleteSession(c, sha256(previousToken));
      const s = await createSession(c, config, user.id, { remember: !!remember, ip, userAgent });
      await repo.recordAttempt(c, key, ip, 'ok');
      await audit(c, { action: 'login_ok', entity: 'users', entityId: user.id, detail: `Ingreso de ${user.username}${legacy ? ' con el PIN de 2.x' : ''}`, actorId: user.id, ip });
      return { ...s, user: await repo.findUserById(c, user.id) };
    },
  });
  if (!r.ok) throw new DomainError(BAD_LOGIN, 'bad_credentials', 401);
  return r.ok;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function createSession(q, config, userId, { remember, ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(32).toString('base64url');
  const ttlMs = remember ? config.session.rememberDays * 864e5 : config.session.absoluteHours * 36e5;
  const expiresAt = new Date(Date.now() + ttlMs);
  await repo.insertSession(q, { idHash: sha256(token), userId, csrfToken, remember, expiresAt, ip, userAgent: userAgent ? String(userAgent).slice(0, 500) : null });
  return { token, csrfToken, remember, expiresAt };
}

// Sesión válida para el token de la cookie, o null (y la borra si venció).
export async function resolveSession(db, config, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const idHash = sha256(token);
  const s = await repo.findSession(db, idHash);
  if (!s) return null;
  const idleLimit = s.remember ? config.session.rememberDays * 86400 : config.session.idleMinutes * 60;
  if (s.expired || !s.active || s.idle_seconds > idleLimit) {
    await repo.deleteSession(db, idHash);
    return null;
  }
  await repo.touchSession(db, idHash);
  return {
    idHash,
    csrfToken: s.csrf_token,
    remember: s.remember,
    user: { id: s.user_id, username: s.username, name: s.name, role: s.role, mustChangePassword: s.must_change_password },
  };
}

export async function logout(db, session, ip) {
  await repo.deleteSession(db, session.idHash);
  await audit(db, { action: 'logout', entity: 'users', entityId: session.user.id, detail: `Salida de ${session.user.username}`, actorId: session.user.id, ip });
}

export async function me(db, session) {
  const overrides = await repo.loadOverrides(db);
  return {
    user: { id: session.user.id, username: session.user.username, name: session.user.name, role: session.user.role },
    role: session.user.role,
    permissions: effectivePermissions(session.user.role, overrides),
    mustChangePassword: session.user.mustChangePassword,
    csrfToken: session.csrfToken,
  };
}

// Cambia la contraseña (o reemplaza el PIN migrado de 2.x). Cierra todas las sesiones del
// usuario y devuelve una sesión nueva (identificador y token CSRF renovados).
export async function changePassword(db, config, session, { currentPassword, newPassword, ip, userAgent }) {
  const user = await repo.findUserById(db, session.user.id);
  const key = lockKey(user.username);
  const r = await guardedAttempt(db, key, ip, {
    check: async () => verifyUserSecret(user, currentPassword),
    onFail: async (c, f) => {
      if (f) await audit(c, { action: 'password_change_fail', entity: 'users', entityId: user.id, detail: 'Contraseña actual incorrecta al cambiarla', actorId: user.id, ip });
    },
    onOk: async () => true,
  });
  if (!r.ok) throw new DomainError('La contraseña actual no es correcta.', 'bad_current_password', 400);
  checkPasswordPolicy(newPassword);
  if (newPassword === currentPassword) throw new DomainError('La contraseña nueva tiene que ser distinta de la actual.', 'same_password', 400);
  const hash = await hashPassword(newPassword);
  return withTransaction(db, async (c) => {
    await repo.updateUser(c, user.id, { passwordHash: hash, mustChangePassword: false, legacySalt: null, legacyPinHash: null });
    await repo.deleteUserSessions(c, user.id);
    const s = await createSession(c, config, user.id, { remember: !!session.remember, ip, userAgent });
    await audit(c, { action: 'password_change', entity: 'users', entityId: user.id, detail: `Cambio de contraseña de ${user.username}`, actorId: user.id, ip });
    return s;
  });
}
