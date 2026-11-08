import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodOf, pkeyOf, pnumOf, parsePkey, prevP, weekRange, localDateISO, plabel } from '../../src/domain/period.js';

test('periodOf usa la fecha local de Buenos Aires, no la UTC', () => {
  // 2026-03-08 01:30 UTC es 2026-03-07 22:30 en Buenos Aires: día 7, semana 1.
  assert.deepEqual(periodOf(new Date('2026-03-08T01:30:00Z')), { y: 2026, m: 3, w: 1 });
  assert.deepEqual(periodOf(new Date('2026-03-08T03:00:00Z')), { y: 2026, m: 3, w: 2 });
});

test('semana = min(4, ceil(día/7))', () => {
  const at = (d) => periodOf(new Date(`2026-01-${String(d).padStart(2, '0')}T12:00:00-03:00`)).w;
  assert.deepEqual([1, 7, 8, 14, 15, 21, 22, 28, 29, 31].map(at), [1, 1, 2, 2, 3, 3, 4, 4, 4, 4]);
});

test('cambio de año en hora local', () => {
  assert.deepEqual(periodOf(new Date('2027-01-01T02:59:59Z')), { y: 2026, m: 12, w: 4 });
  assert.deepEqual(periodOf(new Date('2027-01-01T03:00:00Z')), { y: 2027, m: 1, w: 1 });
});

test('pkey, pnum y parse', () => {
  const p = { y: 2026, m: 3, w: 2 };
  assert.equal(pkeyOf(p), '2026-03-2');
  assert.equal(pnumOf(p), 2026032);
  assert.deepEqual(parsePkey('2026-03-2'), p);
});

test('período anterior', () => {
  assert.deepEqual(prevP({ y: 2026, m: 3, w: 2 }), { y: 2026, m: 3, w: 1 });
  assert.deepEqual(prevP({ y: 2026, m: 3, w: 1 }), { y: 2026, m: 2, w: 4 });
  assert.deepEqual(prevP({ y: 2026, m: 1, w: 1 }), { y: 2025, m: 12, w: 4 });
});

test('weekRange: la semana 4 llega hasta fin de mes, en hora local', () => {
  const [a, b] = weekRange({ y: 2026, m: 2, w: 4 });
  assert.equal(a.toISOString(), '2026-02-22T03:00:00.000Z');
  assert.equal(b.toISOString(), '2026-03-01T02:59:59.999Z');
  const [c, d] = weekRange({ y: 2026, m: 1, w: 1 });
  assert.equal(c.toISOString(), '2026-01-01T03:00:00.000Z');
  assert.equal(d.toISOString(), '2026-01-08T02:59:59.999Z');
});

test('fecha local ISO y etiqueta', () => {
  assert.equal(localDateISO(new Date('2026-03-08T01:30:00Z')), '2026-03-07');
  assert.equal(plabel({ y: 2026, m: 3, w: 2 }), 'Semana 2 de marzo 2026');
});
