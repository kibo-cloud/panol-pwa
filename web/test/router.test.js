// Rutas por hash, iguales a 2.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, navKeyOf } from '../src/ui/router.js';

test('secciones del menú y Más', () => {
  assert.deepEqual(parseRoute('#inicio'), { name: 'inicio', id: '' });
  assert.deepEqual(parseRoute('#reportes'), { name: 'reportes', id: '' });
  assert.deepEqual(parseRoute('#mas'), { name: 'mas', id: '' });
  assert.deepEqual(parseRoute(''), { name: 'inicio', id: '' });
  assert.deepEqual(parseRoute('#nada'), { name: 'inicio', id: '' });
});
test('detalles con id (el id puede tener guiones)', () => {
  assert.deepEqual(parseRoute('#tecnico-t-ana'), { name: 'tecnico', id: 't-ana' });
  assert.deepEqual(parseRoute('#control-t-ana'), { name: 'ck', id: 't-ana' });
  assert.deepEqual(parseRoute('#control'), { name: 'control', id: '' });
  assert.deepEqual(parseRoute('#controlver-c-t-ana-2026-11-1'), { name: 'ver', id: 'c-t-ana-2026-11-1' });
  assert.deepEqual(parseRoute('#herramienta-tool-x'), { name: 'herramienta', id: 'tool-x' });
  assert.deepEqual(parseRoute('#turno-manana'), { name: 'turno', id: 'manana' });
});
test('la sección marcada de un detalle es la de su lista', () => {
  assert.equal(navKeyOf(parseRoute('#tecnico-t1')), 'tecnicos');
  assert.equal(navKeyOf(parseRoute('#control-t1')), 'control');
  assert.equal(navKeyOf(parseRoute('#controlver-c1')), 'controles');
  assert.equal(navKeyOf(parseRoute('#admin')), 'admin');
});
