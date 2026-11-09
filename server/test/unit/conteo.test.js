// Etapa 4: conteo por cantidad, limpieza, alertas e informes por unidades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemQuantities, itemState, validateFinalize, buildControlDoc, asgUnits } from '../../src/domain/controls.js';
import { deriveAlerts } from '../../src/domain/alerts.js';
import { deriveState } from '../../src/domain/derive.js';
import { computeReport } from '../../src/domain/report.js';

const fin = (id, holder, pkey, finishedAt, items, extra = {}) => {
  const [y, m, w] = pkey.split('-').map(Number);
  return { id, ...holder, pkey, period: { y, m, w }, pnum: y * 1000 + m * 10 + w, status: 'finalizado', finishedAt, items, ...extra };
};
const q = (expected, good, change, missing, extra = {}) => ({ state: itemState({ good, change, missing }), expected, qty: expected, good, change, missing, ...extra });

test('cantidades: estado de los botones, buen estado + recambio (faltan el resto) y errores', () => {
  assert.deepEqual(itemQuantities({ state: 'bueno' }, 5), { good: 5, change: 0, missing: 0 });
  assert.deepEqual(itemQuantities({ state: 'cambio' }, 1), { good: 0, change: 1, missing: 0 });
  assert.deepEqual(itemQuantities({ state: 'faltante' }, 3), { good: 0, change: 0, missing: 3 });
  assert.deepEqual(itemQuantities({ good: 3, change: 1 }, 5), { good: 3, change: 1, missing: 1 });
  assert.deepEqual(itemQuantities({ good: 3, change: 2, missing: 0, state: 'cambio' }, 5), { good: 3, change: 2, missing: 0 });
  assert.equal(itemState({ good: 3, change: 2, missing: 0 }), 'cambio');
  assert.equal(itemState({ good: 0, change: 4, missing: 1 }), 'faltante');
  assert.equal(itemState({ good: 5, change: 0, missing: 0 }), 'bueno');
  assert.throws(() => itemQuantities({ good: 4, change: 2 }, 5), (e) => e.code === 'invalid_count' && /no pueden superar 5/.test(e.message));
  assert.throws(() => itemQuantities({ good: 1, change: 1, missing: 1 }, 5), (e) => e.code === 'invalid_count');
  assert.throws(() => itemQuantities({ good: 5, change: 0, state: 'faltante' }, 5), (e) => e.code === 'invalid_count');
  assert.throws(() => itemQuantities({ good: 2 }, 5), (e) => e.code === 'invalid_count');
  // Contado con otra cantidad asignada: queda pendiente (hay que volver a contarlo).
  assert.equal(itemQuantities({ good: 3, change: 0, expected: 3 }, 4), null);
  assert.equal(itemQuantities(null, 4), null);
  assert.equal(itemQuantities({ note: 'x' }, 4), null);
});

test('documento: unidades por estado, estado derivado, línea solo con faltantes o recambios y limpieza', () => {
  const doc = buildControlDoc({
    tech: { id: 'tA', name: 'Ana', plantillaId: 'p1' },
    period: { y: 2026, m: 3, w: 2 },
    assignments: [{ id: 'a1', toolId: 'llave', qty: 5 }, { id: 'a2', toolId: 'pinza', qty: 1 }, { id: 'a3', toolId: 'llave', qty: 4 }],
    items: { a1: { good: 3, change: 1, note: ' perdida ', lineaId: 'l1' }, a2: { state: 'bueno', lineaId: 'l1' }, a3: { good: 2, change: 2, lineaId: 'l2' } },
    tools: { llave: { name: 'Llave' }, pinza: { name: 'Pinza' } },
    units: {}, categories: {}, status: 'borrador',
    cleaning: { status: 'requiere_limpieza', note: ' grasa ' },
  });
  assert.deepEqual(doc.counts, { bueno: 6, cambio: 3, faltante: 1 });
  assert.equal(doc.items.a1.state, 'faltante');
  assert.deepEqual([doc.items.a1.good, doc.items.a1.change, doc.items.a1.missing, doc.items.a1.expected, doc.items.a1.qty], [3, 1, 1, 5, 5]);
  assert.equal(doc.items.a1.note, 'perdida');
  assert.equal(doc.items.a1.lineaId, 'l1');
  assert.equal(doc.items.a2.lineaId, null);
  assert.equal(doc.items.a3.state, 'cambio');
  assert.equal(doc.items.a3.lineaId, 'l2');
  assert.deepEqual(doc.cleaning, { status: 'requiere_limpieza', note: 'grasa' });
  const limpio = buildControlDoc({ tech: { id: 'tA', name: 'Ana' }, period: { y: 2026, m: 3, w: 2 }, assignments: [], items: {}, tools: {}, units: {}, categories: {}, status: 'borrador', cleaning: { status: 'limpio', note: 'no va' } });
  assert.deepEqual(limpio.cleaning, { status: 'limpio', note: '' });
});

test('finalizar: faltante parcial con motivo y limpieza obligatoria (con nota si requiere)', () => {
  const asgs = [{ id: 'a1' }, { id: 'a2' }];
  const items = { a1: q(5, 3, 1, 1), a2: q(1, 1, 0, 0) };
  assert.deepEqual(validateFinalize(asgs, items, { status: 'limpio' }), { ok: false, pending: [], missingNote: ['a1'], cleaning: null });
  items.a1.note = 'Extraviada en el trabajo';
  assert.equal(validateFinalize(asgs, items, { status: 'limpio' }).ok, true);
  // Solo recambio: la nota es opcional.
  assert.equal(validateFinalize(asgs, { a1: q(5, 3, 2, 0), a2: q(1, 1, 0, 0) }, { status: 'limpio' }).ok, true);
  assert.equal(validateFinalize(asgs, items, null).cleaning, 'pending');
  assert.equal(validateFinalize(asgs, items, { status: null }).cleaning, 'pending');
  assert.equal(validateFinalize(asgs, items, { status: 'requiere_limpieza', note: '  ' }).cleaning, 'note');
  assert.equal(validateFinalize(asgs, items, { status: 'requiere_limpieza', note: 'Grasa en la caja' }).ok, true);
});

test('unidades de una asignación: del último control, o por estado si cambió la cantidad', () => {
  assert.deepEqual(asgUnits(null, 3), { bueno: 0, cambio: 0, faltante: 0, pendiente: 3 });
  assert.deepEqual(asgUnits(q(5, 3, 1, 1), 5), { bueno: 3, cambio: 1, faltante: 1, pendiente: 0 });
  assert.deepEqual(asgUnits(q(5, 3, 1, 1), 6), { bueno: 0, cambio: 0, faltante: 6, pendiente: 0 });
  assert.deepEqual(asgUnits({ state: 'cambio' }, 2), { bueno: 0, cambio: 2, faltante: 0, pendiente: 0 });
});

const NOW = new Date('2026-03-18T15:00:00-03:00'); // semana 3 de marzo

test('alertas por cantidad: faltante y cambio a la vez, consecutiva por recambio y limpieza consecutiva', () => {
  const tA = { techId: 'tA' };
  const kz = { cajaId: 'k1' };
  const data = {
    now: NOW,
    techs: { tA: { name: 'Ana', active: true } },
    cajas: { k1: { name: 'Caja L1' } },
    tools: { llave: { name: 'Llave' }, pinza: { name: 'Pinza' } },
    units: {},
    assignments: {
      a1: { techId: 'tA', toolId: 'llave', active: true, qty: 5 },
      a2: { techId: 'tA', toolId: 'pinza', active: true, qty: 1 },
      a3: { cajaId: 'k1', toolId: 'pinza', active: true, qty: 2 },
    },
    controls: [
      fin('c1', tA, '2026-03-1', '2026-03-02T10:00:00Z', { a1: q(5, 4, 1, 0), a2: q(1, 1, 0, 0) }, { cleaning: { status: 'requiere_limpieza', note: 'grasa' } }),
      fin('c2', tA, '2026-03-2', '2026-03-09T10:00:00Z', { a1: q(5, 2, 2, 1, { note: 'una perdida' }), a2: q(1, 1, 0, 0) }, { cleaning: { status: 'requiere_limpieza', note: 'barro' } }),
      fin('c3', tA, '2026-03-3', '2026-03-16T10:00:00Z', { a1: q(5, 2, 2, 1, { note: 'una perdida' }), a2: q(1, 1, 0, 0) }, { cleaning: { status: 'requiere_limpieza', note: 'aceite' } }),
      fin('k-1', kz, '2026-03-2', '2026-03-09T11:00:00Z', { a3: q(2, 2, 0, 0) }, { cleaning: { status: 'requiere_limpieza', note: '' } }),
      fin('k-2', kz, '2026-03-3', '2026-03-16T11:00:00Z', { a3: q(2, 2, 0, 0) }, { cleaning: { status: 'limpio', note: '' } }),
    ],
    movements: [],
    alertRes: {},
  };
  const a = deriveAlerts(data);
  const keys = a.map((x) => x.key).sort();
  assert.deepEqual(keys, ['cons-a1-c3', 'falt-a1-c3', 'limp-tA-c3'].sort());
  const falt = a.find((x) => x.key === 'falt-a1-c3');
  assert.equal(falt.text, 'Llave, Ana: faltan 1 de 5. una perdida');
  assert.equal(a.find((x) => x.key === 'cons-a1-c3').text, 'Llave, Ana: 2 de 5 para recambio. una perdida');
  const limp = a.find((x) => x.type === 'limpieza');
  assert.deepEqual([limp.techId, limp.sev, limp.title, limp.text], ['tA', 2, 'Requiere limpieza en controles consecutivos', 'Ana. aceite']);
  // Resuelta, no aparece; un control nuevo que también requiere limpieza la vuelve a abrir.
  assert.ok(!deriveAlerts({ ...data, alertRes: { 'limp-tA-c3': {} } }).some((x) => x.type === 'limpieza'));
  // Recambio solo en un control (sin el anterior): alerta de cambio, no consecutiva.
  const one = deriveAlerts({ ...data, controls: [data.controls[2]] });
  assert.ok(one.some((x) => x.key === 'camb-a1-c3'));
  assert.ok(!one.some((x) => x.type === 'limpieza'));
});

test('informe: % en condiciones por unidades, recambio no es faltante, % limpio y pérdidas por línea', () => {
  const S = {
    shifts: [{ id: 'manana', name: 'Mañana', order: 1 }],
    techs: { tA: { name: 'Ana', legajo: '1', shiftId: 'manana', active: true } },
    tools: { llave: { name: 'Llave' }, pinza: { name: 'Pinza' } },
    units: {},
    lineas: { l1: { name: 'Línea 1', kind: 'linea', order: 1 }, l2: { name: 'Sector B', kind: 'sector', order: 2 } },
    cajas: { k1: { name: 'Caja L1', lineaId: 'l1' } },
    assignments: {
      a1: { techId: 'tA', toolId: 'llave', qty: 6, active: true },
      a2: { techId: 'tA', toolId: 'pinza', qty: 2, active: true },
      a3: { cajaId: 'k1', toolId: 'pinza', qty: 2, active: true },
    },
    controls: {
      c1: { techId: 'tA', period: { y: 2026, m: 3, w: 1 }, status: 'finalizado', finishedAt: '2026-03-03T13:00:00.000Z', counts: { bueno: 8, cambio: 0, faltante: 0 }, items: { a1: q(6, 6, 0, 0), a2: q(2, 2, 0, 0) }, cleaning: { status: 'limpio', note: '' } },
      c2: {
        techId: 'tA', period: { y: 2026, m: 3, w: 2 }, status: 'finalizado', finishedAt: '2026-03-10T13:00:00.000Z', counts: { bueno: 4, cambio: 3, faltante: 1 },
        items: { a1: q(6, 3, 2, 1, { note: 'perdida', lineaId: 'l1' }), a2: q(2, 1, 1, 0) }, cleaning: { status: 'requiere_limpieza', note: 'grasa' },
      },
      k1c: { cajaId: 'k1', period: { y: 2026, m: 3, w: 2 }, status: 'finalizado', finishedAt: '2026-03-10T14:00:00.000Z', counts: { bueno: 0, cambio: 2, faltante: 0 }, items: { a3: q(2, 0, 2, 0, { lineaId: 'l2' }) } },
    },
    movements: {},
  };
  const d = deriveState(S, { now: NOW });
  // Estado actual por unidades (del último control).
  assert.deepEqual([d.techInfo.tA.bueno, d.techInfo.tA.cambio, d.techInfo.tA.faltante, d.techInfo.tA.total], [4, 3, 1, 8]);
  const R = computeReport(d, { ym: '2026-03' });
  const r = R.rows[0];
  assert.deepEqual([r.bueno, r.cambio, r.faltante, r.pct], [4, 3, 1, 50]);
  assert.deepEqual([r.limpio, r.sucio, r.pctLimpio], [1, 1, 50]);
  assert.deepEqual([R.totals.pctLimpio, R.shifts[0].pctLimpio], [50, 50]);
  assert.deepEqual(R.lineas, [
    { id: 'l1', name: 'Línea 1', kind: 'linea', faltante: 1, cambio: 2 },
    { id: 'l2', name: 'Sector B', kind: 'sector', faltante: 0, cambio: 2 },
    { id: null, name: 'Sin línea', kind: null, faltante: 0, cambio: 1 },
  ]);
  // Con filtro de técnico, las cajas no entran.
  assert.deepEqual(computeReport(d, { ym: '2026-03', tech: 'tA' }).lineas.map((x) => x.id), ['l1', null]);
  const llave = R.tools.find((x) => x.id === 'llave');
  assert.deepEqual([llave.bueno, llave.cambio, llave.faltante, llave.pendiente], [3, 2, 1, 0]);
  // Sin datos de limpieza: null.
  assert.equal(computeReport(d, { ym: '2026-02' }).totals.pctLimpio, null);
});
