// SQL de las solicitudes de compra (etapa 7). La lista filtra en el servidor (estado, mes del alta,
// plantilla, técnico, caja, herramienta, motivo, texto y eliminadas), más nuevas primero, con
// cursor; los totales cuentan las aprobadas por mes de la decisión; `queryPurchasesOfPeriod` es la
// consulta por período que reusa la impresión de auditoría (etapa 10).
import { OPEN_STATUSES } from '../../domain/compras.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const num = (v) => (v == null ? null : Number(v));

const SELECT = `
  SELECT r.*, tl.name AS cur_tool_name, tl.serialized AS tool_serialized, tl.archived_at AS tool_archived_at,
         un.code AS cur_unit_code, t.name AS tech_name, t.archived_at AS tech_archived_at,
         k.name AS caja_name, k.archived_at AS caja_archived_at, p.name AS plantilla_name, p.archived_at AS plantilla_archived_at,
         cu.name AS created_by_name, du.name AS decided_by_name, pu.name AS purchased_by_name, ru.name AS received_by_name,
         to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM purchase_requests r
    JOIN tools tl ON tl.id = r.tool_id
    LEFT JOIN units un ON un.id = r.unit_id
    LEFT JOIN techs t ON t.id = r.tech_id
    LEFT JOIN cajas k ON k.id = r.caja_id
    LEFT JOIN plantillas p ON p.id = r.plantilla_id
    LEFT JOIN users cu ON cu.id = r.created_by
    LEFT JOIN users du ON du.id = r.decided_by
    LEFT JOIN users pu ON pu.id = r.purchased_by
    LEFT JOIN users ru ON ru.id = r.received_by`;

// Fila -> solicitud de la API. Los nombres del poseedor y la herramienta son la foto del alta.
export function toApi(r) {
  if (!r) return null;
  return {
    id: r.id, seq: Number(r.seq), name: r.name,
    toolId: r.tool_id, toolName: r.tool_name || r.cur_tool_name, toolArchived: r.tool_archived_at != null, serialized: !!r.tool_serialized,
    unitId: r.unit_id, unitCode: r.unit_code || r.cur_unit_code || null, assignmentId: r.assignment_id,
    techId: r.tech_id, cajaId: r.caja_id, holderName: r.holder_name || r.tech_name || r.caja_name || null,
    holderArchived: (r.tech_id && r.tech_archived_at != null) || (r.caja_id && r.caja_archived_at != null) || false,
    plantillaId: r.plantilla_id, plantillaName: r.plantilla_name ?? null, plantillaArchived: r.plantilla_archived_at != null,
    reason: r.reason, observation: r.observation || '', qty: r.qty, estimatedCost: num(r.estimated_cost), supplier: r.supplier || '',
    origin: r.origin, originControlId: r.origin_control_id, alertKey: r.alert_key,
    status: r.status,
    decidedBy: r.decided_by, decidedByName: r.decided_by_name ?? null, decidedAt: iso(r.decided_at), decisionComment: r.decision_comment || '',
    purchasedBy: r.purchased_by, purchasedByName: r.purchased_by_name ?? null, purchasedAt: iso(r.purchased_at), purchaseNote: r.purchase_note || '',
    receivedBy: r.received_by, receivedByName: r.received_by_name ?? null, receivedAt: iso(r.received_at), receivedQty: r.received_qty, receptionNote: r.reception_note || '',
    ingresoMovementId: r.ingreso_movement_id, reposicionMovementId: r.reposicion_movement_id,
    lossResolvedAt: iso(r.loss_resolved_at),
    archived: r.archived_at != null, archivedAt: iso(r.archived_at), archivedBy: r.archived_by, archiveReason: r.archive_reason,
    version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), by: r.created_by, byName: r.created_by_name ?? null,
  };
}

export async function getPurchase(q, id) {
  return toApi((await q.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0]);
}

// Fila sola, bloqueada (para una transición o una edición).
export async function lockPurchase(q, id) {
  return (await q.query('SELECT * FROM purchase_requests WHERE id = $1 FOR UPDATE', [id])).rows[0] || null;
}

export async function insertPurchase(q, v) {
  await q.query(
    `INSERT INTO purchase_requests (id, tool_id, unit_id, assignment_id, tech_id, caja_id, plantilla_id, holder_name, tool_name, unit_code,
       reason, observation, qty, estimated_cost, supplier, origin, origin_control_id, alert_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [v.id, v.toolId, v.unitId, v.assignmentId, v.techId, v.cajaId, v.plantillaId, v.holderName, v.toolName, v.unitCode,
      v.reason, v.observation || null, v.qty, v.estimatedCost, v.supplier || null, v.origin, v.originControlId || null, v.alertKey || null, v.createdBy],
  );
}

export async function linkControl(q, requestId, controlId, qty) {
  await q.query('INSERT INTO purchase_request_controls (request_id, control_id, qty) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [requestId, controlId, qty]);
}

// Controles vinculados, en orden de período.
export async function controlsOf(q, id) {
  const { rows } = await q.query(
    `SELECT l.control_id, l.qty, l.linked_at, c.period_y, c.period_m, c.period_w, c.finished_at, c.correction, c.supersedes_id
       FROM purchase_request_controls l JOIN controls c ON c.id = l.control_id
      WHERE l.request_id = $1 ORDER BY c.period_y, c.period_m, c.period_w, c.finished_at, l.control_id`,
    [id],
  );
  return rows.map((r) => ({ controlId: r.control_id, qty: r.qty, linkedAt: iso(r.linked_at), period: { y: r.period_y, m: r.period_m, w: r.period_w }, finishedAt: iso(r.finished_at), correction: r.correction, supersedes: r.supersedes_id }));
}

// Línea de tiempo: la auditoría de la solicitud (alta, decisión, compra, recepción, ediciones…).
export async function timelineOf(q, id) {
  const { rows } = await q.query(
    `SELECT a.action, a.detail, a.at, a.actor_id, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.entity = 'purchase_requests' AND a.entity_id = $1 ORDER BY a.at, a.id`,
    [id],
  );
  return rows.map((r) => ({ action: r.action, detail: r.detail, at: iso(r.at), by: r.actor_id, byName: r.actor_name ?? null }));
}

/**
 * Candidatas de la creación automática (bloqueadas FOR UPDATE, por id): no eliminadas, de esas
 * asignaciones o unidades, abiertas o rechazadas sin resolver. Con `supersededId` (corrección)
 * marca las vinculadas al control corregido y si todos sus controles son de ese poseedor y período.
 */
export async function lockCandidates(q, { assignmentIds, unitIds, supersededId = null }) {
  const { rows } = await q.query(
    `SELECT r.id, r.status, r.reason, r.assignment_id, r.unit_id, r.qty, r.origin, r.loss_resolved_at
       FROM purchase_requests r
      WHERE r.archived_at IS NULL AND (r.assignment_id = ANY($1) OR r.unit_id = ANY($2))
        AND (r.status = ANY($3) OR (r.status = 'rechazada' AND r.loss_resolved_at IS NULL))
      ORDER BY r.id FOR UPDATE`,
    [assignmentIds, unitIds, OPEN_STATUSES],
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const links = (await q.query(
    `SELECT l.request_id, c.id, c.tech_id, c.caja_id, c.period_y, c.period_m, c.period_w FROM purchase_request_controls l JOIN controls c ON c.id = l.control_id
      WHERE l.request_id = ANY($1)`,
    [ids],
  )).rows;
  const sup = supersededId ? (await q.query('SELECT tech_id, caja_id, period_y, period_m, period_w FROM controls WHERE id = $1', [supersededId])).rows[0] : null;
  const samePeriod = (c) => sup && (c.caja_id || null) === (sup.caja_id || null) && (c.caja_id ? true : c.tech_id === sup.tech_id)
    && c.period_y === sup.period_y && c.period_m === sup.period_m && c.period_w === sup.period_w;
  const pnum = (c) => c.period_y * 1000 + c.period_m * 10 + c.period_w;
  return rows.map((r) => {
    const ls = links.filter((l) => l.request_id === r.id);
    return {
      id: r.id, status: r.status, reason: r.reason, assignmentId: r.assignment_id, unitId: r.unit_id, qty: r.qty, origin: r.origin, lossResolvedAt: iso(r.loss_resolved_at),
      linkedToSuperseded: !!supersededId && ls.some((l) => l.id === supersededId),
      onlyThisPeriod: !!sup && ls.length > 0 && ls.every(samePeriod),
      maxLinkedPnum: ls.reduce((m, l) => Math.max(m, pnum(l)), 0),
    };
  });
}

// Resumen para /api/state (todos los perfiles): estado de las abiertas, de las rechazadas sin
// resolver (alerta "compra rechazada") y de las recibidas que todavía no tienen reposición. Sin
// costos ni proveedores.
export async function loadPurchaseSummary(q) {
  const { rows } = await q.query(
    `SELECT r.id, r.name, r.status, r.reason, r.tool_id, r.unit_id, r.assignment_id, r.tech_id, r.caja_id, r.qty, r.received_qty,
            r.decision_comment, r.decided_at, r.received_at, r.created_at, r.holder_name, r.tool_name
       FROM purchase_requests r
      WHERE r.archived_at IS NULL AND (r.status = ANY($1) OR (r.status = 'rechazada' AND r.loss_resolved_at IS NULL)
            OR (r.status = 'recibida' AND r.reposicion_movement_id IS NULL))
      ORDER BY r.created_at, r.id`,
    [OPEN_STATUSES],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, status: r.status, reason: r.reason, toolId: r.tool_id, unitId: r.unit_id, assignmentId: r.assignment_id, techId: r.tech_id, cajaId: r.caja_id,
    qty: r.qty, receivedQty: r.received_qty, decisionComment: r.status === 'rechazada' ? r.decision_comment || '' : '', decidedAt: iso(r.decided_at), receivedAt: iso(r.received_at),
    createdAt: iso(r.created_at), holderName: r.holder_name, toolName: r.tool_name,
  }));
}

const likePattern = (s) => '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

// Condiciones comunes de la lista y los totales.
function whereOf(f, p) {
  const where = [];
  if (f.status === 'open') where.push(`r.status = ANY(${p(OPEN_STATUSES)})`);
  else if (f.status) where.push(`r.status = ${p(f.status)}`);
  if (f.scope === 'receive') where.push("r.status IN ('aprobada', 'comprada')");
  // Mes local del alta (la sesión de la base usa la zona horaria de la empresa).
  if (f.month) where.push(`r.created_at >= (${p(f.month + '-01')}::date) AND r.created_at < ((${p(f.month + '-01')}::date) + interval '1 month')`);
  if (f.plantillaId) where.push(`r.plantilla_id = ${p(f.plantillaId)}`);
  if (f.techId) where.push(`r.tech_id = ${p(f.techId)}`);
  if (f.cajaId) where.push(`r.caja_id = ${p(f.cajaId)}`);
  if (f.toolId) where.push(`r.tool_id = ${p(f.toolId)}`);
  if (f.reason) where.push(`r.reason = ${p(f.reason)}`);
  if (f.archived === 'exclude') where.push('r.archived_at IS NULL');
  if (f.archived === 'only') where.push('r.archived_at IS NOT NULL');
  if (f.q) where.push(`concat_ws(' ', r.name, r.tool_name, r.unit_code, r.holder_name, r.observation, r.supplier, r.decision_comment, tl.name, p.name) ILIKE ${p(likePattern(f.q))}`);
  return where;
}

// f: filtros de parsePurchaseFilters. Devuelve { rows, next, cursor, total }.
export async function queryPurchases(q, f, { withTotal = true } = {}) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = whereOf(f, p);
  const base = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = !withTotal ? null : (await q.query(`SELECT count(*)::int AS n FROM (${SELECT} ${base}) x`, params)).rows[0].n;
  const page = [...where];
  if (f.before) page.push(`(r.created_at, r.id) < (${p(f.before.at)}::timestamptz, ${p(f.before.id)})`);
  const limit = f.limit ?? 50;
  const { rows } = await q.query(`${SELECT} ${page.length ? `WHERE ${page.join(' AND ')}` : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT ${Number(limit) + 1}`, params);
  const more = rows.length > limit;
  const list = rows.slice(0, limit);
  const last = list[list.length - 1];
  const cursor = more && last ? { at: last.cursor_at, id: last.id } : null;
  return { rows: list.map(toApi), next: cursor ? `${cursor.at}|${cursor.id}` : null, cursor, total };
}

/**
 * Totales por mes de la decisión (meses locales `from`..`to`, AAAA-MM): aprobadas (aprobada,
 * comprada o recibida), suma de los costos conocidos, cuántas sin costo y rechazadas. Los filtros
 * de poseedor, herramienta y motivo valen igual que en la lista.
 */
export async function purchaseTotals(q, f, { from, to }) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = whereOf({ ...f, status: null, month: null, scope: null, archived: 'exclude' }, p);
  const fromP = p(from + '-01');
  const toP = p(to + '-01');
  where.push(`r.decided_at >= ${fromP}::date AND r.decided_at < (${toP}::date + interval '1 month')`);
  const { rows } = await q.query(
    `SELECT to_char(date_trunc('month', r.decided_at), 'YYYY-MM') AS month,
            count(*) FILTER (WHERE r.status IN ('aprobada', 'comprada', 'recibida'))::int AS approved,
            count(*) FILTER (WHERE r.status IN ('aprobada', 'comprada', 'recibida') AND r.estimated_cost IS NOT NULL)::int AS with_cost,
            count(*) FILTER (WHERE r.status IN ('aprobada', 'comprada', 'recibida') AND r.estimated_cost IS NULL)::int AS without_cost,
            coalesce(sum(r.estimated_cost) FILTER (WHERE r.status IN ('aprobada', 'comprada', 'recibida')), 0)::text AS cost_sum,
            count(*) FILTER (WHERE r.status = 'rechazada')::int AS rejected
       FROM purchase_requests r JOIN tools tl ON tl.id = r.tool_id LEFT JOIN plantillas p ON p.id = r.plantilla_id
      WHERE ${where.join(' AND ')}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  return rows.map((r) => ({ month: r.month, approved: r.approved, withCost: r.with_cost, withoutCost: r.without_cost, costSum: Number(r.cost_sum), rejected: r.rejected }));
}

// Pendientes de decisión (insignia del menú y alerta "compras pendientes").
export async function pendingCount(q) {
  return (await q.query("SELECT count(*)::int AS n FROM purchase_requests WHERE status = 'pendiente' AND archived_at IS NULL")).rows[0].n;
}

/**
 * Aprobadas y rechazadas en el período (por fecha de la decisión, días locales `from`..`to`), con
 * los filtros de poseedor, herramienta y motivo, de la más vieja a la más nueva; de a páginas por id.
 */
export async function queryDecidedPage(q, f, { afterAt = null, afterId = null, limit = 200 } = {}) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = whereOf({ ...f, status: null, month: null, scope: null, archived: 'exclude' }, p);
  where.push("r.status <> 'pendiente'");
  if (f.from) where.push(`r.decided_at >= ${p(f.from)}::date`);
  if (f.to) where.push(`r.decided_at < (${p(f.to)}::date + 1)`);
  if (afterAt) where.push(`(r.decided_at, r.id) > (${p(afterAt)}::timestamptz, ${p(afterId)})`);
  const { rows } = await q.query(
    `${SELECT.replace('AS cursor_at', "AS cursor_at, to_char(r.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS decided_cursor")}
     WHERE ${where.join(' AND ')} ORDER BY r.decided_at, r.id LIMIT ${Number(limit)}`,
    params,
  );
  const last = rows[rows.length - 1];
  return { rows: rows.map(toApi), after: rows.length === limit && last ? { at: last.decided_cursor, id: last.id } : null };
}
