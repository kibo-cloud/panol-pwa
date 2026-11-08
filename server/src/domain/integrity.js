// Verificación de integridad (portado de integrity() de 2.1): compara asignaciones, unidades e
// inventario. Recibe el resultado de deriveState().
import { POOL } from './constants.js';

const KEYS = ['disponible', 'asignado', 'reparacion', 'retirado', 'pendiente', 'baja'];

export function integrityIssues(d) {
  const out = [];
  const techById = Object.fromEntries(d.techs.map((t) => [t.id, t]));
  const toolById = Object.fromEntries(d.tools.map((t) => [t.id, t]));
  const toolName = (id) => (toolById[id] || {}).name || 'Herramienta eliminada';
  for (const t of d.tools) {
    const p = d.pools[t.id];
    const asg = d.activeAsg.filter((a) => a.toolId === t.id).reduce((s, a) => s + (a.qty || 1), 0);
    if (p.asignado !== asg) out.push({ sev: 'bad', t: `${t.name}: asignaciones no coinciden`, s: `Inventario indica ${p.asignado} asignadas y las fichas de técnicos suman ${asg}.` });
    for (const k of KEYS) if (p[k] < 0) out.push({ sev: 'bad', t: `${t.name}: saldo negativo`, s: `${POOL[k]}: ${p[k]}` });
    if (t.serialized) {
      for (const k of KEYS) {
        const n = (d.unitsByTool[t.id] || []).filter((u) => u.status === k).length;
        if (n !== p[k]) out.push({ sev: 'warn', t: `${t.name}: unidades y movimientos difieren`, s: `${POOL[k]}: ${n} unidades contra ${p[k]} según movimientos.` });
      }
    }
  }
  const codes = {};
  for (const u of d.units) {
    const c = (u.code || '').toLowerCase();
    if (codes[c]) out.push({ sev: 'bad', t: 'Código duplicado', s: u.code });
    codes[c] = 1;
  }
  for (const a of d.activeAsg) {
    const t = techById[a.techId];
    if (!t) out.push({ sev: 'bad', t: 'Asignación sin técnico', s: toolName(a.toolId) });
    else if (t.active === false) out.push({ sev: 'warn', t: `${t.name} está inactivo y tiene herramientas`, s: `${toolName(a.toolId)}: registrá la devolución o el retiro.` });
  }
  return out;
}
