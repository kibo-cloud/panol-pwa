// Anular un movimiento (etapa 5): el contramovimiento invierte las transferencias del original
// (mismas herramientas, unidades y poseedor) y deshace sus efectos en asignaciones y unidades.
// El original nunca se borra ni se modifica. Antes de planear se revisa que la reversión sea
// posible con el stock y las asignaciones de hoy; si no, el error explica el motivo exacto.
import { DomainError } from './errors.js';
import { MV, POOL, VOID_TYPE, VOID_LABEL } from './constants.js';
import { localDateISO } from './period.js';

const fail = (msg) => {
  throw new DomainError(msg, 'void_not_possible', 422);
};
const ENTREGA = ['entrega_inicial', 'adicional'];
const SALIDA = ['devolucion', 'retiro'];
// Lugares donde una unidad queda en manos de un poseedor.
const HELD = ['asignado', 'pendiente'];
const fdate = (iso) => {
  const [y, m, d] = localDateISO(new Date(iso)).split('-');
  return `${d}/${m}/${y}`;
};
const label = (type) => (type === VOID_TYPE ? VOID_LABEL : MV[type] || type);
const article = (type) => (['devolucion', 'reposicion', 'entrega_inicial', 'adicional', 'baja', 'recepcion', 'reparado'].includes(type) ? 'una' : 'un');

/**
 * input: {
 *   mv: movimiento original con `transfers`,
 *   voidedBy: id de la anulación que ya tiene (o null),
 *   dependents: movimientos posteriores, no anulados, que nombran sus asignaciones o unidades,
 *   assignments: { id: { active, qty, techId, cajaId, endMovementId } } (las que nombra),
 *   units: { id: { code, status, techId, cajaId } } (las que nombra),
 *   pools: { toolId: { pool: n } } (stock de hoy),
 *   holder: { active, name } del técnico o la caja (null si el movimiento no tiene poseedor),
 *   tool: { name, active },
 * }
 * opts: { at, newId, reason }
 */
export function planVoid(input, { at, newId, reason }) {
  const { mv } = input;
  if (mv.type === VOID_TYPE) fail('Una anulación no se anula.');
  if (input.voidedBy) fail('Este movimiento ya está anulado.');
  if (mv.type === 'recepcion') fail('Una devolución pendiente recibida no se anula. Registrá el movimiento que corresponda.');
  const dep = (input.dependents || [])[0];
  if (dep) fail(`No se puede anular: después se registró ${article(dep.type)} ${label(dep.type)} (${fdate(dep.at)}) que depende de este movimiento. Anulá primero ese movimiento.`);

  const asgs = input.assignments || {};
  const units = input.units || {};
  const holder = input.holder;
  const vid = newId('m');
  const assignmentUpdates = [];
  const needsHolder = SALIDA.includes(mv.type) || mv.type === 'reposicion';
  if (needsHolder) {
    if (!holder || !holder.active) fail(`No se puede anular: ${holder ? holder.name : 'el poseedor'} ya no está activo. Restauralo o reactivalo antes.`);
    if (input.tool && input.tool.active === false) fail('No se puede anular: la herramienta está eliminada o desactivada.');
  }
  const closeNew = (id) => {
    const a = asgs[id];
    if (!a || !a.active) fail('No se puede anular: la asignación ya no está activa (se devolvió, se retiró o se repuso después).');
    if ((a.qty || 1) !== (mv.qty || 1)) fail('No se puede anular: la cantidad asignada cambió después.');
    assignmentUpdates.push({ id, set: { active: false, until: at, endReason: 'anulacion', endMovementId: vid } });
  };

  if (ENTREGA.includes(mv.type)) closeNew(mv.newAssignmentId);
  else if (SALIDA.includes(mv.type)) {
    const a = asgs[mv.oldAssignmentId];
    if (!a) fail('No se puede anular: no se encontró la asignación.');
    if (a.endMovementId === mv.id && !a.active) assignmentUpdates.push({ id: mv.oldAssignmentId, set: { active: true, until: null, endReason: null, endMovementId: null } });
    else if (a.active) assignmentUpdates.push({ id: mv.oldAssignmentId, set: { qty: (a.qty || 1) + (mv.qty || 1) } });
    else fail('No se puede anular: la asignación cambió después de este movimiento.');
  } else if (mv.type === 'reposicion') {
    closeNew(mv.newAssignmentId);
    const a = asgs[mv.oldAssignmentId];
    if (!a || a.active || a.endMovementId !== mv.id) fail('No se puede anular: la asignación anterior cambió después de la reposición.');
    assignmentUpdates.push({ id: mv.oldAssignmentId, set: { active: true, until: null, endReason: null, replacedBy: null, endMovementId: null } });
  }

  // Transferencias invertidas, de la última a la primera (se deshace en orden inverso).
  const transfers = [...(mv.transfers || [])].reverse().map((t) => ({ toolId: t.toolId, qty: t.qty, from: t.to, to: t.from, unitId: t.unitId ?? null }));
  const need = {};
  for (const t of transfers) {
    if (t.from === 'externo') continue;
    const k = `${t.toolId}|${t.from}`;
    need[k] = (need[k] || 0) + t.qty;
  }
  for (const [k, q] of Object.entries(need)) {
    const [toolId, pool] = k.split('|');
    const has = ((input.pools || {})[toolId] || {})[pool] || 0;
    if (has < q) fail(`No se puede anular: se necesitan ${q} en «${POOL[pool]}» y hay ${has}.`);
  }
  const unitUpdates = [];
  const holderOf = { techId: mv.techId ?? null, cajaId: mv.cajaId ?? null };
  for (const t of transfers) {
    if (!t.unitId) continue;
    const u = units[t.unitId];
    if (!u) fail('No se puede anular: no se encontró la unidad.');
    const sameHolder = (u.techId ?? null) === holderOf.techId && (u.cajaId ?? null) === holderOf.cajaId;
    if (u.status !== t.from || (HELD.includes(t.from) && !sameHolder)) fail(`No se puede anular: la unidad ${u.code} ya no está en «${POOL[t.from]}».`);
    unitUpdates.push({ id: t.unitId, set: { status: t.to, ...(HELD.includes(t.to) ? holderOf : { techId: null, cajaId: null }) } });
  }

  const codes = (mv.transfers || []).map((t) => t.unitId && units[t.unitId] && units[t.unitId].code).filter(Boolean);
  const qty = mv.qty || 1;
  const toolName = (input.tool && input.tool.name) || 'Herramienta';
  const movement = {
    id: vid, type: VOID_TYPE, voidsMovementId: mv.id, techId: mv.techId ?? null, ...(mv.cajaId ? { cajaId: mv.cajaId } : {}), toolId: mv.toolId ?? null,
    qty: mv.qty ?? null, unitId: mv.unitId ?? null, reason, notes: '', at,
  };
  return {
    movement, transfers, assignmentUpdates, unitUpdates, newAssignments: [], newUnits: [],
    audit: { action: 'movement_void', detail: `Anulación de ${label(mv.type)}: ${toolName}${codes.length ? ' ' + codes.join(', ') : ''}${qty > 1 ? ' ×' + qty : ''}${holder ? ` (${holder.name})` : ''}. Motivo: ${reason}` },
  };
}

// Para la interfaz: si se puede anular y, si no, el motivo exacto (sin escribir nada).
export function voidCheck(input) {
  try {
    planVoid(input, { at: new Date().toISOString(), newId: (p) => `${p}-check`, reason: '' });
    return { ok: true, reason: null };
  } catch (err) {
    if (err && err.name === 'DomainError') return { ok: false, reason: err.message };
    throw err;
  }
}
