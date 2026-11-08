// Períodos y fechas (puro, igual que 2.1). 4 controles por mes: semana w = min(4, ceil(día/7)).
import { MONTHS, MSHORT } from './constants.js';

export const pad = (n) => String(n).padStart(2, '0');
export function periodOf(d = new Date()) { return { y: d.getFullYear(), m: d.getMonth() + 1, w: Math.min(4, Math.ceil(d.getDate() / 7)) }; }
export const pkeyOf = (p) => `${p.y}-${pad(p.m)}-${p.w}`;
export const pnumOf = (p) => p.y * 1000 + p.m * 10 + p.w;
export function parsePkey(k) { const [a, b, c] = String(k).split('-').map(Number); return { y: a, m: b, w: c }; }
export function prevP(p) { if (p.w > 1) return { ...p, w: p.w - 1 }; if (p.m > 1) return { y: p.y, m: p.m - 1, w: 4 }; return { y: p.y - 1, m: 12, w: 4 }; }
export function prevMonth(y, m) { return m > 1 ? { y, m: m - 1 } : { y: y - 1, m: 12 }; }
export function nextMonth(y, m) { return m < 12 ? { y, m: m + 1 } : { y: y + 1, m: 1 }; }
export const daysIn = (y, m) => new Date(y, m, 0).getDate();
export function weekRange(p) { const s = (p.w - 1) * 7 + 1, e = p.w < 4 ? p.w * 7 : daysIn(p.y, p.m); return [new Date(p.y, p.m - 1, s), new Date(p.y, p.m - 1, e, 23, 59, 59, 999)]; }
export function monthRange(y, m) { return [new Date(y, m - 1, 1), new Date(y, m, 0, 23, 59, 59, 999)]; }
export const plabel = (p) => `Semana ${p.w} de ${MONTHS[p.m - 1]} ${p.y}`;
export const mlabel = (y, m) => `${MONTHS[m - 1]} ${y}`;
export function toDate(iso) { return /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) : new Date(iso); }
export function fdate(iso) { if (!iso) return '—'; const d = toDate(iso); return `${d.getDate()} ${MSHORT[d.getMonth()]} ${d.getFullYear()}`; }
export function fdt(iso) { if (!iso) return '—'; const d = toDate(iso); return `${fdate(iso)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export const fhm = (iso) => { const d = toDate(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
export const pshort = (p) => `${MSHORT[p.m - 1][0].toUpperCase() + MSHORT[p.m - 1].slice(1)} · Sem ${p.w}`;
export function wrange(p) { const [a, b] = weekRange(p); return `${a.getDate()}–${b.getDate()} ${MSHORT[p.m - 1]}`; }
export function inRange(iso, [a, b]) { if (!iso) return false; const t = new Date(iso).getTime(); return t >= a.getTime() && t <= b.getTime(); }
export const nowISO = () => new Date().toISOString();
export const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
