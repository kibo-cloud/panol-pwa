// Etapa 8: existencia por técnico (la hoja RESUMEN del Excel) y días desde el último control,
// puro. Las mismas reglas que el servidor (server/src/domain/existencia.js): celda = unidades
// asignadas hoy; las marcas (C recambio, F faltante) salen del último control efectivo del
// poseedor; "requiere recambio" nunca cuenta como faltante; los archivados no entran. Los días se
// cuentan con la fecha de Buenos Aires, no con la del equipo.
import { holderKey } from './plantillas.js';
import { asgUnits } from './conteo.js';

export const TIME_ZONE = 'America/Argentina/Buenos_Aires';
export const DEFAULT_CONTROL_OVERDUE_DAYS = 14;
export const MAX_CONTROL_OVERDUE_DAYS = 365;

const DAY = 864e5;
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric' });
function localYMD(date) {
  const o = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day };
}
const dayNumber = (date) => { const p = localYMD(date); return Date.UTC(p.y, p.m - 1, p.d) / DAY; };

export function localDaysSince(from, now = new Date()) {
  if (!from) return null;
  const a = new Date(from);
  if (Number.isNaN(a.getTime())) return null;
  return Math.max(0, dayNumber(now) - dayNumber(a));
}

// Fecha local corta (D/M/AAAA) de un instante, como la alerta del servidor.
export function localDay(iso) {
  if (!iso) return '—';
  const p = localYMD(new Date(iso));
  return `${p.d}/${p.m}/${p.y}`;
}

export const isOverdue = (age, threshold) => threshold > 0 && !!age && age.days != null && age.days > threshold;

export function controlAge(last, firstSince, now = new Date()) {
  if (last) {
    const at = last.finishedAt || null;
    return { lastControlId: last.id, lastControlAt: at, never: false, from: at, days: localDaysSince(at, now) };
  }
  const from = firstSince || null;
  return { lastControlId: null, lastControlAt: null, never: true, from, days: localDaysSince(from, now) };
}

function firstActiveSince(activeAsg) {
  const o = {};
  for (const a of activeAsg || []) {
    const hk = holderKey(a); const at = a.since || a.createdAt || null;
    if (at && (!o[hk] || new Date(at) < new Date(o[hk]))) o[hk] = at;
  }
  return o;
}
const lastOf = (d, hk) => { const l = (d.effByTech || {})[hk] || []; return l[l.length - 1] || null; };

// Antigüedad del control de un poseedor (`<techId>` o `caja:<id>`).
export function holderAge(d, hk, now = new Date()) {
  return controlAge(lastOf(d, hk), firstActiveSince((d.activeAsg || []).filter((a) => holderKey(a) === hk))[hk], now);
}

export function ageLabel(age) {
  if (!age) return '';
  if (age.never) return age.days == null ? 'Sin controles' : `Sin controles (${age.days} ${age.days === 1 ? 'día' : 'días'} desde la primera entrega)`;
  if (age.days == null) return 'Último control sin fecha';
  return age.days === 0 ? 'Último control hoy' : age.days === 1 ? 'Último control ayer' : `Último control hace ${age.days} días`;
}
// ok: dentro del umbral; bad: vencido; pend: nunca controlado (todavía dentro del umbral).
export function ageTone(age, threshold) {
  if (isOverdue(age, threshold)) return 'bad';
  return age && age.never ? 'pend' : 'ok';
}

const liveTool = (t) => !!t && !t.archived && !t.archivedAt && t.active !== false;
const liveHolder = (t) => !!t && !t.archived && !t.archivedAt && t.active !== false;

// f: { plantilla: 'all' | id, cajas (true por defecto), withTools }.
export function buildExistencia(d, f = {}, { now = new Date() } = {}) {
  const filters = { plantilla: f.plantilla && f.plantilla !== 'all' ? f.plantilla : 'all', cajas: f.cajas !== false, withTools: !!f.withTools };
  const tools = (d.tools || []).filter(liveTool);
  const toolSet = new Set(tools.map((t) => t.id));
  const esp = Object.fromEntries((d.especialidades || []).map((e) => [e.id, e]));
  const plOf = (t) => t.plantillaId ?? t.shiftId ?? null;
  const first = firstActiveSince(d.activeAsg);

  let holders = (d.activeTechs || []).filter(liveHolder).filter((t) => filters.plantilla === 'all' || plOf(t) === filters.plantilla).map((t) => ({
    key: t.id, kind: 'tech', id: t.id, name: t.name || '', legajo: t.legajo || '', especialidadId: t.especialidadId || null,
    especialidad: t.especialidadId && esp[t.especialidadId] ? esp[t.especialidadId].name : '', plantillaId: plOf(t), lineaId: null,
  }));
  if (filters.cajas) {
    holders.push(...(d.activeCajas || d.cajas || []).filter(liveHolder).map((k) => ({
      key: `caja:${k.id}`, kind: 'caja', id: k.id, name: k.name || '', legajo: '', especialidadId: null, especialidad: '', plantillaId: null, lineaId: k.lineaId || null,
    })));
  }
  const keys = new Set(holders.map((h) => h.key));
  const cells = {};
  for (const a of d.activeAsg || []) {
    const hk = holderKey(a);
    if (!keys.has(hk) || !toolSet.has(a.toolId)) continue;
    const q = a.qty || 1;
    const row = cells[a.toolId] || (cells[a.toolId] = {});
    const cell = row[hk] || (row[hk] = { qty: 0, cambio: 0, faltante: 0 });
    cell.qty += q;
    const ctl = lastOf(d, hk); const item = ctl && ctl.items ? ctl.items[a.id] : null;
    if (item && item.state) { const u = asgUnits(item, q); cell.cambio += u.cambio; cell.faltante += u.faltante; }
  }
  holders = holders.map((h) => {
    const s = { total: 0, cambio: 0, faltante: 0 };
    for (const t of tools) { const c = cells[t.id] && cells[t.id][h.key]; if (c) { s.total += c.qty; s.cambio += c.cambio; s.faltante += c.faltante; } }
    return { ...h, ...controlAge(lastOf(d, h.key), first[h.key], now), ...s };
  });
  if (filters.withTools) holders = holders.filter((h) => h.total > 0);
  const shown = holders.map((h) => h.key);
  const totals = { total: 0, cambio: 0, faltante: 0, disponible: 0 };
  const rows = tools.map((t, i) => {
    const r = { toolId: t.id, n: i + 1, name: t.name || '', categoryId: t.categoryId || null, serialized: !!t.serialized, cells: {}, total: 0, cambio: 0, faltante: 0, disponible: ((d.pools || {})[t.id] || {}).disponible || 0 };
    for (const hk of shown) { const c = cells[t.id] && cells[t.id][hk]; if (c) { r.cells[hk] = c; r.total += c.qty; r.cambio += c.cambio; r.faltante += c.faltante; } }
    for (const k of Object.keys(totals)) totals[k] += r[k];
    return r;
  });
  return { filters, holders, rows, totals };
}

// Marcas de una celda: legibles en blanco y negro (letra y número, además del color).
export const cellMarks = (c) => [c && c.cambio ? `C ${c.cambio}` : '', c && c.faltante ? `F ${c.faltante}` : ''].filter(Boolean).join(' · ');
const cellText = (c) => { if (!c || !c.qty) return ''; const m = cellMarks(c); return m ? `${c.qty} (${m})` : String(c.qty); };

export const EXI_LEGEND = [
  'Cada celda: unidades asignadas hoy.',
  'C n: n unidades requieren recambio según el último control del técnico o la caja (no cuentan como faltantes).',
  'F n: n unidades faltantes según el último control.',
  'Sin marca: en buen estado en el último control, o entregada después de él.',
];
export const holderLabel = (h) => (h.kind === 'tech' && h.legajo ? `${h.name} (${h.legajo})` : h.name);

// Filas de la hoja de Excel (y del CSV si hiciera falta): encabezado de cada poseedor, una fila
// por herramienta, totales y la referencia al pie.
export function existenciaSheet(X, { title = 'Existencia por técnico', subtitle = '', catName = () => '' } = {}) {
  const pad = ['', '', ''];
  const tail = ['', '', '', ''];
  const out = [[title]];
  if (subtitle) out.push([subtitle]);
  out.push([]);
  out.push(['N°', 'Herramienta', 'Categoría', ...X.holders.map(holderLabel), 'Total asignado', 'Recambio', 'Faltante', 'Stock del pañol']);
  out.push(['Especialidad', ...pad.slice(1), ...X.holders.map((h) => (h.kind === 'caja' ? 'Caja compartida' : h.especialidad || 'Sin especialidad')), ...tail]);
  out.push(['Último control', ...pad.slice(1), ...X.holders.map((h) => (h.never ? 'Sin controles' : localDay(h.lastControlAt))), ...tail]);
  out.push(['Días desde el último control', ...pad.slice(1), ...X.holders.map((h) => (h.days == null ? '' : h.days)), ...tail]);
  for (const r of X.rows) out.push([r.n, r.name, catName(r.categoryId), ...X.holders.map((h) => cellText(r.cells[h.key])), r.total, r.cambio, r.faltante, r.disponible]);
  out.push(['', 'Total', '', ...X.holders.map((h) => cellText({ qty: h.total, cambio: h.cambio, faltante: h.faltante }) || '0'), X.totals.total, X.totals.cambio, X.totals.faltante, X.totals.disponible]);
  out.push([]);
  out.push(['Referencias']);
  for (const l of EXI_LEGEND) out.push([l]);
  return out;
}
