// Etapa 6: reglas puras de las novedades (comentario, temas, vínculo, edición y filtros).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanNovedad, checkLinkable, canEditNovedad, parseNovedadFilters, editChanges, novedadLabel, LINKABLE_TYPES,
} from '../../src/domain/novedades.js';

test('comentario obligatorio, recortado y con límite; temas opcionales e independientes', () => {
  assert.throws(() => cleanNovedad({ comment: '   ' }), (e) => e.code === 'comment_required' && e.status === 422);
  assert.throws(() => cleanNovedad({}), (e) => e.code === 'comment_required');
  assert.throws(() => cleanNovedad({ comment: 'x'.repeat(2001) }), /hasta 2000/);
  assert.deepEqual(cleanNovedad({ comment: '  Faltó la pinza  ' }), { comment: 'Faltó la pinza', techId: null, plantillaId: null, lineaId: null });
  assert.deepEqual(cleanNovedad({ comment: 'x', techId: 't-ana', lineaId: 'ln-1' }), { comment: 'x', techId: 't-ana', plantillaId: null, lineaId: 'ln-1' });
  assert.equal(cleanNovedad({ comment: 'x'.repeat(2000) }).comment.length, 2000);
});

test('edición parcial: solo lo que viene; null quita un tema', () => {
  assert.deepEqual(cleanNovedad({ techId: null }, { partial: true }), { techId: null });
  assert.deepEqual(cleanNovedad({ comment: ' Otro ' }, { partial: true }), { comment: 'Otro' });
  assert.throws(() => cleanNovedad({ comment: '' }, { partial: true }), (e) => e.code === 'comment_required');
  assert.deepEqual(cleanNovedad({}, { partial: true }), {});
});

test('solo se vincula una entrega o una reposición que no sea una anulación ni esté anulada', () => {
  assert.deepEqual(LINKABLE_TYPES, ['entrega_inicial', 'adicional', 'reposicion']);
  for (const type of LINKABLE_TYPES) assert.doesNotThrow(() => checkLinkable({ id: 'm1', type }, null));
  for (const type of ['devolucion', 'retiro', 'ingreso', 'baja', 'recepcion']) {
    assert.throws(() => checkLinkable({ id: 'm1', type }, null), (e) => e.code === 'invalid_movement' && e.status === 422, type);
  }
  assert.throws(() => checkLinkable({ id: 'm1', type: 'anulacion', voidsMovementId: 'm0' }, null), (e) => e.code === 'invalid_movement');
  assert.throws(() => checkLinkable({ id: 'm1', type: 'entrega_inicial' }, 'm2'), (e) => e.code === 'movement_voided' && e.status === 409);
  assert.throws(() => checkLinkable(null, null), (e) => e.code === 'not_found' && e.status === 404);
});

test('edita el autor (con permiso de cargar) o quien tiene novedades_edit', () => {
  const n = { authorId: 'u-a' };
  assert.equal(canEditNovedad({ id: 'u-a' }, n, { create: true, edit: false }), true);
  assert.equal(canEditNovedad({ id: 'u-a' }, n, { create: false, edit: false }), false);
  assert.equal(canEditNovedad({ id: 'u-b' }, n, { create: true, edit: false }), false);
  assert.equal(canEditNovedad({ id: 'u-b' }, n, { create: false, edit: true }), true);
});

test('cambios de una edición con los valores anteriores', () => {
  const cur = { comment: 'Viejo', techId: 't-ana', plantillaId: null, lineaId: 'ln-1' };
  assert.deepEqual(editChanges(cur, { comment: 'Viejo', techId: 't-ana' }), {});
  assert.deepEqual(editChanges(cur, { comment: 'Nuevo', lineaId: null, plantillaId: 'manana' }), {
    comment: { from: 'Viejo', to: 'Nuevo' }, lineaId: { from: 'ln-1', to: null }, plantillaId: { from: null, to: 'manana' },
  });
});

test('etiqueta corta para la confirmación de la eliminación definitiva', () => {
  assert.equal(novedadLabel(12), 'Novedad 12');
  assert.equal(novedadLabel('7'), 'Novedad 7');
});

test('filtros: período local, temas, autor, texto, vínculo, eliminadas, página', () => {
  assert.deepEqual(parseNovedadFilters({}), {
    from: null, to: null, techId: null, plantillaId: null, lineaId: null, authorId: null, movementId: null, purchaseRequestId: null, q: '', linked: null, archived: 'exclude', limit: 50, before: null,
  });
  const f = parseNovedadFilters({ from: '2026-11-01', to: '2026-11-30', techId: 't-ana', q: '  pinza ', linked: 'yes', archived: 'include', limit: '10', before: '2026-11-10T12:00:00.000Z|nv1' });
  assert.equal(f.from, '2026-11-01');
  assert.equal(f.to, '2026-11-30');
  assert.equal(f.q, 'pinza');
  assert.equal(f.linked, true);
  assert.equal(f.archived, 'include');
  assert.equal(f.limit, 10);
  assert.deepEqual(f.before, { at: '2026-11-10T12:00:00.000Z', id: 'nv1' });
  assert.equal(parseNovedadFilters({ linked: 'no' }).linked, false);
  assert.equal(parseNovedadFilters({ limit: '999' }).limit, 200);
  assert.throws(() => parseNovedadFilters({ from: '2026-11-31' }), (e) => e.code === 'invalid_date');
  assert.throws(() => parseNovedadFilters({ from: '2026-11-10', to: '2026-11-01' }), (e) => e.code === 'invalid_range');
  assert.throws(() => parseNovedadFilters({ before: 'x' }), (e) => e.code === 'invalid_cursor');
});
