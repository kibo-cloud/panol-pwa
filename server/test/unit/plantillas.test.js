import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  covers, effectiveRange, planMove, planMove as planMoveRaw, planRotation, canRotate, defaultPlantillaName, cleanPlantillaName, shiftChangesFromHistory,
  controlRefDate, reportPlantillaOf,
} from '../../src/domain/plantillas.js';

let n = 0;
const newId = (p) => `${p}${++n}`;
const R = (id, plantillaId, validFrom, validTo = null, extra = {}) => ({ id, techId: 'tA', plantillaId, validFrom, validTo, temporary: false, reason: '', ...extra });

test('rango [desde, hasta): desde nulo = desde siempre, hasta nulo = abierto', () => {
  assert.equal(covers(R('r', 'a', null, '2026-03-01'), '2026-02-28'), true);
  assert.equal(covers(R('r', 'a', null, '2026-03-01'), '2026-03-01'), false);
  assert.equal(covers(R('r', 'a', '2026-03-01'), '2026-03-01'), true);
  assert.equal(covers(R('r', 'a', '2026-03-01'), '2099-01-01'), true);
  // Rango anulado (desde = hasta): no cubre ningún día.
  assert.equal(covers(R('r', 'a', '2026-03-01', '2026-03-01'), '2026-03-01'), false);
});

test('plantilla efectiva en una fecha: un solo rango', () => {
  const h = [R('r1', 'manana', null, '2026-03-01'), R('r2', 'tarde', '2026-03-01', '2026-03-10', { temporary: true }), R('r3', 'manana', '2026-03-10')];
  assert.equal(effectiveRange(h, '2026-01-01').plantillaId, 'manana');
  assert.equal(effectiveRange(h, '2026-03-05').plantillaId, 'tarde');
  assert.equal(effectiveRange(h, '2026-03-10').plantillaId, 'manana');
  assert.equal(effectiveRange([], '2026-03-10'), null);
});

test('mover: cierra el rango abierto en la fecha desde y abre uno nuevo', () => {
  const p = planMove([R('r1', 'manana', null)], { techId: 'tA', targetId: 'tarde', from: '2026-03-05', reason: ' Pidió el cambio ' }, { newId });
  assert.deepEqual(p.close, { id: 'r1', validTo: '2026-03-05' });
  assert.equal(p.inserts.length, 1);
  assert.deepEqual({ ...p.inserts[0], id: undefined }, { id: undefined, techId: 'tA', plantillaId: 'tarde', validFrom: '2026-03-05', validTo: null, temporary: false, reason: 'Pidió el cambio' });
  assert.equal(p.fromPlantillaId, 'manana');
});

test('mover el mismo día que el último cambio deja el rango anterior anulado', () => {
  const p = planMove([R('r1', 'manana', null, '2026-03-05'), R('r2', 'tarde', '2026-03-05')], { techId: 'tA', targetId: 'noche', from: '2026-03-05', reason: 'Corrección' }, { newId });
  assert.deepEqual(p.close, { id: 'r2', validTo: '2026-03-05' });
  assert.equal(p.inserts[0].plantillaId, 'noche');
});

test('cobertura temporal: rango temporal y vuelta automática a la plantilla base', () => {
  const p = planMove([R('r1', 'manana', null)], { techId: 'tA', targetId: 'noche', from: '2026-03-05', until: '2026-03-12', reason: 'Cubre vacaciones' }, { newId });
  assert.deepEqual(p.close, { id: 'r1', validTo: '2026-03-05' });
  assert.deepEqual(p.inserts.map((r) => [r.plantillaId, r.validFrom, r.validTo, r.temporary]), [
    ['noche', '2026-03-05', '2026-03-12', true],
    ['manana', '2026-03-12', null, false],
  ]);
  const h = [R('r1', 'manana', null, '2026-03-05'), ...p.inserts];
  assert.equal(effectiveRange(h, '2026-03-11').plantillaId, 'noche');
  assert.equal(effectiveRange(h, '2026-03-12').plantillaId, 'manana');
});

test('validaciones: fecha, motivo, destino distinto, hasta posterior, no antes del último cambio', () => {
  const h = [R('r1', 'manana', null, '2026-03-05'), R('r2', 'tarde', '2026-03-05')];
  const mv = (x) => planMove(h, { techId: 'tA', targetId: 'noche', from: '2026-03-10', reason: 'x', ...x }, { newId });
  assert.throws(() => mv({ from: '2026-02-30' }), /fecha desde no es válida/);
  assert.throws(() => mv({ reason: '  ' }), /Ingresá el motivo/);
  assert.throws(() => mv({ targetId: 'tarde' }), /ya está en esa plantilla/);
  assert.throws(() => mv({ until: '2026-03-10' }), /fecha hasta tiene que ser posterior/);
  assert.throws(() => mv({ until: 'mañana' }), /fecha hasta no es válida/);
  assert.throws(() => mv({ from: '2026-03-04' }), /no puede ser anterior al 2026-03-05/);
  assert.throws(() => mv({ targetId: null }), /Elegí la plantilla destino/);
  assert.throws(() => mv({ reason: 'x'.repeat(2001) }), /hasta 2000/);
});

test('cambio definitivo durante una cobertura: acorta la cobertura y anula la vuelta a la base', () => {
  const h = [R('r1', 'manana', null, '2026-03-05'), R('r2', 'noche', '2026-03-05', '2026-03-12', { temporary: true }), R('r3', 'manana', '2026-03-12')];
  // Hoy dentro de la cobertura (la cobertura se mira contra hoy).
  const planMove = (ranges, input, deps) => planMoveRaw(ranges, { today: '2026-03-06', ...input }, deps);
  const p = planMove(h, { techId: 'tA', targetId: 'tarde', from: '2026-03-08', reason: 'Se queda' }, { newId });
  assert.deepEqual(p.shorten, { id: 'r2', validTo: '2026-03-08' });
  assert.deepEqual(p.close, { id: 'r3', validTo: '2026-03-12' });
  assert.deepEqual(p.inserts.map((r) => [r.plantillaId, r.validFrom, r.validTo, r.temporary]), [['tarde', '2026-03-08', null, false]]);
  assert.equal(p.fromPlantillaId, 'noche');
  assert.equal(p.cancelledReturn.plantillaId, 'manana');
  // Volver antes a la base también es un cambio definitivo.
  assert.equal(planMove(h, { techId: 'tA', targetId: 'manana', from: '2026-03-08', reason: 'Vuelve antes' }, { newId }).inserts[0].plantillaId, 'manana');
  // Desde el comienzo de la cobertura la anula; antes no se puede.
  assert.deepEqual(planMove(h, { techId: 'tA', targetId: 'tarde', from: '2026-03-05', reason: 'x' }, { newId }).shorten, { id: 'r2', validTo: '2026-03-05' });
  assert.throws(() => planMove(h, { techId: 'tA', targetId: 'tarde', from: '2026-03-04', reason: 'x' }, { newId }), /no puede ser anterior al 2026-03-05/);
  // Otra cobertura mientras dura la primera, no; después de que termina, sí.
  assert.throws(() => planMove(h, { techId: 'tA', targetId: 'tarde', from: '2026-03-08', until: '2026-03-10', reason: 'x' }, { newId }), /cobertura temporal hasta el 2026-03-12/);
  assert.equal(planMove(h, { techId: 'tA', targetId: 'tarde', from: '2026-03-12', until: '2026-03-15', reason: 'x' }, { newId }).shorten, null);
});

// La cobertura se mira contra hoy, no contra la fecha del cambio: una cobertura que ya terminó
// no vuelve a abrir el camino de la cobertura (A), ni lo abre una cobertura ya cortada (B).
test('cobertura ya terminada: un cambio con fecha anterior respeta el último tramo vivido', () => {
  const h = [R('r1', 'manana', null, '2026-03-05'), R('r2', 'noche', '2026-03-05', '2026-03-12', { temporary: true }), R('r3', 'manana', '2026-03-12')];
  const mv = (from, today) => planMove(h, { techId: 'tA', targetId: 'tarde', from, reason: 'x', today }, { newId });
  assert.throws(() => mv('2026-03-08', '2026-03-20'), (e) => e.code === 'move_before_last' && /anterior al 2026-03-12/.test(e.message));
  // El mismo día en que termina la cobertura ya no hay cobertura: cambio normal desde la vuelta.
  assert.throws(() => mv('2026-03-08', '2026-03-12'), (e) => e.code === 'move_before_last');
  const p = mv('2026-03-14', '2026-03-20');
  assert.equal(p.shorten, null);
  assert.deepEqual(p.close, { id: 'r3', validTo: '2026-03-14' });
  // Una cobertura nueva después de una ya terminada no choca con la vieja.
  assert.equal(planMove(h, { techId: 'tA', targetId: 'tarde', from: '2026-03-14', until: '2026-03-16', reason: 'x', today: '2026-03-20' }, { newId }).shorten, null);
});

test('cobertura cortada por un cambio definitivo: un cambio posterior no anula el rango definitivo', () => {
  // Cobertura [05, 12) cortada el 08 por un cambio definitivo a tarde: queda [05, 08), la vuelta
  // del 12 anulada y tarde abierto desde el 08.
  const h = [
    R('r1', 'manana', null, '2026-03-05'), R('r2', 'noche', '2026-03-05', '2026-03-08', { temporary: true }),
    R('r3', 'manana', '2026-03-12', '2026-03-12'), R('r4', 'tarde', '2026-03-08'),
  ];
  const mv = (from, today) => planMove(h, { techId: 'tA', targetId: 'noche', from, reason: 'x', today }, { newId });
  // Hoy después del corte (el definitivo ya se vive).
  assert.throws(() => mv('2026-03-06', '2026-03-09'), (e) => e.code === 'move_before_last' && /anterior al 2026-03-08/.test(e.message));
  // Hoy antes del corte (definitivo programado): la cobertura sigue en curso pero ya está cortada.
  assert.throws(() => mv('2026-03-06', '2026-03-06'), (e) => e.code === 'move_before_last' && /anterior al 2026-03-08/.test(e.message));
  const p = mv('2026-03-10', '2026-03-09');
  assert.equal(p.shorten, null);
  assert.deepEqual(p.close, { id: 'r4', validTo: '2026-03-10' });
});

test('cambio definitivo desde la vuelta programada: la cobertura sigue y se puede cortar antes', () => {
  // Cobertura [05, 12) y cambio definitivo a tarde desde el 12 (la vuelta a mañana queda anulada).
  const h = [
    R('r1', 'manana', null, '2026-03-05'), R('r2', 'noche', '2026-03-05', '2026-03-12', { temporary: true }),
    R('r3', 'manana', '2026-03-12', '2026-03-12'), R('r4', 'tarde', '2026-03-12'),
  ];
  const p = planMove(h, { techId: 'tA', targetId: 'manana', from: '2026-03-08', reason: 'x', today: '2026-03-06' }, { newId });
  assert.deepEqual(p.shorten, { id: 'r2', validTo: '2026-03-08' });
  assert.deepEqual(p.close, { id: 'r4', validTo: '2026-03-12' });
});

test('mover a un técnico sin plantilla abre su primer rango', () => {
  const p = planMove([], { techId: 'tA', targetId: 'tarde', from: '2026-03-05', reason: 'Alta en plantilla' }, { newId });
  assert.equal(p.close, null);
  assert.equal(p.fromPlantillaId, null);
  assert.deepEqual(p.inserts.map((r) => [r.plantillaId, r.validFrom, r.validTo]), [['tarde', '2026-03-05', null]]);
});

test('rotación: rótulo de la lista, fecha válida no futura, distinto del actual', () => {
  const labels = ['Mañana', 'Tarde', 'Noche'];
  assert.deepEqual(planRotation({ labels, current: 'Mañana', label: 'Tarde', from: '2026-03-05', today: '2026-03-06' }), { label: 'Tarde', from: '2026-03-05' });
  assert.deepEqual(planRotation({ labels, current: null, label: 'Noche', from: null, today: '2026-03-06' }), { label: 'Noche', from: '2026-03-06' });
  assert.throws(() => planRotation({ labels, current: 'Mañana', label: 'Franco', today: '2026-03-06' }), /Elegí un turno de la lista/);
  assert.throws(() => planRotation({ labels, current: 'Mañana', label: 'Mañana', today: '2026-03-06' }), /ya está en ese turno/);
  assert.throws(() => planRotation({ labels, current: 'Mañana', label: 'Tarde', from: '2026-03-07', today: '2026-03-06' }), /no puede ser futura/);
});

test('permisos de rotación: plantilla_rotate o supervisor de esa plantilla', () => {
  const pl = { supervisorUserId: 'u-sup' };
  assert.equal(canRotate({ id: 'u-adm', role: 'admin' }, pl, {}), true);
  assert.equal(canRotate({ id: 'u-sup', role: 'supervisor' }, pl, {}), true);
  assert.equal(canRotate({ id: 'u-otro', role: 'supervisor' }, pl, {}), false);
  assert.equal(canRotate({ id: 'u-res', role: 'responsable' }, pl, { responsable: { plantilla_rotate: true } }), true);
  assert.equal(canRotate({ id: 'u-sup', role: 'consulta' }, pl, {}), false);
  assert.equal(canRotate({ id: 'u-sup', role: 'gerencia' }, pl, {}), false);
});

test('nombre por defecto y nombre limpio', () => {
  assert.equal(defaultPlantillaName('Juana Pérez'), 'Plantilla de Juana Pérez');
  assert.equal(cleanPlantillaName('  Norte  ', null), 'Norte');
  assert.equal(cleanPlantillaName('', 'Juana Pérez'), 'Plantilla de Juana Pérez');
  assert.throws(() => cleanPlantillaName('', null), /Ingresá un nombre o elegí un supervisor/);
  assert.throws(() => cleanPlantillaName('x'.repeat(121), null), /hasta 120/);
});

test('historial -> cambios de turno de 2.1 (para el .txt)', () => {
  const h = [
    R('r1', 'manana', null, '2026-03-05'),
    R('r2', 'tarde', '2026-03-05', '2026-03-05', { reason: 'anulado' }),
    R('r3', 'noche', '2026-03-05', null, { reason: 'Pidió', createdAt: '2026-03-04T10:00:00.000Z', by: 'u-sup' }),
  ];
  const names = { manana: 'Turno mañana', tarde: 'Turno tarde', noche: 'Turno noche' };
  const sc = shiftChangesFromHistory({ tA: h }, names);
  assert.deepEqual(Object.keys(sc), ['r3']);
  assert.deepEqual(sc.r3, { techId: 'tA', from: 'manana', to: 'noche', fromName: 'Turno mañana', toName: 'Turno noche', effectiveFrom: '2026-03-05', note: 'Pidió', at: '2026-03-04T10:00:00.000Z', by: 'u-sup', demo: false });
});

test('fecha de referencia de un control: hoy, o el último día de su semana si ya pasó', () => {
  assert.equal(controlRefDate({ y: 2026, m: 3, w: 2 }, '2026-03-10'), '2026-03-10');
  assert.equal(controlRefDate({ y: 2026, m: 3, w: 2 }, '2026-04-01'), '2026-03-14');
  assert.equal(controlRefDate({ y: 2026, m: 2, w: 4 }, '2026-04-01'), '2026-02-28');
});

test('plantilla de un técnico en un informe: foto del control, si no historial, si no actual', () => {
  const hist = { tA: [R('r1', 'manana', null, '2026-03-20'), R('r2', 'tarde', '2026-03-20')] };
  assert.equal(reportPlantillaOf({ id: 'tA', shiftId: 'tarde' }, { lastControl: { plantillaId: 'noche' }, hist, day: '2026-03-31' }), 'noche');
  assert.equal(reportPlantillaOf({ id: 'tA', shiftId: 'tarde' }, { lastControl: null, hist, day: '2026-03-14' }), 'manana');
  assert.equal(reportPlantillaOf({ id: 'tB', shiftId: 'tarde' }, { lastControl: null, hist, day: '2026-03-14' }), 'tarde');
});
