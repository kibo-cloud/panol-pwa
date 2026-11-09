// Datos derivados del estado (portado de derive() de 2.1). Recibe las colecciones con la misma
// forma que `S` de 2.1 (objetos por id) y devuelve listas ordenadas, controles efectivos,
// historial, inventario y resúmenes por técnico y por turno.
import { periodOf, pkeyOf, pnumOf, localDateISO } from './period.js';
import { effectiveControls, controlHistory, asgUnits } from './controls.js';
import { pendingReturns } from './alerts.js';
import { poolsFromTransfers, emptyPool } from './pools.js';
import { DEFAULT_SHIFTS } from './constants.js';
import { orderTools } from './orden.js';

export const toList = (o) => Object.entries(o || {}).map(([id, x]) => ({ id, ...x }));
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'es');

export function groupBy(arr, k) {
  const o = {};
  for (const x of arr) (o[x[k]] || (o[x[k]] = [])).push(x);
  return o;
}

const emptySum = () => ({ bueno: 0, cambio: 0, faltante: 0, pendiente: 0, total: 0 });

// S: { shifts: [{id,name,order}], techs, tools, units, assignments, controls, movements, pools? }
// Los controles necesitan `period`; `pkey` y `pnum` se completan si faltan.
export function deriveState(S, { now = new Date() } = {}) {
  const cur = periodOf(now);
  const curKey = pkeyOf(cur);
  const curNum = pnumOf(cur);
  const shifts = (S.shifts && S.shifts.length ? S.shifts : DEFAULT_SHIFTS).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]));
  // Plantillas (también las archivadas, para informes históricos) e historial de pertenencia.
  const plantillaById = { ...Object.fromEntries(Object.entries(S.plantillas || {}).map(([id, p]) => [id, { id, ...p }])), ...shiftById };
  const plantillaHist = S.plantillaHistory || {};
  const techs = toList(S.techs).sort(byName);
  const activeTechs = techs.filter((t) => t.active !== false);
  // Orden personalizado (etapa 3): categoría y después la herramienta.
  const tools = orderTools(toList(S.tools), toList(S.categories));
  const rank = Object.fromEntries(tools.map((t, i) => [t.id, i]));
  const byTool = (a, b) => (rank[a.toolId] ?? 1e9) - (rank[b.toolId] ?? 1e9) || toolNameOf(a.toolId).localeCompare(toolNameOf(b.toolId), 'es');
  const units = toList(S.units).sort((a, b) => (a.code || '').localeCompare(b.code || '', 'es', { numeric: true }));
  const unitsByTool = groupBy(units, 'toolId');
  const asgs = toList(S.assignments);
  const activeAsg = asgs.filter((a) => a.active);
  const toolNameOf = (id) => ((S.tools || {})[id] || {}).name || '';
  // Asignaciones por poseedor: técnico o caja compartida (etapa 2).
  const asgByTech = groupBy(activeAsg.filter((a) => a.techId), 'techId');
  const asgByCaja = groupBy(activeAsg.filter((a) => a.cajaId), 'cajaId');
  const cajas = toList(S.cajas).sort(byName);
  for (const k in asgByCaja) asgByCaja[k].sort(byTool);
  for (const k in asgByTech) asgByTech[k].sort(byTool);

  const ctls = toList(S.controls).map((c) => ({ ...c, pkey: c.pkey || pkeyOf(c.period), pnum: c.pnum || pnumOf(c.period) }));
  const { eff, effList, drafts, supersededBy } = effectiveControls(ctls);
  const effByTech = groupBy(effList, 'techId');
  const { stateOf, hist, transitions } = controlHistory(effList);

  const movs = toList(S.movements).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const pools = S.pools ? { ...S.pools } : poolsFromTransfers(movs.flatMap((m) => m.transfers || []));
  for (const t of tools) pools[t.id] = { ...emptyPool(), ...(pools[t.id] || {}) };
  const pend = pendingReturns(movs);

  const infoOf = (list, key) => {
    const s = emptySum();
    // Etapa 4: por unidades (en buen estado, para recambio, faltantes, sin controlar).
    for (const a of list) {
      const q = a.qty || 1;
      const u = asgUnits(stateOf[a.id], q);
      for (const k of ['bueno', 'cambio', 'faltante', 'pendiente']) s[k] += u[k];
      s.total += q;
    }
    const curEff = eff[key + '|' + curKey];
    const curDraft = drafts[key + '|' + curKey];
    s.curStatus = curEff ? 'done' : curDraft ? 'draft' : 'pend';
    s.light = !s.total ? 'pend' : s.faltante ? 'bad' : s.cambio ? 'warn' : s.pendiente ? 'pend' : 'ok';
    s.lines = list.length;
    return s;
  };
  const techInfo = {};
  for (const t of techs) techInfo[t.id] = infoOf(asgByTech[t.id] || [], t.id);
  const cajaInfo = {};
  for (const k of cajas) cajaInfo[k.id] = infoOf(asgByCaja[k.id] || [], 'caja:' + k.id);
  const sumOf = (list) => {
    const s = emptySum();
    for (const t of list) for (const k of Object.keys(s)) s[k] += techInfo[t.id][k];
    return s;
  };
  const shiftInfo = {};
  for (const s of shifts) {
    const ts = activeTechs.filter((t) => t.shiftId === s.id);
    const sum = sumOf(ts);
    shiftInfo[s.id] = {
      techs: ts.length, tools: sum.total, sum,
      done: ts.filter((t) => techInfo[t.id].curStatus === 'done').length,
      draft: ts.filter((t) => techInfo[t.id].curStatus === 'draft').length,
    };
  }
  const all = sumOf(activeTechs);
  const kpi = {
    techs: activeTechs.length, tools: all.total, bueno: all.bueno, cambio: all.cambio, faltante: all.faltante, pendiente: all.pendiente,
    pendCtl: activeTechs.filter((t) => techInfo[t.id].curStatus !== 'done').length,
    ctlMonth: effList.filter((c) => c.period && c.period.y === cur.y && c.period.m === cur.m).length,
  };
  return {
    especialidadById: Object.fromEntries(toList(S.especialidades).map((e) => [e.id, e])),
    lineas: toList(S.lineas).sort((a, b) => (a.order || 0) - (b.order || 0) || byName(a, b)),
    cur, curKey, curNum, today: localDateISO(now), shifts, shiftById, plantillaById, plantillaHist, techs, activeTechs, cajas, tools, units, unitsByTool, asgs, activeAsg, asgByTech, asgByCaja,
    ctls, eff, effList, effByTech, drafts, supersededBy, stateOf, hist, transitions, movs, pools, pendingReturns: pend,
    techInfo, cajaInfo, shiftInfo, kpi,
  };
}
