// Kits (etapa 3): kit base (el equivalente a `BLANCO`) y kits opcionales por especialidad, cada
// uno una lista ordenada de herramientas con cantidad. "Entregar kit" planifica un movimiento por
// herramienta (entrega inicial, o adicional si el poseedor ya la tiene) y es todo o nada: si una
// herramienta no alcanza, se nombra y no se entrega ninguna.
import { DomainError, tooLong } from './errors.js';
import { LIM } from './constants.js';
import { planMovement } from './movements.js';
import { sameHolder } from './lineas.js';

export const KIT_MAX_ITEMS = 300;
export const KIT_MAX_QTY = 10000;
const fail = (msg, code = 'invalid_input') => {
  throw new DomainError(msg, code);
};

export function cleanKitName(name) {
  const n = String(name ?? '').trim();
  if (!n) fail('Ingresá el nombre del kit.');
  tooLong(n, LIM.name, 'El nombre');
  return n;
}

// items: [{ toolId, qty }] en el orden del kit. tools: { id: herramienta }.
export function cleanKitItems(items, tools) {
  if (!Array.isArray(items)) fail('La lista de herramientas no es válida.');
  if (items.length > KIT_MAX_ITEMS) fail(`Un kit admite hasta ${KIT_MAX_ITEMS} herramientas.`);
  const seen = new Set();
  return items.map((it) => {
    const tool = tools[it && it.toolId];
    if (!tool) fail('Elegí una herramienta válida.');
    if (seen.has(it.toolId)) fail(`La herramienta ${tool.name} está repetida en el kit.`);
    seen.add(it.toolId);
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > KIT_MAX_QTY) fail(`Indicá una cantidad válida para ${tool.name}.`);
    return { toolId: it.toolId, qty: it.qty };
  });
}

// Copia del contexto con lo que ya planificó la entrega (asignaciones nuevas, unidades
// entregadas y stock descontado), para planificar la herramienta siguiente.
function applyToCtx(ctx, plan) {
  for (const a of plan.newAssignments) ctx.assignments[a.id] = { techId: a.techId, cajaId: a.cajaId ?? null, toolId: a.toolId, unitId: a.unitId, qty: a.qty, active: true };
  for (const u of plan.unitUpdates) ctx.units[u.id] = { ...ctx.units[u.id], ...u.set };
  for (const t of plan.transfers) {
    const p = (ctx.pools[t.toolId] = { ...(ctx.pools[t.toolId] || {}) });
    p[t.from] = (p[t.from] || 0) - t.qty;
    p[t.to] = (p[t.to] || 0) + t.qty;
  }
}

const byCode = (units) => (a, b) => (units[a].code || '').localeCompare(units[b].code || '', 'es', { numeric: true });

// ctx: el de planMovement(). input: { items, holder: { techId } | { cajaId }, unitIds?: { toolId:
// [unitId] }, kitName, reason? }. Devuelve { plans, problems }: si hay problemas, plans = [].
export function planKitDelivery(ctx0, input, { at, newId }) {
  const items = input.items || [];
  if (!items.length) fail('El kit no tiene herramientas.', 'kit_empty');
  const holder = input.holder || {};
  if (holder.cajaId) {
    const k = (ctx0.cajas || {})[holder.cajaId];
    if (!k || k.archivedAt) fail('Elegí una caja activa.');
  } else {
    const t = ctx0.techs[holder.techId];
    if (!t || t.active === false) fail('Elegí un técnico activo.');
  }
  const h = holder.cajaId ? { techId: null, cajaId: holder.cajaId } : { techId: holder.techId };
  const ctx = { ...ctx0, assignments: { ...ctx0.assignments }, units: { ...ctx0.units }, pools: { ...ctx0.pools } };
  const chosen = input.unitIds || {};
  const reason = String(input.reason ?? '').trim() || `Entrega del kit ${input.kitName}`;
  const problems = [];
  const plans = [];
  for (const it of items) {
    const tool = ctx.tools[it.toolId];
    const name = tool ? tool.name : 'Herramienta eliminada';
    const problem = (message) => problems.push({ toolId: it.toolId, toolName: name, message: `${name}: ${message}` });
    if (!tool) { problem('ya no existe.'); continue; }
    if (tool.active === false) { problem('está inactiva.'); continue; }
    let lines;
    if (tool.serialized) {
      const avail = Object.keys(ctx.units).filter((id) => ctx.units[id].toolId === it.toolId && ctx.units[id].status === 'disponible').sort(byCode(ctx.units));
      const pick = chosen[it.toolId];
      if (pick) {
        if (new Set(pick).size !== pick.length) { problem('hay una unidad repetida.'); continue; }
        if (pick.length !== it.qty) { problem(`elegí ${it.qty} ${it.qty === 1 ? 'unidad' : 'unidades'}.`); continue; }
        const bad = pick.find((id) => !avail.includes(id));
        if (bad) { problem(ctx.units[bad] && ctx.units[bad].toolId === it.toolId ? `la unidad ${ctx.units[bad].code} no está disponible.` : 'elegí unidades de esta herramienta.'); continue; }
        lines = pick;
      } else {
        if (avail.length < it.qty) { problem(`se necesitan ${it.qty} ${it.qty === 1 ? 'unidad' : 'unidades'} y hay ${avail.length} ${avail.length === 1 ? 'disponible' : 'disponibles'}.`); continue; }
        lines = avail.slice(0, it.qty);
      }
      lines = lines.map((unitId) => ({ unitId }));
    } else {
      if (chosen[it.toolId]) { problem('es por cantidad: no lleva unidades.'); continue; }
      const disp = (ctx.pools[it.toolId] || {}).disponible || 0;
      if (disp < it.qty) { problem(`se necesitan ${it.qty} y hay ${disp} disponibles.`); continue; }
      lines = [{ qty: it.qty }];
    }
    try {
      for (const x of lines) {
        const has = Object.values(ctx.assignments).some((a) => a.active && a.toolId === it.toolId && sameHolder(a, h));
        const plan = planMovement(ctx, { type: has ? 'adicional' : 'entrega_inicial', ...holder, toolId: it.toolId, ...x, reason }, { at, newId });
        applyToCtx(ctx, plan);
        plans.push(plan);
      }
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      problem(err.message);
    }
  }
  return problems.length ? { plans: [], problems } : { plans, problems };
}
