// Controles semanales (portado de derive/ckDoc/ckFinish de 2.1).
// Etapa 4: conteo por cantidad. Cada ítem guarda cuántas unidades se esperaban y cuántas están
// en buen estado, requieren recambio o faltan (good + change + missing = expected). El estado
// del ítem se deriva: faltante si falta alguna, si no cambio si alguna requiere recambio, si no
// bueno. "Requiere recambio" nunca cuenta como faltante. Limpieza por control: limpio o
// requiere limpieza (con nota); los controles viejos no tienen dato (null).
import { pkeyOf, pnumOf } from './period.js';
import { holderKey } from './lineas.js';
import { ITEM_STATES } from './constants.js';
import { DomainError } from './errors.js';

export const CLEANING = ['limpio', 'requiere_limpieza'];

// Estado derivado de las cantidades de un ítem.
export const itemState = ({ good = 0, change = 0, missing = 0 } = {}) => (missing > 0 ? 'faltante' : change > 0 ? 'cambio' : 'bueno');

// Cantidades que corresponden a un estado de 2.1 (los tres botones, el .txt v2, datos viejos).
export const quantitiesOfState = (state, qty) => ({ good: state === 'bueno' ? qty : 0, change: state === 'cambio' ? qty : 0, missing: state === 'faltante' ? qty : 0 });

// Falta o requiere recambio alguna unidad. Un ítem viejo sin unidades (qty 0, solo importado)
// o sin cantidades usa su estado.
export const hasMissing = (it) => !!it && (it.missing > 0 || (!it.expected && it.state === 'faltante'));
export const hasChange = (it) => !!it && (it.change > 0 || (!it.expected && it.state === 'cambio'));

const countError = (msg) => new DomainError(msg, 'invalid_count', 422);
const isCount = (v) => Number.isInteger(v) && v >= 0;

// Cantidades de un ítem para una asignación de `expected` unidades. El ítem trae `state` (los
// tres botones o "marcar pendientes como buen estado") o `good` y `change` (las que faltan son el
// resto). Si trae `expected` y no coincide con la cantidad asignada hoy (cambió desde que se
// contó), devuelve null: el ítem queda pendiente y hay que volver a contarlo.
export function itemQuantities(it, expected) {
  if (!it) return null;
  if (it.expected != null && it.expected !== expected) return null;
  const counted = it.good != null || it.change != null || it.missing != null;
  if (!counted) return ITEM_STATES.includes(it.state) ? quantitiesOfState(it.state, expected) : null;
  if (!isCount(it.good) || !isCount(it.change)) throw countError('Indicá cuántas unidades están en buen estado y cuántas requieren recambio.');
  if (it.good + it.change > expected) throw countError(`Las unidades en buen estado y para recambio no pueden superar ${expected}.`);
  const q = { good: it.good, change: it.change, missing: expected - it.good - it.change };
  if (it.missing != null && it.missing !== q.missing) throw countError(`Las cantidades tienen que sumar ${expected}.`);
  if (it.state != null && it.state !== itemState(q)) throw countError('El estado no coincide con las cantidades.');
  return q;
}

// Unidades de una asignación activa de `qty` unidades según su último control efectivo `s`
// (stateOf): { bueno, cambio, faltante, pendiente }. Si la cantidad asignada cambió desde ese
// control, se usa el estado del ítem para todas las unidades (como antes de la etapa 4).
export function asgUnits(s, qty) {
  if (!s || !s.state) return { bueno: 0, cambio: 0, faltante: 0, pendiente: qty };
  const q = s.expected === qty && s.good != null ? s : quantitiesOfState(s.state, qty);
  return { bueno: q.good, cambio: q.change, faltante: q.missing, pendiente: 0 };
}

// Limpieza normalizada: { status: 'limpio' | 'requiere_limpieza' | null, note }. La nota solo se
// guarda cuando requiere limpieza.
export function cleanCleaning(v) {
  const status = v && CLEANING.includes(v.status) ? v.status : null;
  return { status, note: status === 'requiere_limpieza' ? String((v && v.note) || '').trim() : '' };
}

// Control efectivo por poseedor (técnico o caja) y período: el finalizado más reciente (una
// corrección gana al original). También el borrador más reciente y qué control reemplaza a
// cuál. Clave: `<técnico>|<período>` (como en 2.1) o `caja:<caja>|<período>`.
export function effectiveControls(controls) {
  const eff = {};
  const drafts = {};
  const supersededBy = {};
  for (const c of controls) {
    const k = holderKey(c) + '|' + c.pkey;
    if (c.status === 'finalizado') {
      if (!eff[k] || (eff[k].finishedAt || '') < (c.finishedAt || '')) eff[k] = c;
      if (c.supersedes) supersededBy[c.supersedes] = c.id;
    } else if (c.status === 'borrador') {
      if (!drafts[k] || (drafts[k].updatedAt || '') < (c.updatedAt || '')) drafts[k] = c;
    }
  }
  const effList = Object.values(eff).sort((a, b) => a.pnum - b.pnum || (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  return { eff, effList, drafts, supersededBy };
}

// Cantidades de un ítem guardado (los de prueba o muy viejos pueden no tenerlas).
const qtyOf = (it) => ({ expected: it.expected ?? it.qty ?? null, good: it.good ?? null, change: it.change ?? null, missing: it.missing ?? null });

// Historial de estados por asignación a partir de los controles efectivos, en orden.
// Una transición es un cambio de estado; el primer "bueno" no cuenta como transición.
export function controlHistory(effList) {
  const stateOf = {};
  const hist = {};
  const transitions = [];
  for (const c of effList) {
    for (const [aid, it] of Object.entries(c.items || {})) {
      if (!it || !it.state) continue;
      const prev = stateOf[aid];
      const q = qtyOf(it);
      (hist[aid] || (hist[aid] = [])).push({ state: it.state, ...q, controlId: c.id, pkey: c.pkey, pnum: c.pnum });
      const ps = prev ? prev.state : null;
      if (ps !== it.state && (it.state !== 'bueno' || ps)) {
        transitions.push({ techId: c.techId, ...(c.cajaId ? { cajaId: c.cajaId } : {}), asgId: aid, toolId: it.toolId, toolName: it.toolName, unitCode: it.unitCode, from: ps, to: it.state, pkey: c.pkey, pnum: c.pnum, at: c.finishedAt, controlId: c.id, note: it.note });
      }
      stateOf[aid] = { state: it.state, ...q, note: it.note || '', lineaId: it.lineaId || null, controlId: c.id, at: c.finishedAt, pkey: c.pkey };
    }
  }
  return { stateOf, hist, transitions };
}

// Para finalizar: cada asignación activa está contada, todo faltante tiene motivo y la limpieza
// está indicada (con nota si requiere limpieza). `items` son los del documento (con cantidades).
// cleaning: null (bien), 'pending' (sin indicar) o 'note' (requiere limpieza sin nota).
// Con cleaningRequired: false (corrección de un control sin dato de limpieza) puede quedar sin
// indicar; si se indica "requiere limpieza", la nota sigue siendo obligatoria.
export function validateFinalize(activeAssignments, items, cleaning, { cleaningRequired = true } = {}) {
  const pending = [];
  const missingNote = [];
  for (const a of activeAssignments) {
    const it = items[a.id];
    if (!it || !it.state) pending.push(a.id);
    else if (hasMissing(it) && !String(it.note || '').trim()) missingNote.push(a.id);
  }
  const cl = cleanCleaning(cleaning);
  const cleaningIssue = !cl.status ? (cleaningRequired ? 'pending' : null) : cl.status === 'requiere_limpieza' && !cl.note ? 'note' : null;
  return { ok: !pending.length && !missingNote.length && !cleaningIssue, pending, missingNote, cleaning: cleaningIssue };
}

// Limpieza obligatoria para finalizar: siempre en un control original; en una corrección, solo si
// el control corregido tenía dato de limpieza (uno viejo o importado sin dato puede seguir sin dato).
export const cleaningRequiredFor = (corrected) => !corrected || !!(corrected.cleaning && corrected.cleaning.status);

// Documento del control: copia nombre, categoría y código al momento del control, y cuenta
// unidades (en buen estado, para recambio y faltantes). Solo entran las asignaciones activas
// cuyo ítem está contado. `plantillaId` es la plantilla del técnico al hacerse el control (foto
// para los informes); `shiftId` la repite por compatibilidad con 2.1.
// Poseedor: `tech` o `caja` ({ id, name }); una caja no tiene plantilla.
// La línea (opcional) solo se guarda en ítems con faltantes o recambios.
export function buildControlDoc({ tech = null, caja = null, period, assignments, items, tools, units, categories, status, correctionOf = null, cleaning = null }) {
  const holder = tech || caja;
  const out = {};
  const counts = { bueno: 0, cambio: 0, faltante: 0 };
  for (const a of assignments) {
    const it = items[a.id];
    const expected = a.qty || 1;
    const q = itemQuantities(it, expected);
    if (!q) continue;
    const u = a.unitId && units[a.unitId];
    const tool = tools[a.toolId] || {};
    const cat = tool.categoryId && categories[tool.categoryId];
    out[a.id] = {
      state: itemState(q),
      note: String(it.note || '').trim(),
      toolId: a.toolId,
      toolName: tool.name || '',
      category: cat ? cat.name : '',
      unitId: a.unitId || null,
      unitCode: u ? u.code : null,
      qty: expected,
      expected,
      good: q.good,
      change: q.change,
      missing: q.missing,
      lineaId: q.missing + q.change > 0 ? it.lineaId || null : null,
    };
    counts.bueno += q.good;
    counts.cambio += q.change;
    counts.faltante += q.missing;
  }
  return {
    techId: tech ? tech.id : null,
    cajaId: caja ? caja.id : null,
    techName: holder.name || '',
    shiftId: tech ? tech.plantillaId ?? tech.shiftId ?? null : null,
    plantillaId: tech ? tech.plantillaId ?? tech.shiftId ?? null : null,
    period: { y: period.y, m: period.m, w: period.w },
    pkey: pkeyOf(period),
    pnum: pnumOf(period),
    status,
    items: out,
    counts,
    cleaning: cleanCleaning(cleaning),
    correction: !!correctionOf,
    supersedes: correctionOf || null,
  };
}
