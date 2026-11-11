// Solicitudes de compra (etapa 7): reglas puras. Estados, decisión, costo estimado, alta manual,
// pérdidas de un control y el plan de la creación automática.
// - Estados: pendiente -> aprobada | rechazada; aprobada -> comprada (paso opcional) -> recibida
//   (también aprobada -> recibida). Rechazada y recibida quedan cerradas en el historial.
// - Una sola solicitud abierta (pendiente, aprobada o comprada) por asignación (o unidad) y motivo:
//   los controles siguientes se vinculan a la existente. Nunca se deduplica por la clave de la
//   alerta (cambia con cada control o corrección).
import { DomainError, tooLong } from './errors.js';
import { LIM } from './constants.js';
import { hasMissing, hasChange } from './controls.js';

export const PURCHASE_STATUSES = ['pendiente', 'aprobada', 'rechazada', 'comprada', 'recibida'];
export const OPEN_STATUSES = ['pendiente', 'aprobada', 'comprada'];
export const PURCHASE_STATUS_LABEL = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', comprada: 'Comprada', recibida: 'Recibida' };
// Motivo: cambio (la herramienta está dañada) o faltante (extraviada).
export const PURCHASE_REASONS = { cambio: 'Dañada (cambio)', faltante: 'Extraviada (faltante)' };
export const PURCHASE_REASON_KEYS = Object.keys(PURCHASE_REASONS);
// Origen: un control finalizado (automática), la ficha de la herramienta o una alerta (manuales).
export const PURCHASE_ORIGINS = ['control', 'tool', 'alert'];
export const PURCHASE_ACTIONS = ['approve', 'reject', 'purchase', 'receive'];

const rule = (msg, code, status = 422) => new DomainError(msg, code, status);

const TRANSITIONS = {
  approve: { from: ['pendiente'], to: 'aprobada', msg: 'Solo se aprueba una solicitud pendiente.' },
  reject: { from: ['pendiente'], to: 'rechazada', msg: 'Solo se rechaza una solicitud pendiente.' },
  purchase: { from: ['aprobada'], to: 'comprada', msg: 'Solo se marca como comprada una solicitud aprobada.' },
  receive: { from: ['aprobada', 'comprada'], to: 'recibida', msg: 'Solo se recibe una solicitud aprobada o comprada.' },
};

// Estado siguiente de una transición, o el error con el motivo (409: el estado cambió).
export function checkTransition(req, action) {
  const t = TRANSITIONS[action];
  if (!t) throw rule('Acción desconocida.', 'invalid_action', 400);
  if (req.archived) throw rule('La solicitud está eliminada: restaurala antes de seguir.', 'archived', 409);
  if (!t.from.includes(req.status)) throw rule(`${t.msg} Esta está ${PURCHASE_STATUS_LABEL[req.status].toLowerCase()}.`, 'invalid_transition', 409);
  return t.to;
}

const text = (v, max, what) => {
  const s = String(v ?? '').trim();
  tooLong(s, max, what);
  return s;
};

// Comentario de la decisión: obligatorio al rechazar.
export function cleanDecision(action, input = {}) {
  const comment = text(input.comment, LIM.text, 'El comentario');
  if (action === 'reject' && !comment) throw rule('Escribí el motivo del rechazo.', 'comment_required');
  return { comment };
}

const COST_RE = /^\d{1,10}(\.\d{1,2})?$/;
// Costo estimado en pesos (numeric(12,2)): vacío = sin dato. Devuelve el texto con dos decimales.
export function cleanCost(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v).trim();
  if (!COST_RE.test(s)) throw rule('El costo estimado es un importe en pesos, con hasta dos decimales.', 'invalid_cost');
  const [int, dec = ''] = s.split('.');
  return `${String(Number(int))}.${dec.padEnd(2, '0')}`;
}

export const cleanSupplier = (v) => text(v, LIM.name, 'El proveedor');
export const cleanObservation = (v) => text(v, LIM.text, 'La observación');

function cleanQty(v) {
  if (!Number.isInteger(v) || v < 1 || v > 100000) throw rule('Indicá una cantidad válida (1 o más).', 'invalid_qty');
  return v;
}

// Alta manual desde la ficha de la herramienta o desde una alerta (con la asignación).
export function cleanManualPurchase(input = {}) {
  if (!PURCHASE_REASON_KEYS.includes(input.reason)) throw rule('Elegí el motivo: dañada o extraviada.', 'invalid_reason');
  const origin = input.origin || 'tool';
  if (origin !== 'tool' && origin !== 'alert') throw rule('Origen de la solicitud inválido.', 'invalid_origin');
  return {
    toolId: input.toolId, assignmentId: input.assignmentId || null, reason: input.reason, qty: cleanQty(input.qty),
    estimatedCost: cleanCost(input.estimatedCost), supplier: cleanSupplier(input.supplier), observation: cleanObservation(input.observation),
    origin, alertKey: origin === 'alert' ? input.alertKey || null : null,
  };
}

// Cantidad perdida de un ítem por un motivo. Un ítem viejo sin cantidades usa su estado para todas
// las unidades asignadas.
function lossQty(it, reason, qty) {
  const counted = it.expected != null && (it.good != null || it.change != null || it.missing != null);
  if (reason === 'faltante') return hasMissing(it) ? (counted ? it.missing : it.expected || qty) : 0;
  return hasChange(it) ? (counted ? it.change : it.expected || qty) : 0;
}

/**
 * Pérdidas de un control finalizado: por cada asignación, las unidades que faltan (faltante) y las
 * que requieren recambio (cambio). items: los del documento; assignments: [{ id, toolId, unitId, qty }].
 */
export function lossesOf(items, assignments) {
  const out = [];
  for (const a of assignments) {
    const it = items[a.id];
    if (!it || !it.state) continue;
    for (const reason of ['faltante', 'cambio']) {
      const qty = lossQty(it, reason, a.qty || 1);
      if (qty > 0) out.push({ assignmentId: a.id, unitId: a.unitId || null, toolId: a.toolId, reason, qty, note: it.note || '' });
    }
  }
  return out;
}

// Asignación y motivo de cada ítem contado (con o sin pérdida).
export const countedPairs = (items, assignments) => assignments.filter((a) => items[a.id] && items[a.id].state)
  .flatMap((a) => ['faltante', 'cambio'].map((reason) => ({ assignmentId: a.id, unitId: a.unitId || null, reason })));

// Una solicitud corresponde a una pérdida: mismo motivo y la misma asignación o unidad.
export const sameKey = (r, x) => r.reason === x.reason && (r.assignmentId === x.assignmentId || (!!x.unitId && r.unitId === x.unitId));

/**
 * Plan de la creación automática al finalizar (o corregir) un control.
 * losses: lossesOf(...); counted: countedPairs(...); pnum: período del control.
 * candidates: solicitudes no eliminadas de esas asignaciones o unidades, abiertas o rechazadas sin
 *   resolver: { id, status, reason, assignmentId, unitId, qty, origin, lossResolvedAt,
 *   linkedToSuperseded (vinculada al control que se corrige), onlyThisPeriod (todos sus controles
 *   son de este poseedor y período), maxLinkedPnum }.
 * Devuelve { create: [pérdida], link: [{ id, qty }] (qty: nueva cantidad o null), archive: [id],
 * resolve: [id] (rechazadas cuya pérdida se resolvió), blocked: [{ assignmentId, reason, requestId }] }.
 */
export function planAutoPurchases({ losses, counted, candidates, pnum }) {
  const out = { create: [], link: [], archive: [], resolve: [], blocked: [] };
  const open = candidates.filter((r) => OPEN_STATUSES.includes(r.status));
  const rejected = candidates.filter((r) => r.status === 'rechazada' && !r.lossResolvedAt);
  for (const l of losses) {
    const r = open.find((x) => sameKey(x, l));
    if (r) {
      const follow = r.status === 'pendiente' && pnum >= (r.maxLinkedPnum || 0) && r.qty !== l.qty;
      if (!out.link.some((x) => x.id === r.id)) out.link.push({ id: r.id, qty: follow ? l.qty : null });
      continue;
    }
    const rej = rejected.find((x) => sameKey(x, l));
    if (rej) out.blocked.push({ assignmentId: l.assignmentId, reason: l.reason, requestId: rej.id });
    else out.create.push(l);
  }
  const lost = (p) => losses.some((l) => l.assignmentId === p.assignmentId && l.reason === p.reason);
  for (const p of counted.filter((x) => !lost(x))) {
    for (const r of rejected) if (sameKey(r, p) && !out.resolve.includes(r.id)) out.resolve.push(r.id);
    for (const r of open) {
      if (r.status === 'pendiente' && r.origin === 'control' && r.linkedToSuperseded && r.onlyThisPeriod && sameKey(r, p) && !out.archive.includes(r.id)) out.archive.push(r.id);
    }
  }
  return out;
}

// Etiqueta corta (la que se ve en las listas y en Registros eliminados).
export const purchaseLabel = (seq) => `Compra ${seq}`;

// ---------------------------------------------------------------- filtros de la lista
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([A-Za-z0-9_.~:@+-]{1,200})$/;

export function parseMonth(v, code = 'invalid_month') {
  if (v == null || v === '') return null;
  if (!MONTH_RE.test(String(v))) throw rule('El mes no es válido (AAAA-MM).', code, 400);
  return String(v);
}

/**
 * Filtros de GET /api/compras: status (un estado u `open`), month (AAAA-MM del alta), plantilla,
 * técnico, caja, herramienta, motivo, texto (q), archived (exclude | include | only), scope
 * (`receive`: las que se pueden recibir), limit (1..200) y before (cursor `<createdAt ISO>|<id>`).
 */
export function parsePurchaseFilters(q = {}) {
  const status = q.status == null || q.status === '' ? null : String(q.status);
  if (status && status !== 'open' && !PURCHASE_STATUSES.includes(status)) throw rule('Estado de compra inválido.', 'invalid_status', 400);
  const reason = q.reason ? String(q.reason) : null;
  if (reason && !PURCHASE_REASON_KEYS.includes(reason)) throw rule('Motivo inválido.', 'invalid_reason', 400);
  let before = null;
  if (q.before) {
    const m = CURSOR_RE.exec(String(q.before));
    if (!m) throw rule('Cursor de compras inválido.', 'invalid_cursor', 400);
    before = { at: m[1], id: m[2] };
  }
  const n = Number(q.limit || 50);
  return {
    status, month: parseMonth(q.month),
    plantillaId: q.plantillaId || null, techId: q.techId || null, cajaId: q.cajaId || null, toolId: q.toolId || null, reason,
    q: String(q.q || '').trim(),
    archived: ['include', 'only'].includes(q.archived) ? q.archived : 'exclude',
    scope: q.scope === 'receive' ? 'receive' : null,
    limit: Math.max(1, Math.min(200, Number.isFinite(n) ? Math.floor(n) : 50)),
    before,
  };
}
