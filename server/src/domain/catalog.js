// Reglas de técnicos, turnos, categorías, herramientas y unidades (portado de validTech,
// validCat, validTool y de los formularios de turnos de 2.1). Los mensajes son los de 2.1.
import { DomainError, tooLong } from './errors.js';
import { LIM } from './constants.js';

const fail = (msg, code = 'invalid_input') => {
  throw new DomainError(msg, code, 422);
};
const trim = (v) => String(v ?? '').trim();
export const sameText = (a, b) => trim(a).toLowerCase() === trim(b).toLowerCase();

// Primer registro (de una lista con `id`) cuyo campo coincide sin distinguir mayúsculas.
export function findDuplicate(rows, field, value, exceptId = null) {
  return rows.find((r) => r.id !== exceptId && r[field] != null && sameText(r[field], value)) || null;
}

// Fecha ISO YYYY-MM-DD que existe en el calendario.
export function validDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
export function cleanDay(s, what = 'La fecha') {
  if (s == null || s === '') return null;
  if (!validDay(s)) fail(`${what} no es válida.`, 'invalid_date');
  return s;
}

export function cleanText(v, what) {
  const s = trim(v);
  tooLong(s, LIM.text, what);
  return s;
}

export function cleanTech(input) {
  const name = trim(input.name);
  const legajo = trim(input.legajo);
  if (name.length < 3) fail('Ingresá nombre y apellido.');
  if (!legajo) fail('Ingresá el legajo.');
  tooLong(name, LIM.name, 'El nombre');
  tooLong(legajo, LIM.legajo, 'El legajo');
  return { name, legajo };
}

export const legajoTaken = (legajo, owner) => new DomainError(`El legajo ${legajo} ya pertenece a ${owner}.`, 'legajo_taken', 409);

// Turnos, categorías y herramientas: al menos 2 caracteres.
export function cleanName(v, msg = 'Ingresá un nombre.') {
  const n = trim(v);
  if (n.length < 2) fail(msg);
  tooLong(n, LIM.name, 'El nombre');
  return n;
}

export function cleanCode(v) {
  const c = trim(v);
  if (!c) fail('Ingresá el código.');
  tooLong(c, LIM.code, 'El código');
  return c;
}
