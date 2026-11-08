// Datos de demostración (equivalente a seedDemo/clearDemo de 2.1): técnicos, herramientas,
// entregas y controles de ejemplo marcados como demo. Se borran sin tocar los datos reales.
// El borrado es la única excepción al "solo agregar" del libro y de los controles finalizados,
// y la base solo la permite para filas demo dentro de esta transacción (`panol.demo_clear`);
// los movimientos los borra `demo_clear_ledger()` (SECURITY DEFINER del dueño).
import * as repo from '../adapters/pg/catalog-repo.js';
import { saveControl } from '../adapters/pg/inventory-repo.js';
import { buildControlDoc } from '../domain/controls.js';
import { DomainError } from '../domain/errors.js';
import { periodOf, prevP, pkeyOf, zonedDate, daysIn, localDateISO } from '../domain/period.js';
import { newId } from './ids.js';
import { withTransaction, record } from './common.js';
import { applyMovement } from './movements.js';
import { insertRange } from '../adapters/pg/plantilla-repo.js';

const CATS = [['el', 'Eléctricas'], ['me', 'Medición'], ['ma', 'Manuales']];
const TOOLS = [
  ['Taladro percutor', 'el', true, 'TAL', 8], ['Multímetro digital', 'me', true, 'MUL', 8], ['Pinza amperométrica', 'me', true, 'PAM', 7],
  ['Llave ajustable 10"', 'ma', false, null, 20], ['Juego de destornilladores', 'ma', false, null, 12], ['Alicate universal', 'ma', false, null, 12],
  ['Linterna LED', 'el', false, null, 10],
];
const TECHS = [['Martín Gómez', '1021', 0], ['Lucía Fernández', '1034', 0], ['Diego Álvarez', '1047', 1], ['Sofía Romero', '1052', 1], ['Javier Torres', '1068', 2], ['Carla Medina', '1073', 2]];
// Estados por técnico en los dos controles anteriores (el resto, buen estado).
const PLAN = [
  [{}, { 'Taladro percutor': { state: 'cambio', note: 'Mandril con juego' } }],
  [{}, {}],
  [{ 'Multímetro digital': { state: 'cambio', note: 'Display intermitente' } }, { 'Multímetro digital': { state: 'cambio', note: 'Display intermitente' }, 'Alicate universal': { state: 'faltante', note: 'Extraviada durante el trabajo' } }],
  [{}, { 'Linterna LED': { state: 'cambio', note: 'Desgaste por uso' } }],
  [{ 'Juego de destornilladores': { state: 'faltante', note: 'Pendiente de devolución' } }, {}],
  [{}, {}],
];

const DEMO_TABLES = ['techs', 'shift_changes', 'tech_plantilla_history', 'categories', 'tools', 'units', 'assignments', 'movements', 'controls', 'alert_resolutions'];

export async function hasDemo(q) {
  for (const t of DEMO_TABLES) if ((await q.query(`SELECT 1 FROM ${t} WHERE demo LIMIT 1`)).rows[0]) return true;
  return false;
}

export async function loadDemo(db, actor, { now = new Date() } = {}) {
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'demo');
    if (await hasDemo(c)) throw new DomainError('Ya hay datos de demostración cargados.', 'demo_loaded', 409);
    const takenCodes = new Set((await c.query('SELECT lower(code) AS c FROM units')).rows.map((r) => r.c));
    const takenLeg = new Set((await c.query('SELECT lower(btrim(legajo)) AS l FROM techs WHERE legajo IS NOT NULL')).rows.map((r) => r.l));
    const cats = {};
    for (const [k, name] of CATS) cats[k] = (await repo.insertRow(c, 'categories', newId('g'), { name, demo: true, by: actor.id })).id;
    const T = {};
    for (const [name, cat, ser, pre, n] of TOOLS) {
      const t = await repo.insertRow(c, 'tools', newId('h'), { name, description: '', categoryId: cats[cat], serialized: ser, active: true, demo: true, by: actor.id });
      T[name] = { id: t.id, ser };
      if (ser) {
        const codes = [];
        for (let i = 1; i <= n; i++) {
          const code = `${pre}-${String(i).padStart(3, '0')}`;
          codes.push(takenCodes.has(code.toLowerCase()) ? `DEMO-${code}` : code);
        }
        await applyMovement(c, actor, { type: 'ingreso', toolId: t.id, codes: codes.join('\n'), notes: 'Carga inicial (demo)' }, { demo: true });
        T[name].units = (await c.query('SELECT id FROM units WHERE tool_id = $1 ORDER BY code', [t.id])).rows.map((r) => r.id);
      } else {
        await applyMovement(c, actor, { type: 'ingreso', toolId: t.id, qty: n, notes: 'Carga inicial (demo)' }, { demo: true });
      }
    }
    const shifts = (await c.query('SELECT id FROM plantillas WHERE archived_at IS NULL ORDER BY sort_order, id')).rows.map((r) => r.id);
    const techIds = [];
    const techPl = {};
    for (const [name, leg, si] of TECHS) {
      const legajo = takenLeg.has(leg) ? `D${leg}` : leg;
      const t = await repo.insertRow(c, 'techs', newId('t'), { name, legajo, active: true, alta: localDateISO(now), demo: true, by: actor.id });
      if (shifts.length) await insertRange(c, { id: newId('ph'), techId: t.id, plantillaId: shifts[si % shifts.length], validFrom: null, validTo: null, reason: 'Alta del técnico (demo)' }, { actorId: actor.id, demo: true });
      techIds.push(t.id);
      techPl[t.id] = shifts.length ? shifts[si % shifts.length] : null;
    }
    const used = {};
    for (let ti = 0; ti < techIds.length; ti++) {
      for (const [name, , ser] of TOOLS) {
        if (name === 'Linterna LED' && ti % 2) continue;
        const t = T[name];
        const m = { type: 'entrega_inicial', techId: techIds[ti], toolId: t.id, reason: 'Ingreso del técnico' };
        if (ser) m.unitId = t.units[(used[name] = (used[name] || 0) + 1) - 1];
        else m.qty = name.startsWith('Llave') ? 2 : 1;
        await applyMovement(c, actor, m, { demo: true });
      }
    }
    // Dos controles finalizados por técnico: hace dos semanas y la semana anterior.
    const p1 = prevP(periodOf(now));
    const p2 = prevP(p1);
    const tools = Object.fromEntries(Object.entries(T).map(([name, t]) => [t.id, { name }]));
    const units = Object.fromEntries((await c.query('SELECT id, code FROM units WHERE demo')).rows.map((r) => [r.id, { code: r.code }]));
    for (let i = 0; i < techIds.length; i++) {
      const tech = { ...(await repo.getRow(c, 'techs', techIds[i])), plantillaId: techPl[techIds[i]] };
      const asgs = (await c.query('SELECT id, tool_id, unit_id, qty FROM assignments WHERE tech_id = $1 AND active', [tech.id])).rows.map((r) => ({ id: r.id, toolId: r.tool_id, unitId: r.unit_id, qty: r.qty }));
      for (const [p, over] of [[p2, PLAN[i][0]], [p1, PLAN[i][1]]]) {
        const items = Object.fromEntries(asgs.map((a) => [a.id, over[tools[a.toolId].name] || { state: 'bueno', note: '' }]));
        const doc = buildControlDoc({ tech, period: p, assignments: asgs, items, tools, units, categories: {}, status: 'finalizado' });
        const at = zonedDate(p.y, p.m, Math.min((p.w - 1) * 7 + 3, daysIn(p.y, p.m)), 10, 30);
        await saveControl(c, `c-${tech.id}-${pkeyOf(p)}`, doc, { actorId: actor.id, startedAt: at, finishedAt: at, demo: true });
      }
    }
    await record(c, actor, { action: 'demo_load', entity: 'system', id: 'demo', event: 'reload', detail: 'Carga de datos de demostración' });
    return { ok: true, techs: techIds.length, tools: TOOLS.length };
  });
}

export async function clearDemo(db, actor) {
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'demo');
    await c.query("SELECT set_config('panol.demo_clear', 'on', true)");
    const demoTechs = "SELECT id FROM techs WHERE demo";
    const demoTools = "SELECT id FROM tools WHERE demo";
    const realLedger = (await c.query(
      `SELECT (SELECT count(*) FROM movements WHERE NOT demo AND (tech_id IN (${demoTechs}) OR tool_id IN (${demoTools})))
            + (SELECT count(*) FROM controls WHERE NOT demo AND tech_id IN (${demoTechs})) AS n`,
    )).rows[0].n;
    if (realLedger > 0) {
      throw new DomainError('Hay movimientos o controles reales hechos sobre datos de demostración: no se pueden borrar sin perder historial.', 'demo_in_use', 409);
    }
    const del = async (sql) => (await c.query(sql)).rowCount;
    const n = {};
    n.controlItems = await del('DELETE FROM control_items WHERE control_id IN (SELECT id FROM controls WHERE demo)');
    n.controls = await del('DELETE FROM controls WHERE demo');
    // El rol de la app no puede borrar del libro: lo hace una función del dueño, solo para demo.
    n.movements = (await c.query('SELECT demo_clear_ledger() AS n')).rows[0].n;
    n.assignments = await del(`DELETE FROM assignments WHERE demo OR tech_id IN (${demoTechs}) OR tool_id IN (${demoTools})`);
    n.units = await del(`DELETE FROM units WHERE demo OR tool_id IN (${demoTools})`);
    n.shiftChanges = await del(`DELETE FROM shift_changes WHERE demo OR tech_id IN (${demoTechs})`);
    // Pertenencia a plantillas: los rangos de técnicos demo son demo (el trigger solo deja borrar esos).
    n.plantillaHistory = await del('DELETE FROM tech_plantilla_history WHERE demo');
    n.alertRes = await del(`DELETE FROM alert_resolutions WHERE demo OR tech_id IN (${demoTechs})`);
    n.techs = await del('DELETE FROM techs WHERE demo');
    n.tools = await del('DELETE FROM tools WHERE demo');
    n.categories = await del('DELETE FROM categories WHERE demo');
    await record(c, actor, { action: 'demo_clear', entity: 'system', id: 'demo', event: 'reload', detail: `Borrado de datos de demostración (${n.techs} técnicos, ${n.tools} herramientas, ${n.movements} movimientos, ${n.controls} controles)` });
    return { ok: true, deleted: n };
  });
}
