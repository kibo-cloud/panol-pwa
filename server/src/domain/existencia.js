// Etapa 8: existencia por técnico (la hoja RESUMEN del Excel) y días desde el último control.
// Puro: recibe el resultado de deriveState(). Las fechas se cuentan con la fecha local de la
// empresa. "Requiere recambio" nunca cuenta como faltante; los registros eliminados (archivados)
// no entran: son historial.
import { localParts, zonedDate } from './period.js';
import { asgUnits } from './controls.js';
import { holderKey } from './lineas.js';
import { DomainError } from './errors.js';

export const DEFAULT_CONTROL_OVERDUE_DAYS = 14;
export const MAX_CONTROL_OVERDUE_DAYS = 365;

const DAY = 86400000;
const dayNumber = (date) => {
  const p = localParts(date);
  return Date.UTC(p.y, p.m - 1, p.d) / DAY;
};

// Días de calendario (fecha local) entre `from` y `now`. Nunca negativo; sin fecha, null.
export function localDaysSince(from, now = new Date()) {
  if (!from) return null;
  const a = new Date(from);
  if (Number.isNaN(a.getTime())) return null;
  return Math.max(0, dayNumber(now) - dayNumber(a));
}

// Umbral de la alerta "Sin control hace N días" (0 la desactiva).
export function cleanOverdueDays(v) {
  if (!Number.isInteger(v) || v < 0 || v > MAX_CONTROL_OVERDUE_DAYS) {
    throw new DomainError(`Los días sin control tienen que ser un número entero entre 0 y ${MAX_CONTROL_OVERDUE_DAYS} (0 desactiva la alerta).`, 'invalid_setting', 422);
  }
  return v;
}

export const isOverdue = (age, threshold) => threshold > 0 && !!age && age.days != null && age.days > threshold;

// Fecha de un control para "último control": cuando se finalizó (o el inicio de su semana).
const controlAt = (c) => c.finishedAt || (c.period ? zonedDate(c.period.y, c.period.m, (c.period.w - 1) * 7 + 1).toISOString() : null);

// Último control efectivo por poseedor (`effList` viene ordenada por período y finalización).
export function lastControlByHolder(effList) {
  const o = {};
  for (const c of effList || []) o[holderKey(c)] = c;
  return o;
}

// Desde cuándo tiene herramientas cada poseedor: la primera asignación activa.
export function firstActiveSince(activeAsg) {
  const o = {};
  for (const a of activeAsg || []) {
    const hk = holderKey(a);
    const at = a.since || a.createdAt || null;
    if (!at) continue;
    if (!o[hk] || new Date(at) < new Date(o[hk])) o[hk] = at;
  }
  return o;
}

// Antigüedad del último control de un poseedor. Sin controles cuenta desde la primera entrega.
export function controlAge(last, firstSince, now = new Date()) {
  if (last) {
    const at = controlAt(last);
    return { lastControlId: last.id, lastControlAt: at, never: false, from: at, days: localDaysSince(at, now) };
  }
  const from = firstSince || null;
  return { lastControlId: null, lastControlAt: null, never: true, from, days: localDaysSince(from, now) };
}

const liveTool = (t) => !!t && !t.archivedAt && t.active !== false;
const liveTech = (t) => !!t && !t.archivedAt && t.active !== false;

// Matriz herramientas x poseedores. f: { plantilla: 'all' | id, cajas (true por defecto),
// withTools (solo poseedores con herramientas) }. Celda = unidades asignadas hoy; las marcas
// (recambio y faltante) salen del último control efectivo del poseedor para esas asignaciones.
export function buildExistencia(d, f = {}, { now = new Date() } = {}) {
  const filters = { plantilla: f.plantilla && f.plantilla !== 'all' ? f.plantilla : 'all', cajas: f.cajas !== false, withTools: !!f.withTools };
  const tools = (d.tools || []).filter(liveTool);
  const toolSet = new Set(tools.map((t) => t.id));
  const espById = d.especialidadById || {};
  const plOf = (t) => t.plantillaId ?? t.shiftId ?? null;
  const last = lastControlByHolder(d.effList);
  const first = firstActiveSince(d.activeAsg);

  let holders = (d.activeTechs || []).filter(liveTech).filter((t) => filters.plantilla === 'all' || plOf(t) === filters.plantilla).map((t) => ({
    key: t.id, kind: 'tech', id: t.id, name: t.name || '', legajo: t.legajo || '', especialidadId: t.especialidadId || null,
    especialidad: t.especialidadId && espById[t.especialidadId] ? espById[t.especialidadId].name : '', plantillaId: plOf(t), lineaId: null,
  }));
  if (filters.cajas) {
    holders.push(...(d.cajas || []).filter((k) => !k.archivedAt).map((k) => ({
      key: `caja:${k.id}`, kind: 'caja', id: k.id, name: k.name || '', legajo: '', especialidadId: null, especialidad: '', plantillaId: null, lineaId: k.lineaId || null,
    })));
  }

  // Celdas: herramienta -> poseedor -> { qty, cambio, faltante }.
  const cells = {};
  const keys = new Set(holders.map((h) => h.key));
  for (const a of d.activeAsg || []) {
    const hk = holderKey(a);
    if (!keys.has(hk) || !toolSet.has(a.toolId)) continue;
    const q = a.qty || 1;
    const cell = ((cells[a.toolId] ||= {})[hk] ||= { qty: 0, cambio: 0, faltante: 0 });
    cell.qty += q;
    const ctl = last[hk];
    const item = ctl && ctl.items ? ctl.items[a.id] : null;
    if (item && item.state) {
      const u = asgUnits(item, q);
      cell.cambio += u.cambio;
      cell.faltante += u.faltante;
    }
  }

  holders = holders.map((h) => {
    const s = { total: 0, cambio: 0, faltante: 0 };
    for (const t of tools) {
      const c = cells[t.id] && cells[t.id][h.key];
      if (!c) continue;
      s.total += c.qty;
      s.cambio += c.cambio;
      s.faltante += c.faltante;
    }
    return { ...h, ...controlAge(last[h.key], first[h.key], now), ...s };
  });
  if (filters.withTools) holders = holders.filter((h) => h.total > 0);
  const shown = holders.map((h) => h.key);

  const totals = { total: 0, cambio: 0, faltante: 0, disponible: 0 };
  const rows = tools.map((t, i) => {
    const r = { toolId: t.id, n: i + 1, name: t.name || '', categoryId: t.categoryId || null, serialized: !!t.serialized, cells: {}, total: 0, cambio: 0, faltante: 0, disponible: ((d.pools || {})[t.id] || {}).disponible || 0 };
    for (const hk of shown) {
      const c = cells[t.id] && cells[t.id][hk];
      if (!c) continue;
      r.cells[hk] = c;
      r.total += c.qty;
      r.cambio += c.cambio;
      r.faltante += c.faltante;
    }
    for (const k of Object.keys(totals)) totals[k] += r[k];
    return r;
  });
  return { filters, holders, rows, totals };
}
