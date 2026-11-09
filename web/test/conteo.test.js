// Etapa 4: conteo por cantidad y limpieza en el checklist (mismas reglas que el servidor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemQty, ckSummary, ckWhy, checklistItem, apiItem, asgUnits, cleaningStats, lossesByLinea, qtyText } from '../src/state/conteo.js';
import { nextDraft, requestFor } from '../src/state/drafts.js';

test('cantidades del checklist: botones, buen estado + recambio y pendientes', () => {
  assert.deepEqual(itemQty({ state: 'faltante' }, 1), { good: 0, change: 0, missing: 1 });
  assert.deepEqual(itemQty({ good: 3, change: 1, expected: 5 }, 5), { good: 3, change: 1, missing: 1 });
  assert.equal(itemQty({ good: 3, change: 1, expected: 5 }, 6), null); // cambió la cantidad asignada
  assert.equal(itemQty({ good: 4, change: 2 }, 5), null);
  assert.equal(itemQty(undefined, 2), null);
});

test('resumen y motivo: pendientes, faltante sin motivo, limpieza sin indicar y sin nota', () => {
  const list = [{ id: 'a1', qty: 5 }, { id: 'a2', qty: 1 }];
  const items = { a1: { good: 3, change: 1, expected: 5, note: '' } };
  let c = ckSummary(list, items, { status: null });
  assert.deepEqual([c.bueno, c.cambio, c.faltante, c.pendiente, c.pendUnits, c.noNote, c.alerts], [3, 1, 1, 1, 1, 1, 2]);
  assert.equal(ckWhy(c), 'Falta 1 herramienta por controlar');
  items.a2 = { state: 'cambio', expected: 1 };
  assert.equal(ckWhy(ckSummary(list, items, { status: null })), 'Completá el motivo de 1 faltante');
  items.a1.note = 'Extraviada en el trabajo';
  assert.equal(ckWhy(ckSummary(list, items, { status: null })), 'Indicá la limpieza de herramientas y caja');
  assert.equal(ckWhy(ckSummary(list, items, { status: 'requiere_limpieza', note: ' ' })), 'Completá la nota de limpieza');
  c = ckSummary(list, items, { status: 'requiere_limpieza', note: 'Caja sucia' });
  assert.equal(ckWhy(c), '');
  assert.equal(ckWhy(c, true), 'Sin conexión: el control se finaliza cuando vuelva la conexión');
  // Solo recambio: el motivo es opcional; recambio no cuenta como faltante.
  c = ckSummary([{ id: 'a1', qty: 4 }], { a1: { good: 2, change: 2, expected: 4 } }, { status: 'limpio' });
  assert.deepEqual([c.faltante, c.cambio, c.noNote, ckWhy(c)], [0, 2, 0, '']);
});

test('ítems: del servidor al checklist y al pedido (la línea solo con faltantes o recambios)', () => {
  const srv = { state: 'faltante', expected: 5, qty: 5, good: 3, change: 1, missing: 1, note: 'x', lineaId: 'l1' };
  assert.deepEqual(checklistItem(srv, 5), { note: 'x', lineaId: 'l1', good: 3, change: 1, expected: 5 });
  assert.deepEqual(checklistItem({ state: 'bueno', expected: 1, good: 1, change: 0, missing: 0 }, 1), { note: '', lineaId: null, state: 'bueno', expected: 1 });
  assert.deepEqual(apiItem({ good: 5, change: 0, expected: 5, lineaId: 'l1' }, 5), { good: 5, change: 0, expected: 5, note: '', lineaId: null });
  assert.deepEqual(apiItem({ state: 'cambio', lineaId: 'l1' }, 1), { state: 'cambio', note: '', lineaId: 'l1' });
});

test('unidades, % limpio, pérdidas por línea y texto de cantidades', () => {
  assert.deepEqual(asgUnits({ state: 'faltante', expected: 5, good: 3, change: 1, missing: 1 }, 5), { bueno: 3, cambio: 1, faltante: 1, pendiente: 0 });
  assert.deepEqual(cleaningStats([{ cleaning: { status: 'limpio' } }, { cleaning: { status: 'requiere_limpieza' } }, { cleaning: { status: null } }, {}]), { limpio: 1, sucio: 1, pctLimpio: 50 });
  assert.equal(cleaningStats([]).pctLimpio, null);
  const ctls = [{ items: { a: { state: 'faltante', expected: 5, good: 3, change: 1, missing: 1, lineaId: 'l2' }, b: { state: 'cambio', qty: 1 }, c: { state: 'bueno', expected: 2, good: 2, change: 0, missing: 0 } } }];
  assert.deepEqual(lossesByLinea(ctls, [{ id: 'l1', name: 'L1' }, { id: 'l2', name: 'Sector B', kind: 'sector' }]), [
    { id: 'l2', name: 'Sector B', kind: 'sector', faltante: 1, cambio: 1 },
    { id: null, name: 'Sin línea', kind: null, faltante: 0, cambio: 1 },
  ]);
  assert.equal(qtyText({ expected: 5, good: 3, change: 1, missing: 1 }), '3 bien · 1 para recambio · 1 falta');
  assert.equal(qtyText({ expected: 1, good: 1 }), '');
});

test('borrador sin conexión: lleva cantidades y limpieza; otra limpieza cambia la clave', () => {
  const base = { techId: 't-ana', period: { y: 2026, m: 3, w: 2 }, items: { a1: { good: 2, change: 1, expected: 4, note: 'perdida' } }, cleaning: { status: 'limpio', note: '' } };
  const r1 = nextDraft(null, base, 'k1');
  assert.deepEqual(requestFor(r1).body, { techId: 't-ana', period: base.period, items: base.items, cleaning: base.cleaning });
  assert.equal(nextDraft(r1, base, 'k2').idemKey, 'k1');
  const r3 = nextDraft(r1, { ...base, cleaning: { status: 'requiere_limpieza', note: 'grasa' } }, 'k3');
  assert.equal(r3.idemKey, 'k3');
  const save = requestFor({ ...r3, controlId: 'c1', version: 2 });
  assert.deepEqual([save.kind, save.cleaning.status, save.items.a1.good], ['save', 'requiere_limpieza', 2]);
  // Un borrador guardado antes de la etapa 4 (sin limpieza) se sigue enviando igual.
  assert.ok(!('cleaning' in requestFor(nextDraft(null, { ...base, cleaning: undefined }, 'k4')).body));
});
