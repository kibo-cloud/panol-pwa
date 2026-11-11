// Importar Excel (etapa 9): grupos de casos, decisiones locales contra las de la última vista
// previa y totales, sin DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCases, CASE_INFO, decisionsOf, sameDecisions, setDecision, setGroupDecision, totalsRows, checkFile, toBase64, MAX_EXCEL_BYTES } from '../src/state/excelimport.js';

const cases = [
  { id: 'tec:l0', type: 'tecnico_nuevo', skippable: true, defaultDecision: 'accept', decision: 'accept', message: 'a' },
  { id: 'tec:l1', type: 'conflicto', skippable: false, decision: null, message: 'b' },
  { id: 'aj:l0:t0', type: 'ajuste', skippable: true, defaultDecision: 'accept', decision: 'accept', message: 'c' },
  { id: 'aj:l0:t1', type: 'ajuste', skippable: true, defaultDecision: 'accept', decision: 'skip', message: 'd' },
  { id: 'fal:l0:c7:t0', type: 'faltante', skippable: false, decision: null, message: 'e' },
];

test('grupos en el orden de los tipos, con cantidades y omitidos', () => {
  const g = groupCases(cases, {});
  assert.deepEqual(g.map((x) => [x.type, x.cases.length, x.skippable, x.skipped]), [['conflicto', 1, false, 0], ['tecnico_nuevo', 1, true, 0], ['ajuste', 2, true, 1], ['faltante', 1, false, 0]]);
  assert.ok(g.every((x) => CASE_INFO[x.type] && x.label));
  // Una decisión local cambia lo que se muestra.
  assert.equal(groupCases(cases, { 'aj:l0:t0': 'skip' })[2].skipped, 2);
});

test('decisiones: las elegidas a mano (aunque coincidan con el valor por defecto) y la comparación con la última vista previa', () => {
  let local = {};
  local = setDecision(local, cases, 'aj:l0:t0', 'skip');
  local = setDecision(local, cases, 'fal:l0:c7:t0', 'skip');
  assert.deepEqual(local, { 'aj:l0:t0': 'skip' });
  local = setGroupDecision(local, cases, 'ajuste', 'accept');
  assert.deepEqual(decisionsOf(local), { 'aj:l0:t0': 'accept', 'aj:l0:t1': 'accept' });
  assert.equal(sameDecisions({ a: 'skip' }, { a: 'skip' }), true);
  assert.equal(sameDecisions({ a: 'skip' }, {}), false);
});

test('totales para mostrar, sin los ceros', () => {
  const rows = totalsRows({ techsCreate: 3, techsAttach: 0, toolsCreate: 5, controls: 10, corrections: 1, novedades: 0 });
  assert.deepEqual(rows.map((r) => r[1]), [3, 5, 10, 1]);
  assert.ok(rows.every((r) => typeof r[0] === 'string'));
});

test('archivo: extensión, tamaño y base64', () => {
  assert.equal(checkFile({ name: 'datos.xlsm', size: 1000 }), null);
  assert.equal(checkFile({ name: 'DATOS.XLSX', size: 1000 }), null);
  assert.match(checkFile({ name: 'datos.txt', size: 10 }), /xlsx o .xlsm/);
  assert.match(checkFile({ name: 'a.xlsx', size: MAX_EXCEL_BYTES + 1 }), /MB/);
  const bytes = new Uint8Array(70000).map((_, i) => i % 256);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
});
