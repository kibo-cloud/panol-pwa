// Datos derivados del estado (portado de derive() de 2.1). Recibe las colecciones con la misma
// forma que `S` de 2.1 (objetos por id) y devuelve listas ordenadas, controles efectivos,
// historial, inventario y resúmenes por técnico y por turno.
import { periodOf, pkeyOf, pnumOf, localDateISO } from './period.js';
import { effectiveControls, controlHistory } from './controls.js';
import { pendingReturns } from './alerts.js';
import { poolsFromTransfers, emptyPool } from './pools.js';
import { DEFAULT_SHIFTS } from './constants.js';

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
  const tools = toList(S.tools).sort(byName);
  const units = toList(S.units).sort((a, b) => (a.code || '').localeCompare(b.code || '', 'es', { numeric: true }));
  const unitsByTool = groupBy(units, 'toolId');
  const asgs = toList(S.assignments);
  const activeAsg = asgs.filter((a) => a.active);
  const toolNameOf = (id) => ((S.tools || {})[id] || {}).name || '';
  const asgByTech = groupBy(activeAsg, 'techId');
  for (const k in asgByTech) asgByTech[k].sort((a, b) => toolNameOf(a.toolId).localeCompare(toolNameOf(b.toolId), 'es'));

  const ctls = toList(S.controls).map((c) => ({ ...c, pkey: c.pkey || pkeyOf(c.period), pnum: c.pnum || pnumOf(c.period) }));
  const { eff, effList, drafts, supersededBy } = effectiveControls(ctls);
  const effByTech = groupBy(effList, 'techId');
  const { stateOf, hist, transitions } = controlHistory(effList);

  const movs = toList(S.movements).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const pools = S.pools ? { ...S.pools } : poolsFromTransfers(movs.flatMap((m) => m.transfers || []));
  for (const t of tools) pools[t.id] = { ...emptyPool(), ...(pools[t.id] || {}) };
  const pend = pendingReturns(movs);

  const techInfo = {};
  for (const t of techs) {
    const list = asgByTech[t.id] || [];
    const s = emptySum();
    for (const a of list) {
      const st = (stateOf[a.id] && stateOf[a.id].state) || 'pendiente';
      const q = a.qty || 1;
      s[st] += q;
      s.total += q;
    }
    const curEff = eff[t.id + '|' + curKey];
    const curDraft = drafts[t.id + '|' + curKey];
    s.curStatus = curEff ? 'done' : curDraft ? 'draft' : 'pend';
    s.light = !s.total ? 'pend' : s.faltante ? 'bad' : s.cambio ? 'warn' : s.pendiente ? 'pend' : 'ok';
    s.lines = list.length;
    techInfo[t.id] = s;
  }
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
    cur, curKey, curNum, today: localDateISO(now), shifts, shiftById, plantillaById, plantillaHist, techs, activeTechs, tools, units, unitsByTool, asgs, activeAsg, asgByTech,
    ctls, eff, effList, effByTech, drafts, supersededBy, stateOf, hist, transitions, movs, pools, pendingReturns: pend,
    techInfo, shiftInfo, kpi,
  };
}
