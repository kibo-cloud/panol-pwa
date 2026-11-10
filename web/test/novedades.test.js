// Etapa 6: piezas puras de Novedades (consulta de la lista, quién edita, qué movimiento se
// vincula y cómo se nombran los temas eliminados).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novQuery, canEditNov, linkableMv, novSubjects, NOV_EMPTY, activeFilters } from '../src/state/novedades.js';

test('la consulta solo lleva los filtros cargados', () => {
  assert.equal(novQuery(NOV_EMPTY), '');
  assert.equal(novQuery({ ...NOV_EMPTY, q: '  pinza ', techId: 't-ana', linked: 'yes' }), 'techId=t-ana&q=pinza&linked=yes');
  assert.equal(novQuery({ ...NOV_EMPTY, from: '2026-11-01', to: '2026-11-30', archived: true }, { limit: 20, before: 'a|b' }), 'from=2026-11-01&to=2026-11-30&archived=include&limit=20&before=a%7Cb');
  assert.equal(activeFilters(NOV_EMPTY), 0);
  assert.equal(activeFilters({ ...NOV_EMPTY, q: 'x', plantillaId: 'p1' }), 2);
});

test('edita el autor con permiso de cargar, o quien tiene novedades_edit; nunca una eliminada', () => {
  const n = { authorId: 'u1', archived: false };
  const can = (set) => (p) => set.includes(p);
  assert.equal(canEditNov(n, 'u1', can(['novedades_create'])), true);
  assert.equal(canEditNov(n, 'u2', can(['novedades_create'])), false);
  assert.equal(canEditNov(n, 'u2', can(['novedades_edit'])), true);
  assert.equal(canEditNov(n, 'u1', can([])), false);
  assert.equal(canEditNov({ ...n, archived: true }, 'u1', can(['novedades_edit'])), false);
});

test('se vincula una entrega o una reposición que no sea anulación ni esté anulada', () => {
  assert.equal(linkableMv({ type: 'entrega_inicial' }, null), true);
  assert.equal(linkableMv({ type: 'adicional' }, null), true);
  assert.equal(linkableMv({ type: 'reposicion' }, null), true);
  assert.equal(linkableMv({ type: 'reposicion' }, 'v1'), false);
  assert.equal(linkableMv({ type: 'devolucion' }, null), false);
  assert.equal(linkableMv({ type: 'anulacion' }, null), false);
  assert.equal(linkableMv(null, null), false);
});

test('temas con la marca de eliminado', () => {
  assert.deepEqual(novSubjects({ techId: 't1', techName: 'Ana', techArchived: true, plantillaId: 'p1', plantillaName: 'Mañana', lineaId: null }), [
    { kind: 'tech', id: 't1', label: 'Ana (eliminado)', href: '#tecnico-t1' },
    { kind: 'plantilla', id: 'p1', label: 'Mañana', href: '#plantilla-p1' },
  ]);
  assert.deepEqual(novSubjects({ lineaId: 'l1', lineaName: 'Línea 2', lineaArchived: false, lineaKind: 'sector' }), [{ kind: 'linea', id: 'l1', label: 'Línea 2', href: '#lineas' }]);
  assert.deepEqual(novSubjects({}), []);
});
