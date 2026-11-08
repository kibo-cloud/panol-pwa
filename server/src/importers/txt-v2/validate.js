// Lectura y validación del `.txt` versión 2 de Pañol 2.x (puro, sin I/O).
// - parseTxt: igual que parseDataText de 2.1 (texto desde el primer `{`, app 'panol', claves
//   __proto__/constructor/prototype rechazadas, límite de 20 MB) y además solo `version: 2`.
// - checkData: el esquema estricto de 2.1 (SCHEMA/CONFIG_SCHEMA) más las reglas de la 3.0:
//   fecha vacía ('') solo en campos opcionales (se guarda nula); obligatoria vacía es un error;
//   límites y enteros de la base. No corta en el primer problema: devuelve todos los errores
//   (colección, id, campo) para el informe, y con errores no se aplica nada.
// Los registros salen normalizados ("canónicos"): mismos nombres de campo de 2.1, fechas ISO
// completas o null, textos opcionales vacíos como null. El estado del servidor se lleva a la
// misma forma, así se comparan directamente.
import { validId, POOL_K, MV_TYPES, ROLE_KEYS, PERM_KEYS, ITEM_STATES, SCHEMA_LIM } from '../../domain/constants.js';

export const MAX_IMPORT = 20 * 1024 * 1024;
export const COLS = ['techs', 'shiftChanges', 'categories', 'tools', 'units', 'assignments', 'controls', 'movements', 'alertRes', 'audit', 'users', 'config'];
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class ImportFileError extends Error {
  constructor(message, code = 'invalid_file') {
    super(message);
    this.code = code;
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (max = SCHEMA_LIM.text) => (v) => typeof v === 'string' && v.length <= max;
const ISO_DT = /^\d{4}-\d{2}-\d{2}T/;
const ISO_D = /^\d{4}-\d{2}-\d{2}/;

export function parseTxt(text) {
  const txt = String(text ?? '');
  if (txt.length > MAX_IMPORT) throw new ImportFileError('El archivo es demasiado grande para ser de Pañol.', 'too_large');
  const i = txt.indexOf('{');
  if (i < 0) throw new ImportFileError('El archivo no tiene datos de Pañol.');
  let p;
  let badKey = false;
  try {
    p = JSON.parse(txt.slice(i), (k, v) => {
      if (BAD_KEYS.has(k)) badKey = true;
      return v;
    });
  } catch {
    throw new ImportFileError('El archivo está dañado o no es de Pañol.');
  }
  if (!isObj(p) || p.app !== 'panol' || !isObj(p.data)) throw new ImportFileError('El archivo no es de Pañol.');
  if (badKey) throw new ImportFileError('El archivo tiene datos con un formato no válido. No se cargó nada.');
  if (p.version !== 2) {
    const v = typeof p.version === 'number' || typeof p.version === 'string' ? String(p.version).slice(0, 20) : 'sin versión';
    throw new ImportFileError(`El archivo es de una versión del formato que no se puede importar (${v}). Solo se importan archivos .txt versión 2 (Pañol 2.0 y 2.1).`, 'unsupported_version');
  }
  if (!COLS.some((c) => isObj(p.data[c]) && Object.keys(p.data[c]).length)) throw new ImportFileError('El archivo no tiene datos de Pañol.');
  return { savedAt: isStr(40)(p.savedAt) ? p.savedAt : null, data: p.data };
}

// ---------------------------------------------------------------- campos
// Cada lector recibe el valor y devuelve { v } (valor canónico) o { e } (mensaje de error).
const ok = (v) => ({ v });
const bad = (e) => ({ e });
const MSG = {
  type: 'tiene un formato no válido',
  date: 'no es una fecha válida',
  emptyReq: 'es una fecha obligatoria y está vacía',
  missing: 'falta',
  empty: 'está vacío',
  int: 'tiene que ser un número entero',
};

function parseDate(v) {
  if (typeof v !== 'string' || v.length > 40 || !ISO_DT.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function parseDay(v) {
  if (typeof v !== 'string' || v.length > 40 || !ISO_D.test(v)) return null;
  const d = v.slice(0, 10);
  const t = Date.parse(d + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d ? d : null;
}

const F = {
  // Texto opcional (2.1 STR): '' se guarda como null.
  text: (max = SCHEMA_LIM.text) => (v) => (v == null || v === '' ? ok(null) : isStr(max)(v) ? ok(v) : bad(MSG.type)),
  // Texto obligatorio no vacío (la base exige al menos 1 carácter).
  name: (max = SCHEMA_LIM.name) => (v) => (v == null ? bad(MSG.missing) : !isStr(max)(v) ? bad(MSG.type) : v.trim() === '' ? bad(MSG.empty) : ok(v)),
  id: (v) => (v == null ? bad(MSG.missing) : validId(v) ? ok(v) : bad(MSG.type)),
  oid: (v) => (v == null || v === '' ? ok(null) : validId(v) ? ok(v) : bad(MSG.type)),
  bool: (def) => (v) => (v == null ? ok(def) : typeof v === 'boolean' ? ok(v) : bad(MSG.type)),
  boolOpt: (v) => (v == null ? ok(null) : typeof v === 'boolean' ? ok(v) : bad(MSG.type)),
  int: (min, def) => (v) => (v == null ? (def === undefined ? ok(null) : ok(def)) : typeof v !== 'number' || !Number.isFinite(v) ? bad(MSG.type) : !Number.isInteger(v) || v < min || v > 2147483647 ? bad(MSG.int) : ok(v)),
  one: (list, opt = false) => (v) => (v == null && opt ? ok(null) : list.includes(v) ? ok(v) : bad(v == null ? MSG.missing : MSG.type)),
  dateOpt: (v) => (v == null || v === '' ? ok(null) : (parseDate(v) ? ok(parseDate(v)) : bad(MSG.date))),
  dateReq: (v) => (v == null || v === '' ? bad(MSG.emptyReq) : (parseDate(v) ? ok(parseDate(v)) : bad(MSG.date))),
  dayOpt: (v) => (v == null || v === '' ? ok(null) : (parseDay(v) ? ok(parseDay(v)) : bad(MSG.date))),
  legajo: (v) => {
    if (v == null || v === '') return ok(null);
    if (typeof v === 'number' && Number.isFinite(v)) return ok(String(v));
    return isStr(SCHEMA_LIM.legajo)(v) ? ok(v.trim() === '' ? null : v) : bad(MSG.type);
  },
};

const COMMON = { createdAt: F.dateOpt, updatedAt: F.dateOpt, by: F.oid, demo: F.bool(false) };

const PERIOD = (v) => {
  if (!isObj(v)) return bad(v == null ? MSG.missing : MSG.type);
  const okN = (x, a, b) => Number.isInteger(x) && x >= a && x <= b;
  return okN(v.y, 1900, 9999) && okN(v.m, 1, 12) && okN(v.w, 1, 4) ? ok({ y: v.y, m: v.m, w: v.w }) : bad(MSG.type);
};

const ITEM = {
  state: F.one(ITEM_STATES), note: F.text(), toolId: F.oid, toolName: F.text(), category: F.text(), unitId: F.oid, unitCode: F.text(), qty: F.int(0, 1),
};
const TRANSFER = { toolId: F.id, qty: F.int(1), from: F.one(POOL_K), to: F.one(POOL_K), unitId: F.oid };

// Lee un objeto con un esquema: devuelve { v } o { e: 'campo: mensaje' }.
function shape(fields, { extraPrim = true } = {}) {
  return (r) => {
    if (!isObj(r)) return bad('registro: ' + MSG.type);
    const out = {};
    for (const [k, f] of Object.entries(fields)) {
      const x = f(r[k]);
      if (x.e) return bad(`${k}: ${x.e}`);
      out[k] = x.v;
    }
    // 2.1 acepta campos desconocidos solo si son primitivos; acá además se descartan.
    if (extraPrim) {
      for (const [k, v] of Object.entries(r)) {
        if (k in fields) continue;
        if (!(v == null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || isStr()(v))) return bad(`${k}: ${MSG.type}`);
      }
    }
    return ok(out);
  };
}

const items = (v) => {
  if (v == null) return ok({});
  if (!isObj(v)) return bad(MSG.type);
  const out = {};
  const it = shape(ITEM);
  for (const [aid, x] of Object.entries(v)) {
    if (!validId(aid)) return bad(MSG.type);
    const r = it(x);
    if (r.e) return bad(`${aid} › ${r.e}`);
    out[aid] = r.v;
  }
  return ok(out);
};
const counts = (v) => {
  if (v == null) return ok(null);
  const r = shape({ bueno: F.int(0, 0), cambio: F.int(0, 0), faltante: F.int(0, 0) })(v);
  return r;
};
const transfers = (v) => {
  if (v == null) return ok([]);
  if (!Array.isArray(v) || v.length > 100000) return bad(MSG.type);
  const t = shape(TRANSFER);
  const out = [];
  for (const [i, x] of v.entries()) {
    const r = t(x);
    if (r.e) return bad(`#${i} › ${r.e}`);
    out.push(r.v);
  }
  return ok(out);
};

const SCHEMA = {
  techs: { name: F.name(), legajo: F.legajo, shiftId: F.oid, active: F.bool(true), alta: F.dayOpt, ...COMMON },
  shiftChanges: { techId: F.id, from: F.oid, to: F.oid, fromName: F.text(), toName: F.text(), effectiveFrom: F.dayOpt, note: F.text(), at: F.dateReq, ...COMMON },
  categories: { name: F.name(), ...COMMON },
  tools: { name: F.name(), description: F.text(), categoryId: F.oid, serialized: F.bool(false), active: F.bool(true), ...COMMON },
  units: { toolId: F.id, code: F.name(SCHEMA_LIM.code), status: F.one(POOL_K), techId: F.oid, ...COMMON },
  assignments: {
    techId: F.id, toolId: F.id, unitId: F.oid, qty: F.int(1, 1), active: F.bool(true), since: F.dateOpt, until: F.dateOpt, movementId: F.oid,
    replaces: F.oid, endReason: F.text(), replacedBy: F.oid, endMovementId: F.oid, ...COMMON,
  },
  controls: {
    techId: F.id, techName: F.text(), shiftId: F.oid, period: PERIOD, status: F.one(['borrador', 'finalizado']), items, counts,
    correction: F.bool(false), supersedes: F.oid, startedAt: F.dateOpt, finishedAt: F.dateOpt, ...COMMON,
    pkey: (v) => (v == null || (typeof v === 'string' && /^\d{4}-\d{2}-[1-4]$/.test(v)) ? ok(undefined) : bad(MSG.type)),
    pnum: (v) => (v == null || (typeof v === 'number' && Number.isFinite(v)) ? ok(undefined) : bad(MSG.type)),
  },
  movements: {
    type: F.one(MV_TYPES), techId: F.oid, toolId: F.oid, qty: F.int(0), unitId: F.oid, newAssignmentId: F.oid, oldAssignmentId: F.oid, oldUnitId: F.oid,
    newUnitId: F.oid, oldState: F.one(['bueno', 'cambio', 'faltante', 'pendiente'], true), returned: F.boolOpt, oldDest: F.one(POOL_K, true),
    condition: F.one(POOL_K, true), linkedControlId: F.oid, resolvesMovementId: F.oid, transfers, reason: F.text(), notes: F.text(), at: F.dateReq, ...COMMON,
  },
  alertRes: { type: F.text(), title: F.text(), text: F.text(), techId: F.oid, note: F.text(), at: F.dateReq, ...COMMON },
  audit: { action: F.name(200), entity: F.text(200), entityId: F.text(), detail: F.text(), at: F.dateReq, ...COMMON },
  users: {
    name: F.name(), role: F.one(ROLE_KEYS), active: F.bool(true), salt: F.text(200), pinHash: F.text(400),
    username: (v) => (v == null || v === '' ? ok(null) : typeof v === 'string' && /^[a-z0-9._-]{3,60}$/.test(v) ? ok(v) : bad(MSG.type)),
    ...COMMON,
  },
};

const TURNO = shape({ id: F.id, name: F.name(), order: (v) => (v == null ? ok(0) : typeof v === 'number' && Number.isFinite(v) ? ok(Math.trunc(v)) : bad(MSG.type)) }, { extraPrim: false });
const CONFIG = {
  turnos: (r) => {
    if (!isObj(r)) return bad('registro: ' + MSG.type);
    if (!Array.isArray(r.list) || r.list.length > 100) return bad('list: ' + (r.list == null ? MSG.missing : MSG.type));
    const list = [];
    for (const [i, x] of r.list.entries()) {
      const t = TURNO(x);
      if (t.e) return bad(`list › #${i} › ${t.e}`);
      list.push(t.v);
    }
    const c = shape(COMMON, { extraPrim: false })({ createdAt: r.createdAt, updatedAt: r.updatedAt, by: r.by, demo: r.demo });
    if (c.e) return c;
    return ok({ list, ...c.v });
  },
  permisos: (r) => {
    if (!isObj(r)) return bad('registro: ' + MSG.type);
    const out = {};
    const ignored = [];
    for (const [role, perms] of Object.entries(r)) {
      if (role in COMMON) continue;
      if (perms == null) continue;
      if (!isObj(perms) || !Object.entries(perms).every(([k, x]) => validId(k) && typeof x === 'boolean')) return bad(`${role}: ${MSG.type}`);
      if (!ROLE_KEYS.includes(role) || role === 'admin') {
        ignored.push(role);
        continue;
      }
      for (const [k, x] of Object.entries(perms)) {
        if (PERM_KEYS.includes(k)) (out[role] ||= {})[k] = x;
        else ignored.push(`${role}.${k}`);
      }
    }
    const c = shape(COMMON, { extraPrim: false })({ createdAt: r.createdAt, updatedAt: r.updatedAt, by: r.by, demo: r.demo });
    if (c.e) return c;
    return ok({ roles: out, ignored, ...c.v });
  },
};

const DEL_KEY = (k) => {
  const i = k.indexOf('/');
  return i > 0 && COLS.includes(k.slice(0, i)) && validId(k.slice(i + 1));
};

// Revisa todas las colecciones. Devuelve { data, deleted, errors }.
export function checkData(src) {
  const data = {};
  const deleted = {};
  const errors = [];
  const err = (collection, id, field, message) => errors.push({ collection, id, field, message });
  for (const c of COLS) {
    data[c] = {};
    const col = src[c];
    if (col == null) continue;
    if (!isObj(col)) {
      err(c, null, null, 'la colección tiene un formato no válido');
      continue;
    }
    for (const [id, r0] of Object.entries(col)) {
      if (!validId(id)) {
        err(c, null, 'id', 'id no válido');
        continue;
      }
      const reader = c === 'config' ? CONFIG[id] : shape(SCHEMA[c]);
      if (!reader) continue; // config desconocida: 2.1 la acepta y no la usa
      const r = reader(r0);
      if (r.e) {
        const i = r.e.indexOf(':');
        err(c, id, i > 0 ? r.e.slice(0, i) : null, i > 0 ? r.e.slice(i + 1).trim() : r.e);
        continue;
      }
      const rec = r.v;
      if (c === 'controls') {
        delete rec.pkey;
        delete rec.pnum;
        if (rec.status === 'finalizado' && !rec.finishedAt) {
          err(c, id, 'finishedAt', `${MSG.emptyReq} (control finalizado)`);
          continue;
        }
        if (rec.correction && !rec.supersedes) {
          err(c, id, 'supersedes', 'falta (la corrección tiene que indicar el control que corrige)');
          continue;
        }
        if (!rec.counts) rec.counts = countItems(rec.items);
      }
      if (c === 'users' && rec.pinHash && !rec.salt) rec.salt = '';
      data[c][id] = rec;
    }
  }
  if (src.deleted != null) {
    if (!isObj(src.deleted)) err('deleted', null, null, 'tiene un formato no válido');
    else {
      for (const [k, at] of Object.entries(src.deleted)) {
        if (DEL_KEY(k) && isStr(40)(at) && ISO_DT.test(at) && parseDate(at)) deleted[k] = parseDate(at);
        else err('deleted', k.slice(0, 200), null, 'borrado con formato no válido');
      }
    }
  }
  return { data, deleted, errors };
}

export function countItems(items) {
  const n = { bueno: 0, cambio: 0, faltante: 0 };
  for (const it of Object.values(items || {})) n[it.state]++;
  return n;
}
