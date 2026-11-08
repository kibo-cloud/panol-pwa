// Lógica pura de plantillas del frontend: plantilla por fecha, coberturas, agrupación,
// selección y validación de formularios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  covers, effectiveRange, coverageOf, periodEndDay, reportPlantillaOf, groupByPlantilla, mineFirst, toggleId, pruneSelection, allSelected,
  validateMove, historyRows, validateShiftLabels, holderKey, holderBody, validateAssignment, validateLinea, validateCaja, validDay, daysBetween,
} from '../src/state/plantillas.js';

const R = (id, plantillaId, validFrom, validTo = null, extra = {}) => ({ id, plantillaId, validFrom, validTo, temporary: false, reason: '', ...extra });
const cov = [R('r1', 'manana', null, '2026-03-05'), R('r2', 'noche', '2026-03-05', '2026-03-12', { temporary: true, reason: 'Cubre' }), R('r3', 'manana', '2026-03-12', null, { reason: 'Vuelve de la cobertura temporal' })];

test('plantilla efectiva por fecha y rangos anulados', () => {
  assert.equal(effectiveRange(cov, '2026-01-01').plantillaId, 'manana');
  assert.equal(effectiveRange(cov, '2026-03-11').plantillaId, 'noche');
  assert.equal(effectiveRange(cov, '2026-03-12').plantillaId, 'manana');
  assert.equal(covers(R('v', 'x', '2026-03-01', '2026-03-01'), '2026-03-01'), false);
});

test('cobertura vigente o programada, y terminada', () => {
  assert.deepEqual(coverageOf(cov, '2026-03-06'), { plantillaId: 'noche', from: '2026-03-05', until: '2026-03-12', returnTo: 'manana', started: true });
  assert.equal(coverageOf(cov, '2026-03-01').started, false);
  assert.equal(coverageOf(cov, '2026-03-12'), null);
  assert.equal(coverageOf([R('a', 'x', null)], '2026-03-01'), null);
});

test('informes: foto del control, si no historial al fin del período, si no la actual', () => {
  assert.equal(periodEndDay({ y: 2026, m: 2, w: 4 }), '2026-02-28');
  assert.equal(periodEndDay({ y: 2026, m: 3, w: 2 }), '2026-03-14');
  const t = { id: 'tA', plantillaId: 'tarde' };
  assert.equal(reportPlantillaOf(t, { lastControl: { plantillaId: 'noche' }, ranges: cov, day: '2026-03-14' }), 'noche');
  assert.equal(reportPlantillaOf(t, { lastControl: null, ranges: cov, day: '2026-03-07' }), 'noche');
  assert.equal(reportPlantillaOf(t, { lastControl: null, ranges: [], day: '2026-03-07' }), 'tarde');
});

test('agrupación por plantilla con las propias primero y los sin plantilla al final', () => {
  const pls = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const g = groupByPlantilla([{ p: 'a' }, { p: 'c' }, { p: 'zz' }, { p: 'c' }], (x) => x.p, pls, ['c']);
  assert.deepEqual(g.map((x) => [x.plantilla && x.plantilla.id, x.items.length, x.mine]), [['c', 2, true], ['a', 1, false], ['b', 0, false], [null, 1, false]]);
  assert.deepEqual(mineFirst(pls, ['b']).map((p) => p.id), ['b', 'a', 'c']);
});

test('selección de técnicos', () => {
  let s = toggleId([], 'x'); s = toggleId(s, 'y'); s = toggleId(s, 'x');
  assert.deepEqual(s, ['y']);
  assert.deepEqual(toggleId(['y'], 'y', true), ['y']);
  assert.deepEqual(pruneSelection(['a', 'b', 'c'], ['c', 'a']), ['a', 'c']);
  assert.equal(allSelected(['a', 'b'], ['b', 'a']), true);
  assert.equal(allSelected([], []), false);
});

test('validación de mover: destino, fecha, motivo, cobertura y cobertura activa', () => {
  const ok = { plantillaId: 'tarde', from: '2026-03-05', reason: ' Pidió ' };
  assert.deepEqual(validateMove(ok, { currentId: 'manana' }), { ok: true, body: { from: '2026-03-05', reason: 'Pidió' } });
  assert.match(validateMove({ ...ok, plantillaId: '' }).error, /destino/);
  assert.match(validateMove({ ...ok, from: '2026-02-30' }).error, /fecha desde/);
  assert.match(validateMove({ ...ok, reason: '  ' }).error, /motivo/);
  assert.match(validateMove(ok, { currentId: 'tarde' }).error, /Ya está/);
  assert.match(validateMove({ ...ok, coverage: true, until: '' }).error, /fecha hasta/);
  assert.match(validateMove({ ...ok, coverage: true, until: '2026-03-05' }).error, /posterior/);
  assert.deepEqual(validateMove({ ...ok, coverage: true, until: '2026-03-09' }).body, { from: '2026-03-05', reason: 'Pidió', until: '2026-03-09' });
  const c = coverageOf(cov, '2026-03-06');
  assert.match(validateMove({ ...ok, from: '2026-03-06', coverage: true, until: '2026-03-08' }, { currentId: 'noche', coverage: c }).error, /cobertura temporal hasta el 2026-03-12/);
  // Un cambio definitivo durante la cobertura (incluso a la plantilla base) sí.
  assert.equal(validateMove({ ...ok, plantillaId: 'noche', from: '2026-03-06' }, { currentId: 'noche', coverage: c }).ok, true);
});

test('historial del técnico: más nuevo primero, cobertura con su vuelta, sin anulados', () => {
  const h = historyRows([...cov, R('v', 'tarde', '2026-03-12', '2026-03-12')], { manana: 'Mañana', noche: 'Noche' });
  assert.deepEqual(h.map((x) => [x.name, x.from, x.to, x.temporary, x.returnTo, x.fromName]), [
    ['Mañana', '2026-03-12', null, false, null, 'Noche'],
    ['Noche', '2026-03-05', '2026-03-12', true, 'Mañana', 'Mañana'],
    ['Mañana', null, '2026-03-05', false, null, null],
  ]);
});

test('lista de turnos', () => {
  assert.deepEqual(validateShiftLabels([' Mañana ', '', 'Tarde']).labels, ['Mañana', 'Tarde']);
  assert.match(validateShiftLabels(['Mañana', 'mañana']).error, /repetido/);
  assert.match(validateShiftLabels(['', ' ']).error, /al menos un/);
  assert.match(validateShiftLabels(['M']).error, /2 letras/);
});

test('poseedor y alta de asignación por cantidad o por unidades', () => {
  assert.equal(holderKey({ cajaId: 'k1', techId: null }), 'caja:k1');
  assert.equal(holderKey({ techId: 't1' }), 't1');
  assert.deepEqual(holderBody('caja:k1'), { cajaId: 'k1' });
  assert.deepEqual(holderBody('t1'), { techId: 't1' });
  const qtyTool = { id: 'tl', serialized: false };
  assert.deepEqual(validateAssignment({ holder: 'caja:k1', qty: '2', reason: ' Nueva ' }, { tool: qtyTool, available: 3 }).body, { holder: { cajaId: 'k1' }, toolId: 'tl', qty: 2, reason: 'Nueva' });
  assert.match(validateAssignment({ holder: 't1', qty: 4 }, { tool: qtyTool, available: 3 }).error, /Solo hay 3/);
  assert.match(validateAssignment({ holder: '', qty: 1 }, { tool: qtyTool, available: 3 }).error, /técnico o la caja/);
  const serTool = { id: 'ts', serialized: true };
  assert.match(validateAssignment({ holder: 't1', unitIds: ['u9'] }, { tool: serTool, availableUnitIds: ['u1'] }).error, /al menos una unidad/);
  assert.deepEqual(validateAssignment({ holder: 't1', unitIds: ['u1', 'u9'] }, { tool: serTool, availableUnitIds: ['u1'] }).body, { holder: { techId: 't1' }, toolId: 'ts', unitIds: ['u1'] });
});

test('línea, sector y caja', () => {
  assert.deepEqual(validateLinea({ name: ' Línea 1 ', kind: 'linea' }).body, { name: 'Línea 1', kind: 'linea' });
  assert.match(validateLinea({ name: 'L1', kind: 'otro' }).error, /línea o un sector/);
  assert.match(validateLinea({ name: 'linea 1', kind: 'sector' }, [{ name: 'Línea 1' }, { name: 'LINEA 1' }]).error, /Ya existe/);
  assert.deepEqual(validateCaja({ name: 'Caja A', lineaId: 'l1', referenteTechId: '' }).body, { name: 'Caja A', lineaId: 'l1', referenteTechId: null });
  assert.match(validateCaja({ name: 'Caja A' }).error, /línea o el sector/);
});

test('fechas', () => {
  assert.equal(validDay('2026-02-29'), false);
  assert.equal(validDay('2028-02-29'), true);
  assert.equal(daysBetween(null, '2026-03-01'), null);
  assert.equal(daysBetween('2026-03-01T15:00:00', '2026-03-04'), 3);
});
