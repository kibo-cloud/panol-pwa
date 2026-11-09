// Etapa 5: lo eliminado (archivado) no aparece en listas ni selectores pero sigue para el
// historial; una reposición anulada ya no es una devolución pendiente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../src/state/derive.js';
import { mvLabel } from '../src/state/constants.js';

const S = {
  derived: { cur: { y: 2026, m: 3, w: 2 } },
  plantillas: {}, shifts: [],
  techs: { t1: { name: 'Ana', active: true }, t2: { name: 'Beto', active: false, archived: true, archivedAt: '2026-03-01T00:00:00Z' } },
  cajas: { k1: { name: 'Caja vieja', archived: true, archivedAt: '2026-03-01T00:00:00Z' } },
  categories: { c1: { name: 'Manuales', order: 1 }, c2: { name: 'Vieja', order: 2, archived: true } },
  tools: { h1: { name: 'Pinza', categoryId: 'c1', order: 1 }, h2: { name: 'Martillo', categoryId: 'c1', order: 2, archived: true, active: false } },
  units: {}, assignments: {}, controls: {}, alertRes: {}, especialidades: {}, kits: { kb: { name: 'Kit base', items: [] }, kx: { name: 'Kit X', especialidadId: 'e1', items: [], archived: true } }, lineas: {},
  movements: {
    m1: { type: 'reposicion', techId: 't1', toolId: 'h1', returned: false, at: '2026-03-02T10:00:00Z', transfers: [] },
    m2: { type: 'reposicion', techId: 't1', toolId: 'h1', returned: false, at: '2026-03-03T10:00:00Z', transfers: [] },
    v1: { type: 'anulacion', voidsMovementId: 'm2', techId: 't1', toolId: 'h1', at: '2026-03-04T10:00:00Z', transfers: [] },
  },
};

test('listas y selectores sin lo eliminado; resúmenes para todos', () => {
  const d = deriveState(S);
  assert.deepEqual(d.techs.map((t) => t.id), ['t1']);
  assert.deepEqual(d.allTechs.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(d.cajas, []);
  assert.deepEqual(d.cats.map((c) => c.id), ['c1']);
  assert.deepEqual(d.tools.map((t) => t.id), ['h1']);
  assert.deepEqual(d.kits.map((k) => k.id), ['kb']);
  assert.ok(d.techInfo.t2 && d.cajaInfo.k1);
});

test('anulaciones: marca del original y devoluciones pendientes', () => {
  const d = deriveState(S);
  assert.deepEqual(d.voidedBy, { m2: 'v1' });
  assert.deepEqual(d.pendingReturns.map((m) => m.id), ['m1']);
  assert.equal(mvLabel('anulacion'), 'Anulación');
  assert.equal(mvLabel('devolucion'), 'Devolución');
});
