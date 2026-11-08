// Períodos de control: 4 por mes, semana w = min(4, ceil(día/7)), siempre con la fecha local
// de la empresa (no la del equipo ni la UTC).
import { MONTHS } from './constants.js';

export const TIME_ZONE = 'America/Argentina/Buenos_Aires';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

// Partes de la fecha local de un instante.
export function localParts(date) {
  const o = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}

// Instante (Date) de una hora local de la empresa. Sirve aunque cambie el huso horario.
export function zonedDate(y, m, d, h = 0, mi = 0, s = 0, ms = 0) {
  const want = Date.UTC(y, m - 1, d, h, mi, s, ms);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(t));
    const got = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, ms);
    if (got === want) break;
    t += want - got;
  }
  return new Date(t);
}

export const pad = (n) => String(n).padStart(2, '0');

export function periodOf(date = new Date()) {
  const p = localParts(date);
  return { y: p.y, m: p.m, w: Math.min(4, Math.ceil(p.d / 7)) };
}
export const pkeyOf = (p) => `${p.y}-${pad(p.m)}-${p.w}`;
export const pnumOf = (p) => p.y * 1000 + p.m * 10 + p.w;
export function parsePkey(k) {
  const [y, m, w] = String(k).split('-').map(Number);
  return { y, m, w };
}
export function prevP(p) {
  if (p.w > 1) return { ...p, w: p.w - 1 };
  if (p.m > 1) return { y: p.y, m: p.m - 1, w: 4 };
  return { y: p.y - 1, m: 12, w: 4 };
}
export const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// [inicio, fin] de la semana del período, en hora local (la semana 4 llega a fin de mes).
export function weekRange(p) {
  const s = (p.w - 1) * 7 + 1;
  const e = p.w < 4 ? p.w * 7 : daysIn(p.y, p.m);
  return [zonedDate(p.y, p.m, s), zonedDate(p.y, p.m, e, 23, 59, 59, 999)];
}

export function localDateISO(date = new Date()) {
  const p = localParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export const plabel = (p) => `Semana ${p.w} de ${MONTHS[p.m - 1]} ${p.y}`;
