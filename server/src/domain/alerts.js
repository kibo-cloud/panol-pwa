// Alertas derivadas (portado de derive() de 2.1). Una alerta resuelta (alertRes[key]) no se
// muestra; como la clave incluye el control o movimiento, un control nuevo la vuelve a abrir.
import { periodOf, pkeyOf, plabel } from './period.js';
import { effectiveControls, controlHistory } from './controls.js';

// data: { now, techs, tools, units, assignments, controls: [], movements: [], alertRes }
export function deriveAlerts(data) {
  const cur = periodOf(data.now || new Date());
  const curKey = pkeyOf(cur);
  const { eff, effList, drafts } = effectiveControls(data.controls || []);
  const { stateOf, hist } = controlHistory(effList);
  const activeAsg = Object.entries(data.assignments || {}).filter(([, a]) => a.active).map(([id, a]) => ({ id, ...a }));
  const alerts = [];

  for (const [tid, t] of Object.entries(data.techs || {})) {
    if (t.active === false) continue;
    const lines = activeAsg.filter((a) => a.techId === tid).length;
    const done = !!eff[tid + '|' + curKey];
    const draft = !!drafts[tid + '|' + curKey];
    if (!done && lines) {
      alerts.push({ key: `pend-${tid}-${curKey}`, type: 'pendiente', sev: 1, title: draft ? 'Control incompleto' : 'Control pendiente', text: `${t.name}, ${plabel(cur).toLowerCase()}`, techId: tid });
    }
  }

  for (const a of activeAsg) {
    const s = stateOf[a.id];
    if (!s) continue;
    const t = data.techs[a.techId];
    if (!t || t.active === false) continue;
    const tn = (data.tools[a.toolId] || {}).name || 'Herramienta';
    const code = a.unitId && data.units[a.unitId] ? ` (${data.units[a.unitId].code})` : '';
    const text = `${tn}${code}, ${t.name}${s.note ? '. ' + s.note : ''}`;
    if (s.state === 'faltante') alerts.push({ key: `falt-${a.id}-${s.controlId}`, type: 'faltante', sev: 3, title: 'Herramienta faltante', text, techId: a.techId, asgId: a.id, at: s.at });
    if (s.state === 'cambio') {
      const h = hist[a.id] || [];
      const cons = h.length >= 2 && h[h.length - 2].state === 'cambio';
      alerts.push({ key: `${cons ? 'cons' : 'camb'}-${a.id}-${s.controlId}`, type: cons ? 'consecutiva' : 'cambio', sev: cons ? 3 : 2, title: cons ? 'Dañada en controles consecutivos' : 'Para cambio, reposición pendiente', text, techId: a.techId, asgId: a.id, at: s.at });
    }
  }

  const movs = data.movements || [];
  const resolvedRecv = new Set(movs.filter((m) => m.type === 'recepcion' && m.resolvesMovementId).map((m) => m.resolvesMovementId));
  for (const m of pendingReturns(movs, resolvedRecv)) {
    const t = data.techs[m.techId] || {};
    const tn = (data.tools[m.toolId] || {}).name || 'Herramienta';
    const code = m.oldUnitId && data.units[m.oldUnitId] ? ` (${data.units[m.oldUnitId].code})` : '';
    alerts.push({ key: `dev-${m.id}`, type: 'devolucion', sev: 2, title: 'Pendiente de devolución', text: `${tn}${code}, ${t.name || 'técnico'}`, techId: m.techId, movId: m.id, at: m.at });
  }

  const res = data.alertRes || {};
  return alerts.filter((a) => !res[a.key]).sort((a, b) => b.sev - a.sev || (b.at || '').localeCompare(a.at || ''));
}

// Reposiciones sin devolver que todavía no se recibieron.
export function pendingReturns(movements, resolved) {
  const r = resolved || new Set(movements.filter((m) => m.type === 'recepcion' && m.resolvesMovementId).map((m) => m.resolvesMovementId));
  return movements.filter((m) => m.type === 'reposicion' && m.returned === false && !r.has(m.id));
}
