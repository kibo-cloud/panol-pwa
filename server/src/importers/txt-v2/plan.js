// Plan de importación del `.txt` v2 (puro): a partir del estado del servidor y del archivo,
// ambos en la forma canónica de validate.js, calcula el estado final y los cambios.
// - merge: semántica de mergeInto de 2.1 registro por registro (gana la fecha más nueva, los
//   empates quedan como en el servidor, un borrado de `data.deleted` más nuevo elimina el
//   registro; fechas más de un día en el futuro cuentan como ahora). Excepciones de la 3.0:
//   el libro de movimientos y la auditoría son de solo agregar y un control finalizado no se
//   modifica: lo que choca con eso es un conflicto informado, no se pisa.
// - replace: migración inicial. El servidor queda igual al archivo (la auditoría se agrega);
//   solo en un servidor sin movimientos ni controles, y el archivo tiene que traer un
//   administrador activo. El usuario que importa se conserva siempre.
// Después se revisan referencias y unicidades del estado final (como las restricciones de la
// base) y se generan los nombres de usuario que falten.
import crypto from 'node:crypto';
import { COLS } from './validate.js';
import { DEFAULT_SHIFTS } from '../../domain/constants.js';

const DATA_COLS = COLS.filter((c) => c !== 'config');
const LEDGER = new Set(['movements', 'audit']);
const DAY_MS = 864e5;
const LIST_MAX = 200;

const t = (v) => (typeof v === 'string' && v ? Date.parse(v) : -Infinity);
export const stamp = (r) => t(r.updatedAt || r.finishedAt || r.at || r.createdAt || '');

// JSON estable (claves ordenadas): para comparar registros y para el token del informe.
export function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
const content = (r, skip = ['createdAt', 'updatedAt']) => stableJson(Object.fromEntries(Object.entries(r).filter(([k]) => !skip.includes(k))));
const sameRecord = (a, b, skip) => content(a, skip) === content(b, skip);
// Usuarios: las credenciales no se comparan acá (se resuelven aparte).
const USER_SKIP = ['createdAt', 'updatedAt', 'salt', 'pinHash', 'username'];
const sameCols = (c, a, b) => (c === 'users' ? sameRecord(a, b, USER_SKIP) && (a.username || null) === (b.username || null) : sameRecord(a, b));
const controlIdentity = (r) => stableJson([r.techId, r.period, r.correction, r.supersedes]);

const shiftsOf = (doc) => {
  const list = doc.config.turnos?.list?.length ? doc.config.turnos.list : DEFAULT_SHIFTS;
  return Object.fromEntries(list.map((s) => [s.id, { name: s.name, order: s.order ?? 0 }]));
};

// Nombre de usuario a partir del nombre: minúsculas, sin acentos, lo que no es letra o número
// pasa a punto; sufijo numérico si ya existe.
export function deriveUsername(name, taken) {
  let base = String(name || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 55);
  if (base.length < 3) base = (base ? base + '.' : '') + 'usuario';
  let u = base;
  for (let i = 2; taken.has(u); i++) u = `${base}${i}`;
  taken.add(u);
  return u;
}

/**
 * server: { doc, creds: { [userId]: { hasPassword, legacyPinHash } }, ledger: { movements, controls, novedades, purchases, refs? },
 *           archived?, hidden?, tombstones?: { 'colección/id': fecha } }
 * file:   { data, deleted, savedAt }
 * Devuelve { mode, errors, conflicts, assumptions, changes, counts, token, final }.
 */
export const REPLACE_NOVEDADES = 'Reemplazar es solo para la migración inicial: el servidor ya tiene novedades. Usá Combinar.';
// Etapa 7: las solicitudes de compra tampoco están en el .txt v2.
export const REPLACE_COMPRAS = 'Reemplazar es solo para la migración inicial: el servidor ya tiene solicitudes de compra. Usá Combinar.';

export function planImport(server, file, { mode, actorId, now = new Date() }) {
  const errors = [];
  const conflicts = [];
  const assumptions = [];
  const err = (collection, id, field, message) => errors.push({ collection, id, field, message });
  const conflict = (collection, id, message) => conflicts.push({ collection, id, message });
  const assume = (collection, id, field, message) => assumptions.push({ collection, id, field, message });
  const sdoc = server.doc;
  const final = Object.fromEntries(COLS.map((c) => [c, { ...sdoc[c] }]));
  // Etapa 5: lo eliminado (archivado) en el servidor sigue eliminado; un registro más nuevo del
  // archivo no lo restaura en silencio (se informa). Las anulaciones y los movimientos anulados
  // no están en el .txt v2: el archivo no los vuelve a crear.
  const archived = server.archived || {};
  const hidden = server.hidden || new Set();
  // E5.V1: lo eliminado definitivamente en el servidor (sus marcas de borrado, por la auditoría)
  // no se vuelve a crear desde un archivo que todavía lo tiene: se informa.
  const tombstones = server.tombstones || {};
  // E7.V1: { 'colección/id': true } de lo que nombran las compras y las novedades del servidor.
  const refs = server.ledger?.refs || {};

  if (mode === 'replace') {
    if (server.ledger.movements > 0 || server.ledger.controls > 0) {
      err(null, null, null, 'Reemplazar es solo para la migración inicial: el servidor ya tiene movimientos o controles. Usá Combinar.');
    }
    // Etapa 6: las novedades no están en el .txt v2; reemplazar borraría lo que nombran.
    if (server.ledger.novedades > 0) err(null, null, null, REPLACE_NOVEDADES);
    if (server.ledger.purchases > 0) err(null, null, null, REPLACE_COMPRAS);
    const fileAdmins = Object.entries(file.data.users).filter(([id, u]) => id !== actorId && u.role === 'admin' && u.active !== false);
    if (!fileAdmins.length) err('users', null, null, 'El archivo no tiene un administrador activo. Reemplazar dejaría el sistema sin administrador.');
    for (const c of DATA_COLS) {
      if (c === 'audit') {
        for (const [id, r] of Object.entries(file.data.audit)) {
          if (!final.audit[id]) final.audit[id] = r;
          else if (!sameRecord(final.audit[id], r)) conflict('audit', id, 'Ya existe en la auditoría del servidor con otro contenido: no se modifica.');
        }
        continue;
      }
      final[c] = { ...file.data[c] };
    }
    // El usuario que importa se conserva tal cual (su sesión y su perfil no cambian).
    if (sdoc.users[actorId]) {
      if (file.data.users[actorId]) assume('users', actorId, null, 'Es tu usuario: se conserva el del servidor.');
      final.users[actorId] = sdoc.users[actorId];
    }
    final.config = { turnos: file.data.config.turnos || { list: DEFAULT_SHIFTS }, permisos: file.data.config.permisos || { roles: {} } };
  } else {
    const lim = now.getTime() + DAY_MS;
    const nowIso = now.toISOString();
    const clamp = (r) => {
      const o = { ...r };
      for (const k of ['updatedAt', 'finishedAt', 'at', 'createdAt', 'startedAt']) if (typeof o[k] === 'string' && t(o[k]) > lim) o[k] = nowIso;
      return o;
    };
    for (const c of DATA_COLS) {
      for (const [id, r0] of Object.entries(file.data[c])) {
        const r = clamp(r0);
        const cur = final[c][id];
        if (hidden.has(`${c}/${id}`)) {
          conflict(c, id, 'El movimiento está anulado en el servidor: no se importa.');
          continue;
        }
        if (cur && archived[`${c}/${id}`]) {
          if (stamp(r) > stamp(cur) && !sameCols(c, cur, r)) conflict(c, id, 'Está eliminado en el servidor: se conserva eliminado. Si corresponde, restauralo desde Administración › Registros eliminados.');
          continue;
        }
        if (!cur && tombstones[`${c}/${id}`]) {
          conflict(c, id, 'Está eliminado definitivamente en el servidor: no se vuelve a crear.');
          continue;
        }
        if (!cur) {
          final[c][id] = r;
          continue;
        }
        if (LEDGER.has(c)) {
          if (!sameRecord(cur, r)) conflict(c, id, c === 'movements' ? 'Ya existe en el libro del servidor con otro contenido: el libro no se modifica.' : 'Ya existe en la auditoría del servidor con otro contenido: no se modifica.');
          continue;
        }
        if (stamp(r) <= stamp(cur)) continue;
        if (c === 'controls') {
          if (cur.status === 'finalizado') {
            if (!sameRecord(cur, r)) conflict(c, id, 'El control está finalizado en el servidor: no se modifica (se corrige con un registro nuevo).');
            continue;
          }
          if (controlIdentity(cur) !== controlIdentity(r)) {
            conflict(c, id, 'El borrador del servidor es de otro técnico, período o tipo: no se modifica.');
            continue;
          }
        }
        if (c === 'users') {
          if (id === actorId) {
            if (r.role !== cur.role || r.active !== cur.active) conflict(c, id, 'Es tu usuario: no se cambia su perfil ni su estado al importar.');
            continue;
          }
          final[c][id] = { ...cur, name: r.name, role: r.role, active: r.active, updatedAt: r.updatedAt, salt: r.salt, pinHash: r.pinHash };
          continue;
        }
        final[c][id] = r;
      }
    }
    for (const [k, at0] of Object.entries(file.deleted)) {
      const at = t(at0) > lim ? t(nowIso) : t(at0);
      const i = k.indexOf('/');
      const c = k.slice(0, i);
      const id = k.slice(i + 1);
      if (c === 'config') {
        assume('config', id, null, 'Borrado de configuración ignorado.');
        continue;
      }
      const cur = final[c][id];
      if (!cur || !(at > stamp(cur))) continue;
      // Ya eliminado en el servidor: queda como está (archivado, con su historial).
      if (archived[`${c}/${id}`]) continue;
      if (LEDGER.has(c)) {
        conflict(c, id, c === 'movements' ? 'El archivo lo borra, pero el libro de movimientos no se borra.' : 'El archivo lo borra, pero la auditoría no se borra.');
        continue;
      }
      if (c === 'controls' && cur.status === 'finalizado') {
        conflict(c, id, 'El archivo lo borra, pero un control finalizado no se borra.');
        continue;
      }
      if (c === 'users' && id === actorId) {
        conflict(c, id, 'El archivo borra tu usuario: se conserva.');
        continue;
      }
      // E7.V1: las solicitudes de compra y las novedades no están en el .txt v2; lo que nombran
      // tiene historial en el servidor y no se borra.
      if (refs[`${c}/${id}`]) {
        conflict(c, id, 'El archivo lo borra, pero una solicitud de compra o una novedad del servidor lo nombra: se conserva.');
        continue;
      }
      delete final[c][id];
    }
    for (const key of ['turnos', 'permisos']) {
      const r = file.data.config[key];
      const cur = sdoc.config[key];
      if (r && (!cur || stamp(clamp(r)) > stamp(cur))) final.config[key] = clamp(r);
    }
    final.config.turnos ||= { list: DEFAULT_SHIFTS };
    final.config.permisos ||= { roles: {} };
  }
  for (const r of [file.data.config.permisos]) {
    for (const x of r?.ignored || []) assume('config', 'permisos', x, 'Permiso o perfil desconocido: se ignora.');
  }

  // ------------------------------------------------------------ usuarios: credenciales y nombres
  const taken = new Set();
  for (const [id, u] of Object.entries(final.users)) {
    const cur = sdoc.users[id];
    if (cur) {
      final.users[id] = { ...u, username: cur.username };
      taken.add(cur.username.toLowerCase());
    }
  }
  for (const [id, u] of Object.entries(final.users)) {
    if (sdoc.users[id]) continue;
    if (u.username && !taken.has(u.username)) {
      taken.add(u.username);
      continue;
    }
    const username = deriveUsername(u.name, taken);
    if (u.username) assume('users', id, 'username', `El usuario «${u.username}» ya existe: se usa «${username}».`);
    else assume('users', id, 'username', `Usuario generado: «${username}» (lo puede cambiar un administrador).`);
    final.users[id] = { ...u, username };
  }
  const credChanges = {};
  for (const [id, u] of Object.entries(final.users)) {
    const cr = server.creds[id];
    if (!sdoc.users[id]) {
      if (!u.pinHash) assume('users', id, 'pinHash', 'Sin PIN en el archivo: queda sin contraseña hasta que un administrador la restablezca.');
      continue;
    }
    // Un usuario que ya tiene contraseña nunca vuelve a un PIN; uno migrado puede renovar su PIN.
    if (cr && !cr.hasPassword && u.pinHash && u.pinHash !== cr.legacyPinHash && id !== actorId) credChanges[id] = { salt: u.salt, pinHash: u.pinHash };
  }

  // ------------------------------------------------------------ referencias y unicidades
  const fshifts = shiftsOf(final);
  const changed = (c, id) => !sdoc[c][id] || !sameCols(c, sdoc[c][id], final[c][id]);
  const fixRef = (c, id, field, exists, { optional, nullable = true }) => {
    const r = final[c][id];
    const v = r[field];
    if (v == null || exists(v)) return;
    if (!optional) return err(c, id, field, `hace referencia a un registro que no existe (${v})`);
    if (changed(c, id) && nullable) {
      final[c][id] = { ...r, [field]: null };
      assume(c, id, field, `Hace referencia a ${v}, que no existe: queda vacío.`);
    } else if (field === 'shiftId' || field === 'categoryId') {
      assume(c, id, field, `Hace referencia a ${v}, que ya no existe: queda vacío.`);
    } else {
      err(c, id, field, `hace referencia a un registro que se borra (${v})`);
    }
  };
  const has = (c) => (v) => !!final[c][v];
  for (const id of Object.keys(final.techs)) fixRef('techs', id, 'shiftId', (v) => !!fshifts[v], { optional: true });
  for (const id of Object.keys(final.tools)) fixRef('tools', id, 'categoryId', has('categories'), { optional: true });
  for (const id of Object.keys(final.units)) {
    fixRef('units', id, 'toolId', has('tools'), { optional: false });
    fixRef('units', id, 'techId', has('techs'), { optional: true });
  }
  for (const id of Object.keys(final.assignments)) {
    fixRef('assignments', id, 'techId', has('techs'), { optional: false });
    fixRef('assignments', id, 'toolId', has('tools'), { optional: false });
    fixRef('assignments', id, 'unitId', has('units'), { optional: true });
  }
  for (const id of Object.keys(final.shiftChanges)) fixRef('shiftChanges', id, 'techId', has('techs'), { optional: false });
  for (const id of Object.keys(final.controls)) {
    fixRef('controls', id, 'techId', has('techs'), { optional: false });
    fixRef('controls', id, 'supersedes', has('controls'), { optional: false });
  }
  const unique = (c, keyOf, field, message, show = (r) => r[field]) => {
    const seen = new Map();
    for (const [id, r] of Object.entries(final[c])) {
      const k = keyOf(r);
      if (k == null) continue;
      if (seen.has(k)) err(c, changed(c, id) ? id : seen.get(k), field, `${message} (${show(r)})`);
      else seen.set(k, id);
    }
  };
  unique('techs', (r) => r.legajo, 'legajo', 'legajo repetido');
  // Turnos = plantillas activas: nombre único sin distinguir mayúsculas (índice de la migración 008).
  const seenShift = new Map();
  for (const [id, s] of Object.entries(fshifts)) {
    const k = String(s.name ?? '').toLowerCase();
    if (seenShift.has(k)) err('shifts', id, 'name', `nombre de plantilla repetido (${s.name})`);
    else seenShift.set(k, id);
  }
  unique('units', (r) => r.code.toLowerCase(), 'code', 'código de unidad repetido');
  unique('controls', (r) => (r.correction ? null : stableJson([r.techId, r.period])), 'period', 'ya hay un control original de ese técnico en ese período', (r) => `${r.period.y}-${r.period.m}-${r.period.w}`);
  unique('movements', (r) => (r.type === 'recepcion' && r.resolvesMovementId ? r.resolvesMovementId : null), 'resolvesMovementId', 'esa devolución pendiente ya fue recibida');
  if (mode === 'merge') {
    const hasAdmin = (users) => Object.values(users).some((u) => u.role === 'admin' && u.active !== false);
    if (hasAdmin(sdoc.users) && !hasAdmin(final.users)) err('users', null, null, 'Combinar dejaría el sistema sin administrador activo.');
  }

  // ------------------------------------------------------------ cambios
  const changes = {};
  for (const c of DATA_COLS) {
    const create = {};
    const update = {};
    const del = [];
    for (const [id, r] of Object.entries(final[c])) {
      if (!sdoc[c][id]) create[id] = r;
      else if (!sameCols(c, sdoc[c][id], r) || (c === 'users' && credChanges[id])) update[id] = c === 'users' ? { ...r, ...(credChanges[id] ? { setPin: credChanges[id] } : {}) } : r;
    }
    for (const id of Object.keys(sdoc[c])) if (!final[c][id]) del.push(id);
    changes[c] = { create, update, delete: del };
  }
  const sshifts = shiftsOf(sdoc);
  changes.shifts = { create: {}, update: {}, delete: [] };
  for (const [id, s] of Object.entries(fshifts)) {
    if (!sshifts[id]) changes.shifts.create[id] = s;
    else if (!sameRecord(sshifts[id], s)) changes.shifts.update[id] = s;
  }
  for (const id of Object.keys(sshifts)) if (!fshifts[id]) changes.shifts.delete.push(id);
  const froles = final.config.permisos?.roles || {};
  changes.permisos = stableJson(froles) !== stableJson(sdoc.config.permisos?.roles || {}) ? froles : null;

  const counts = {};
  let total = 0;
  for (const c of [...DATA_COLS, 'shifts']) {
    const ch = changes[c];
    const n = { file: c === 'shifts' ? (file.data.config.turnos?.list?.length ?? 0) : Object.keys(file.data[c]).length, create: Object.keys(ch.create).length, update: Object.keys(ch.update).length, delete: ch.delete.length };
    total += n.create + n.update + n.delete;
    counts[c] = n;
  }
  if (changes.permisos) total++;
  // Las fechas llevadas a "ahora" cambian entre la revisión y la confirmación: no entran al token.
  const token = crypto.createHash('sha256').update(stableJson({ mode, changes }).split(now.toISOString()).join('<ahora>')).digest('hex');
  return { mode, errors, conflicts, assumptions, changes, counts, total, token, final };
}

// Informe para el cliente (sin credenciales; listas de ids recortadas).
export function reportOf(plan, { savedAt, fileErrors = [] }) {
  const errors = [...fileErrors, ...plan.errors];
  const ids = (o) => {
    const list = Array.isArray(o) ? o : Object.keys(o);
    return { ids: list.slice(0, LIST_MAX), more: Math.max(0, list.length - LIST_MAX) };
  };
  const changes = {};
  for (const [c, ch] of Object.entries(plan.changes)) {
    if (c === 'permisos') continue;
    changes[c] = { create: ids(ch.create), update: ids(ch.update), delete: ids(ch.delete) };
  }
  const users = Object.entries(plan.changes.users.create).map(([id, u]) => ({ id, name: u.name, username: u.username, role: u.role, pin: pinKind(u.pinHash) }));
  return {
    mode: plan.mode,
    version: 2,
    savedAt,
    token: errors.length ? null : plan.token,
    canApply: errors.length === 0,
    totalChanges: plan.total,
    counts: plan.counts,
    permissionsChange: !!plan.changes.permisos,
    changes,
    errorCount: errors.length,
    errors: errors.slice(0, LIST_MAX),
    conflicts: plan.conflicts.slice(0, LIST_MAX),
    conflictCount: plan.conflicts.length,
    assumptions: plan.assumptions.slice(0, LIST_MAX),
    assumptionCount: plan.assumptions.length,
    newUsers: users.slice(0, LIST_MAX),
  };
}

export function pinKind(h) {
  if (!h) return null;
  if (h.startsWith('pbkdf2$')) return 'pbkdf2';
  if (h.startsWith('sha256:')) return 'sha256';
  if (h.startsWith('fnv:')) return 'fnv';
  return 'desconocido';
}
