// Datos derivados para las vistas (puro): el mismo cálculo de 2.1 sobre el estado que manda
// GET /api/state. El período actual lo decide el servidor (hora de Buenos Aires).
import { pkeyOf, pnumOf, plabel, periodOf } from './period.js';

export function groupBy(arr, k) { const o = {}; for (const x of arr) (o[x[k]] || (o[x[k]] = [])).push(x); return o; }
const list = (o) => Object.entries(o || {}).map(([id, x]) => ({ id, ...x }));
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'es');
const DEMO_COLS = ['techs', 'shiftChanges', 'categories', 'tools', 'units', 'assignments', 'controls', 'movements', 'alertRes'];

export function deriveState(S) {
  const cur = (S.derived && S.derived.cur) || periodOf();
  const curKey = pkeyOf(cur), curNum = pnumOf(cur);
  const shifts = (S.shifts || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]));
  const techs = list(S.techs).sort(byName);
  const activeTechs = techs.filter((t) => t.active !== false);
  const cats = list(S.categories).sort(byName);
  const tools = list(S.tools).sort(byName);
  const units = list(S.units).sort((a, b) => (a.code || '').localeCompare(b.code || '', 'es', { numeric: true }));
  const unitsByTool = groupBy(units, 'toolId');
  const asgs = list(S.assignments);
  const activeAsg = asgs.filter((a) => a.active);
  const asgByTech = groupBy(activeAsg, 'techId');
  const tname = (id) => ((S.tools[id] || {}).name || '');
  for (const k in asgByTech) asgByTech[k].sort((a, b) => tname(a.toolId).localeCompare(tname(b.toolId), 'es'));
  const ctls = list(S.controls);
  const fin = ctls.filter((c) => c.status === 'finalizado');
  const eff = {};
  for (const c of fin) { const k = c.techId + '|' + c.pkey; if (!eff[k] || (eff[k].finishedAt || '') < (c.finishedAt || '')) eff[k] = c; }
  const effList = Object.values(eff).sort((a, b) => a.pnum - b.pnum || (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  const effByTech = groupBy(effList, 'techId');
  const drafts = {};
  for (const c of ctls) if (c.status === 'borrador') { const k = c.techId + '|' + c.pkey; if (!drafts[k] || (drafts[k].updatedAt || '') < (c.updatedAt || '')) drafts[k] = c; }
  const supersededBy = {}; for (const c of fin) if (c.supersedes) supersededBy[c.supersedes] = c.id;
  // historial de estados por asignación
  const stateOf = {}, hist = {}, transitions = [];
  for (const c of effList) {
    for (const [aid, it] of Object.entries(c.items || {})) {
      if (!it || !it.state) continue;
      const prev = stateOf[aid];
      (hist[aid] || (hist[aid] = [])).push({ state: it.state, controlId: c.id, pkey: c.pkey, pnum: c.pnum });
      const ps = prev ? prev.state : null;
      if (ps !== it.state && (it.state !== 'bueno' || ps)) transitions.push({ techId: c.techId, asgId: aid, toolId: it.toolId, toolName: it.toolName, unitCode: it.unitCode, from: ps, to: it.state, pkey: c.pkey, pnum: c.pnum, at: c.finishedAt, controlId: c.id, note: it.note });
      stateOf[aid] = { state: it.state, note: it.note || '', controlId: c.id, at: c.finishedAt, pkey: c.pkey };
    }
  }
  // movimientos y saldos (siempre desde las transferencias)
  const movs = list(S.movements).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const pools = {};
  const P = (t) => pools[t] || (pools[t] = { disponible: 0, asignado: 0, reparacion: 0, retirado: 0, pendiente: 0, baja: 0, externo: 0 });
  for (const m of movs) for (const tr of (m.transfers || [])) { const p = P(tr.toolId), q = Number(tr.qty) || 0; p[tr.from] = (p[tr.from] || 0) - q; p[tr.to] = (p[tr.to] || 0) + q; }
  for (const t of tools) P(t.id);
  const resolvedRecv = new Set(movs.filter((m) => m.type === 'recepcion' && m.resolvesMovementId).map((m) => m.resolvesMovementId));
  const pendingReturns = movs.filter((m) => m.type === 'reposicion' && m.returned === false && !resolvedRecv.has(m.id));
  // resumen por técnico
  const emptySum = () => ({ bueno: 0, cambio: 0, faltante: 0, pendiente: 0, total: 0 });
  const techInfo = {};
  for (const t of techs) {
    const l = asgByTech[t.id] || []; const s = emptySum();
    for (const a of l) { const st = (stateOf[a.id] && stateOf[a.id].state) || 'pendiente'; const q = a.qty || 1; s[st] += q; s.total += q; }
    const curEff = eff[t.id + '|' + curKey], curDraft = drafts[t.id + '|' + curKey];
    s.curStatus = curEff ? 'done' : curDraft ? 'draft' : 'pend';
    s.light = !s.total ? 'pend' : s.faltante ? 'bad' : s.cambio ? 'warn' : s.pendiente ? 'pend' : 'ok';
    s.lines = l.length;
    techInfo[t.id] = s;
  }
  const sumOf = (ts) => { const s = emptySum(); for (const t of ts) { const i = techInfo[t.id]; for (const k of ['bueno', 'cambio', 'faltante', 'pendiente', 'total']) s[k] += i[k]; } return s; };
  const shiftInfo = {};
  for (const s of shifts) { const ts = activeTechs.filter((t) => t.shiftId === s.id); const sum = sumOf(ts); shiftInfo[s.id] = { techs: ts.length, tools: sum.total, sum, done: ts.filter((t) => techInfo[t.id].curStatus === 'done').length, draft: ts.filter((t) => techInfo[t.id].curStatus === 'draft').length }; }
  const all = sumOf(activeTechs);
  const kpi = { techs: activeTechs.length, tools: all.total, bueno: all.bueno, cambio: all.cambio, faltante: all.faltante, pendiente: all.pendiente, pendCtl: activeTechs.filter((t) => techInfo[t.id].curStatus !== 'done').length, ctlMonth: effList.filter((c) => c.period && c.period.y === cur.y && c.period.m === cur.m).length };
  // alertas (mismas claves que el servidor, para resolverlas por la API)
  const alerts = [];
  for (const t of activeTechs) { const i = techInfo[t.id]; if (i.curStatus !== 'done' && i.lines) alerts.push({ key: `pend-${t.id}-${curKey}`, type: 'pendiente', sev: 1, title: i.curStatus === 'draft' ? 'Control incompleto' : 'Control pendiente', text: `${t.name}, ${plabel(cur).toLowerCase()}`, techId: t.id, href: `#control-${t.id}` }); }
  for (const a of activeAsg) {
    const s = stateOf[a.id]; if (!s) continue; const t = S.techs[a.techId]; if (!t || t.active === false) continue;
    const tn = (S.tools[a.toolId] || {}).name || 'Herramienta'; const code = a.unitId && S.units[a.unitId] ? ` (${S.units[a.unitId].code})` : '';
    if (s.state === 'faltante') alerts.push({ key: `falt-${a.id}-${s.controlId}`, type: 'faltante', sev: 3, title: 'Herramienta faltante', text: `${tn}${code}, ${t.name}${s.note ? '. ' + s.note : ''}`, techId: a.techId, asgId: a.id, at: s.at, href: `#tecnico-${a.techId}` });
    if (s.state === 'cambio') {
      const h = hist[a.id] || []; const cons = h.length >= 2 && h[h.length - 2].state === 'cambio';
      alerts.push({ key: `${cons ? 'cons' : 'camb'}-${a.id}-${s.controlId}`, type: cons ? 'consecutiva' : 'cambio', sev: cons ? 3 : 2, title: cons ? 'Dañada en controles consecutivos' : 'Para cambio, reposición pendiente', text: `${tn}${code}, ${t.name}${s.note ? '. ' + s.note : ''}`, techId: a.techId, asgId: a.id, at: s.at, href: `#tecnico-${a.techId}` });
    }
  }
  for (const m of pendingReturns) { const t = S.techs[m.techId] || {}; const tn = (S.tools[m.toolId] || {}).name || 'Herramienta'; const code = m.oldUnitId && S.units[m.oldUnitId] ? ` (${S.units[m.oldUnitId].code})` : ''; alerts.push({ key: `dev-${m.id}`, type: 'devolucion', sev: 2, title: 'Pendiente de devolución', text: `${tn}${code}, ${t.name || 'técnico'}`, techId: m.techId, movId: m.id, at: m.at, href: '#entregas' }); }
  const alertsOpen = alerts.filter((a) => !(S.alertRes || {})[a.key]).sort((a, b) => b.sev - a.sev || (b.at || '').localeCompare(a.at || ''));
  const hasDemo = DEMO_COLS.some((c) => Object.values(S[c] || {}).some((d) => d && d.demo));
  return { cur, curKey, curNum, shifts, shiftById, techs, activeTechs, cats, tools, units, unitsByTool, asgs, activeAsg, asgByTech, ctls, fin, eff, effList, effByTech, drafts, supersededBy, stateOf, hist, transitions, movs, pools, pendingReturns, techInfo, shiftInfo, kpi, alertsOpen, hasDemo };
}
