import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../../src/domain/derive.js';
import { computeReport } from '../../src/domain/report.js';
import { integrityIssues } from '../../src/domain/integrity.js';

// Datos inventados: hoy es la semana 3 de marzo de 2026.
const NOW = new Date('2026-03-18T15:00:00.000Z');
const tr = (toolId, qty, from, to, unitId = null) => ({ toolId, qty, from, to, unitId });

function fixture() {
  return {
    shifts: [{ id: 'tarde', name: 'Turno tarde', order: 2 }, { id: 'manana', name: 'Turno mañana', order: 1 }],
    techs: {
      tA: { name: 'Ana Prueba', legajo: '1', shiftId: 'manana', active: true },
      tB: { name: 'Beto Ejemplo', legajo: '2', shiftId: 'tarde', active: true },
    },
    tools: { pinza: { name: 'Pinza', serialized: false }, taladro: { name: 'Taladro', serialized: true } },
    units: { u1: { toolId: 'taladro', code: 'TAL-001', status: 'asignado', techId: 'tA' } },
    assignments: {
      a1: { techId: 'tA', toolId: 'pinza', qty: 2, active: true },
      a2: { techId: 'tA', toolId: 'taladro', unitId: 'u1', qty: 1, active: true },
    },
    controls: {
      c1: { techId: 'tA', period: { y: 2026, m: 3, w: 1 }, status: 'finalizado', finishedAt: '2026-03-03T13:00:00.000Z', counts: { bueno: 0, cambio: 2, faltante: 1 }, items: { a1: { state: 'cambio', toolId: 'pinza' }, a2: { state: 'faltante', note: 'No está', toolId: 'taladro' } } },
      c2: { techId: 'tA', period: { y: 2026, m: 3, w: 2 }, status: 'finalizado', finishedAt: '2026-03-10T13:00:00.000Z', counts: { bueno: 1, cambio: 2, faltante: 0 }, items: { a1: { state: 'cambio', toolId: 'pinza' }, a2: { state: 'bueno', toolId: 'taladro' } } },
      d1: { techId: 'tB', period: { y: 2026, m: 3, w: 3 }, status: 'borrador', items: {} },
    },
    movements: {
      m1: { type: 'ingreso', toolId: 'pinza', at: '2026-02-01T12:00:00.000Z', transfers: [tr('pinza', 5, 'externo', 'disponible')] },
      m2: { type: 'ingreso', toolId: 'taladro', at: '2026-02-01T12:00:00.000Z', transfers: [tr('taladro', 1, 'externo', 'disponible', 'u1')] },
      m3: { type: 'entrega_inicial', techId: 'tA', toolId: 'pinza', at: '2026-02-02T12:00:00.000Z', transfers: [tr('pinza', 2, 'disponible', 'asignado')] },
      m4: { type: 'entrega_inicial', techId: 'tA', toolId: 'taladro', at: '2026-02-02T12:00:00.000Z', transfers: [tr('taladro', 1, 'disponible', 'asignado', 'u1')] },
      m5: { type: 'reposicion', techId: 'tA', toolId: 'pinza', returned: true, at: '2026-03-15T15:00:00.000Z', transfers: [] },
    },
  };
}

test('deriveState: turnos ordenados, inventario, resumen por técnico y KPI', () => {
  const d = deriveState(fixture(), { now: NOW });
  assert.deepEqual(d.shifts.map((s) => s.id), ['manana', 'tarde']);
  assert.equal(d.curKey, '2026-03-3');
  assert.deepEqual({ ...d.pools.pinza }, { disponible: 3, asignado: 2, reparacion: 0, retirado: 0, pendiente: 0, baja: 0, externo: -5 });
  assert.equal(d.techInfo.tA.total, 3);
  assert.equal(d.techInfo.tA.cambio, 2);
  assert.equal(d.techInfo.tA.light, 'warn');
  assert.equal(d.techInfo.tA.curStatus, 'pend');
  assert.equal(d.techInfo.tB.curStatus, 'draft');
  assert.equal(d.kpi.ctlMonth, 2);
  assert.equal(d.shiftInfo.manana.tools, 3);
});

test('computeReport: mes completo, por técnico y por turno', () => {
  const d = deriveState(fixture(), { now: NOW });
  const R = computeReport(d, { ym: '2026-03' });
  const a = R.rows.find((r) => r.id === 'tA');
  assert.deepEqual(
    { bueno: a.bueno, cambio: a.cambio, faltante: a.faltante, pct: a.pct, ctl: a.ctl, expected: a.expected, repos: a.repos, recup: a.recup, total: a.total, fromControl: a.fromControl },
    { bueno: 1, cambio: 2, faltante: 0, pct: 33, ctl: 2, expected: 3, repos: 1, recup: 1, total: 3, fromControl: true },
  );
  const b = R.rows.find((r) => r.id === 'tB');
  assert.equal(b.pct, null);
  assert.equal(b.fromControl, false);
  assert.deepEqual(R.shifts.map((s) => [s.id, s.ctl, s.pend]), [['manana', 2, 1], ['tarde', 0, 3]]);
  assert.equal(R.label, 'marzo 2026');
  // Etapa 4: limpieza (estos controles viejos no tienen dato).
  assert.deepEqual(R.totals, { techs: 2, total: 3, bueno: 1, cambio: 2, faltante: 0, pct: 33, repos: 1, limpio: 0, sucio: 0, pctLimpio: null });
  const last = R.evo[R.evo.length - 1];
  assert.deepEqual([last.label, last.ctl, last.cambio, last.repos, last.recup], ['mar 26', 2, 2, 1, 1]);
  assert.equal(R.evo.length, 6);
});

test('computeReport: filtros de semana, turno y técnico', () => {
  const d = deriveState(fixture(), { now: NOW });
  const R = computeReport(d, { ym: '2026-03', w: '1', shift: 'manana', tech: 'tA' });
  assert.equal(R.rows.length, 1);
  const a = R.rows[0];
  assert.deepEqual([a.bueno, a.cambio, a.faltante, a.pct, a.ctl, a.expected, a.repos, a.recup], [0, 2, 1, 0, 1, 1, 0, 0]);
  assert.equal(R.label, 'Semana 1 de marzo 2026, Turno mañana, Ana Prueba');
  assert.deepEqual(R.shifts.map((s) => s.id), ['manana']);
});

test('integrityIssues: sin problemas, y detecta inactivo con herramientas y códigos repetidos', () => {
  assert.deepEqual(integrityIssues(deriveState(fixture(), { now: NOW })), []);
  const S = fixture();
  S.techs.tA.active = false;
  S.units.u2 = { toolId: 'taladro', code: 'tal-001', status: 'disponible' };
  const issues = integrityIssues(deriveState(S, { now: NOW }));
  const titles = issues.map((i) => i.t);
  assert.ok(titles.includes('Código duplicado'));
  assert.ok(titles.includes('Ana Prueba está inactivo y tiene herramientas'));
  assert.ok(titles.includes('Taladro: unidades y movimientos difieren'));
});
