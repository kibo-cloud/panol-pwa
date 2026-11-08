import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTech, cleanName, cleanCode, cleanDay, validDay, findDuplicate, legajoTaken } from '../../src/domain/catalog.js';

test('técnico: nombre de 3+ caracteres, legajo obligatorio y límites LIM', () => {
  assert.deepEqual(cleanTech({ name: '  Ana Prueba ', legajo: ' 12 ' }), { name: 'Ana Prueba', legajo: '12' });
  assert.throws(() => cleanTech({ name: 'An', legajo: '1' }), /Ingresá nombre y apellido/);
  assert.throws(() => cleanTech({ name: 'Ana Prueba', legajo: ' ' }), /Ingresá el legajo/);
  assert.throws(() => cleanTech({ name: 'x'.repeat(121), legajo: '1' }), /hasta 120/);
  assert.throws(() => cleanTech({ name: 'Ana Prueba', legajo: '1'.repeat(51) }), /hasta 50/);
});

test('duplicados sin distinguir mayúsculas ni espacios, excepto el propio registro', () => {
  const rows = [{ id: 't1', legajo: 'AB-1', name: 'Ana' }, { id: 't2', legajo: null, name: 'Beto' }];
  assert.equal(findDuplicate(rows, 'legajo', ' ab-1 ').id, 't1');
  assert.equal(findDuplicate(rows, 'legajo', 'ab-1', 't1'), null);
  const e = legajoTaken('ab-1', 'Ana');
  assert.equal(e.status, 409);
  assert.equal(e.message, 'El legajo ab-1 ya pertenece a Ana.');
});

test('nombres, códigos y fechas', () => {
  assert.equal(cleanName(' Turno A '), 'Turno A');
  assert.throws(() => cleanName('A'), /Ingresá un nombre/);
  assert.throws(() => cleanCode(''), /Ingresá el código/);
  assert.throws(() => cleanCode('x'.repeat(61)), /hasta 60/);
  assert.equal(validDay('2026-02-28'), true);
  assert.equal(validDay('2026-02-30'), false);
  assert.equal(validDay('2026-2-1'), false);
  assert.equal(cleanDay(''), null);
  assert.throws(() => cleanDay('2026-13-01'), /no es válida/);
});
