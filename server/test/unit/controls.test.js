import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveControls, controlHistory, validateFinalize, buildControlDoc } from '../../src/domain/controls.js';
import { deriveAlerts } from '../../src/domain/alerts.js';

const fin = (id, techId, pkey, finishedAt, items, extra = {}) => {
  const [y, m, w] = pkey.split('-').map(Number);
  return { id, techId, pkey, period: { y, m, w }, pnum: y * 1000 + m * 10 + w, status: 'finalizado', finishedAt, items, ...extra };
};

test('control efectivo: el finalizado más reciente por técnico y período (corrección gana)', () => {
  const ctls = [
    fin('c1', 'tA', '2026-03-1', '2026-03-02T10:00:00Z', {}),
    fin('k1', 'tA', '2026-03-1', '2026-03-03T10:00:00Z', {}, { correction: true, supersedes: 'c1' }),
    { id: 'c2', techId: 'tA', pkey: '2026-03-2', status: 'borrador', updatedAt: '2026-03-09T10:00:00Z' },
    fin('c3', 'tB', '2026-03-1', '2026-03-02T11:00:00Z', {}),
  ];
  const r = effectiveControls(ctls);
  assert.equal(r.eff['tA|2026-03-1'].id, 'k1');
  assert.equal(r.eff['tB|2026-03-1'].id, 'c3');
  assert.equal(r.drafts['tA|2026-03-2'].id, 'c2');
  assert.equal(r.supersededBy.c1, 'k1');
  // Mismo período: orden por fecha de finalización.
  assert.deepEqual(r.effList.map((c) => c.id), ['c3', 'k1']);
});

test('historial: estados y transiciones (bueno inicial no es transición)', () => {
  const list = [
    fin('c1', 'tA', '2026-03-1', '2026-03-02T10:00:00Z', { a1: { state: 'bueno' }, a2: { state: 'cambio', note: 'gastada' } }),
    fin('c2', 'tA', '2026-03-2', '2026-03-09T10:00:00Z', { a1: { state: 'faltante', note: 'no está' }, a2: { state: 'cambio' } }),
  ];
  const h = controlHistory(list);
  assert.equal(h.stateOf.a1.state, 'faltante');
  assert.equal(h.stateOf.a1.controlId, 'c2');
  assert.deepEqual(h.hist.a2.map((x) => x.state), ['cambio', 'cambio']);
  assert.deepEqual(h.transitions.map((t) => [t.asgId, t.from, t.to]), [['a2', null, 'cambio'], ['a1', 'bueno', 'faltante']]);
});

test('finalizar: todas con estado y faltante con nota', () => {
  const asgs = [{ id: 'a1' }, { id: 'a2' }];
  // Etapa 4: además la limpieza (ver conteo.test.js).
  const limpio = { status: 'limpio' };
  assert.deepEqual(validateFinalize(asgs, { a1: { state: 'bueno' } }, limpio), { ok: false, pending: ['a2'], missingNote: [], cleaning: null });
  assert.deepEqual(validateFinalize(asgs, { a1: { state: 'bueno' }, a2: { state: 'faltante', note: '  ' } }, limpio), { ok: false, pending: [], missingNote: ['a2'], cleaning: null });
  assert.deepEqual(validateFinalize(asgs, { a1: { state: 'bueno' }, a2: { state: 'faltante', note: 'perdida' } }, limpio), { ok: true, pending: [], missingNote: [], cleaning: null });
  assert.equal(validateFinalize([], {}, limpio).ok, true);
});

test('documento del control: copia de datos y conteos por cantidad', () => {
  const doc = buildControlDoc({
    tech: { id: 'tA', name: 'Ana', shiftId: 'manana' },
    period: { y: 2026, m: 3, w: 2 },
    assignments: [{ id: 'a1', toolId: 'pinza', qty: 3 }, { id: 'a2', toolId: 'taladro', unitId: 'u1', qty: 1 }, { id: 'a3', toolId: 'pinza', qty: 1 }],
    items: { a1: { state: 'cambio', note: ' gastada ' }, a2: { state: 'bueno' } },
    tools: { pinza: { name: 'Pinza', categoryId: 'c1' }, taladro: { name: 'Taladro', categoryId: null } },
    units: { u1: { code: 'TAL-001' } },
    categories: { c1: { name: 'Manuales' } },
    status: 'borrador',
  });
  assert.equal(doc.pkey, '2026-03-2');
  assert.equal(doc.pnum, 2026032);
  assert.deepEqual(doc.counts, { bueno: 1, cambio: 3, faltante: 0 });
  assert.deepEqual(doc.items.a1, {
    state: 'cambio', note: 'gastada', toolId: 'pinza', toolName: 'Pinza', category: 'Manuales', unitId: null, unitCode: null, qty: 3,
    expected: 3, good: 0, change: 3, missing: 0, lineaId: null,
  });
  assert.equal(doc.items.a2.unitCode, 'TAL-001');
  assert.equal(doc.items.a3, undefined);
  assert.equal(doc.correction, false);
});

test('alertas: pendiente, faltante, cambio, consecutiva y devolución; resueltas no aparecen', () => {
  const data = {
    now: new Date('2026-03-10T12:00:00-03:00'), // semana 2 de marzo
    techs: { tA: { name: 'Ana', active: true }, tB: { name: 'Beto', active: true }, tC: { name: 'Caro', active: false } },
    tools: { pinza: { name: 'Pinza' }, taladro: { name: 'Taladro' } },
    units: { u1: { code: 'TAL-001' } },
    assignments: {
      a1: { techId: 'tA', toolId: 'pinza', active: true, qty: 1 },
      a2: { techId: 'tA', toolId: 'taladro', unitId: 'u1', active: true, qty: 1 },
      a3: { techId: 'tB', toolId: 'pinza', active: true, qty: 1 },
      a4: { techId: 'tC', toolId: 'pinza', active: true, qty: 1 },
    },
    controls: [
      fin('c1', 'tA', '2026-03-1', '2026-03-02T10:00:00Z', { a1: { state: 'cambio' }, a2: { state: 'bueno' } }),
      fin('c2', 'tA', '2026-03-2', '2026-03-09T10:00:00Z', { a1: { state: 'cambio', note: 'rota' }, a2: { state: 'faltante', note: 'perdida' } }),
      fin('c3', 'tB', '2026-03-1', '2026-03-02T10:00:00Z', { a3: { state: 'cambio' } }),
      fin('c4', 'tC', '2026-03-1', '2026-03-02T10:00:00Z', { a4: { state: 'faltante', note: 'x' } }),
    ],
    movements: [
      { id: 'm1', type: 'reposicion', techId: 'tB', toolId: 'pinza', returned: false, at: '2026-03-05T10:00:00Z' },
      { id: 'm2', type: 'reposicion', techId: 'tB', toolId: 'pinza', returned: false, at: '2026-03-05T11:00:00Z' },
      { id: 'm3', type: 'recepcion', resolvesMovementId: 'm2', at: '2026-03-06T10:00:00Z' },
    ],
    alertRes: { 'camb-a3-c3': { at: '2026-03-04T10:00:00Z' } },
  };
  const a = deriveAlerts(data);
  const keys = a.map((x) => x.key).sort();
  assert.deepEqual(keys, ['cons-a1-c2', 'dev-m1', 'falt-a2-c2', 'pend-tB-2026-03-2'].sort());
  // Orden: severidad descendente.
  assert.deepEqual(a.map((x) => x.sev), [...a.map((x) => x.sev)].sort((p, q) => q - p));
  const falt = a.find((x) => x.type === 'faltante');
  assert.equal(falt.text, 'Taladro (TAL-001), Ana. perdida');
  assert.equal(a.find((x) => x.type === 'pendiente').title, 'Control pendiente');
});
