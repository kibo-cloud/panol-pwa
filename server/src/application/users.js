// Administración de usuarios (solo admin) y de permisos por rol.
import * as repo from '../adapters/pg/auth-repo.js';
import { withTransaction } from '../adapters/pg/pool.js';
import { DomainError } from '../domain/errors.js';
import { LIM, ROLES, ROLE_KEYS, PERM_KEYS, PERMS } from '../domain/constants.js';
import { effectivePermissions } from '../domain/permissions.js';
import { hashPassword, checkPasswordPolicy, generateTemporaryPassword } from './passwords.js';
import { newId } from './ids.js';
import { audit } from './auth.js';
import { lockName } from '../adapters/pg/catalog-repo.js';

const USERNAME_RE = /^[a-z0-9._-]{3,60}$/;
const LAST_ADMIN = 'Tiene que quedar al menos un administrador activo.';

function cleanName(name) {
  const n = String(name ?? '').trim();
  if (!n) throw new DomainError('Ingresá el nombre.', 'invalid_name', 400);
  if (n.length > LIM.name) throw new DomainError(`El nombre admite hasta ${LIM.name} caracteres.`, 'too_long', 400);
  return n;
}
function cleanRole(role) {
  if (!ROLE_KEYS.includes(role)) throw new DomainError('Elegí un perfil válido.', 'invalid_role', 400);
  return role;
}
function cleanUsername(u) {
  const s = String(u ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(s)) throw new DomainError('El usuario tiene que tener entre 3 y 60 caracteres: letras minúsculas, números, punto, guion o guion bajo.', 'invalid_username', 400);
  return s;
}
async function mustFind(q, id) {
  const u = await repo.findUserById(q, id);
  if (!u) throw new DomainError('No se encontró el usuario.', 'not_found', 404);
  return u;
}
// Un solo cambio de perfil, baja o restablecimiento de usuarios a la vez: así el chequeo de
// "último administrador activo" no se puede saltear con dos pedidos en paralelo.
export const lockAdmins = (c) => lockName(c, 'users:admins');

const versionConflict = () => new DomainError('Otra persona modificó este usuario. Recargá para ver los cambios.', 'version_conflict', 409);

export const listUsers = async (db) => (await repo.listUsers(db)).map(repo.publicUser);

export async function createUser(db, actor, input) {
  const username = cleanUsername(input.username);
  const name = cleanName(input.name);
  const role = cleanRole(input.role);
  const generated = input.temporaryPassword == null;
  const temporaryPassword = generated ? generateTemporaryPassword() : input.temporaryPassword;
  checkPasswordPolicy(temporaryPassword);
  const passwordHash = await hashPassword(temporaryPassword);
  return withTransaction(db, async (c) => {
    if (await repo.findUserByUsername(c, username)) throw new DomainError('Ya existe un usuario con ese nombre de usuario.', 'username_taken', 409);
    const row = await repo.insertUser(c, { id: newId('u'), username, name, role, passwordHash, mustChangePassword: true, createdBy: actor.id }).catch((e) => {
      if (e.code === '23505') throw new DomainError('Ya existe un usuario con ese nombre de usuario.', 'username_taken', 409);
      throw e;
    });
    await audit(c, { action: 'user_create', entity: 'users', entityId: row.id, detail: `Alta de usuario ${username} (${ROLES[role]})`, actorId: actor.id, ip: actor.ip });
    return { user: repo.publicUser(row), ...(generated ? { temporaryPassword } : {}) };
  });
}

export async function updateUser(db, actor, id, input, version) {
  return withTransaction(db, async (c) => {
    await lockAdmins(c);
    const cur = await mustFind(c, id);
    const set = {};
    if (input.name !== undefined) set.name = cleanName(input.name);
    if (input.role !== undefined) set.role = cleanRole(input.role);
    if (!Object.keys(set).length) throw new DomainError('No hay cambios para guardar.', 'no_changes', 400);
    if (cur.role === 'admin' && set.role && set.role !== 'admin' && cur.active && (await repo.countActiveAdmins(c, id)) === 0) throw new DomainError(LAST_ADMIN, 'last_admin', 409);
    const row = await repo.updateUser(c, id, set, { version });
    if (!row) throw versionConflict();
    const parts = [];
    if (set.name && set.name !== cur.name) parts.push(`nombre «${cur.name}» → «${set.name}»`);
    if (set.role && set.role !== cur.role) parts.push(`perfil ${ROLES[cur.role]} → ${ROLES[set.role]}`);
    await audit(c, { action: 'user_update', entity: 'users', entityId: id, detail: `Usuario ${cur.username}: ${parts.join(', ') || 'sin cambios'}`, actorId: actor.id, ip: actor.ip });
    return repo.publicUser(row);
  });
}

export async function setActive(db, actor, id, active, version) {
  return withTransaction(db, async (c) => {
    await lockAdmins(c);
    const cur = await mustFind(c, id);
    if (!active && cur.role === 'admin' && cur.active && (await repo.countActiveAdmins(c, id)) === 0) throw new DomainError(LAST_ADMIN, 'last_admin', 409);
    if (!active && id === actor.id) throw new DomainError('No podés desactivar tu propio usuario.', 'self_deactivate', 409);
    const row = await repo.updateUser(c, id, { active }, { version });
    if (!row) throw versionConflict();
    if (!active) await repo.deleteUserSessions(c, id);
    await audit(c, { action: active ? 'user_reactivate' : 'user_deactivate', entity: 'users', entityId: id, detail: `${active ? 'Reactivación' : 'Desactivación'} de ${cur.username}`, actorId: actor.id, ip: actor.ip });
    return repo.publicUser(row);
  });
}

// Fija una contraseña temporal y obliga a cambiarla en el próximo ingreso.
export async function resetPassword(db, actor, id, input = {}, version) {
  const generated = input.temporaryPassword == null;
  const temporaryPassword = generated ? generateTemporaryPassword() : input.temporaryPassword;
  checkPasswordPolicy(temporaryPassword);
  const passwordHash = await hashPassword(temporaryPassword);
  return withTransaction(db, async (c) => {
    await lockAdmins(c);
    const cur = await mustFind(c, id);
    const row = await repo.updateUser(c, id, { passwordHash, mustChangePassword: true, legacySalt: null, legacyPinHash: null }, { version });
    if (!row) throw versionConflict();
    await repo.deleteUserSessions(c, id);
    await repo.clearLock(c, cur.username.toLowerCase());
    await audit(c, { action: 'password_reset', entity: 'users', entityId: id, detail: `Restablecimiento de contraseña de ${cur.username}`, actorId: actor.id, ip: actor.ip });
    return { user: repo.publicUser(row), ...(generated ? { temporaryPassword } : {}) };
  });
}

// ---------------------------------------------------------------- permisos por rol
export async function getPermissions(db) {
  const overrides = await repo.loadOverrides(db);
  return {
    roles: ROLE_KEYS.map((k) => ({ key: k, label: ROLES[k] })),
    perms: PERMS.map(([key, label]) => ({ key, label })),
    overrides,
    effective: Object.fromEntries(ROLE_KEYS.map((r) => [r, effectivePermissions(r, overrides)])),
  };
}

export async function setPermissions(db, actor, overrides) {
  for (const [role, perms] of Object.entries(overrides)) {
    if (!ROLE_KEYS.includes(role) || role === 'admin') throw new DomainError('Perfil inválido en los permisos.', 'invalid_role', 400);
    for (const [perm, v] of Object.entries(perms)) {
      if (!PERM_KEYS.includes(perm) || typeof v !== 'boolean') throw new DomainError('Permiso inválido.', 'invalid_perm', 400);
    }
  }
  await withTransaction(db, async (c) => {
    await repo.replaceOverrides(c, overrides, actor.id);
    await audit(c, { action: 'permissions_update', entity: 'role_permissions', detail: `Permisos actualizados: ${JSON.stringify(overrides)}`, actorId: actor.id, ip: actor.ip });
  });
  return getPermissions(db);
}
