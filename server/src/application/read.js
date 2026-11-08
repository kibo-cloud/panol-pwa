// Modelos de lectura: estado completo para el frontend, inventario, alertas, integridad,
// informes, controles y auditoría. Los cálculos los hace el dominio.
import { readState, withSnapshot } from '../adapters/pg/state-repo.js';
import { loadControls } from '../adapters/pg/inventory-repo.js';
import { deriveState } from '../domain/derive.js';
import { deriveAlerts } from '../domain/alerts.js';
import { computeReport } from '../domain/report.js';
import { integrityIssues } from '../domain/integrity.js';
import { effectiveControls } from '../domain/controls.js';
import { notFoundError } from '../domain/errors.js';

const ids = (o) => Object.fromEntries(Object.entries(o).map(([k, c]) => [k, c.id]));
const DEMO_COLS = ['techs', 'shiftChanges', 'categories', 'tools', 'units', 'assignments', 'controls', 'movements', 'alertRes'];

function derived(S, now) {
  const d = deriveState(S, { now });
  const alerts = deriveAlerts({ now, techs: S.techs, tools: S.tools, units: S.units, assignments: S.assignments, controls: d.ctls, movements: d.movs, alertRes: S.alertRes });
  return { d, alerts };
}

// "Mi plantilla" de un supervisor: sus plantillas activas, su gente (hoy) y las alertas de su gente.
function myPlantilla(S, user, alerts) {
  const ids = user ? Object.entries(S.plantillas).filter(([, p]) => !p.archivedAt && p.supervisorUserId === user.id).map(([id]) => id) : [];
  const set = new Set(ids);
  const techIds = Object.entries(S.techs).filter(([, t]) => t.active !== false && set.has(t.plantillaId)).map(([id]) => id);
  const techSet = new Set(techIds);
  return { plantillaIds: ids, techIds, alertKeys: alerts.filter((a) => a.techId && techSet.has(a.techId)).map((a) => a.key) };
}

export async function getState(db, { now = new Date(), user = null } = {}) {
  const S = await withSnapshot(db, readState);
  const { d, alerts } = derived(S, now);
  return {
    now: now.toISOString(),
    ...S,
    config: { turnos: { list: S.shifts.map((s) => ({ id: s.id, name: s.name, order: s.order })) }, shiftLabels: S.shiftLabels },
    derived: {
      cur: d.cur, curKey: d.curKey, pools: d.pools, stateOf: d.stateOf, effective: ids(d.eff), drafts: ids(d.drafts), supersededBy: d.supersededBy,
      pendingReturns: d.pendingReturns.map((m) => m.id), techInfo: d.techInfo, shiftInfo: d.shiftInfo, kpi: d.kpi, alerts,
      hasDemo: DEMO_COLS.some((c) => Object.values(S[c]).some((x) => x.demo)),
      myPlantilla: myPlantilla(S, user, alerts),
    },
  };
}

export async function getInventory(db) {
  const S = await withSnapshot(db, readState);
  const d = deriveState(S);
  return { pools: d.pools, pendingReturns: d.pendingReturns.map((m) => m.id) };
}

export async function getAlerts(db, { now = new Date() } = {}) {
  const S = await withSnapshot(db, readState);
  const { alerts } = derived(S, now);
  const resolved = Object.entries(S.alertRes).map(([key, r]) => ({ key, ...r })).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return { open: alerts, resolved };
}

export async function getIntegrity(db) {
  const S = await withSnapshot(db, readState);
  return { issues: integrityIssues(deriveState(S)) };
}

export async function getReport(db, filters, { now = new Date() } = {}) {
  const S = await withSnapshot(db, readState);
  return computeReport(deriveState(S, { now }), filters);
}

// Historial de controles (opcionalmente de un técnico), del más nuevo al más viejo.
export async function listControls(db, { techId, status, plantillaId } = {}) {
  let list = await loadControls(db, status ? { status } : {});
  const { supersededBy, eff } = effectiveControls(list);
  const effIds = new Set(Object.values(eff).map((c) => c.id));
  if (techId) list = list.filter((c) => c.techId === techId);
  // Por plantilla: la foto que guardó cada control (no la plantilla actual del técnico).
  if (plantillaId) list = list.filter((c) => c.plantillaId === plantillaId);
  list.sort((a, b) => b.pnum - a.pnum || (b.finishedAt || b.updatedAt || '').localeCompare(a.finishedAt || a.updatedAt || ''));
  return list.map((c) => ({ ...c, supersededBy: supersededBy[c.id] || null, effective: effIds.has(c.id) }));
}

export async function getControl(db, id) {
  const c = (await loadControls(db, { id }))[0];
  if (!c) throw notFoundError('No se encontró el control.');
  return c;
}

// Auditoría paginada por fecha descendente; `before` es el cursor { at, id } del último visto.
export async function listAudit(db, { limit = 50, before = null } = {}) {
  const params = [limit + 1];
  let where = '';
  if (before) {
    params.push(before.at, before.id);
    where = 'WHERE (at, id) < ($2::timestamptz, $3)';
  }
  const { rows } = await db.query(`SELECT id, action, entity, entity_id, detail, at, actor_id, ip FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT $1`, params);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({ id: r.id, action: r.action, entity: r.entity, entityId: r.entity_id, detail: r.detail, at: r.at.toISOString(), by: r.actor_id, ip: r.ip }));
  const last = items[items.length - 1];
  return { items, next: more && last ? `${last.at}|${last.id}` : null };
}
