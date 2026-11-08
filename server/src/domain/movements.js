// Planificación de movimientos de inventario (portado de runMovement/runInv/createUnits de 2.1).
// No escribe nada: valida las mismas precondiciones que 2.1 y devuelve lo que hay que guardar
// (movimiento, transferencias, asignaciones y unidades). Los mensajes de error son los de 2.1.
import { DomainError, tooLong } from './errors.js';
import { LIM, MV, POOL } from './constants.js';

const STOCK_TYPES = ['entrega_inicial', 'adicional', 'reposicion', 'devolucion', 'retiro', 'recepcion'];
const INV_TYPES = ['ingreso', 'reparado', 'baja', 'recupero'];
const REPOSICION_DEST = ['reparacion', 'baja'];
const RETURN_COND = ['disponible', 'reparacion', 'baja'];
const BAJA_FROM = ['disponible', 'reparacion'];

export function requiredPermission(type) {
  if (STOCK_TYPES.includes(type)) return 'movements_do';
  if (INV_TYPES.includes(type)) return 'inventory_edit';
  throw new DomainError('Tipo de movimiento desconocido.', 'invalid_type', 400);
}

const fail = (msg) => {
  throw new DomainError(msg);
};
const unitCode = (ctx, id) => (id && ctx.units[id] ? ctx.units[id].code : '');

// ctx: { techs, tools, units, assignments, pools, stateOf, pendingReturns }
// opts: { at: ISO, newId: (prefijo) => id }
export function planMovement(ctx, m, { at, newId }) {
  requiredPermission(m.type);
  const reason = String(m.reason ?? '').trim();
  const notes = String(m.notes ?? '').trim();
  tooLong(reason, LIM.text, 'El motivo');
  tooLong(notes, LIM.text, 'Las observaciones');
  const plan = { movement: null, transfers: [], newAssignments: [], assignmentUpdates: [], newUnits: [], unitUpdates: [], audit: null };
  const mid = newId('m');
  if (INV_TYPES.includes(m.type)) return planInventory(ctx, m, plan, { at, mid, notes, newId });
  if (m.type === 'recepcion') return planReception(ctx, m, plan, { at, mid, notes });

  const tech = ctx.techs[m.techId];
  if (!tech || tech.active === false) fail('Elegí un técnico activo.');
  const activeOf = (techId) => Object.entries(ctx.assignments).filter(([, a]) => a.active && a.techId === techId);

  if (m.type === 'entrega_inicial' || m.type === 'adicional') {
    const tool = ctx.tools[m.toolId];
    if (!tool || tool.active === false) fail('Elegí una herramienta activa.');
    const has = activeOf(m.techId).some(([, a]) => a.toolId === m.toolId);
    if (m.type === 'entrega_inicial' && has) fail('El técnico ya tiene esta herramienta. Usá Entrega adicional o Reposición.');
    if (m.type === 'adicional' && !has) fail('El técnico todavía no tiene esta herramienta. Usá Entrega inicial.');
    let qty = 1;
    let unitId = null;
    if (tool.serialized) {
      const u = ctx.units[m.unitId];
      if (!u || u.toolId !== m.toolId || u.status !== 'disponible') fail('Elegí una unidad disponible.');
      unitId = m.unitId;
    } else {
      qty = parseInt(m.qty, 10);
      const disp = (ctx.pools[m.toolId] || {}).disponible || 0;
      if (!(qty >= 1)) fail('Indicá una cantidad válida.');
      if (qty > disp) fail(`Solo hay ${disp} disponibles. Registrá un ingreso en Inventario.`);
    }
    const aid = newId('a');
    plan.movement = { id: mid, type: m.type, techId: m.techId, toolId: m.toolId, qty, unitId, newAssignmentId: aid, reason, notes, at };
    plan.transfers.push({ toolId: m.toolId, qty, from: 'disponible', to: 'asignado', unitId });
    plan.newAssignments.push({ id: aid, techId: m.techId, toolId: m.toolId, unitId, qty, active: true, since: at, movementId: mid, replaces: null });
    if (unitId) plan.unitUpdates.push({ id: unitId, set: { status: 'asignado', techId: m.techId } });
    plan.audit = { action: 'movement', detail: `${MV[m.type]}: ${tool.name}${unitId ? ' ' + unitCode(ctx, unitId) : ''}${qty > 1 ? ' ×' + qty : ''} a ${tech.name}` };
    return plan;
  }

  const a0 = ctx.assignments[m.asgId];
  const a = a0 ? { id: m.asgId, ...a0 } : null;
  if (!a || !a.active || a.techId !== m.techId) fail('Elegí una herramienta asignada al técnico.');
  const tool = ctx.tools[a.toolId] || { name: 'Herramienta' };
  const st = ctx.stateOf[a.id];

  if (m.type === 'reposicion') {
    let newUnitId = null;
    const qty = a.qty || 1;
    if (tool.serialized) {
      const u = ctx.units[m.newUnitId];
      if (!u || u.toolId !== a.toolId || u.status !== 'disponible') fail('Elegí la unidad nueva que recibe.');
      newUnitId = m.newUnitId;
    } else {
      const disp = (ctx.pools[a.toolId] || {}).disponible || 0;
      if (qty > disp) fail(`No hay stock suficiente: se necesitan ${qty} y hay ${disp} disponibles.`);
    }
    const oldDest = m.oldDest || 'reparacion';
    if (m.returned && !REPOSICION_DEST.includes(oldDest)) fail('Elegí el destino de la herramienta dañada.');
    const dest = m.returned ? oldDest : 'pendiente';
    const naid = newId('a');
    plan.movement = {
      id: mid, type: 'reposicion', techId: m.techId, toolId: a.toolId, qty, oldAssignmentId: a.id, newAssignmentId: naid,
      oldUnitId: a.unitId || null, newUnitId, oldState: st ? st.state : 'pendiente', returned: !!m.returned, oldDest: dest,
      linkedControlId: st ? st.controlId : null, reason, notes, at,
    };
    plan.transfers.push({ toolId: a.toolId, qty, from: 'asignado', to: dest, unitId: a.unitId || null });
    plan.transfers.push({ toolId: a.toolId, qty, from: 'disponible', to: 'asignado', unitId: newUnitId });
    plan.assignmentUpdates.push({ id: a.id, set: { active: false, until: at, endReason: 'reposicion', replacedBy: naid, endMovementId: mid } });
    plan.newAssignments.push({ id: naid, techId: m.techId, toolId: a.toolId, unitId: newUnitId, qty, active: true, since: at, movementId: mid, replaces: a.id });
    if (a.unitId) plan.unitUpdates.push({ id: a.unitId, set: { status: dest, techId: dest === 'pendiente' ? m.techId : null } });
    if (newUnitId) plan.unitUpdates.push({ id: newUnitId, set: { status: 'asignado', techId: m.techId } });
    plan.audit = {
      action: 'movement',
      detail: `Reposición: ${tool.name} a ${tech.name}${a.unitId ? `, sale ${unitCode(ctx, a.unitId)}` : ''}${newUnitId ? `, entra ${unitCode(ctx, newUnitId)}` : ''}. Anterior: ${dest === 'pendiente' ? 'pendiente de devolución' : POOL[dest].toLowerCase()}`,
    };
    return plan;
  }

  // devolución o retiro
  let qty = a.qty || 1;
  if (m.type === 'devolucion' && !a.unitId && qty > 1) {
    qty = parseInt(m.qty, 10);
    if (!(qty >= 1 && qty <= a.qty)) fail(`Indicá una cantidad entre 1 y ${a.qty}.`);
  }
  const dest = m.type === 'retiro' ? 'retirado' : m.cond || 'disponible';
  if (m.type === 'devolucion' && !RETURN_COND.includes(dest)) fail('Elegí la condición de lo devuelto.');
  plan.movement = { id: mid, type: m.type, techId: m.techId, toolId: a.toolId, qty, oldAssignmentId: a.id, unitId: a.unitId || null, condition: dest, reason, notes, at };
  plan.transfers.push({ toolId: a.toolId, qty, from: 'asignado', to: dest, unitId: a.unitId || null });
  if (qty >= (a.qty || 1)) plan.assignmentUpdates.push({ id: a.id, set: { active: false, until: at, endReason: m.type, endMovementId: mid } });
  else plan.assignmentUpdates.push({ id: a.id, set: { qty: (a.qty || 1) - qty } });
  if (a.unitId) plan.unitUpdates.push({ id: a.unitId, set: { status: dest, techId: null } });
  plan.audit = { action: 'movement', detail: `${MV[m.type]}: ${tool.name}${a.unitId ? ' ' + unitCode(ctx, a.unitId) : ''}${qty > 1 ? ' ×' + qty : ''} de ${tech.name}, a ${POOL[dest].toLowerCase()}` };
  return plan;
}

function planReception(ctx, m, plan, { at, mid, notes }) {
  const mv = (ctx.pendingReturns || []).find((x) => x.id === m.resolvesMovementId);
  if (!mv) fail('Ya fue registrada.');
  const dest = m.cond || 'reparacion';
  if (!RETURN_COND.includes(dest)) fail('Elegí en qué condición vuelve.');
  const toolName = (ctx.tools[mv.toolId] || {}).name || 'Herramienta';
  plan.movement = { id: mid, type: 'recepcion', techId: mv.techId, toolId: mv.toolId, qty: mv.qty, unitId: mv.oldUnitId || null, resolvesMovementId: mv.id, condition: dest, notes, at };
  plan.transfers.push({ toolId: mv.toolId, qty: mv.qty, from: 'pendiente', to: dest, unitId: mv.oldUnitId || null });
  if (mv.oldUnitId) plan.unitUpdates.push({ id: mv.oldUnitId, set: { status: dest, techId: null } });
  plan.audit = { action: 'movement', detail: `Devolución pendiente recibida: ${toolName}, a ${POOL[dest].toLowerCase()}` };
  return plan;
}

function planInventory(ctx, st, plan, { at, mid, notes, newId }) {
  const tool = ctx.tools[st.toolId] ? { id: st.toolId, ...ctx.tools[st.toolId] } : null;
  if (!tool) fail('Elegí una herramienta.');
  if (st.type === 'ingreso' && tool.serialized) return planNewUnits(ctx, tool, st.codes, plan, { at, mid, notes, newId });
  const p = ctx.pools[tool.id] || {};
  const from0 = st.from || 'disponible';
  if (st.type === 'baja' && !BAJA_FROM.includes(from0)) fail('Elegí el origen de la baja.');
  const map = { ingreso: ['externo', 'disponible'], reparado: ['reparacion', 'disponible'], baja: [from0, 'baja'], recupero: ['retirado', 'disponible'] };
  const [from, to] = map[st.type];
  if (tool.serialized) {
    const u = ctx.units[st.unitId];
    if (!u || u.toolId !== tool.id || u.status !== from) fail('Elegí una unidad válida.');
    plan.movement = { id: mid, type: st.type, toolId: tool.id, qty: 1, unitId: st.unitId, notes, at };
    plan.transfers.push({ toolId: tool.id, qty: 1, from, to, unitId: st.unitId });
    plan.unitUpdates.push({ id: st.unitId, set: { status: to, techId: null } });
    plan.audit = { action: 'inventory', detail: `${MV[st.type]}: ${tool.name} ${u.code}` };
    return plan;
  }
  const qty = parseInt(st.qty, 10);
  if (!(qty >= 1)) fail('Indicá una cantidad válida.');
  if (from !== 'externo' && qty > (p[from] || 0)) fail(`Solo hay ${p[from] || 0} en ${POOL[from].toLowerCase()}.`);
  plan.movement = { id: mid, type: st.type, toolId: tool.id, qty, notes, at };
  plan.transfers.push({ toolId: tool.id, qty, from, to, unitId: null });
  plan.audit = { action: 'inventory', detail: `${MV[st.type]}: ${tool.name} ×${qty}` };
  return plan;
}

function planNewUnits(ctx, tool, codesTxt, plan, { at, mid, notes, newId }) {
  const codes = String(codesTxt || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!codes.length) fail('Ingresá al menos un código.');
  const existing = new Set(Object.values(ctx.units).map((u) => (u.code || '').toLowerCase()));
  const seen = new Set();
  for (const c of codes) {
    tooLong(c, LIM.code, 'Cada código');
    const k = c.toLowerCase();
    if (existing.has(k)) fail(`El código ${c} ya existe.`);
    if (seen.has(k)) fail(`El código ${c} está repetido.`);
    seen.add(k);
  }
  const ids = codes.map(() => newId('u'));
  codes.forEach((code, i) => plan.newUnits.push({ id: ids[i], toolId: tool.id, code, status: 'disponible', techId: null }));
  plan.movement = { id: mid, type: 'ingreso', toolId: tool.id, qty: codes.length, notes, at };
  for (const id of ids) plan.transfers.push({ toolId: tool.id, qty: 1, from: 'externo', to: 'disponible', unitId: id });
  plan.audit = { action: 'inventory', detail: `Alta de unidades de ${tool.name}: ${codes.join(', ')}` };
  return plan;
}
