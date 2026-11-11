// Solicitudes de compra (etapa 7): creación automática al finalizar o corregir un control, alta
// manual (ficha de la herramienta o alerta), decisión de Gerencia, compra, recepción con el ingreso
// al inventario, vínculo de la reposición, edición del costo y el proveedor, listas, totales y la
// consulta por período (impresión, etapa 10). Eliminar y restaurar (cancelar mientras está
// pendiente) van por el modelo genérico (records.js, tipo `compras`).
// Bloqueos (orden global):
// - Finalizar: poseedor FOR SHARE -> control -> asignaciones FOR SHARE (controls.js) -> nombre
//   `purchases.asg:<asignación>` (por id, solo las que tienen pérdidas) -> solicitudes FOR UPDATE (por id).
// - Alta manual: poseedor FOR SHARE -> asignación FOR SHARE -> nombre `purchases.asg:<asignación>`.
// - Decidir, comprar y editar: la solicitud FOR UPDATE. Recibir: la solicitud FOR UPDATE -> el orden
//   de un movimiento (herramienta FOR UPDATE, códigos de unidades).
// - Reposición vinculada: el orden de un movimiento -> la solicitud FOR UPDATE.
// El nombre por asignación serializa dos controles que finalizan a la vez para la misma asignación:
// el segundo ve la abierta del primero y se vincula (además del índice único parcial).
import * as repo from '../adapters/pg/compras-repo.js';
import { lockName } from '../adapters/pg/catalog-repo.js';
import { loadOverrides } from '../adapters/pg/auth-repo.js';
import { withSnapshot } from '../adapters/pg/state-repo.js';
import { plantillaOn } from '../adapters/pg/plantilla-repo.js';
import { can } from '../domain/permissions.js';
import {
  OPEN_STATUSES, PURCHASE_STATUS_LABEL, checkTransition, cleanDecision, cleanCost, cleanSupplier, cleanObservation, cleanManualPurchase,
  lossesOf, countedPairs, planAutoPurchases, parsePurchaseFilters, parseMonth, sameKey, stripCosts, COST_MARK,
} from '../domain/compras.js';
import { parseNovedadFilters } from '../domain/novedades.js';
import { DomainError, ConflictError, notFoundError } from '../domain/errors.js';
import { pnumOf, plabel, localDateISO } from '../domain/period.js';
import { newId } from './ids.js';
import { withTransaction, record } from './common.js';
import { idempotent } from './idempotency.js';
import { applyMovement } from './movements.js';

const forbidden = () => new DomainError('Tu perfil no tiene permiso para esta acción.', 'forbidden', 403);
const rule = (msg, code, status = 422) => new DomainError(msg, code, status);
const notFound = () => notFoundError('No se encontró la solicitud de compra.');
const REASON_TXT = { cambio: 'dañada', faltante: 'extraviada' };
export const assignmentLock = (c, asgId) => lockName(c, `purchases.asg:${asgId}`);

async function permsOf(db, actor) {
  const ov = await loadOverrides(db);
  const p = (k) => can(actor.role, k, ov);
  return { view: p('purchases_view'), decide: p('purchases_decide'), create: p('purchases_create'), receive: p('purchases_receive'), deleted: p('records_delete') };
}

const what = (r) => `${r.tool_name}${r.unit_code ? ' ' + r.unit_code : ''}${r.holder_name ? ` (${r.holder_name})` : ''}`;
const money = (v) => (v == null ? 'sin costo' : `$ ${Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
// E7.V1: costos y proveedores solo con purchases_view (Gerencia, admin). En la auditoría van al
// final, después de COST_MARK, para poder ocultarlos.
const shown = (perms, row) => (perms.view ? row : stripCosts(row));
const costText = (cost, supplier) => `${COST_MARK}${money(cost)}${supplier ? `, proveedor ${supplier}` : ''}`;
// Marca de la transacción para el trigger de 015: después de la decisión, el costo y el proveedor
// solo los cambia quien decide (purchases_decide).
const asDecider = (c) => c.query("SELECT set_config('panol.purchase_decider', 'on', true)");
const costForbidden = () => new DomainError('Después de la decisión, el costo y el proveedor solo los cambia Gerencia.', 'forbidden', 403);

// ---------------------------------------------------------------- creación automática
/**
 * Al finalizar (o corregir) un control, dentro de su transacción. ctx: el de controls.js
 * (poseedor, asignaciones activas bloqueadas, herramientas y unidades); doc: el documento
 * finalizado; supersedesId: el control corregido (o null).
 * Devuelve { created, linked, archived } (ids) para la respuesta.
 */
export async function autoPurchasesOnFinalize(c, actor, { controlId, period, doc, ctx, supersedesId = null }) {
  const asgs = ctx.assignments;
  const losses = lossesOf(doc.items, asgs);
  const counted = countedPairs(doc.items, asgs);
  const out = { created: [], linked: [], archived: [] };
  if (!counted.length) return out;
  for (const id of [...new Set(losses.map((l) => l.assignmentId))].sort()) await assignmentLock(c, id);
  const asgIds = [...new Set(counted.map((p) => p.assignmentId))];
  const unitIds = [...new Set(asgs.filter((a) => asgIds.includes(a.id) && a.unitId).map((a) => a.unitId))];
  const candidates = await repo.lockCandidates(c, { assignmentIds: asgIds, unitIds, supersededId: supersedesId });
  const plan = planAutoPurchases({ losses, counted, candidates, pnum: pnumOf(period) });
  const when = plabel(period).toLowerCase();
  const holder = ctx.tech || ctx.caja;
  for (const l of plan.create) {
    const id = newId('pr');
    const unitCode = l.unitId && ctx.units[l.unitId] ? ctx.units[l.unitId].code : null;
    await repo.insertPurchase(c, {
      id, toolId: l.toolId, unitId: l.unitId, assignmentId: l.assignmentId, techId: ctx.tech ? ctx.tech.id : null, cajaId: ctx.caja ? ctx.caja.id : null,
      plantillaId: ctx.tech ? ctx.tech.plantillaId || null : null, holderName: holder.name, toolName: (ctx.tools[l.toolId] || {}).name || l.toolId, unitCode,
      reason: l.reason, observation: l.note, qty: l.qty, estimatedCost: null, supplier: null, origin: 'control', originControlId: controlId, createdBy: actor.id,
    }).catch((e) => {
      // El nombre por asignación lo evita; el índice único queda de respaldo.
      if (e.code === '23505') throw rule('Otra solicitud de compra se creó al mismo tiempo. Probá de nuevo.', 'conflict', 409);
      throw e;
    });
    await repo.linkControl(c, id, controlId, l.qty);
    const r = (await c.query('SELECT name, version, tool_name, unit_code, holder_name FROM purchase_requests WHERE id = $1', [id])).rows[0];
    await record(c, actor, {
      action: 'purchase_create', entity: 'purchase_requests', id, version: r.version, event: 'create',
      detail: `Alta automática de ${r.name}: ${what(r)}, ${REASON_TXT[l.reason]}, cantidad ${l.qty}. Control de la ${when}${l.note ? `. Observación: ${l.note}` : ''}`,
    });
    out.created.push(id);
  }
  for (const k of plan.link) {
    const cand = candidates.find((r) => r.id === k.id);
    const l = losses.find((x) => sameKey(cand, x));
    await repo.linkControl(c, k.id, controlId, k.qty ?? (l ? l.qty : 1));
    if (k.qty != null) await c.query('UPDATE purchase_requests SET qty = $2 WHERE id = $1', [k.id, k.qty]);
    const r = (await c.query('SELECT name, version, qty FROM purchase_requests WHERE id = $1', [k.id])).rows[0];
    await record(c, actor, {
      action: 'purchase_link', entity: 'purchase_requests', id: k.id, version: r.version,
      detail: `${r.name}: vinculada al control de la ${when}${k.qty != null ? `; la cantidad pasa a ${k.qty}` : ''}`,
    });
    out.linked.push(k.id);
  }
  for (const id of plan.archive) {
    await c.query("UPDATE purchase_requests SET archived_at = now(), archived_by = $2, archive_reason = 'Corregido en el control' WHERE id = $1", [id, actor.id]);
    const r = (await c.query('SELECT name, version FROM purchase_requests WHERE id = $1', [id])).rows[0];
    await record(c, actor, { action: 'purchase_archive', entity: 'purchase_requests', id, version: r.version, detail: `Eliminación de ${r.name}. Motivo: Corregido en el control (${when}).` });
    out.archived.push(id);
  }
  if (plan.resolve.length) {
    await c.query('UPDATE purchase_requests SET loss_resolved_at = now(), loss_resolved_control_id = $2 WHERE id = ANY($1)', [plan.resolve, controlId]);
    for (const id of plan.resolve) {
      const r = (await c.query('SELECT name, version FROM purchase_requests WHERE id = $1', [id])).rows[0];
      await record(c, actor, { action: 'purchase_resolved', entity: 'purchase_requests', id, version: r.version, detail: `${r.name}: el control de la ${when} muestra la pérdida resuelta` });
    }
  }
  // E7.V1: una pendiente cuyo control más nuevo ya no muestra la pérdida queda marcada (no se
  // cancela); si un control posterior la vuelve a mostrar, se quita la marca.
  for (const [ids, set, action, txt] of [
    [plan.flag, 'loss_resolved_at = now(), loss_resolved_control_id = $2', 'purchase_loss_gone', 'la pérdida ya no figura en el control de la'],
    [plan.unflag, 'loss_resolved_at = NULL, loss_resolved_control_id = NULL', 'purchase_loss_back', 'la pérdida vuelve a figurar en el control de la'],
  ]) {
    if (!ids.length) continue;
    await c.query(`UPDATE purchase_requests SET ${set} WHERE id = ANY($1)`, set.includes('$2') ? [ids, controlId] : [ids]);
    for (const id of ids) {
      const r = (await c.query('SELECT name, version FROM purchase_requests WHERE id = $1', [id])).rows[0];
      await record(c, actor, { action, entity: 'purchase_requests', id, version: r.version, detail: `${r.name}: ${txt} ${when}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- alta manual
export async function createPurchase(db, actor, input, { idempotencyKey, path } = {}) {
  const v = cleanManualPurchase(input);
  const perms = await permsOf(db, actor);
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: v }, async (c) => {
    let snap = { assignmentId: null, unitId: null, techId: null, cajaId: null, plantillaId: null, holderName: null, unitCode: null };
    let toolName;
    if (v.assignmentId) {
      const a0 = (await c.query('SELECT tech_id, caja_id FROM assignments WHERE id = $1', [v.assignmentId])).rows[0];
      if (!a0) throw rule('Esa herramienta ya no está asignada. Recargá y probá de nuevo.', 'invalid_assignment');
      const h = a0.caja_id
        ? (await c.query('SELECT id, name, archived_at, true AS active FROM cajas WHERE id = $1 FOR SHARE', [a0.caja_id])).rows[0]
        : (await c.query('SELECT id, name, archived_at, active FROM techs WHERE id = $1 FOR SHARE', [a0.tech_id])).rows[0];
      const a = (await c.query(
        `SELECT a.id, a.tool_id, a.unit_id, a.active, t.name AS tool_name, u.code AS unit_code FROM assignments a JOIN tools t ON t.id = a.tool_id
           LEFT JOIN units u ON u.id = a.unit_id WHERE a.id = $1 FOR SHARE OF a`,
        [v.assignmentId],
      )).rows[0];
      if (!h || h.archived_at || !h.active || !a.active) throw rule('Esa herramienta ya no está asignada. Recargá y probá de nuevo.', 'invalid_assignment');
      if (a.tool_id !== v.toolId) throw rule('La asignación no es de esa herramienta.', 'invalid_assignment');
      await assignmentLock(c, a.id);
      const open = (await c.query(
        `SELECT id, name FROM purchase_requests WHERE archived_at IS NULL AND status = ANY($1) AND reason = $2
            AND (assignment_id = $3 OR (unit_id IS NOT NULL AND unit_id = $4)) LIMIT 1`,
        [OPEN_STATUSES, v.reason, a.id, a.unit_id],
      )).rows[0];
      if (open) throw Object.assign(rule(`Ya hay una solicitud abierta para esta herramienta y motivo (${open.name}).`, 'purchase_exists', 409), { extra: { current: open.id } });
      snap = {
        assignmentId: a.id, unitId: a.unit_id, techId: a0.caja_id ? null : h.id, cajaId: a0.caja_id ? h.id : null,
        plantillaId: a0.caja_id ? null : await plantillaOn(c, h.id, localDateISO()), holderName: h.name, unitCode: a.unit_code,
      };
      toolName = a.tool_name;
    } else {
      const t = (await c.query('SELECT id, name, active, archived_at FROM tools WHERE id = $1 FOR SHARE', [v.toolId])).rows[0];
      if (!t || t.archived_at || !t.active) throw rule('Elegí una herramienta activa.', 'invalid_tool');
      toolName = t.name;
    }
    const id = newId('pr');
    await repo.insertPurchase(c, { id, toolId: v.toolId, ...snap, toolName, reason: v.reason, observation: v.observation, qty: v.qty, estimatedCost: v.estimatedCost, supplier: v.supplier, origin: v.origin, alertKey: v.alertKey, createdBy: actor.id })
      .catch((e) => {
        if (e.code === '23505') throw rule('Ya hay una solicitud abierta para esta herramienta y motivo.', 'purchase_exists', 409);
        throw e;
      });
    const row = await repo.getPurchase(c, id);
    await record(c, actor, {
      action: 'purchase_create', entity: 'purchase_requests', id, version: row.version, event: 'create',
      detail: `Alta de ${row.name} desde ${v.origin === 'alert' ? 'una alerta' : 'la ficha de la herramienta'}: ${toolName}${snap.unitCode ? ' ' + snap.unitCode : ''}${snap.holderName ? ` (${snap.holderName})` : ''}, ${REASON_TXT[v.reason]}, cantidad ${v.qty}${costText(v.estimatedCost, v.supplier)}`,
    });
    return { status: 201, body: { compra: shown(perms, row) } };
  });
}

// ---------------------------------------------------------------- decisión, compra y recepción
const ACTION_TXT = { approve: 'aprobada', reject: 'rechazada', purchase: 'marcada como comprada', receive: 'recibida' };

function cleanReceive(input, row, serialized) {
  const note = cleanObservation(input.note);
  if (serialized) {
    const codes = String(input.codes || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!codes.length) throw rule('Ingresá el código de cada unidad recibida.', 'codes_required');
    if (input.qty != null && input.qty !== codes.length) throw rule('La cantidad recibida tiene que coincidir con los códigos.', 'invalid_qty');
    return { qty: codes.length, codes: codes.join('\n'), note };
  }
  const qty = input.qty == null ? row.qty : input.qty;
  if (!Number.isInteger(qty) || qty < 1) throw rule('Indicá la cantidad recibida.', 'invalid_qty');
  return { qty, codes: null, note };
}

/**
 * Transición (approve, reject, purchase, receive) con If-Match e Idempotency-Key.
 * approve: { comment?, estimatedCost?, supplier? }; reject: { comment }; purchase: { note?,
 * estimatedCost?, supplier? }; receive: { qty?, codes? (unidades), note? } -> ingreso al inventario.
 */
export async function transitionPurchase(db, actor, id, action, input = {}, version, { idempotencyKey, path } = {}) {
  const perms = await permsOf(db, actor);
  const allowed = { approve: perms.decide, reject: perms.decide, purchase: perms.decide || perms.receive, receive: perms.receive }[action];
  if (!allowed) throw forbidden();
  // E7.V1: quien solo recibe marca comprada sin tocar el costo ni el proveedor.
  if (!perms.decide && (input.estimatedCost !== undefined || input.supplier !== undefined)) throw costForbidden();
  const dec = action === 'approve' || action === 'reject' ? cleanDecision(action, input) : { comment: '' };
  const cost = input.estimatedCost !== undefined ? cleanCost(input.estimatedCost) : undefined;
  const supplier = input.supplier !== undefined ? cleanSupplier(input.supplier) : undefined;
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: { id, action, version, input } }, async (c) => {
    const cur = await repo.lockPurchase(c, id);
    if (!cur || (cur.archived_at && !perms.deleted)) throw notFound();
    if (cur.version !== version) throw new ConflictError(shown(perms, await repo.getPurchase(c, id)));
    if (perms.decide) await asDecider(c);
    const to = checkTransition({ status: cur.status, archived: !!cur.archived_at }, action);
    const set = { status: to };
    if (cost !== undefined) set.estimated_cost = cost;
    if (supplier !== undefined) set.supplier = supplier || null;
    let extra = '';
    if (action === 'approve' || action === 'reject') Object.assign(set, { decided_by: actor.id, decided_at: new Date(), decision_comment: dec.comment || null });
    if (action === 'purchase') Object.assign(set, { purchased_by: actor.id, purchased_at: new Date(), purchase_note: cleanObservation(input.note) || null });
    if (action === 'receive') {
      const tool = (await c.query('SELECT serialized FROM tools WHERE id = $1', [cur.tool_id])).rows[0];
      const rv = cleanReceive(input, cur, !!(tool && tool.serialized));
      const plan = await applyMovement(c, actor, {
        type: 'ingreso', toolId: cur.tool_id, ...(rv.codes ? { codes: rv.codes } : { qty: rv.qty }),
        notes: `Recepción de ${cur.name}${rv.note ? ': ' + rv.note : ''}`,
      });
      Object.assign(set, { received_by: actor.id, received_at: new Date(), received_qty: rv.qty, reception_note: rv.note || null, ingreso_movement_id: plan.movement.id });
      extra = `; ingreso al inventario de ${rv.qty}${rv.codes ? ` (${rv.codes.split('\n').join(', ')})` : ''}`;
    }
    const keys = Object.keys(set);
    await c.query(`UPDATE purchase_requests SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => set[k])]);
    const row = await repo.getPurchase(c, id);
    const note = action === 'reject' || action === 'approve' ? dec.comment : cleanObservation(input.note);
    await record(c, actor, {
      action: `purchase_${action}`, entity: 'purchase_requests', id, version: row.version,
      detail: `${row.name} ${ACTION_TXT[action]}: ${what(cur)}, ${REASON_TXT[cur.reason]}, cantidad ${cur.qty}${extra}${note ? `. ${action === 'reject' ? 'Motivo' : 'Comentario'}: ${note}` : ''}${cost !== undefined || supplier ? costText(cost !== undefined ? cost : cur.estimated_cost, supplier) : ''}`,
    });
    return { status: 200, body: { compra: shown(perms, row) } };
  });
}

// ---------------------------------------------------------------- edición (costo, proveedor, cantidad)
export async function updatePurchase(db, actor, id, input, version) {
  const perms = await permsOf(db, actor);
  if (!perms.create && !perms.decide) throw forbidden();
  const next = {};
  if (input.estimatedCost !== undefined) next.estimated_cost = cleanCost(input.estimatedCost);
  if (input.supplier !== undefined) next.supplier = cleanSupplier(input.supplier) || null;
  if (input.observation !== undefined) next.observation = cleanObservation(input.observation) || null;
  if (input.qty !== undefined) {
    if (!Number.isInteger(input.qty) || input.qty < 1) throw rule('Indicá una cantidad válida (1 o más).', 'invalid_qty');
    next.qty = input.qty;
  }
  return withTransaction(db, async (c) => {
    const cur = await repo.lockPurchase(c, id);
    if (!cur || (cur.archived_at && !perms.deleted)) throw notFound();
    if (cur.version !== version) throw new ConflictError(shown(perms, await repo.getPurchase(c, id)));
    if (cur.archived_at) throw rule('La solicitud está eliminada: restaurala antes de editarla.', 'archived', 409);
    if (!OPEN_STATUSES.includes(cur.status)) throw rule(`La solicitud está ${PURCHASE_STATUS_LABEL[cur.status].toLowerCase()}: ya no se modifica.`, 'closed', 409);
    // E7.V1: después de la decisión, el costo y el proveedor solo los cambia quien decide.
    if (!perms.decide && cur.status !== 'pendiente' && ('estimated_cost' in next || 'supplier' in next)) throw costForbidden();
    if (perms.decide) await asDecider(c);
    if (next.qty !== undefined && next.qty !== cur.qty && cur.status !== 'pendiente') throw rule('La cantidad solo se cambia mientras la solicitud está pendiente.', 'qty_locked', 409);
    const LABEL = { estimated_cost: 'costo estimado', supplier: 'proveedor', observation: 'observación', qty: 'cantidad' };
    const fmt = (k, v) => (k === 'estimated_cost' ? money(v) : v == null || v === '' ? '(vacío)' : String(v));
    const changed = Object.keys(next).filter((k) => String(cur[k] ?? '') !== String(next[k] ?? '') && !(k === 'estimated_cost' && cur[k] != null && next[k] != null && Number(cur[k]) === Number(next[k])));
    if (!changed.length) return shown(perms, await repo.getPurchase(c, id));
    await c.query(`UPDATE purchase_requests SET ${changed.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...changed.map((k) => next[k])]);
    const row = await repo.getPurchase(c, id);
    // El costo y el proveedor van al final, después de COST_MARK (se ocultan sin purchases_view).
    const isCost = (k) => k === 'estimated_cost' || k === 'supplier';
    const part = (ks) => ks.map((k) => `${LABEL[k]}: ${fmt(k, cur[k])} → ${fmt(k, next[k])}`).join('; ');
    const plain = changed.filter((k) => !isCost(k));
    const costs = changed.filter(isCost);
    await record(c, actor, { action: 'purchase_edit', entity: 'purchase_requests', id, version: row.version, detail: `Edición de ${row.name}.${plain.length ? ' ' + part(plain) : ''}${costs.length ? COST_MARK + part(costs) : ''}` });
    return shown(perms, row);
  });
}

// ---------------------------------------------------------------- reposición vinculada
// Antes de registrar la reposición (sin bloquear): la solicitud recibida, sin reposición, de la
// misma herramienta y de la misma asignación (E7.V1: el mismo poseedor no alcanza; si la
// solicitud nombra una unidad, la unidad que sale es esa). Una compra para stock (sin
// asignación) no se vincula. mv: { toolId, techId, cajaId, asgId, unitId }.
export async function checkReposicionLink(c, requestId, mv) {
  const r = (await c.query('SELECT * FROM purchase_requests WHERE id = $1', [requestId])).rows[0];
  if (!r || r.archived_at) throw rule('No se encontró la compra a vincular.', 'invalid_purchase');
  if (r.status !== 'recibida') throw rule('Solo se vincula una compra recibida.', 'invalid_purchase');
  if (r.reposicion_movement_id) throw rule(`${r.name} ya está vinculada a otra reposición.`, 'invalid_purchase', 409);
  if (r.tool_id !== mv.toolId) throw rule(`${r.name} es de otra herramienta.`, 'invalid_purchase');
  if (!r.assignment_id) throw rule(`${r.name} es una compra para stock: no se vincula a una reposición.`, 'invalid_purchase');
  if (r.tech_id !== (mv.techId || null) || r.caja_id !== (mv.cajaId || null)) throw rule(`${r.name} es de otro poseedor.`, 'invalid_purchase');
  if (r.assignment_id !== (mv.asgId || null)) throw rule(`${r.name} es de otra asignación de esa herramienta.`, 'invalid_purchase');
  if (r.unit_id && r.unit_id !== (mv.unitId || null)) throw rule(`${r.name} es de otra unidad.`, 'invalid_purchase');
  return r;
}

// Después de registrar la reposición: la solicitud FOR UPDATE (orden: movimiento -> solicitud).
export async function linkReposicion(c, actor, requestId, mv) {
  const cur = await repo.lockPurchase(c, requestId);
  await checkReposicionLink(c, requestId, mv);
  await c.query('UPDATE purchase_requests SET reposicion_movement_id = $2 WHERE id = $1', [requestId, mv.id]);
  const v = (await c.query('SELECT version FROM purchase_requests WHERE id = $1', [requestId])).rows[0].version;
  await record(c, actor, { action: 'purchase_reposicion', entity: 'purchase_requests', id: requestId, version: v, detail: `${cur.name}: reposición a ${mv.holderName || 'el poseedor'} vinculada` });
}

// ---------------------------------------------------------------- lecturas
function checkList(perms, f) {
  if (!perms.view && !(perms.receive && f.scope === 'receive')) throw forbidden();
  if (f.archived !== 'exclude' && !(perms.view && perms.deleted)) throw forbidden();
}

export async function listPurchases(db, actor, query) {
  const f = parsePurchaseFilters(query);
  const perms = await permsOf(db, actor);
  checkList(perms, f);
  const r = await repo.queryPurchases(db, { ...f, costs: perms.view });
  return { compras: r.rows.map((x) => shown(perms, x)), next: r.next, total: r.total };
}

export async function getPurchaseDetail(db, actor, id) {
  const perms = await permsOf(db, actor);
  if (!perms.view && !perms.receive && !perms.create) throw forbidden();
  return withSnapshot(db, async (c) => {
    const row = await repo.getPurchase(c, id);
    if (!row || (row.archived && !perms.deleted)) throw notFound();
    const novedades = (await c.query('SELECT id, name, comment, occurred_at FROM novedades WHERE purchase_request_id = $1 AND archived_at IS NULL ORDER BY occurred_at DESC, id DESC LIMIT 50', [id])).rows
      .map((n) => ({ id: n.id, name: n.name, comment: n.comment, occurredAt: n.occurred_at.toISOString() }));
    return shown(perms, { ...row, controls: await repo.controlsOf(c, id), timeline: await repo.timelineOf(c, id), novedades });
  });
}

const monthOf = (d) => localDateISO(d).slice(0, 7);
function monthsBack(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) - n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

// Totales aprobados por mes (de `from` a `to`, AAAA-MM; por defecto los últimos 6 meses).
export async function purchaseTotals(db, actor, query = {}, { now = new Date() } = {}) {
  if (!(await permsOf(db, actor)).view) throw forbidden();
  const to = parseMonth(query.to) || monthOf(now);
  const from = parseMonth(query.from) || monthsBack(to, 5);
  if (from > to) throw rule('El mes desde es posterior al mes hasta.', 'invalid_range', 400);
  const f = parsePurchaseFilters({ ...query, from: undefined, to: undefined });
  const months = await repo.purchaseTotals(db, f, { from, to });
  const pending = await repo.pendingCount(db);
  return { from, to, months, pending };
}

// Consulta por período para otros casos de uso (impresión de auditoría, etapa 10).
// filters: from, to (días locales, inclusive, por la fecha de la decisión), plantillaId, techId,
// cajaId, toolId, reason. Devuelve las aprobadas (también compradas y recibidas) y las rechazadas
// del período, de la más vieja a la más nueva, de a páginas dentro de una sola instantánea
// (REPEATABLE READ, solo lectura). El permiso propio del caso de uso que llama lo revisa ese caso
// de uso (como novedadesOfPeriod).
export async function purchasesOfPeriod(db, actor, filters = {}) {
  const d = parseNovedadFilters({ from: filters.from, to: filters.to });
  const f = { ...parsePurchaseFilters({ plantillaId: filters.plantillaId, techId: filters.techId, cajaId: filters.cajaId, toolId: filters.toolId, reason: filters.reason }), from: d.from, to: d.to };
  return withSnapshot(db, (c) => collectDecided(c, f));
}

// Aprobadas y rechazadas de los filtros ya validados, con un cliente dentro de una instantánea.
export async function collectDecided(c, f) {
  const out = [];
  let after = null;
  do {
    const r = await repo.queryDecidedPage(c, f, { afterAt: after && after.at, afterId: after && after.id });
    out.push(...r.rows);
    after = r.after;
  } while (after);
  return out;
}

