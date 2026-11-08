// Plantillas en el frontend (puro, se prueba con node --test): plantilla efectiva por fecha
// según el historial de rangos [desde, hasta), coberturas temporales, agrupación por
// plantilla, selección de técnicos y validación de los formularios de mover, asignar y
// catálogos. Las reglas definitivas las aplica el servidor; acá se avisa antes de enviar.
import { pad, daysIn } from './period.js';

const trim = (v) => String(v ?? '').trim();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const validDay = (d) => DAY_RE.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T12:00:00Z')) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d;

// Rango [desde, hasta): desde nulo = desde siempre, hasta nulo = abierto. desde = hasta: anulado.
export const covers = (r, day) => (r.validFrom == null || r.validFrom <= day) && (r.validTo == null || day < r.validTo);
export const isVoid = (r) => r.validFrom != null && r.validTo != null && r.validTo <= r.validFrom;
export const effectiveRange = (ranges, day) => (ranges || []).find((r) => covers(r, day)) || null;
export const sortRanges = (ranges) => (ranges || []).slice().sort((a, b) => (a.validFrom ?? '').localeCompare(b.validFrom ?? '') || (a.validTo ?? '9999').localeCompare(b.validTo ?? '9999'));

// Cobertura temporal vigente o programada en `day`: { plantillaId, from, until, returnTo }.
export function coverageOf(ranges, day) {
  const sorted = sortRanges(ranges);
  const open = sorted.find((r) => r.validTo == null);
  if (!open || open.validFrom == null) return null;
  const c = sorted.find((r) => r.temporary && !isVoid(r) && r.validTo === open.validFrom && day < r.validTo);
  return c ? { plantillaId: c.plantillaId, from: c.validFrom, until: c.validTo, returnTo: open.plantillaId, started: c.validFrom <= day } : null;
}

// Último día (fecha local) de la semana de un período (como el servidor).
export function periodEndDay(p) {
  const d = p.w < 4 ? p.w * 7 : daysIn(p.y, p.m);
  return `${p.y}-${pad(p.m)}-${pad(d)}`;
}

// Plantilla con la que un técnico entra en un informe de un período (como el servidor): la
// foto del último control del período; si no hay, la del historial al final del período; si
// no, la actual.
export function reportPlantillaOf(tech, { lastControl, ranges, day }) {
  if (lastControl && (lastControl.plantillaId || lastControl.shiftId)) return lastControl.plantillaId || lastControl.shiftId;
  const r = effectiveRange(ranges, day);
  if (r) return r.plantillaId;
  return tech.plantillaId ?? tech.shiftId ?? null;
}

// Agrupa elementos por plantilla en el orden de `plantillas` (las de `firstIds` primero). Los
// que no tienen plantilla (o es desconocida) quedan al final en el grupo `null`.
export function groupByPlantilla(items, plantillaOf, plantillas, firstIds = []) {
  const first = new Set(firstIds);
  const order = [...plantillas.filter((p) => first.has(p.id)), ...plantillas.filter((p) => !first.has(p.id))];
  const by = new Map(order.map((p) => [p.id, []]));
  const rest = [];
  for (const it of items) { const k = plantillaOf(it); if (by.has(k)) by.get(k).push(it); else rest.push(it); }
  const out = order.map((p) => ({ plantilla: p, items: by.get(p.id), mine: first.has(p.id) }));
  if (rest.length) out.push({ plantilla: null, items: rest, mine: false });
  return out;
}

// Ordena con las plantillas propias primero (sin cambiar el orden dentro de cada parte).
export const mineFirst = (plantillas, myIds = []) => groupByPlantilla([], () => null, plantillas, myIds).map((g) => g.plantilla);

// Selección de técnicos (lista de ids, sin repetidos, en el orden en que se eligieron).
export const toggleId = (sel, id, on = !sel.includes(id)) => (on ? (sel.includes(id) ? sel : [...sel, id]) : sel.filter((x) => x !== id));
export const pruneSelection = (sel, validIds) => { const ok = new Set(validIds); return sel.filter((x) => ok.has(x)); };
export const allSelected = (sel, ids) => ids.length > 0 && ids.every((x) => sel.includes(x));

// Formulario de mover (uno o varios): { plantillaId, from, reason, coverage, until }.
// Devuelve { ok: true, body } o { ok: false, error } con el mensaje para el usuario.
export function validateMove(st, { currentId = null, coverage = null } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!st.plantillaId) return fail('Elegí la plantilla destino.');
  if (!validDay(st.from)) return fail('Ingresá una fecha desde válida.');
  const reason = trim(st.reason);
  if (!reason) return fail('Ingresá el motivo.');
  if (reason.length > 2000) return fail('El motivo admite hasta 2000 caracteres.');
  // Durante una cobertura, volver antes a la base o quedarse en la de la cobertura es válido.
  if (st.plantillaId === currentId && !coverage) return fail('Ya está en esa plantilla.');
  const body = { from: st.from, reason };
  if (st.coverage) {
    if (!validDay(st.until)) return fail('Ingresá la fecha hasta de la cobertura.');
    if (st.until <= st.from) return fail('La fecha hasta tiene que ser posterior a la fecha desde.');
    if (coverage && st.from < coverage.until) return fail(`Ya tiene una cobertura temporal hasta el ${coverage.until}. Para otra cobertura, elegí una fecha desde el ${coverage.until} en adelante, o hacé un cambio definitivo.`);
    body.until = st.until;
  }
  return { ok: true, body };
}

// Historial de plantillas de un técnico para mostrar (del más nuevo al más viejo), sin los
// rangos anulados. names: { id: nombre }.
export function historyRows(ranges, names = {}) {
  const live = sortRanges(ranges).filter((r) => !isVoid(r));
  const nm = (id) => (id ? names[id] || 'Plantilla eliminada' : 'Sin plantilla');
  return live.map((r, i) => {
    const prev = i > 0 && live[i - 1].validTo === r.validFrom ? live[i - 1] : null;
    const back = r.temporary ? live.find((x) => x.validFrom === r.validTo && !x.temporary) : null;
    return { id: r.id, from: r.validFrom, to: r.validTo, plantillaId: r.plantillaId, name: nm(r.plantillaId), fromName: prev ? nm(prev.plantillaId) : null, temporary: !!r.temporary, returnTo: back ? nm(back.plantillaId) : null, reason: r.reason || '', at: r.createdAt || null, by: r.by || null };
  }).reverse();
}

// Lista de turnos configurable: 1 a 20, sin repetidos, cada uno de 2 a 120 caracteres.
export function validateShiftLabels(list) {
  const out = [];
  for (const x of list || []) { const l = trim(x); if (!l) continue; if (l.length < 2) return { ok: false, error: 'Cada turno necesita un nombre de al menos 2 letras.' }; if (l.length > 120) return { ok: false, error: 'Cada turno admite hasta 120 caracteres.' }; if (out.some((y) => y.toLowerCase() === l.toLowerCase())) return { ok: false, error: `El turno ${l} está repetido.` }; out.push(l); }
  if (!out.length) return { ok: false, error: 'Ingresá al menos un turno.' };
  if (out.length > 20) return { ok: false, error: 'Se pueden cargar hasta 20 turnos.' };
  return { ok: true, labels: out };
}

// Poseedor de una asignación: `<techId>` o `caja:<cajaId>` (la misma clave que los controles).
export const holderKey = (o) => (o && o.cajaId ? 'caja:' + o.cajaId : o ? o.techId : null);
export const holderBody = (hk) => (String(hk || '').startsWith('caja:') ? { cajaId: hk.slice(5) } : { techId: hk });

// Alta de una asignación en un solo formulario: { holder, toolId, qty | unitIds, reason }.
export function validateAssignment(st, { tool, availableUnitIds = [], available = 0 }) {
  const fail = (error) => ({ ok: false, error });
  if (!st.holder) return fail('Elegí el técnico o la caja que recibe.');
  if (!tool) return fail('Elegí una herramienta.');
  const body = { holder: holderBody(st.holder), toolId: tool.id };
  const reason = trim(st.reason); if (reason.length > 2000) return fail('El motivo admite hasta 2000 caracteres.');
  if (reason) body.reason = reason;
  if (tool.serialized) {
    const ok = new Set(availableUnitIds);
    const ids = (st.unitIds || []).filter((x) => ok.has(x));
    if (!ids.length) return fail('Elegí al menos una unidad disponible.');
    body.unitIds = ids;
  } else {
    const q = Number(st.qty);
    if (!Number.isInteger(q) || q < 1) return fail('Indicá una cantidad válida.');
    if (q > available) return fail(`Solo hay ${available} disponibles.`);
    body.qty = q;
  }
  return { ok: true, body };
}

// Línea o sector: nombre 2-120 y tipo; caja: nombre, línea activa y referente opcional.
export function validateLinea(st, others = []) {
  const name = trim(st.name);
  if (name.length < 2) return { ok: false, error: 'Ingresá un nombre.' };
  if (name.length > 120) return { ok: false, error: 'El nombre admite hasta 120 caracteres.' };
  if (!['linea', 'sector'].includes(st.kind)) return { ok: false, error: 'Elegí si es una línea o un sector.' };
  if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: 'Ya existe una línea o un sector con ese nombre.' };
  return { ok: true, body: { name, kind: st.kind } };
}
export function validateCaja(st, others = []) {
  const name = trim(st.name);
  if (name.length < 2) return { ok: false, error: 'Ingresá un nombre.' };
  if (name.length > 120) return { ok: false, error: 'El nombre admite hasta 120 caracteres.' };
  if (!st.lineaId) return { ok: false, error: 'Elegí la línea o el sector.' };
  if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: 'Ya existe una caja con ese nombre.' };
  return { ok: true, body: { name, lineaId: st.lineaId, referenteTechId: st.referenteTechId || null } };
}

// Días enteros entre dos fechas ISO (fecha local); null si falta alguna.
export function daysBetween(fromIso, toDay) {
  if (!fromIso || !toDay) return null;
  const d = new Date(fromIso); const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.parse(toDay + 'T00:00:00Z');
  return Math.max(0, Math.round((b - a) / 864e5));
}
