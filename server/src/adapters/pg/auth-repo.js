// SQL de usuarios, sesiones, bloqueos, permisos y auditoría. `q` es un pool o un cliente.
import { LOCK_AFTER, LOCK_BASE_SECONDS, LOCK_MAX_SECONDS } from '../../domain/lockout.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

// Nunca incluye hashes.
export const publicUser = (r) => ({
  id: r.id,
  username: r.username,
  name: r.name,
  role: r.role,
  active: r.active,
  mustChangePassword: r.must_change_password,
  lastLoginAt: iso(r.last_login_at),
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  // Etapa 5: baja lógica (eliminado = desactivado y oculto).
  archived: r.archived_at != null,
  archivedAt: iso(r.archived_at),
  archivedBy: r.archived_by ?? null,
  archiveReason: r.archive_reason ?? null,
});

export async function findUserByUsername(q, username) {
  const { rows } = await q.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0] || null;
}

export async function findUserById(q, id) {
  const { rows } = await q.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// Sin los eliminados (se ven en Administración › Registros eliminados).
export async function listUsers(q) {
  const { rows } = await q.query('SELECT * FROM users WHERE archived_at IS NULL ORDER BY lower(name), id');
  return rows;
}

export async function countActiveAdmins(q, exceptId = null) {
  const { rows } = await q.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND id IS DISTINCT FROM $1", [exceptId]);
  return rows[0].n;
}

export async function insertUser(q, u) {
  const { rows } = await q.query(
    `INSERT INTO users (id, username, name, role, active, password_hash, must_change_password, created_by)
     VALUES ($1,$2,$3,$4,true,$5,$6,$7) RETURNING *`,
    [u.id, u.username, u.name, u.role, u.passwordHash, u.mustChangePassword, u.createdBy ?? null],
  );
  return rows[0];
}

// Actualiza campos permitidos; con `version` exige que coincida (si no, devuelve null).
const USER_COLS = { name: 'name', role: 'role', active: 'active', passwordHash: 'password_hash', mustChangePassword: 'must_change_password', lastLoginAt: 'last_login_at', legacySalt: 'legacy_salt', legacyPinHash: 'legacy_pin_hash' };
export async function updateUser(q, id, set, { version } = {}) {
  const keys = Object.keys(set);
  for (const k of keys) if (!USER_COLS[k]) throw new Error(`Campo no permitido: ${k}`);
  const params = [id, ...keys.map((k) => set[k])];
  let where = 'id = $1';
  if (version != null) {
    params.push(version);
    where += ` AND version = $${params.length}`;
  }
  const sets = keys.map((k, i) => `${USER_COLS[k]} = $${i + 2}`).join(', ');
  const { rows } = await q.query(`UPDATE users SET ${sets} WHERE ${where} RETURNING *`, params);
  return rows[0] || null;
}

// ---------------------------------------------------------------- sesiones
export async function insertSession(q, s) {
  await q.query(
    'INSERT INTO sessions (id_hash, user_id, csrf_token, remember, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [s.idHash, s.userId, s.csrfToken, s.remember, s.expiresAt, s.ip, s.userAgent],
  );
}

export async function findSession(q, idHash) {
  const { rows } = await q.query(
    `SELECT s.id_hash, s.user_id, s.csrf_token, s.remember, s.created_at, s.last_seen_at, s.expires_at,
            extract(epoch FROM now() - s.last_seen_at)::float AS idle_seconds, now() >= s.expires_at AS expired,
            u.username, u.name, u.role, u.active, u.must_change_password, u.version
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1`,
    [idHash],
  );
  return rows[0] || null;
}

export const touchSession = (q, idHash) => q.query("UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1 AND last_seen_at < now() - interval '60 seconds'", [idHash]);
export const deleteSession = (q, idHash) => q.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]);
export const deleteUserSessions = (q, userId, exceptHash = null) => q.query('DELETE FROM sessions WHERE user_id = $1 AND id_hash IS DISTINCT FROM $2', [userId, exceptHash]);

// ---------------------------------------------------------------- bloqueo progresivo
export async function getLock(q, key) {
  const { rows } = await q.query(
    'SELECT fails, locked_until, GREATEST(0, ceil(extract(epoch FROM locked_until - now())))::int AS seconds_left FROM login_locks WHERE username = $1',
    [key],
  );
  return rows[0] || null;
}

// Crea (si falta) y toma con FOR UPDATE la fila de bloqueo del usuario. Llamar dentro de una
// transacción: los intentos en paralelo del mismo usuario esperan acá hasta que el anterior
// registre su resultado.
export async function lockForAttempt(q, key) {
  await q.query('INSERT INTO login_locks (username, fails) VALUES ($1, 0) ON CONFLICT (username) DO NOTHING', [key]);
  const { rows } = await q.query(
    'SELECT fails, locked_until, GREATEST(0, ceil(extract(epoch FROM locked_until - now())))::int AS seconds_left FROM login_locks WHERE username = $1 FOR UPDATE',
    [key],
  );
  return rows[0];
}

// Suma un fallo de forma atómica y, desde el quinto, fija la espera (30 s, doble, máx. 15 min).
export async function registerFailure(q, key, ip) {
  const { rows } = await q.query(
    `INSERT INTO login_locks AS l (username, fails, locked_until, last_ip, updated_at)
       VALUES ($1, 1, CASE WHEN 1 >= $3 THEN now() + make_interval(secs => $4) END, $2, now())
     ON CONFLICT (username) DO UPDATE SET
       fails = l.fails + 1,
       locked_until = CASE WHEN l.fails + 1 >= $3
         THEN now() + make_interval(secs => LEAST($5::float8, $4::float8 * power(2, l.fails + 1 - $3)))
         ELSE NULL END,
       last_ip = EXCLUDED.last_ip,
       updated_at = now()
     RETURNING fails, GREATEST(0, ceil(extract(epoch FROM locked_until - now())))::int AS seconds_left`,
    [key, ip, LOCK_AFTER, LOCK_BASE_SECONDS, LOCK_MAX_SECONDS],
  );
  return rows[0];
}

export const clearLock = (q, key) => q.query('DELETE FROM login_locks WHERE username = $1', [key]);

export const recordAttempt = (q, username, ip, outcome) =>
  q.query('INSERT INTO login_attempts (username, ip, outcome) VALUES ($1,$2,$3)', [String(username).slice(0, 200), ip, outcome]);

// ---------------------------------------------------------------- permisos
export async function loadOverrides(q) {
  const { rows } = await q.query('SELECT role, perm, allowed FROM role_permissions');
  const out = {};
  for (const r of rows) (out[r.role] ||= {})[r.perm] = r.allowed;
  return out;
}

export async function replaceOverrides(q, overrides, actorId) {
  await q.query('DELETE FROM role_permissions');
  for (const [role, perms] of Object.entries(overrides)) {
    for (const [perm, allowed] of Object.entries(perms)) {
      await q.query('INSERT INTO role_permissions (role, perm, allowed, created_by) VALUES ($1,$2,$3,$4)', [role, perm, allowed, actorId]);
    }
  }
}

// ---------------------------------------------------------------- auditoría
export const insertAudit = (q, a) =>
  q.query('INSERT INTO audit_log (id, action, entity, entity_id, detail, actor_id, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    a.id, a.action, a.entity ?? null, a.entityId ?? null, a.detail ?? null, a.actorId ?? null, a.ip ?? null,
  ]);
