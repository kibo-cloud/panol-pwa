// Etapa 10: informe para auditoría (PEDIDO §2.11). Puro: recibe deriveState() del estado leído en
// una sola instantánea, más las novedades y las compras del período, y arma todas las secciones.
// Solo cuentan los controles finalizados vigentes (una corrección reemplaza al original, que se
// lista como corrección); los controles importados del Excel llevan su marca y su limpieza
// "sin dato"; los registros eliminados siguen con la marca "(eliminado)".
// Fechas y meses con la fecha local de la empresa (Buenos Aires).
import { MONTHS, MV, VOID_LABEL } from './constants.js';
import { pad, pnumOf, localParts, localDateISO, zonedDate, daysIn } from './period.js';
import { quantitiesOfState } from './controls.js';
import { holderKey } from './lineas.js';
import { voidedIds } from './alerts.js';
import { shiftChangesFromHistory } from './plantillas.js';
import { stripCosts, PURCHASE_STATUS_LABEL } from './compras.js';
import { DomainError } from './errors.js';

export const AUDIT_SECTIONS = ['resumen', 'poseedores', 'faltantes', 'movimientos', 'compras', 'novedades', 'plantillas', 'firmas'];
export const AUDIT_SECTION_LABEL = {
  resumen: 'Resumen', poseedores: 'Por técnico o caja', faltantes: 'Faltantes y su resolución', movimientos: 'Entregas, reposiciones, devoluciones y retiros',
  compras: 'Compras aprobadas y rechazadas', novedades: 'Novedades', plantillas: 'Cambios de plantilla', firmas: 'Firmas',
};
export const MAX_AUDIT_MONTHS = 24;
// Símbolos de la impresión (blanco y negro): además del color.
export const SYMBOL = { bueno: '✓', cambio: 'C', faltante: 'F', sinDato: '—' };
export const AUDIT_LEGEND = [
  '✓ Bueno: en buen estado.',
  'C Cambio: requiere recambio (nunca cuenta como faltante).',
  'F Faltante: no estaba en el control.',
  'Con más de una unidad, cada símbolo lleva la cantidad (✓2 C1 F1).',
  '— Sin dato: la herramienta no se contó en ese control (por ejemplo, un conteo vacío del Excel).',
  'Corrección: el control reemplaza a otro del mismo período; el original queda en la lista de correcciones.',
  'Importado del Excel: control o movimiento cargado desde la planilla anterior (limpieza sin dato).',
];
// Movimientos del poseedor que van en la sección 4 (más sus anulaciones).
export const HOLDER_MOVES = ['entrega_inicial', 'adicional', 'reposicion', 'devolucion', 'retiro'];

const bad = (msg, code = 'invalid_selection') => new DomainError(msg, code, 400);
const ID_RE = /^[A-Za-z0-9_.~:@+-]{1,200}$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthNum = (y, m) => y * 12 + (m - 1);
const fromNum = (n) => ({ y: Math.floor(n / 12), m: (n % 12) + 1 });
export const monthKey = (y, m) => `${y}-${pad(m)}`;
export const monthLabel = (y, m) => `${MONTHS[m - 1]} ${y}`;

function parseMonth(v, what) {
  const r = MONTH_RE.exec(String(v || '').trim());
  if (!r) throw bad(`El mes ${what} no es válido (AAAA-MM).`, 'invalid_months');
  return { y: Number(r[1]), m: Number(r[2]) };
}

// 'all' | 'none' (si se admite) | lista de ids separados por coma.
function parseIds(v, what, { none = false } = {}) {
  const s = v == null || v === '' ? 'all' : String(v).trim();
  if (s === 'all') return 'all';
  if (s === 'none' && none) return 'none';
  const ids = [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
  if (!ids.length || ids.length > 500 || ids.some((x) => !ID_RE.test(x))) throw bad(`La selección de ${what} no es válida.`);
  return ids;
}

/**
 * Selección del informe (la misma que guarda la pantalla en la dirección):
 * - months: 'AAAA-MM,AAAA-MM' (meses sueltos) o from/to (un rango de meses).
 * - plantillas: 'all' | ids; techs y cajas: 'all' | 'none' | ids; sections: claves de AUDIT_SECTIONS.
 * Hasta MAX_AUDIT_MONTHS meses y ninguno posterior al mes en curso.
 */
export function parseAuditSelection(q = {}, { now = new Date() } = {}) {
  let list = [];
  if (q.months) {
    const raw = String(q.months).split(',').map((x) => x.trim()).filter(Boolean);
    if (raw.length > 200) throw new DomainError(`El informe puede abarcar hasta ${MAX_AUDIT_MONTHS} meses. Elegí menos meses.`, 'report_too_large', 422);
    list = raw.map((x) => parseMonth(x, x));
  } else if (q.from || q.to) {
    const a = parseMonth(q.from || q.to, 'desde');
    const b = parseMonth(q.to || q.from, 'hasta');
    const na = monthNum(a.y, a.m);
    const nb = monthNum(b.y, b.m);
    if (na > nb) throw bad('El mes desde es posterior al mes hasta.', 'invalid_months');
    if (nb - na + 1 > MAX_AUDIT_MONTHS) throw new DomainError(`El informe puede abarcar hasta ${MAX_AUDIT_MONTHS} meses. Elegí menos meses.`, 'report_too_large', 422);
    for (let n = na; n <= nb; n++) list.push(fromNum(n));
  }
  const seen = new Map();
  for (const x of list) seen.set(monthNum(x.y, x.m), x);
  const months = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => ({ y: x.y, m: x.m, key: monthKey(x.y, x.m) }));
  if (!months.length) throw bad('Elegí al menos un mes.', 'invalid_months');
  if (months.length > MAX_AUDIT_MONTHS) throw new DomainError(`El informe puede abarcar hasta ${MAX_AUDIT_MONTHS} meses. Elegí menos meses.`, 'report_too_large', 422);
  const cur = localParts(now);
  const last = months[months.length - 1];
  if (monthNum(last.y, last.m) > monthNum(cur.y, cur.m)) throw new DomainError('No se puede imprimir un mes que todavía no empezó.', 'invalid_months', 422);
  let sections = AUDIT_SECTIONS.slice();
  if (q.sections != null && q.sections !== '' && q.sections !== 'all') {
    const want = new Set(String(q.sections).split(',').map((x) => x.trim()).filter(Boolean));
    if (!want.size || [...want].some((k) => !AUDIT_SECTIONS.includes(k))) throw bad('La selección de secciones no es válida.');
    sections = AUDIT_SECTIONS.filter((k) => want.has(k));
  }
  return {
    months,
    plantillas: parseIds(q.plantillas, 'plantillas'),
    techs: parseIds(q.techs, 'técnicos', { none: true }),
    cajas: parseIds(q.cajas, 'cajas', { none: true }),
    sections,
  };
}

// Rango de fechas (días locales) que abarca la selección: para las consultas de novedades y compras.
export function selectionDays(sel) {
  const a = sel.months[0];
  const b = sel.months[sel.months.length - 1];
  return { from: `${a.y}-${pad(a.m)}-01`, to: `${b.y}-${pad(b.m)}-${pad(daysIn(b.y, b.m))}` };
}

// Texto del período: "octubre 2026", "octubre a diciembre 2026" o la lista de meses sueltos.
export function periodLabel(months) {
  const lab = (x) => monthLabel(x.y, x.m);
  if (months.length === 1) return lab(months[0]);
  const contiguous = months.every((x, i) => !i || monthNum(x.y, x.m) === monthNum(months[i - 1].y, months[i - 1].m) + 1);
  if (contiguous) return `${lab(months[0])} a ${lab(months[months.length - 1])}`;
  return months.map(lab).join(', ');
}

// Unidades de un ítem guardado (los muy viejos solo tienen el estado).
function unitsOf(it) {
  const expected = it.expected ?? it.qty ?? 1;
  if (it.good != null) return { expected, good: it.good || 0, change: it.change || 0, missing: it.missing || 0 };
  const q = quantitiesOfState(it.state, expected || 1);
  return { expected: expected || 1, good: q.good, change: q.change, missing: q.missing };
}

// Celda de un control: símbolo o símbolos con cantidad (✓, C, F) y el estado peor para el color.
export function cellOf(u) {
  if (!u) return { state: 'sindato', text: SYMBOL.sinDato };
  const state = u.missing ? 'faltante' : u.change ? 'cambio' : 'bueno';
  let text;
  if (u.expected <= 1) text = SYMBOL[state];
  else text = [u.good ? `${SYMBOL.bueno}${u.good}` : '', u.change ? `${SYMBOL.cambio}${u.change}` : '', u.missing ? `${SYMBOL.faltante}${u.missing}` : ''].filter(Boolean).join(' ') || SYMBOL.bueno + '0';
  return { state, text, good: u.good, change: u.change, missing: u.missing, expected: u.expected };
}

// Conteo del Excel anterior derivado de las unidades: 1 por unidad en buen estado, 0,5 por unidad
// para recambio, 0 por faltante (PEDIDO §1).
export const planillaCount = (u) => (u ? u.good + 0.5 * u.change : null);

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

/**
 * d: deriveState(S, { now }); ctx: { S, now, actor: {id, name}, perms: {purchasesView, novedadesView},
 * empresa: {name, logo}, novedades (API, del rango), purchases (API, decididas en el rango),
 * purchaseLinks: [{requestId, name, status, reason, assignmentId, controlId}] }.
 */
export function buildAuditReport(d, ctx, sel) {
  const { S, now = new Date(), actor = {}, perms = {}, empresa = {} } = ctx;
  const monthSet = new Set(sel.months.map((x) => x.key));
  const keyOfIso = (iso) => {
    if (!iso) return null;
    const p = localParts(new Date(iso));
    return monthKey(p.y, p.m);
  };
  const inMonths = (iso) => monthSet.has(keyOfIso(iso));
  const inMonthsDay = (day) => !!day && monthSet.has(String(day).slice(0, 7));
  const ctlIn = (c) => monthSet.has(monthKey(c.period.y, c.period.m));
  // Períodos de control ya empezados de los meses elegidos (4 por mes).
  const periods = [];
  for (const x of sel.months) for (let w = 1; w <= 4; w++) if (pnumOf({ y: x.y, m: x.m, w }) <= d.curNum) periods.push({ y: x.y, m: x.m, w });

  // Nombres (con la marca de eliminado).
  const arch = (x) => !!(x && (x.archived || x.archivedAt));
  const mark = (name, x) => (arch(x) ? `${name} (eliminado)` : name);
  const users = S.users || {};
  const userName = (id) => (id && users[id] ? mark(users[id].name, users[id]) : id ? 'Usuario desconocido' : '');
  const plantillas = S.plantillas || {};
  const plName = (id) => (id && plantillas[id] ? mark(plantillas[id].name, plantillas[id]) : id ? id : 'Sin plantilla');
  const tools = S.tools || {};
  const rank = Object.fromEntries(d.tools.map((t, i) => [t.id, i]));
  const toolName = (id, fallback = '') => (tools[id] ? mark(tools[id].name, tools[id]) : fallback || 'Herramienta desconocida');
  const units = S.units || {};
  const unitCode = (id) => (id && units[id] ? units[id].code : null);
  const lineas = S.lineas || {};
  const espById = d.especialidadById || {};

  // ---------------------------------------------------------------- poseedores
  const voided = voidedIds(d.movs);
  const movsIn = d.movs.filter((m) => inMonths(m.at)).sort((a, b) => (a.at || '').localeCompare(b.at || '') || String(a.id).localeCompare(String(b.id)));
  const movsByHolder = {};
  for (const m of movsIn) if (m.techId || m.cajaId) (movsByHolder[holderKey(m)] ||= []).push(m);
  const effByHolder = {};
  for (const c of d.effList) (effByHolder[holderKey(c)] ||= []).push(c);
  const asgByHolder = { ...d.asgByTech };
  for (const [k, v] of Object.entries(d.asgByCaja)) asgByHolder['caja:' + k] = v;

  const firstDay = (x) => `${x.y}-${pad(x.m)}-01`;
  const lastDay = (x) => `${x.y}-${pad(x.m)}-${pad(daysIn(x.y, x.m))}`;
  const hist = S.plantillaHistory || {};
  // Plantillas de un técnico en los meses elegidos: las de sus controles y su historial.
  const techPlantillas = (t, ctls) => {
    const set = new Set(ctls.map((c) => c.plantillaId).filter(Boolean));
    for (const r of hist[t.id] || []) {
      if (sel.months.some((x) => (r.validFrom == null || r.validFrom <= lastDay(x)) && (r.validTo == null || r.validTo > firstDay(x)))) set.add(r.plantillaId);
    }
    if (!set.size && t.plantillaId) set.add(t.plantillaId);
    return [...set];
  };
  const wanted = (list, id) => list === 'all' || (Array.isArray(list) && list.includes(id));

  const holders = [];
  const consider = (kind, x) => {
    const key = kind === 'caja' ? 'caja:' + x.id : x.id;
    if (!wanted(kind === 'caja' ? sel.cajas : sel.techs, x.id)) return;
    const ctls = (effByHolder[key] || []).filter(ctlIn);
    const movs = movsByHolder[key] || [];
    const asg = asgByHolder[key] || [];
    const active = kind === 'caja' ? !arch(x) : x.active !== false && !arch(x);
    const pls = kind === 'tech' ? techPlantillas(x, ctls) : [];
    if (kind === 'tech' && sel.plantillas !== 'all' && !pls.some((p) => sel.plantillas.includes(p))) return;
    // Un poseedor activo con herramientas, o cualquiera con controles o movimientos en el período.
    if (!(ctls.length || movs.length || (active && asg.length))) return;
    holders.push({ key, kind, x, ctls, movs, asg, active, pls });
  };
  for (const t of d.techs) consider('tech', t);
  for (const k of d.cajas) consider('caja', k);
  const holderSet = new Set(holders.map((h) => h.key));

  const supersededBy = d.supersededBy || {};
  const ctlById = Object.fromEntries(d.ctls.map((c) => [c.id, c]));
  const holderOut = holders.map((h) => {
    const { x, kind } = h;
    // Columnas: un control vigente por período, en orden.
    const columns = h.ctls.map((c) => {
      const originals = d.ctls.filter((o) => o.status === 'finalizado' && supersededBy[o.id] === c.id);
      return {
        id: c.id, period: c.period, pkey: c.pkey, finishedAt: c.finishedAt || null, day: c.finishedAt ? localDateISO(new Date(c.finishedAt)) : null,
        by: c.by || null, byName: userName(c.by), correction: !!c.correction || !!c.supersedes, imported: !!c.importBatchId,
        cleaning: { status: (c.cleaning && c.cleaning.status) || null, note: (c.cleaning && c.cleaning.note) || '' },
        counts: c.counts || { bueno: 0, cambio: 0, faltante: 0 },
        corrects: originals.map((o) => ({ id: o.id, finishedAt: o.finishedAt || null, byName: userName(o.by) })),
      };
    });
    // Filas: herramienta (y unidad) en el orden personalizado; las de sus controles y las asignadas hoy.
    const rows = {};
    const rowOf = (toolId, code, fallbackName) => {
      const k = `${toolId}|${code || ''}`;
      return (rows[k] ||= { key: k, toolId, n: rank[toolId] != null ? rank[toolId] + 1 : null, name: toolName(toolId, fallbackName), unitCode: code || null, qty: 0, cells: {} });
    };
    for (const a of h.asg) rowOf(a.toolId, unitCode(a.unitId)).qty += a.qty || 1;
    const notes = [];
    for (const c of h.ctls) {
      const agg = {};
      for (const it of Object.values(c.items || {})) {
        if (!it || !it.state) continue;
        const r = rowOf(it.toolId, it.unitCode, it.toolName);
        const u = unitsOf(it);
        const g = (agg[r.key] ||= { expected: 0, good: 0, change: 0, missing: 0 });
        for (const k of ['expected', 'good', 'change', 'missing']) g[k] += u[k];
        if (it.note) notes.push({ controlId: c.id, period: c.period, day: c.finishedAt ? localDateISO(new Date(c.finishedAt)) : null, toolName: r.name, unitCode: r.unitCode, state: u.missing ? 'faltante' : u.change ? 'cambio' : 'bueno', note: it.note });
      }
      for (const [k, g] of Object.entries(agg)) rows[k].cells[c.id] = cellOf(g);
    }
    const rowList = Object.values(rows).sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || a.name.localeCompare(b.name, 'es') || (a.unitCode || '').localeCompare(b.unitCode || '', 'es', { numeric: true }));
    for (const r of rowList) for (const c of columns) if (!r.cells[c.id]) r.cells[c.id] = cellOf(null);

    // Formato planilla: un bloque ENTREGA / DEVOLUCIÓN / CONTEO por control vigente (y uno final sin
    // conteo con los movimientos posteriores al último control). Por herramienta (todas las unidades).
    const pl = {};
    const plRow = (toolId, fallback) => (pl[toolId] ||= { toolId, n: rank[toolId] != null ? rank[toolId] + 1 : null, name: toolName(toolId, fallback), cells: [] });
    for (const r of rowList) plRow(r.toolId, r.name);
    const live = h.movs.filter((m) => !voided.has(m.id) && m.type !== 'anulacion');
    const blocks = [];
    const moveSums = (from, to) => {
      const o = {};
      for (const m of live) {
        if (from && !(m.at > from)) continue;
        if (to && !(m.at <= to)) continue;
        for (const t of m.transfers || []) {
          const s = (o[t.toolId] ||= { entrega: 0, devolucion: 0 });
          if (t.to === 'asignado' && t.from !== 'asignado') s.entrega += t.qty;
          if (t.from === 'asignado' && t.to !== 'asignado') s.devolucion += t.qty;
          plRow(t.toolId, '');
        }
      }
      return o;
    };
    let prevAt = null;
    for (const c of h.ctls) {
      const at = c.finishedAt || null;
      const mv = moveSums(prevAt, at);
      const counts = {};
      for (const it of Object.values(c.items || {})) {
        if (!it || !it.state) continue;
        const u = unitsOf(it);
        const s = (counts[it.toolId] ||= { good: 0, change: 0, missing: 0, expected: 0 });
        for (const k of ['good', 'change', 'missing', 'expected']) s[k] += u[k];
        plRow(it.toolId, it.toolName);
      }
      blocks.push({ controlId: c.id, day: at ? localDateISO(new Date(at)) : null, period: c.period, correction: !!c.correction || !!c.supersedes, imported: !!c.importBatchId, mv, counts });
      if (at) prevAt = at;
    }
    const tail = moveSums(prevAt, null);
    if (Object.keys(tail).length) blocks.push({ controlId: null, day: null, period: null, correction: false, imported: false, mv: tail, counts: {} });
    const plRows = Object.values(pl).sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || a.name.localeCompare(b.name, 'es'));
    for (const r of plRows) {
      r.cells = blocks.map((b) => {
        const m = b.mv[r.toolId] || { entrega: 0, devolucion: 0 };
        const u = b.counts[r.toolId];
        // Como en el Excel: el 0,5 del recambio también se suma en DEVOLUCIÓN (así no figura como faltante).
        return { entrega: m.entrega || null, devolucion: (m.devolucion + (u ? 0.5 * u.change : 0)) || null, conteo: b.controlId ? planillaCount(u) : null };
      });
    }
    const planilla = { blocks: blocks.map(({ controlId, day, period, correction, imported }) => ({ controlId, day, period, correction, imported })), rows: plRows };

    const last = columns[columns.length - 1];
    const lc = last ? last.counts : null;
    const den = lc ? lc.bueno + lc.cambio + lc.faltante : 0;
    const linea = kind === 'caja' && x.lineaId && lineas[x.lineaId] ? mark(lineas[x.lineaId].name, lineas[x.lineaId]) : '';
    return {
      key: h.key, kind, id: x.id, name: mark(x.name, x), archived: arch(x), inactive: kind === 'tech' && x.active === false && !arch(x),
      legajo: kind === 'tech' ? x.legajo || '' : '', especialidad: kind === 'tech' && x.especialidadId && espById[x.especialidadId] ? espById[x.especialidadId].name : '',
      plantillas: h.pls.map(plName), linea, active: h.active,
      expected: h.active ? periods.length : 0, done: columns.length,
      assigned: h.asg.reduce((s, a) => s + (a.qty || 1), 0),
      last: lc ? { ...lc, pct: pct(lc.bueno, den) } : null,
      columns, rows: rowList, notes, planilla,
    };
  });

  // ---------------------------------------------------------------- faltantes y su resolución
  const links = ctx.purchaseLinks || [];
  const faltantes = [];
  for (const h of holderOut) {
    const all = effByHolder[h.key] || [];
    const open = {};
    const episodes = [];
    for (const c of all) {
      for (const [asgId, it] of Object.entries(c.items || {})) {
        if (!it || !it.state) continue;
        const u = unitsOf(it);
        if (u.missing > 0) {
          if (!open[asgId]) {
            open[asgId] = { asgId, toolId: it.toolId, toolName: toolName(it.toolId, it.toolName), unitCode: it.unitCode || null, controls: [], missing: 0, expected: u.expected, note: '' };
            episodes.push(open[asgId]);
          }
          const e = open[asgId];
          e.controls.push(c);
          e.missing = u.missing;
          e.expected = u.expected;
          if (it.note) e.note = it.note;
        } else if (open[asgId]) {
          open[asgId].recoveredBy = c;
          delete open[asgId];
        }
      }
    }
    for (const e of episodes) {
      if (!e.controls.some(ctlIn)) continue;
      const first = e.controls[0];
      const since = first.finishedAt || '';
      const events = [];
      for (const m of d.movs) {
        if (voided.has(m.id) || m.type === 'anulacion' || (m.at || '') < since) continue;
        if (m.type === 'reposicion' && m.oldAssignmentId === e.asgId) events.push({ kind: 'reposicion', label: 'Reposición', at: m.at });
        if ((m.type === 'devolucion' || m.type === 'retiro') && m.oldAssignmentId === e.asgId) events.push({ kind: m.type, label: MV[m.type], at: m.at });
      }
      if (e.recoveredBy) events.push({ kind: 'recuperada', label: 'Apareció en el control siguiente', at: e.recoveredBy.finishedAt || null });
      events.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
      const ids = new Set(e.controls.map((c) => c.id));
      const req = links.find((l) => l.reason === 'faltante' && l.assignmentId === e.asgId && ids.has(l.controlId));
      const purchase = req ? { id: req.requestId, name: req.name, status: req.status, statusLabel: PURCHASE_STATUS_LABEL[req.status] || req.status } : null;
      const ev = events[0] || null;
      const resolution = ev
        ? { kind: ev.kind, label: ev.label, at: ev.at, day: ev.at ? localDateISO(new Date(ev.at)) : null }
        : purchase ? { kind: 'compra', label: `${purchase.name} (${purchase.statusLabel})`, at: null, day: null } : { kind: 'sin_resolver', label: 'Sin resolver', at: null, day: null };
      faltantes.push({
        holderKey: h.key, holderName: h.name, toolId: e.toolId, n: rank[e.toolId] != null ? rank[e.toolId] + 1 : null, toolName: e.toolName, unitCode: e.unitCode,
        missing: e.missing, expected: e.expected, note: e.note,
        firstControlId: first.id, firstDay: first.finishedAt ? localDateISO(new Date(first.finishedAt)) : null, period: first.period, controls: e.controls.length,
        imported: e.controls.some((c) => !!c.importBatchId), resolution, purchase,
      });
    }
  }

  // ---------------------------------------------------------------- movimientos
  const movById = Object.fromEntries(d.movs.map((m) => [m.id, m]));
  const voidOf = {};
  for (const m of d.movs) if (m.voidsMovementId) voidOf[m.voidsMovementId] = m;
  const holderName = Object.fromEntries(holderOut.map((h) => [h.key, h.name]));
  const movements = [];
  for (const m of movsIn) {
    if (!(m.techId || m.cajaId) || !holderSet.has(holderKey(m))) continue;
    const target = m.type === 'anulacion' ? movById[m.voidsMovementId] : null;
    if (m.type === 'anulacion' ? !(target && HOLDER_MOVES.includes(target.type)) : !HOLDER_MOVES.includes(m.type)) continue;
    const v = voidOf[m.id];
    const code = unitCode(m.newUnitId || m.unitId) || null;
    movements.push({
      id: m.id, at: m.at, day: m.at ? localDateISO(new Date(m.at)) : null, type: m.type, typeLabel: m.type === 'anulacion' ? VOID_LABEL : MV[m.type] || m.type,
      holderKey: holderKey(m), holderName: holderName[holderKey(m)] || '', toolId: m.toolId, toolName: toolName(m.toolId), unitCode: code, oldUnitCode: unitCode(m.oldUnitId),
      qty: m.qty || 1, reason: m.reason || '', notes: m.notes || '', byName: userName(m.by), imported: !!m.importBatchId,
      voided: !!v, voidedAt: v ? v.at : null, voids: target ? { id: target.id, typeLabel: MV[target.type] || target.type, at: target.at } : null,
      returned: m.type === 'reposicion' ? m.returned !== false : null, condition: m.condition || null,
    });
  }
  const mvTotals = {};
  for (const t of HOLDER_MOVES) {
    const list = movements.filter((m) => m.type === t && !m.voided);
    mvTotals[t] = { count: list.length, units: list.reduce((s, m) => s + m.qty, 0) };
  }
  mvTotals.anuladas = movements.filter((m) => m.voided).length;

  // ---------------------------------------------------------------- compras
  const everything = sel.techs === 'all' && sel.cajas === 'all' && sel.plantillas === 'all';
  const costs = !!perms.purchasesView;
  const purchases = (ctx.purchases || [])
    .filter((p) => inMonths(p.decidedAt) && (everything || holderSet.has(p.cajaId ? 'caja:' + p.cajaId : p.techId)))
    .map((p) => {
      const r = costs ? p : stripCosts(p);
      return { ...r, statusLabel: PURCHASE_STATUS_LABEL[p.status] || p.status, decidedDay: p.decidedAt ? localDateISO(new Date(p.decidedAt)) : null, holderName: p.holderName ? (p.holderArchived ? `${p.holderName} (eliminado)` : p.holderName) : 'Stock del pañol' };
    });
  const approved = purchases.filter((p) => p.status !== 'rechazada');
  const purchaseTotals = { aprobadas: approved.length, rechazadas: purchases.length - approved.length };
  if (costs) {
    purchaseTotals.costoConocido = Math.round(approved.reduce((s, p) => s + (p.estimatedCost || 0), 0) * 100) / 100;
    purchaseTotals.sinCosto = approved.filter((p) => p.estimatedCost == null).length;
  }

  // ---------------------------------------------------------------- novedades
  let novedades = null;
  if (perms.novedadesView) {
    const techSet = new Set(holderOut.filter((h) => h.kind === 'tech').map((h) => h.id));
    novedades = (ctx.novedades || [])
      .filter((n) => inMonths(n.occurredAt) && (everything || (n.techId && techSet.has(n.techId)) || (n.plantillaId && Array.isArray(sel.plantillas) && sel.plantillas.includes(n.plantillaId))))
      .sort((a, b) => (a.occurredAt || '').localeCompare(b.occurredAt || ''))
      .map((n) => ({
        id: n.id, name: n.name, occurredAt: n.occurredAt, day: localDateISO(new Date(n.occurredAt)), authorName: n.authorName ? (n.authorArchived ? `${n.authorName} (eliminado)` : n.authorName) : '',
        comment: n.comment, techName: n.techName ? (n.techArchived ? `${n.techName} (eliminado)` : n.techName) : '',
        plantillaName: n.plantillaName ? (n.plantillaArchived ? `${n.plantillaName} (eliminado)` : n.plantillaName) : '',
        lineaName: n.lineaName ? (n.lineaArchived ? `${n.lineaName} (eliminado)` : n.lineaName) : '',
        purchaseName: n.purchase ? n.purchase.name : '', movementLabel: n.movement ? `${MV[n.movement.type] || n.movement.type}${n.movement.voided ? ' (anulada)' : ''}` : '',
        imported: !!n.importBatchId,
      }));
  }

  // ---------------------------------------------------------------- cambios de plantilla
  const plOk = (...ids) => sel.plantillas === 'all' || ids.some((id) => id && sel.plantillas.includes(id));
  const names = Object.fromEntries(Object.entries(plantillas).map(([id, p]) => [id, mark(p.name, p)]));
  const techs = S.techs || {};
  const moves = Object.values(shiftChangesFromHistory(hist, names))
    .filter((c) => inMonthsDay(c.effectiveFrom) && plOk(c.from, c.to) && (sel.techs === 'all' || (Array.isArray(sel.techs) && sel.techs.includes(c.techId))))
    .map((c) => ({ day: c.effectiveFrom, techId: c.techId, techName: techs[c.techId] ? mark(techs[c.techId].name, techs[c.techId]) : c.techId, fromName: c.from ? c.fromName : 'Sin plantilla', toName: c.toName || plName(c.to), note: c.note, byName: userName(c.by) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.techName.localeCompare(b.techName, 'es'));
  const supervisors = (S.plantillaSupervisors || [])
    .filter((x) => inMonthsDay(x.from) && plOk(x.plantillaId))
    .map((x) => ({ day: x.from, plantillaName: plName(x.plantillaId), fromName: x.fromUserId ? userName(x.fromUserId) : 'Sin supervisor', toName: x.supervisorUserId ? userName(x.supervisorUserId) : 'Sin supervisor', byName: userName(x.by) }));
  const rotations = (S.plantillaRotations || [])
    .filter((x) => inMonthsDay(x.from) && plOk(x.plantillaId))
    .map((x) => ({ day: x.from, plantillaName: plName(x.plantillaId), fromLabel: x.fromLabel || '', label: x.label, byName: userName(x.by) }));

  // ---------------------------------------------------------------- resumen
  const activeH = holderOut.filter((h) => h.active);
  const expected = activeH.reduce((s, h) => s + h.expected, 0);
  const doneOnTime = activeH.reduce((s, h) => s + Math.min(h.done, h.expected), 0);
  const lastCounts = holderOut.map((h) => h.last).filter(Boolean);
  const S3 = (k) => lastCounts.reduce((s, c) => s + c[k], 0);
  const cols = holderOut.flatMap((h) => h.columns);
  const limpio = cols.filter((c) => c.cleaning.status === 'limpio').length;
  const sucio = cols.filter((c) => c.cleaning.status === 'requiere_limpieza').length;
  const perMonth = sel.months.map((mo) => {
    const ofMonth = holderOut.map((h) => h.columns.filter((c) => c.period.y === mo.y && c.period.m === mo.m));
    const exp = activeH.length ? periods.filter((p) => p.y === mo.y && p.m === mo.m).length * activeH.length : 0;
    const lasts = ofMonth.map((cs) => cs[cs.length - 1]).filter(Boolean).map((c) => c.counts);
    const g = lasts.reduce((s, c) => s + c.bueno, 0);
    const den = lasts.reduce((s, c) => s + c.bueno + c.cambio + c.faltante, 0);
    const all = ofMonth.flat();
    const l = all.filter((c) => c.cleaning.status === 'limpio').length;
    const su = all.filter((c) => c.cleaning.status === 'requiere_limpieza').length;
    return { key: mo.key, label: monthLabel(mo.y, mo.m), done: all.length, expected: exp, pctCond: pct(g, den), faltantes: lasts.reduce((s, c) => s + c.faltante, 0), pctLimpio: pct(l, l + su) };
  });
  const summary = {
    techs: holderOut.filter((h) => h.kind === 'tech').length,
    cajas: holderOut.filter((h) => h.kind === 'caja').length,
    tools: new Set(holderOut.flatMap((h) => (asgByHolder[h.key] || []).map((a) => a.toolId))).size,
    units: holderOut.reduce((s, h) => s + h.assigned, 0),
    done: cols.length, expected, pctDone: pct(doneOnTime, expected),
    bueno: S3('bueno'), cambio: S3('cambio'), faltante: S3('faltante'), pctCond: pct(S3('bueno'), S3('bueno') + S3('cambio') + S3('faltante')),
    faltantesEpisodios: faltantes.length, sinResolver: faltantes.filter((f) => f.resolution.kind === 'sin_resolver').length,
    reposiciones: mvTotals.reposicion.count,
    limpio, sucio, sinDatoLimpieza: cols.length - limpio - sucio, pctLimpio: pct(limpio, limpio + sucio),
    corrections: cols.filter((c) => c.correction).length, imported: cols.filter((c) => c.imported).length,
    perMonth,
  };

  const filterText = [
    sel.plantillas === 'all' ? 'todas las plantillas' : `plantillas: ${sel.plantillas.map(plName).join(', ')}`,
    sel.techs === 'all' ? 'todos los técnicos' : sel.techs === 'none' ? 'sin técnicos' : `${sel.techs.length} ${sel.techs.length === 1 ? 'técnico' : 'técnicos'}`,
    sel.cajas === 'all' ? 'todas las cajas' : sel.cajas === 'none' ? 'sin cajas' : `${sel.cajas.length} ${sel.cajas.length === 1 ? 'caja' : 'cajas'}`,
  ].join(', ');
  return {
    header: {
      company: empresa.name, logo: empresa.logo || null,
      period: periodLabel(sel.months), filters: filterText,
      issuedAt: now.toISOString(), issuedDay: localDateISO(now), issuer: actor.name || '',
    },
    selection: { months: sel.months.map((x) => x.key), plantillas: sel.plantillas, techs: sel.techs, cajas: sel.cajas, sections: sel.sections },
    sections: sel.sections,
    periods: periods.length,
    costsShown: costs,
    legend: AUDIT_LEGEND,
    summary,
    holders: sel.sections.includes('poseedores') || sel.sections.includes('resumen') ? holderOut : [],
    faltantes,
    movements, movementTotals: mvTotals,
    purchases, purchaseTotals,
    novedades,
    plantillas: { moves, supervisors, rotations },
  };
}

// Instante de inicio del primer mes elegido (para las consultas por fecha).
export const selectionStart = (sel) => zonedDate(sel.months[0].y, sel.months[0].m, 1);
