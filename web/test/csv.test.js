// CSV del reporte: comillas como 2.1 y fórmulas neutralizadas (un nombre como `=HYPERLINK(...)`
// no se ejecuta al abrir el archivo en una planilla).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from '../src/features/reportes/csv.js';

test('texto y números sin cambios; comillas solo cuando hacen falta', () => {
  assert.equal(csvCell('Juan Pérez'), 'Juan Pérez');
  assert.equal(csvCell(12), '12');
  assert.equal(csvCell(-3), '-3');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('dijo "hola"'), '"dijo ""hola"""');
  assert.equal(csvCell('dos\nlíneas'), '"dos\nlíneas"');
});

test('una celda de texto que empieza con = + - @ tab o CR lleva un apóstrofo adelante', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+54 11 5555'), "'+54 11 5555");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tTAB'), "'\tTAB");
  assert.equal(csvCell('\rCR'), "\"'\rCR\"");
  assert.equal(csvCell('=HYPERLINK("http://x";"y")'), '"\'=HYPERLINK(""http://x"";""y"")"');
});

test('el texto que no empieza con esos caracteres no cambia', () => {
  assert.equal(csvCell('a=b'), 'a=b');
  assert.equal(csvCell(' =1'), ' =1');
  assert.equal(csvCell('Ana-María'), 'Ana-María');
});
