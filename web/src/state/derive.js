// Datos derivados para las vistas (puro): el mismo cálculo de 2.1 sobre el estado que manda
// GET /api/state. El período actual lo decide el servidor (hora de Buenos Aires).
// Etapa 2: plantillas (en lugar de turnos) y cajas compartidas. El poseedor de una asignación
// o un control se identifica con una clave: `<techId>` o `caja:<cajaId>` (como el servidor).
import { pkeyOf, pnumOf, plabel, periodOf } from './period.js';
import { holderKey } from './plantillas.js';
import { sortByOrder, orderTools } from './orden.js';

export function groupBy(arr, k) { const o = {}; for (const x of arr) { const key = typeof k === 'function' ? k(x) : x[k]; (o[key] || (o[key] = [])).push(x); } return o; }
const list = (o) => Object.entries(o || {}).map(([id, x]) => ({ id, ...x }));
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'es');
const DEMO_COLS = ['techs', 'shiftChanges', 'categories', 'tools', 'units', 'assignments', 'controls', 'movements', 'alertRes'];

// Enlace de una alerta: la ficha del poseedor, o el control si está pendiente.
function alertHref(a) {
  const hk = holderKey(a);
  if (a.type === 'pendiente') return `#control-${hk}`;
  if (a.type === 'devolucion') return '#entregas';
  return a.cajaId ? `#caja-${a.cajaId}` : `#tecnico-${a.techId}`;
}

export function deriveState(S) {
  const cur = (S.derived && S.derived.cur) || periodOf();
  const curKey = pkeyOf(cur), curNum = pnumOf(cur);
  // Plantillas: todas (también archivadas, para el historial) y las activas en orden.
  const allPl = list(S.plantillas);
  const plSource = allPl.length ? allPl.filter((p) => !p.archivedAt) : (S.shifts || []);
  const shifts = plSource.slice().sort((a, b) => (a.order || 0) - (b.order || 0) || byName(a, b));
  const shiftById = Object.fromEntries(shifts.map((s) => [s.id, s]));
  const plantillaById = { ...Object.fromEntries(allPl.map((p) => [p.id, p])), ...shiftById };
  const archivedPlantillas = allPl.filter((p) => p.archivedAt).sort(byName);
  const techs = list(S.techs).sort(byName);
  const activeTechs = techs.filter((t) => t.active !== false);
  const lineas = list(S.lineas).sort((a, b) => (a.order || 0) - (b.order || 0) || byName(a, b));
  const cajas = list(S.cajas).sort(byName);
  const activeCajas = cajas.filter((k) => !k.archivedAt);
  // Orden personalizado (etapa 3): categorías y herramientas como en la caja física.
  const cats = sortByOrder(list(S.categories));
  const tools = orderTools(list(S.tools), cats);
  const toolRank = Object.fromEntries(tools.map((t, i) => [t.id, i]));
  const especialidades = sortByOrder(list(S.especialidades));
  const kits = list(S.kits).sort((a, b) => (a.especialidadId ? 1 : 0) - (b.especialidadId ? 1 : 0) || byName(a, b));
  const units = list(S.units).sort((a, b) => (a.code || '').localeCompare(b.code || '', 'es', { numeric: true }));
  const unitsByTool = groupBy(units, 'toolId');
  const asgs = list(S.assignments);
  const activeAsg = asgs.filter((a) => a.active);
  // Asignaciones por poseedor (técnico o `caja:<id>`).
  const asgByTech = groupBy(activeAsg, holderKey);
  const tname = (id) => ((S.tools[id] || {}).name || '');
  for (const k in asgByTech) asgByTech[k].sort((a, b) => (toolRank[a.toolId] ?? 1e9) - (toolRank[b.toolId] ?? 1e9) || tname(a.toolId).localeCompare(tname(b.toolId), 'es'));
  const ctls = list(S.controls).map((c) => ({ ...c, hk: holderKey(c) }));
  const fin = ctls.filter((c) => c.status === 'finalizado');
  const eff = {};
  for (const c of fin) { const k = c.hk + '|' + c.pkey; if (!eff[k] || (eff[k].finishedAt || '') < (c.finishedAt || '')) eff[k] = c; }
  const effList = Object.values(eff).sort((a, b) => a.pnum - b.pnum || (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  const effByTech = groupBy(effList, 'hk');
  const drafts = {};
  for (const c of ctls) if (c.status === 'borrador') { const k = c.hk + '|' + c.pkey; if (!drafts[k] || (drafts[k].updatedAt || '') < (c.updatedAt || '')) drafts[k] = c; }
  const supersededBy = {}; for (const c of fin) if (c.supersedes) supersededBy[c.supersedes] = c.id;
  // historial de estados por asignación
  const stateOf = {}, hist = {}, transitions = [];
  for (const c of effList) {
    for (const [aid, it] of Object.entries(c.items || {})) {
      if (!it || !it.state) continue;
      const prev = stateOf[aid];
      (hist[aid] || (hist[aid] = [])).push({ state: it.state, controlId: c.id, pkey: c.pkey, pnum: c.pnum });
      const ps = prev ? prev.state : null;
      if (ps !== it.state && (it.state !== 'bueno' || ps)) transitions.push({ techId: c.techId, cajaId: c.cajaId || null, hk: c.hk, asgId: aid, toolId: it.toolId, toolName: it.toolName, unitCode: it.unitCode, from: ps, to: it.state, pkey: c.pkey, pnum: c.pnum, at: c.finishedAt, controlId: c.id, note: it.note });
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
  // resumen por poseedor (técnicos y cajas comparten la forma)
  const emptySum = () => ({ bueno: 0, cambio: 0, faltante: 0, pendiente: 0, total: 0 });
  const infoOf = (hk) => {
    const l = asgByTech[hk] || []; const s = emptySum();
    for (const a of l) { const st = (stateOf[a.id] && stateOf[a.id].state) || 'pendiente'; const q = a.qty || 1; s[st] += q; s.total += q; }
    const curEff = eff[hk + '|' + curKey], curDraft = drafts[hk + '|' + curKey];
    s.curStatus = curEff ? 'done' : curDraft ? 'draft' : 'pend';
    s.light = !s.total ? 'pend' : s.faltante ? 'bad' : s.cambio ? 'warn' : s.pendiente ? 'pend' : 'ok';
    s.lines = l.length;
    const last = (effByTech[hk] || [])[(effByTech[hk] || []).length - 1];
    s.lastAt = last ? last.finishedAt : null;
    return s;
  };
  const techInfo = {};
  for (const t of techs) techInfo[t.id] = infoOf(t.id);
  const cajaInfo = {};
  for (const k of cajas) { cajaInfo[k.id] = infoOf('caja:' + k.id); techInfo['caja:' + k.id] = cajaInfo[k.id]; }
  const sumOf = (ts) => { const s = emptySum(); for (const t of ts) { const i = techInfo[t.id]; for (const k of ['bueno', 'cambio', 'faltante', 'pendiente', 'total']) s[k] += i[k]; } return s; };
  // alertas: las calcula el servidor (técnicos y cajas); acá solo se agrega el enlace.
  let alerts;
  if (S.derived && Array.isArray(S.derived.alerts)) alerts = S.derived.alerts.map((a) => ({ ...a, href: alertHref(a) }));
  else {
    alerts = [];
    for (const t of activeTechs) { const i = techInfo[t.id]; if (i.curStatus !== 'done' && i.lines) alerts.push({ key: `pend-${t.id}-${curKey}`, type: 'pendiente', sev: 1, title: i.curStatus === 'draft' ? 'Control incompleto' : 'Control pendiente', text: `${t.name}, ${plabel(cur).toLowerCase()}`, techId: t.id }); }
    alerts = alerts.map((a) => ({ ...a, href: alertHref(a) }));
  }
  const alertsOpen = alerts.filter((a) => !(S.alertRes || {})[a.key]).sort((a, b) => b.sev - a.sev || (b.at || '').localeCompare(a.at || ''));
  const alertsByPlantilla = {};
  for (const a of alertsOpen) { const k = a.cajaId ? 'cajas' : ((S.techs[a.techId] || {}).plantillaId ?? (S.techs[a.techId] || {}).shiftId ?? null); (alertsByPlantilla[k] || (alertsByPlantilla[k] = [])).push(a); }
  const shiftInfo = {};
  for (const s of shifts) {
    const ts = activeTechs.filter((t) => t.shiftId === s.id); const sum = sumOf(ts);
    const lastAt = ts.map((t) => techInfo[t.id].lastAt).filter(Boolean).sort().pop() || null;
    shiftInfo[s.id] = { techs: ts.length, tools: sum.total, sum, done: ts.filter((t) => techInfo[t.id].curStatus === 'done').length, draft: ts.filter((t) => techInfo[t.id].curStatus === 'draft').length, alerts: (alertsByPlantilla[s.id] || []).length, lastAt };
  }
  const all = sumOf(activeTechs);
  const kpi = { techs: activeTechs.length, tools: all.total, bueno: all.bueno, cambio: all.cambio, faltante: all.faltante, pendiente: all.pendiente, pendCtl: activeTechs.filter((t) => techInfo[t.id].curStatus !== 'done').length, ctlMonth: effList.filter((c) => !c.cajaId && c.period && c.period.y === cur.y && c.period.m === cur.m).length };
  const my = (S.derived && S.derived.myPlantilla) || { plantillaIds: [], techIds: [], alertKeys: [] };
  const myPlantilla = { plantillaIds: my.plantillaIds.filter((id) => shiftById[id]), techIds: my.techIds || [], alertKeys: new Set(my.alertKeys || []) };
  const hasDemo = DEMO_COLS.some((c) => Object.values(S[c] || {}).some((d) => d && d.demo));
  return { especialidades, kits, toolRank, cur, curKey, curNum, shifts, plantillas: shifts, shiftById, plantillaById, archivedPlantillas, techs, activeTechs, lineas, cajas, activeCajas, cats, tools, units, unitsByTool, asgs, activeAsg, asgByTech, ctls, fin, eff, effList, effByTech, drafts, supersededBy, stateOf, hist, transitions, movs, pools, pendingReturns, techInfo, cajaInfo, shiftInfo, kpi, alertsOpen, alertsByPlantilla, myPlantilla, hasDemo };
}
