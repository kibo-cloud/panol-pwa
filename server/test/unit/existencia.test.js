// Etapa 8: existencia por técnico (RESUMEN del Excel), días desde el último control efectivo y la
// alerta "Sin control hace N días".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../../src/domain/derive.js';
import { deriveAlerts } from '../../src/domain/alerts.js';
import { localDaysSince, controlAge, lastControlByHolder, firstActiveSince, isOverdue, buildExistencia, cleanOverdueDays, DEFAULT_CONTROL_OVERDUE_DAYS } from '../../src/domain/existencia.js';
import { NOW, fixture, reviewFixture } from '../fixtures/existencia.js';

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
  assert.deepEqual(row('llave').cells.tA, { qty: 5, cambio: 2, faltante: 1, codes: [] });
  assert.deepEqual(row('llave').cells['caja:k1'], { qty: 1, cambio: 0, faltante: 0, codes: [] });
  // Taladro por unidades: una para recambio, otra faltante, en la misma celda.
  assert.deepEqual(row('taladro').cells.tA, { qty: 2, cambio: 1, faltante: 1, codes: ['TAL-1', 'TAL-2'] });
  // Pinza entregada después del control: cuenta, sin marcas; la asignación inactiva no cuenta.
  assert.deepEqual(row('pinza').cells.tA, { qty: 1, cambio: 0, faltante: 0, codes: [] });
  assert.deepEqual(row('pinza').cells.tB, { qty: 2, cambio: 0, faltante: 0, codes: [] });
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

// Revisión de la etapa 8 (E8.V1).
const alertData = (S, extra = {}) => {
  const d = deriveState(S, { now: NOW });
  return { now: NOW, techs: S.techs, cajas: S.cajas, tools: S.tools, units: S.units, assignments: S.assignments, controls: d.ctls, movements: d.movs, alertRes: {}, ...extra };
};

test('sin herramientas activas nunca está vencido: se muestran los días, sin alerta', () => {
  const S = reviewFixture();
  const X = buildExistencia(deriveState(S, { now: NOW }), {}, { now: NOW, threshold: 14 });
  const dora = X.holders.find((h) => h.key === 'tD');
  assert.deepEqual([dora.active, dora.days, dora.never, dora.overdue], [0, 44, false, false]);
  // Beto (26 días sin controles, con herramientas) sí está vencido, como su alerta.
  assert.equal(X.holders.find((h) => h.key === 'tB').overdue, true);
  assert.deepEqual(X.holders.filter((h) => h.overdue).map((h) => h.key), ['tB', 'caja:k1']);
  const alerts = deriveAlerts(alertData(S, { controlOverdueDays: 14 })).filter((a) => a.type === 'sin_control');
  assert.ok(!alerts.some((a) => a.techId === 'tD'));
  assert.deepEqual(alerts.map((a) => a.techId || 'caja:' + a.cajaId).sort(), ['caja:k1', 'tB']);
  // Sin umbral nadie está vencido.
  assert.ok(!buildExistencia(deriveState(S, { now: NOW }), {}, { now: NOW }).holders.some((h) => h.overdue));
});

test('control finalizado sin fecha de finalización: cuenta desde el inicio de su semana', () => {
  const X = buildExistencia(deriveState(reviewFixture(), { now: NOW }), {}, { now: NOW, threshold: 14 });
  const k = X.holders.find((h) => h.key === 'caja:k1');
  // Semana 1 de marzo: 1 de marzo a las 00:00 de Buenos Aires.
  assert.deepEqual([k.lastControlId, k.lastControlAt, k.days], ['c6', '2026-03-01T03:00:00.000Z', 17]);
});

test('herramienta desactivada pero asignada: sigue en la matriz, marcada, y suma como en la ficha', () => {
  const X = buildExistencia(deriveState(reviewFixture(), { now: NOW }), {}, { now: NOW });
  const row = X.rows.find((r) => r.toolId === 'inact');
  assert.ok(row, 'fila de la herramienta desactivada');
  assert.deepEqual([row.inactive, row.total, row.cells.tB.qty], [true, 1, 1]);
  assert.equal(X.rows.find((r) => r.toolId === 'pinza').inactive, false);
  // La archivada sigue afuera (es historial).
  assert.ok(!X.rows.some((r) => r.toolId === 'vieja'));
  assert.equal(X.holders.find((h) => h.key === 'tB').total, 3);
});

test('herramientas por unidades: la celda lleva los códigos de ese poseedor', () => {
  const X = buildExistencia(deriveState(fixture(), { now: NOW }), {}, { now: NOW });
  const row = (id) => X.rows.find((r) => r.toolId === id);
  assert.deepEqual(row('taladro').cells.tA.codes, ['TAL-1', 'TAL-2']);
  assert.deepEqual(row('llave').cells.tA.codes, []);
});

test('alerta "nunca" resuelta: sigue oculta aunque después tenga una primera entrega nueva, hasta un control', () => {
  // Ciro tuvo una entrega sin control, la alerta `sinctl-tC-nunca` se resolvió y la devolvió;
  // ahora vuelve a tener herramientas desde hace 17 días: la clave es la misma ("nunca"), así que
  // queda resuelta (oculta). Un control nuevo la cambia (`sinctl-tC-<control>`).
  const S = fixture();
  S.assignments.a11 = { techId: 'tC', toolId: 'pinza', qty: 1, active: true, since: '2026-03-01T12:00:00.000Z' };
  const open = (alertRes) => deriveAlerts(alertData(S, { controlOverdueDays: 14, alertRes })).filter((a) => a.type === 'sin_control' && a.techId === 'tC');
  assert.deepEqual(open({}).map((a) => [a.key, a.days]), [['sinctl-tC-nunca', 17]]);
  assert.deepEqual(open({ 'sinctl-tC-nunca': { note: 'Ya se controló en papel' } }), []);
});
