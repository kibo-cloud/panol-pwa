// Etapa 8: existencia por técnico (RESUMEN del Excel), días desde el último control efectivo y la
// alerta "Sin control hace N días".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../../src/domain/derive.js';
import { deriveAlerts } from '../../src/domain/alerts.js';
import { localDaysSince, controlAge, lastControlByHolder, firstActiveSince, isOverdue, buildExistencia, cleanOverdueDays, DEFAULT_CONTROL_OVERDUE_DAYS } from '../../src/domain/existencia.js';

// Hoy (hora de Buenos Aires): miércoles 18 de marzo de 2026, 12:00.
const NOW = new Date('2026-03-18T15:00:00.000Z');
const tr = (toolId, qty, from, to, unitId = null) => ({ toolId, qty, from, to, unitId });
const fin = (id, holder, period, finishedAt, items) => ({ ...holder, period, status: 'finalizado', finishedAt, counts: { bueno: 0, cambio: 0, faltante: 0 }, items });
const it = (toolId, expected, good, change, missing) => ({ toolId, state: missing ? 'faltante' : change ? 'cambio' : 'bueno', expected, qty: expected, good, change, missing });

function fixture() {
  return {
    shifts: [{ id: 'manana', name: 'Mañana', order: 1 }, { id: 'tarde', name: 'Tarde', order: 2 }],
    plantillas: { manana: { name: 'Mañana', order: 1 }, tarde: { name: 'Tarde', order: 2 } },
    especialidades: { e1: { name: 'Mecánico', order: 1 } },
    techs: {
      tA: { name: 'Ana', legajo: '10', shiftId: 'manana', plantillaId: 'manana', especialidadId: 'e1', active: true },
      tB: { name: 'Beto', legajo: '20', shiftId: 'tarde', plantillaId: 'tarde', active: true },
      tC: { name: 'Ciro', legajo: '30', shiftId: 'manana', plantillaId: 'manana', active: true },
      tX: { name: 'Xenia', legajo: '90', shiftId: 'manana', plantillaId: 'manana', active: false, archivedAt: '2026-03-01T12:00:00.000Z' },
    },
    cajas: { k1: { name: 'Caja L1', lineaId: 'l1' }, k9: { name: 'Caja vieja', archivedAt: '2026-02-01T12:00:00.000Z' } },
    categories: { cat: { name: 'Manuales', order: 1 } },
    tools: {
      llave: { name: 'Llave', categoryId: 'cat', order: 2, serialized: false },
      pinza: { name: 'Pinza', categoryId: 'cat', order: 1, serialized: false },
      taladro: { name: 'Taladro', categoryId: 'cat', order: 3, serialized: true },
      vieja: { name: 'Vieja', categoryId: 'cat', order: 4, active: false, archivedAt: '2026-02-01T12:00:00.000Z' },
    },
    units: { u1: { toolId: 'taladro', code: 'TAL-1' }, u2: { toolId: 'taladro', code: 'TAL-2' } },
    assignments: {
      a1: { techId: 'tA', toolId: 'llave', qty: 5, active: true, since: '2026-02-01T12:00:00.000Z' },
      a2: { techId: 'tA', toolId: 'taladro', unitId: 'u1', qty: 1, active: true, since: '2026-02-01T12:00:00.000Z' },
      a3: { techId: 'tA', toolId: 'taladro', unitId: 'u2', qty: 1, active: true, since: '2026-02-01T12:00:00.000Z' },
      a4: { techId: 'tB', toolId: 'pinza', qty: 2, active: true, since: '2026-02-20T12:00:00.000Z' },
      a5: { cajaId: 'k1', toolId: 'llave', qty: 1, active: true, since: '2026-03-01T12:00:00.000Z' },
      a6: { techId: 'tX', toolId: 'pinza', qty: 1, active: true, since: '2026-01-01T12:00:00.000Z' },
      a7: { techId: 'tA', toolId: 'vieja', qty: 1, active: true, since: '2026-01-01T12:00:00.000Z' },
      a8: { techId: 'tA', toolId: 'pinza', qty: 3, active: false, since: '2026-01-01T12:00:00.000Z' },
      // Entregada después del último control de Ana: suma en la celda, sin marcas.
      a9: { techId: 'tA', toolId: 'pinza', qty: 1, active: true, since: '2026-03-12T12:00:00.000Z' },
    },
    controls: {
      // Corregido por c2 (mismo período): no es el vigente.
      c1: fin('c1', { techId: 'tA' }, { y: 2026, m: 3, w: 2 }, '2026-03-09T15:00:00.000Z', { a1: it('llave', 5, 0, 0, 5), a2: it('taladro', 1, 1, 0, 0), a3: it('taladro', 1, 1, 0, 0) }),
      // Finalizado el 9 de marzo a las 23:30 de Buenos Aires (10 de marzo en UTC).
      c2: { ...fin('c2', { techId: 'tA' }, { y: 2026, m: 3, w: 2 }, '2026-03-10T02:30:00.000Z', { a1: it('llave', 5, 2, 2, 1), a2: it('taladro', 1, 0, 1, 0), a3: it('taladro', 1, 0, 0, 1), a7: it('vieja', 1, 0, 0, 1) }), supersedes: 'c1', correction: true },
      c3: fin('c3', { techId: 'tA' }, { y: 2026, m: 2, w: 4 }, '2026-02-25T15:00:00.000Z', { a1: it('llave', 5, 5, 0, 0) }),
      d1: { techId: 'tC', period: { y: 2026, m: 3, w: 3 }, status: 'borrador', items: {} },
    },
    movements: {
      m1: { type: 'ingreso', toolId: 'llave', at: '2026-01-01T12:00:00.000Z', transfers: [tr('llave', 10, 'externo', 'disponible'), tr('llave', 6, 'disponible', 'asignado')] },
      m2: { type: 'ingreso', toolId: 'pinza', at: '2026-01-01T12:00:00.000Z', transfers: [tr('pinza', 7, 'externo', 'disponible'), tr('pinza', 4, 'disponible', 'asignado')] },
    },
  };
}

test('días desde: fecha local de Buenos Aires, nunca negativos, sin fecha = null', () => {
  // 9 de marzo 23:30 local -> 18 de marzo: 9 días (con la fecha UTC serían 8).
  assert.equal(localDaysSince('2026-03-10T02:30:00.000Z', NOW), 9);
  // A las 22:00 del 18 local ya es 19 en UTC: siguen siendo 9 días.
  assert.equal(localDaysSince('2026-03-10T02:30:00.000Z', new Date('2026-03-19T01:00:00.000Z')), 9);
  assert.equal(localDaysSince('2026-03-18T03:00:00.000Z', NOW), 0);
  assert.equal(localDaysSince('2026-03-20T12:00:00.000Z', NOW), 0);
  assert.equal(localDaysSince(null, NOW), null);
  assert.equal(localDaysSince('no es fecha', NOW), null);
  // Cambio de mes y año bisiesto.
  assert.equal(localDaysSince('2024-02-28T15:00:00.000Z', new Date('2024-03-01T15:00:00.000Z')), 2);
});

test('último control vigente por poseedor y primera entrega activa', () => {
  const d = deriveState(fixture(), { now: NOW });
  const last = lastControlByHolder(d.effList);
  assert.equal(last.tA.id, 'c2');
  assert.equal(last.tB, undefined);
  const first = firstActiveSince(d.activeAsg);
  assert.equal(first.tA, '2026-01-01T12:00:00.000Z');
  assert.equal(first['caja:k1'], '2026-03-01T12:00:00.000Z');
  assert.deepEqual(controlAge(last.tA, first.tA, NOW), { lastControlId: 'c2', lastControlAt: '2026-03-10T02:30:00.000Z', never: false, from: '2026-03-10T02:30:00.000Z', days: 9 });
  // Sin controles: cuenta desde la primera entrega activa.
  assert.deepEqual(controlAge(undefined, first.tB, NOW), { lastControlId: null, lastControlAt: null, never: true, from: '2026-02-20T12:00:00.000Z', days: 26 });
  assert.deepEqual(controlAge(undefined, undefined, NOW), { lastControlId: null, lastControlAt: null, never: true, from: null, days: null });
  assert.equal(isOverdue({ days: 15 }, 14), true);
  assert.equal(isOverdue({ days: 14 }, 14), false);
  assert.equal(isOverdue({ days: 99 }, 0), false);
  assert.equal(isOverdue({ days: null }, 14), false);
});

test('umbral: entero de 0 a 365 (0 desactiva), 14 por defecto', () => {
  assert.equal(DEFAULT_CONTROL_OVERDUE_DAYS, 14);
  assert.equal(cleanOverdueDays(0), 0);
  assert.equal(cleanOverdueDays(365), 365);
  for (const v of [-1, 366, 1.5, '14', null, undefined]) assert.throws(() => cleanOverdueDays(v), (e) => e.code === 'invalid_setting' && e.status === 422, String(v));
});

test('matriz: cantidades, marcas del último control (recambio no es faltante), totales y stock del pañol', () => {
  const d = deriveState(fixture(), { now: NOW });
  const X = buildExistencia(d, {}, { now: NOW });
  // Filas: herramientas activas en el orden personalizado (la archivada no está).
  assert.deepEqual(X.rows.map((r) => [r.n, r.toolId]), [[1, 'pinza'], [2, 'llave'], [3, 'taladro']]);
  // Columnas: técnicos activos (el archivado no) y cajas activas (la archivada no).
  assert.deepEqual(X.holders.map((h) => h.key), ['tA', 'tB', 'tC', 'caja:k1']);
  const row = (id) => X.rows.find((r) => r.toolId === id);
  // Llave x5: 2 para recambio y 1 faltante en c2 (la corrección vigente, no c1).
  assert.deepEqual(row('llave').cells.tA, { qty: 5, cambio: 2, faltante: 1 });
  assert.deepEqual(row('llave').cells['caja:k1'], { qty: 1, cambio: 0, faltante: 0 });
  // Taladro por unidades: una para recambio, otra faltante, en la misma celda.
  assert.deepEqual(row('taladro').cells.tA, { qty: 2, cambio: 1, faltante: 1 });
  // Pinza entregada después del control: cuenta, sin marcas; la asignación inactiva no cuenta.
  assert.deepEqual(row('pinza').cells.tA, { qty: 1, cambio: 0, faltante: 0 });
  assert.deepEqual(row('pinza').cells.tB, { qty: 2, cambio: 0, faltante: 0 });
  assert.equal(row('pinza').cells.tC, undefined);
  assert.deepEqual([row('llave').total, row('llave').cambio, row('llave').faltante, row('llave').disponible], [6, 2, 1, 4]);
  assert.deepEqual([row('pinza').total, row('pinza').disponible], [3, 3]);
  const col = (k) => X.holders.find((h) => h.key === k);
  assert.deepEqual([col('tA').total, col('tA').cambio, col('tA').faltante], [8, 3, 2]);
  assert.deepEqual([col('tA').legajo, col('tA').especialidad, col('tA').lastControlId, col('tA').days, col('tA').never], ['10', 'Mecánico', 'c2', 9, false]);
  assert.deepEqual([col('tB').never, col('tB').days], [true, 26]);
  // Sin herramientas ni controles.
  assert.deepEqual([col('tC').total, col('tC').never, col('tC').days], [0, true, null]);
  assert.deepEqual(X.totals, { total: 11, cambio: 3, faltante: 2, disponible: 7 });
});

test('matriz: filtro de plantilla, sin cajas y solo con herramientas', () => {
  const d = deriveState(fixture(), { now: NOW });
  assert.deepEqual(buildExistencia(d, { plantilla: 'manana' }, { now: NOW }).holders.map((h) => h.key), ['tA', 'tC', 'caja:k1']);
  assert.deepEqual(buildExistencia(d, { plantilla: 'manana', cajas: false }, { now: NOW }).holders.map((h) => h.key), ['tA', 'tC']);
  const X = buildExistencia(d, { plantilla: 'manana', cajas: false, withTools: true }, { now: NOW });
  assert.deepEqual(X.holders.map((h) => h.key), ['tA']);
  // Los totales de fila son solo de las columnas que se muestran.
  assert.equal(X.rows.find((r) => r.toolId === 'llave').total, 5);
  assert.deepEqual(X.totals, { total: 8, cambio: 3, faltante: 2, disponible: 7 });
  assert.deepEqual(X.filters, { plantilla: 'manana', cajas: false, withTools: true });
});

test('alerta "Sin control hace N días": umbral, nunca controlado, clave con el último control', () => {
  const S = fixture();
  const d = deriveState(S, { now: NOW });
  const data = (extra = {}) => ({ now: NOW, techs: S.techs, cajas: S.cajas, tools: S.tools, units: S.units, assignments: S.assignments, controls: d.ctls, movements: d.movs, alertRes: {}, ...extra });
  // Sin umbral (o 0) no hay alerta.
  assert.ok(!deriveAlerts(data()).some((a) => a.type === 'sin_control'));
  assert.ok(!deriveAlerts(data({ controlOverdueDays: 0 })).some((a) => a.type === 'sin_control'));
  const at = (n) => deriveAlerts(data({ controlOverdueDays: n })).filter((a) => a.type === 'sin_control');
  // 14 días: Beto (26 días sin controles desde su primera entrega); Ana (9) y la caja (17 días) según el umbral.
  const a14 = at(14);
  assert.deepEqual(a14.map((a) => a.key).sort(), ['sinctl-caja:k1-nunca', 'sinctl-tB-nunca']);
  const beto = a14.find((a) => a.techId === 'tB');
  assert.deepEqual([beto.title, beto.text, beto.sev, beto.days, beto.controlId], ['Sin control hace 26 días', 'Beto. Sin controles desde la primera entrega', 2, 26, null]);
  assert.equal(a14.find((a) => a.cajaId === 'k1').title, 'Sin control hace 17 días');
  // Con 8 días también Ana; la clave lleva su último control y el texto la fecha local (9 de marzo).
  const ana = at(8).find((a) => a.techId === 'tA');
  assert.deepEqual([ana.key, ana.title, ana.text, ana.controlId], ['sinctl-tA-c2', 'Sin control hace 9 días', 'Ana. Último control: 9/3/2026', 'c2']);
  // Técnico archivado o sin herramientas activas: sin alerta.
  assert.ok(!at(1).some((a) => a.techId === 'tX' || a.techId === 'tC'));
  // Resuelta no aparece; un control nuevo cambia la clave y, si sigue vencido, vuelve a abrirla.
  assert.ok(!deriveAlerts(data({ controlOverdueDays: 8, alertRes: { 'sinctl-tA-c2': {} } })).some((a) => a.key === 'sinctl-tA-c2'));
});
