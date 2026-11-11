// Etapa 8: existencia por técnico en la web (las mismas reglas que server/src/domain/existencia.js),
// días desde el último control con la fecha de Buenos Aires, textos y la hoja del Excel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../src/state/derive.js';
import { localDaysSince, controlAge, ageLabel, ageTone, holderAge, holderOverdue, buildExistencia, cellMarks, existenciaSheet, EXI_LEGEND } from '../src/state/existencia.js';
// Paridad: el mismo estado por el constructor del servidor y el de la web (E8.V1).
import { deriveState as serverDerive } from '../../server/src/domain/derive.js';
import { buildExistencia as serverBuild } from '../../server/src/domain/existencia.js';
import { NOW as FNOW, fixture as sharedFixture, reviewFixture } from '../../server/test/fixtures/existencia.js';

const NOW = new Date('2026-03-18T15:00:00.000Z');
const tr = (toolId, qty, from, to) => ({ toolId, qty, from, to });
const it = (toolId, expected, good, change, missing) => ({ toolId, state: missing ? 'faltante' : change ? 'cambio' : 'bueno', expected, qty: expected, good, change, missing });
const fin = (id, holder, w, finishedAt, items, extra = {}) => ({ id, ...holder, period: { y: 2026, m: 3, w }, pkey: `2026-03-${w}`, pnum: 2026030 + w, status: 'finalizado', finishedAt, items, ...extra });

function state() {
  return {
    plantillas: { manana: { name: 'Mañana', order: 1 }, tarde: { name: 'Tarde', order: 2 } },
    especialidades: { e1: { name: 'Mecánico', order: 1 } },
    techs: {
      tA: { name: 'Ana', legajo: '10', shiftId: 'manana', plantillaId: 'manana', especialidadId: 'e1', active: true },
      tB: { name: 'Beto', legajo: '20', shiftId: 'tarde', plantillaId: 'tarde', active: true },
      tX: { name: 'Xenia', legajo: '90', shiftId: 'manana', plantillaId: 'manana', active: false, archived: true, archivedAt: '2026-03-01T12:00:00.000Z' },
    },
    cajas: { k1: { name: 'Caja L1', lineaId: 'l1' }, k9: { name: 'Caja vieja', archived: true, archivedAt: '2026-02-01T12:00:00.000Z' } },
    categories: { cat: { name: 'Manuales', order: 1 } },
    tools: {
      llave: { name: 'Llave', categoryId: 'cat', order: 2 },
      pinza: { name: 'Pinza', categoryId: 'cat', order: 1 },
      taladro: { name: 'Taladro', categoryId: 'cat', order: 3, serialized: true },
      vieja: { name: 'Vieja', categoryId: 'cat', order: 4, active: false, archived: true, archivedAt: '2026-02-01T12:00:00.000Z' },
    },
    units: {},
    assignments: {
      a1: { techId: 'tA', toolId: 'llave', qty: 5, active: true, since: '2026-02-01T12:00:00.000Z' },
      a2: { techId: 'tA', toolId: 'taladro', unitId: 'u1', qty: 1, active: true, since: '2026-02-01T12:00:00.000Z' },
      a3: { techId: 'tA', toolId: 'taladro', unitId: 'u2', qty: 1, active: true, since: '2026-02-01T12:00:00.000Z' },
      a4: { techId: 'tB', toolId: 'pinza', qty: 2, active: true, since: '2026-02-20T12:00:00.000Z' },
      a5: { cajaId: 'k1', toolId: 'llave', qty: 1, active: true, since: '2026-03-01T12:00:00.000Z' },
      a6: { techId: 'tX', toolId: 'pinza', qty: 1, active: true, since: '2026-01-01T12:00:00.000Z' },
      a7: { techId: 'tA', toolId: 'vieja', qty: 1, active: true, since: '2026-01-01T12:00:00.000Z' },
      a8: { techId: 'tA', toolId: 'pinza', qty: 3, active: false, since: '2026-01-01T12:00:00.000Z' },
    },
    controls: {
      c1: fin('c1', { techId: 'tA' }, 2, '2026-03-09T15:00:00.000Z', { a1: it('llave', 5, 0, 0, 5) }),
      c2: fin('c2', { techId: 'tA' }, 2, '2026-03-10T02:30:00.000Z', { a1: it('llave', 5, 2, 2, 1), a2: it('taladro', 1, 0, 1, 0), a3: it('taladro', 1, 0, 0, 1) }, { supersedes: 'c1', correction: true }),
    },
    movements: {
      m1: { type: 'ingreso', toolId: 'llave', at: '2026-01-01T12:00:00.000Z', transfers: [tr('llave', 10, 'externo', 'disponible'), tr('llave', 6, 'disponible', 'asignado')] },
      m2: { type: 'ingreso', toolId: 'pinza', at: '2026-01-01T12:00:00.000Z', transfers: [tr('pinza', 7, 'externo', 'disponible'), tr('pinza', 3, 'disponible', 'asignado')] },
    },
    alertRes: {},
  };
}

test('días desde el último control con la fecha de Buenos Aires (no la del equipo)', () => {
  assert.equal(localDaysSince('2026-03-10T02:30:00.000Z', NOW), 9);
  assert.equal(localDaysSince('2026-03-10T02:30:00.000Z', new Date('2026-03-19T01:00:00.000Z')), 9);
  assert.equal(localDaysSince('2026-03-20T12:00:00.000Z', NOW), 0);
  assert.equal(localDaysSince(null, NOW), null);
});

test('textos de la antigüedad del control y tono según el umbral', () => {
  const c = (days) => ({ never: false, days, active: 1, lastControlAt: '2026-03-10T02:30:00.000Z' });
  assert.equal(ageLabel(c(0)), 'Último control hoy');
  assert.equal(ageLabel(c(1)), 'Último control ayer');
  assert.equal(ageLabel(c(9)), 'Último control hace 9 días');
  assert.equal(ageLabel({ never: true, days: 26 }), 'Sin controles (26 días desde la primera entrega)');
  assert.equal(ageLabel({ never: true, days: null }), 'Sin controles');
  assert.equal(ageTone(c(9), 14), 'ok');
  assert.equal(ageTone(c(15), 14), 'bad');
  assert.equal(ageTone(c(15), 0), 'ok');
  assert.equal(ageTone({ never: true, days: 3, active: 1 }, 14), 'pend');
  assert.equal(ageTone({ never: true, days: 20, active: 1 }, 14), 'bad');
  // Sin herramientas activas: nunca vencido (como la alerta).
  assert.equal(ageTone({ ...c(40), active: 0 }, 14), 'idle');
});

test('antigüedad por poseedor: último control vigente o primera entrega activa', () => {
  const d = deriveState(state());
  assert.deepEqual(holderAge(d, 'tA', NOW), { lastControlId: 'c2', lastControlAt: '2026-03-10T02:30:00.000Z', never: false, from: '2026-03-10T02:30:00.000Z', days: 9, active: 4 });
  assert.deepEqual(holderAge(d, 'tB', NOW), { ...controlAge(null, '2026-02-20T12:00:00.000Z', NOW), active: 1 });
  assert.equal(holderAge(d, 'caja:k1', NOW).days, 17);
});

test('matriz igual que el servidor: marcas del último control, totales, filtros y archivados afuera', () => {
  const d = deriveState(state());
  const X = buildExistencia(d, {}, { now: NOW });
  assert.deepEqual(X.rows.map((r) => [r.n, r.toolId]), [[1, 'pinza'], [2, 'llave'], [3, 'taladro']]);
  assert.deepEqual(X.holders.map((h) => h.key), ['tA', 'tB', 'caja:k1']);
  const row = (id) => X.rows.find((r) => r.toolId === id);
  assert.deepEqual(row('llave').cells.tA, { qty: 5, cambio: 2, faltante: 1, codes: [] });
  assert.deepEqual(row('taladro').cells.tA, { qty: 2, cambio: 1, faltante: 1, codes: [] });
  assert.deepEqual([row('pinza').total, row('pinza').disponible], [2, 4]);
  assert.deepEqual(X.totals, { total: 10, cambio: 3, faltante: 2, disponible: 8 });
  const A = X.holders[0];
  assert.deepEqual([A.legajo, A.especialidad, A.days, A.total, A.cambio, A.faltante], ['10', 'Mecánico', 9, 7, 3, 2]);
  assert.deepEqual(buildExistencia(d, { plantilla: 'tarde', cajas: false }, { now: NOW }).holders.map((h) => h.key), ['tB']);
  assert.deepEqual(buildExistencia(d, { plantilla: 'manana', withTools: true }, { now: NOW }).holders.map((h) => h.key), ['tA', 'caja:k1']);
});

test('marcas de la celda y hoja del Excel con totales y referencia', () => {
  assert.equal(cellMarks({ qty: 5, cambio: 2, faltante: 1 }), 'C 2 · F 1');
  assert.equal(cellMarks({ qty: 5, cambio: 0, faltante: 0 }), '');
  const d = deriveState(state());
  const X = buildExistencia(d, {}, { now: NOW });
  const rows = existenciaSheet(X, { title: 'Existencia por técnico', catName: () => 'Manuales' });
  assert.equal(rows[0][0], 'Existencia por técnico');
  const head = rows.find((r) => r[0] === 'N°');
  assert.deepEqual(head.slice(0, 3), ['N°', 'Herramienta', 'Categoría']);
  assert.deepEqual(head.slice(3, 6), ['Ana (10)', 'Beto (20)', 'Caja L1']);
  assert.deepEqual(head.slice(6), ['Total asignado', 'Recambio', 'Faltante', 'Stock del pañol']);
  const llave = rows.find((r) => r[1] === 'Llave');
  assert.deepEqual(llave, [2, 'Llave', 'Manuales', '5 (C 2 · F 1)', '', '1', 6, 2, 1, 4]);
  const tot = rows.find((r) => r[1] === 'Total');
  assert.deepEqual(tot.slice(3), ['7 (C 3 · F 2)', '2', '1', 10, 3, 2, 8]);
  assert.ok(rows.some((r) => r[0] === 'Días desde el último control' && r[3] === 9));
  for (const l of EXI_LEGEND) assert.ok(rows.some((r) => r[0] === l), l);
});

// Revisión de la etapa 8 (E8.V1).
test('paridad con el servidor: misma matriz, mismos días y vencidos con el mismo estado', () => {
  for (const make of [sharedFixture, reviewFixture]) {
    for (const f of [{}, { plantilla: 'manana', withTools: true }, { cajas: false }]) {
      for (const threshold of [0, 14]) {
        const srv = serverBuild(serverDerive(make(), { now: FNOW }), f, { now: FNOW, threshold });
        const web = buildExistencia(deriveState(make()), f, { now: FNOW, threshold });
        assert.deepEqual(web, srv, `${make.name} ${JSON.stringify(f)} ${threshold}`);
      }
    }
  }
});

test('sin herramientas activas no está vencido (como la alerta): días a la vista, tono neutro', () => {
  const d = deriveState(reviewFixture());
  const X = buildExistencia(d, {}, { now: FNOW, threshold: 14 });
  const dora = X.holders.find((h) => h.key === 'tD');
  assert.deepEqual([dora.active, dora.days, dora.overdue], [0, 44, false]);
  assert.equal(ageTone(dora, 14), 'idle');
  assert.equal(holderOverdue(dora, 14), false);
  const age = holderAge(d, 'tD', FNOW);
  assert.deepEqual([age.active, age.days, ageTone(age, 14)], [0, 44, 'idle']);
  assert.equal(ageTone(holderAge(d, 'tB', FNOW), 14), 'bad');
  assert.deepEqual(X.holders.filter((h) => h.overdue).map((h) => h.key), ['tB', 'caja:k1']);
});

test('control sin fecha de finalización: inicio de su semana (como el servidor)', () => {
  const age = holderAge(deriveState(reviewFixture()), 'caja:k1', FNOW);
  assert.deepEqual([age.lastControlId, age.lastControlAt, age.days], ['c6', '2026-03-01T03:00:00.000Z', 17]);
});

test('herramienta desactivada asignada en la matriz y códigos de unidad en la celda y el Excel', () => {
  const X = buildExistencia(deriveState(reviewFixture()), {}, { now: FNOW });
  const row = (id) => X.rows.find((r) => r.toolId === id);
  assert.deepEqual([row('inact').inactive, row('inact').cells.tB.qty], [true, 1]);
  assert.deepEqual(row('taladro').cells.tA.codes, ['TAL-1', 'TAL-2']);
  const rows = existenciaSheet(X, { catName: () => 'Manuales' });
  const head = rows.find((r) => r[0] === 'N°');
  const col = head.indexOf('Ana (10)');
  assert.equal(rows.find((r) => r[1] === 'Taladro')[col], '2 (C 1 · F 1) [TAL-1, TAL-2]');
  assert.ok(rows.some((r) => r[1] === 'Inactiva (inactiva)'));
});
