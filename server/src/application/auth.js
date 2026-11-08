// Casos de uso de ingreso, sesión y contraseña.
import crypto from 'node:crypto';
import * as repo from '../adapters/pg/auth-repo.js';
import { withTransaction } from '../adapters/pg/pool.js';
import { DomainError } from '../domain/errors.js';
import { lockMessage } from '../domain/lockout.js';
import { effectivePermissions } from '../domain/permissions.js';
import { verifyPassword, verifyDummy, hashPassword, needsRehash, checkPasswordPolicy } from './passwords.js';
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

// Devuelve { token, session, user } o lanza DomainError (401 genérico o 429 bloqueado).
export async function login(db, config, { username, password, remember, ip, userAgent }) {
  const key = lockKey(username);
  const lock = await repo.getLock(db, key);
  if (lock && lock.seconds_left > 0) {
    await repo.recordAttempt(db, key, ip, 'locked');
    throw new LockedError(lock.seconds_left);
  }
  const user = key ? await repo.findUserByUsername(db, key) : null;
  const usable = user && user.active && user.password_hash;
  const ok = usable ? await verifyPassword(user.password_hash, password) : await verifyDummy(password);
  if (!ok) {
    const f = await repo.registerFailure(db, key, ip);
    await repo.recordAttempt(db, key, ip, 'fail');
    await audit(db, { action: 'login_fail', entity: 'users', entityId: user ? user.id : null, detail: `Ingreso fallido: ${key.slice(0, 60)}`, ip });
    if (f.seconds_left > 0) {
      await audit(db, { action: 'login_lockout', entity: 'users', entityId: user ? user.id : null, detail: `Bloqueo de ${f.seconds_left} s tras ${f.fails} intentos: ${key.slice(0, 60)}`, ip });
      throw new LockedError(f.seconds_left);
    }
    throw new DomainError(BAD_LOGIN, 'bad_credentials', 401);
  }
  return withTransaction(db, async (c) => {
    await repo.clearLock(c, key);
    const set = { lastLoginAt: new Date() };
    if (needsRehash(user.password_hash)) set.passwordHash = await hashPassword(password);
    await repo.updateUser(c, user.id, set);
    const s = await createSession(c, config, user.id, { remember: !!remember, ip, userAgent });
    await repo.recordAttempt(c, key, ip, 'ok');
    await audit(c, { action: 'login_ok', entity: 'users', entityId: user.id, detail: `Ingreso de ${user.username}`, actorId: user.id, ip });
    return { ...s, user: await repo.findUserById(c, user.id) };
  });
}

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
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
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

export async function changePassword(db, session, { currentPassword, newPassword, ip }) {
  const user = await repo.findUserById(db, session.user.id);
  const key = lockKey(user.username);
  const lock = await repo.getLock(db, key);
  if (lock && lock.seconds_left > 0) throw new LockedError(lock.seconds_left);
  if (!(await verifyPassword(user.password_hash || '', currentPassword))) {
    const f = await repo.registerFailure(db, key, ip);
    await audit(db, { action: 'password_change_fail', entity: 'users', entityId: user.id, detail: 'Contraseña actual incorrecta al cambiarla', actorId: user.id, ip });
    if (f.seconds_left > 0) throw new LockedError(f.seconds_left);
    throw new DomainError('La contraseña actual no es correcta.', 'bad_current_password', 400);
  }
  checkPasswordPolicy(newPassword);
  if (newPassword === currentPassword) throw new DomainError('La contraseña nueva tiene que ser distinta de la actual.', 'same_password', 400);
  const hash = await hashPassword(newPassword);
  await withTransaction(db, async (c) => {
    await repo.updateUser(c, user.id, { passwordHash: hash, mustChangePassword: false, legacySalt: null, legacyPinHash: null });
    // Las demás sesiones del usuario se cierran; la actual sigue.
    await repo.deleteUserSessions(c, user.id, session.idHash);
    await repo.clearLock(c, key);
    await audit(c, { action: 'password_change', entity: 'users', entityId: user.id, detail: `Cambio de contraseña de ${user.username}`, actorId: user.id, ip });
  });
}
