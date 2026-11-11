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
  assert.deepEqual(parseRoute('#plantilla-manana'), { name: 'plantilla', id: 'manana' });
  assert.deepEqual(parseRoute('#caja-k-1'), { name: 'caja', id: 'k-1' });
  assert.deepEqual(parseRoute('#control-caja:k-1'), { name: 'ck', id: 'caja:k-1' });
});
test('Turnos queda como alias de Plantillas', () => {
  assert.deepEqual(parseRoute('#turnos'), { name: 'plantillas', id: '' });
  assert.deepEqual(parseRoute('#turno-manana'), { name: 'plantilla', id: 'manana' });
  assert.deepEqual(parseRoute('#lineas'), { name: 'lineas', id: '' });
});
test('la sección marcada de un detalle es la de su lista', () => {
  assert.equal(navKeyOf(parseRoute('#tecnico-t1')), 'tecnicos');
  assert.equal(navKeyOf(parseRoute('#control-t1')), 'control');
  assert.equal(navKeyOf(parseRoute('#controlver-c1')), 'controles');
  assert.equal(navKeyOf(parseRoute('#admin')), 'admin');
  assert.equal(navKeyOf(parseRoute('#plantilla-p1')), 'plantillas');
  assert.equal(navKeyOf(parseRoute('#caja-k1')), 'lineas');
});
test('etapa 10: #auditoria con la selección en la dirección, dentro de Reportes', () => {
  assert.deepEqual(parseRoute('#auditoria'), { name: 'auditoria', id: '' });
  assert.deepEqual(parseRoute('#auditoria-mode=range&d=2026-10&h=2026-11'), { name: 'auditoria', id: 'mode=range&d=2026-10&h=2026-11' });
  assert.equal(navKeyOf(parseRoute('#auditoria-mode=list')), 'reportes');
});
