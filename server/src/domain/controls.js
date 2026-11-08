// Controles semanales (portado de derive/ckDoc/ckFinish de 2.1).
import { pkeyOf, pnumOf } from './period.js';

// Control efectivo por técnico y período: el finalizado más reciente (una corrección gana al
// original). También el borrador más reciente y qué control reemplaza a cuál.
export function effectiveControls(controls) {
  const eff = {};
  const drafts = {};
  const supersededBy = {};
  for (const c of controls) {
    const k = c.techId + '|' + c.pkey;
    if (c.status === 'finalizado') {
      if (!eff[k] || (eff[k].finishedAt || '') < (c.finishedAt || '')) eff[k] = c;
      if (c.supersedes) supersededBy[c.supersedes] = c.id;
    } else if (c.status === 'borrador') {
      if (!drafts[k] || (drafts[k].updatedAt || '') < (c.updatedAt || '')) drafts[k] = c;
    }
  }
  const effList = Object.values(eff).sort((a, b) => a.pnum - b.pnum || (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  return { eff, effList, drafts, supersededBy };
}

// Historial de estados por asignación a partir de los controles efectivos, en orden.
// Una transición es un cambio de estado; el primer "bueno" no cuenta como transición.
export function controlHistory(effList) {
  const stateOf = {};
  const hist = {};
  const transitions = [];
  for (const c of effList) {
    for (const [aid, it] of Object.entries(c.items || {})) {
      if (!it || !it.state) continue;
      const prev = stateOf[aid];
      (hist[aid] || (hist[aid] = [])).push({ state: it.state, controlId: c.id, pkey: c.pkey, pnum: c.pnum });
      const ps = prev ? prev.state : null;
      if (ps !== it.state && (it.state !== 'bueno' || ps)) {
        transitions.push({ techId: c.techId, asgId: aid, toolId: it.toolId, toolName: it.toolName, unitCode: it.unitCode, from: ps, to: it.state, pkey: c.pkey, pnum: c.pnum, at: c.finishedAt, controlId: c.id, note: it.note });
      }
      stateOf[aid] = { state: it.state, note: it.note || '', controlId: c.id, at: c.finishedAt, pkey: c.pkey };
    }
  }
  return { stateOf, hist, transitions };
}

// Para finalizar: cada asignación activa del técnico tiene estado y todo faltante tiene nota.
export function validateFinalize(activeAssignments, items) {
  const pending = [];
  const missingNote = [];
  for (const a of activeAssignments) {
    const it = items[a.id];
    if (!it || !it.state) pending.push(a.id);
    else if (it.state === 'faltante' && !String(it.note || '').trim()) missingNote.push(a.id);
  }
  return { ok: !pending.length && !missingNote.length, pending, missingNote };
}

// Documento del control: copia nombre, categoría y código al momento del control, y cuenta
// por cantidad. Solo entran las asignaciones activas que tienen estado. `plantillaId` es la
// plantilla del técnico al hacerse el control (foto para los informes); `shiftId` la repite
// por compatibilidad con 2.1.
export function buildControlDoc({ tech, period, assignments, items, tools, units, categories, status, correctionOf = null }) {
  const out = {};
  const counts = { bueno: 0, cambio: 0, faltante: 0 };
  for (const a of assignments) {
    const it = items[a.id];
    if (!it || !it.state) continue;
    const u = a.unitId && units[a.unitId];
    const tool = tools[a.toolId] || {};
    const cat = tool.categoryId && categories[tool.categoryId];
    out[a.id] = {
      state: it.state,
      note: String(it.note || '').trim(),
      toolId: a.toolId,
      toolName: tool.name || '',
      category: cat ? cat.name : '',
      unitId: a.unitId || null,
      unitCode: u ? u.code : null,
      qty: a.qty || 1,
    };
    counts[it.state] += a.qty || 1;
  }
  return {
    techId: tech.id,
    techName: tech.name || '',
    shiftId: tech.plantillaId ?? tech.shiftId ?? null,
    plantillaId: tech.plantillaId ?? tech.shiftId ?? null,
    period: { y: period.y, m: period.m, w: period.w },
    pkey: pkeyOf(period),
    pnum: pnumOf(period),
    status,
    items: out,
    counts,
    correction: !!correctionOf,
    supersedes: correctionOf || null,
  };
}
