// Etapa 10: selección del informe de auditoría en la dirección, consulta a la API y el Excel
// (una hoja por sección y una por poseedor en formato planilla), con el informe que arma el
// servidor sobre los datos inventados compartidos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../../server/src/domain/derive.js';
import { buildAuditReport, parseAuditSelection } from '../../server/src/domain/auditoria.js';
import { fixture, ctxOf, NOW } from '../../server/test/fixtures/auditoria.js';
import { defaultSel, encodeSel, decodeSel, selQuery, selMonths, auditWorkbook, sheetName, half, chunk, monthOptions, RESOLUTION_TONE } from '../src/state/auditoria.js';

const report = (q = {}) => {
  const S = fixture();
  return buildAuditReport(deriveState(S, { now: NOW }), ctxOf(S), parseAuditSelection({ months: '2026-10,2026-11', ...q }, { now: NOW }));
};

test('selección: por defecto el mes en curso, todo y todas las secciones; ida y vuelta por la dirección', () => {
  const s = defaultSel({ y: 2026, m: 11 });
  assert.deepEqual(selMonths(s), ['2026-11']);
  assert.equal(s.sections.length, 8);
  const r = { ...s, mode: 'range', from: '2026-09', to: '2026-11', plantillas: ['manana'], techs: ['t:1', 't-2'], cajas: 'none', sections: ['resumen', 'firmas'], planilla: true };
  const h = encodeSel(r);
  assert.ok(!/[\s#]/.test(h), h);
  assert.deepEqual(decodeSel(h), r);
  assert.deepEqual(selMonths(r), ['2026-09', '2026-10', '2026-11']);
  const l = { ...s, mode: 'list', months: ['2026-11', '2026-03'] };
  assert.deepEqual(selMonths(decodeSel(encodeSel(l))), ['2026-03', '2026-11']);
  assert.equal(decodeSel('basura'), null);
  assert.equal(decodeSel(''), null);
  assert.equal(selQuery(r), 'months=2026-09%2C2026-10%2C2026-11&plantillas=manana&techs=t%3A1%2Ct-2&cajas=none&sections=resumen%2Cfirmas');
  assert.deepEqual(monthOptions({ y: 2026, m: 2 }, 3).map((x) => x.key), ['2026-02', '2026-01', '2025-12']);
});

test('ayudas: 0,5 con coma, hojas con nombre válido y único, partes', () => {
  assert.equal(half(1.5), '1,5');
  assert.equal(half(2), '2');
  assert.equal(half(null), '');
  const used = new Set();
  assert.equal(sheetName('Resumen', used), 'Resumen');
  assert.equal(sheetName('Resumen', used), 'Resumen (2)');
  assert.equal(sheetName('A/B:C*D?[E]\\F que es un nombre muy largo de verdad', used).length <= 31, true);
  assert.ok(!/[/\\:*?[\]]/.test(sheetName('a/b', used)));
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('Excel: una hoja por sección y una por poseedor en formato planilla', () => {
  const R = report();
  const wb = auditWorkbook(R);
  const names = wb.map((s) => s.name);
  assert.deepEqual(names.slice(0, 6), ['Resumen', 'Faltantes', 'Movimientos', 'Compras', 'Novedades', 'Plantillas']);
  assert.ok(names.includes('Ana') && names.includes('Xenia (eliminado)') && names.includes('Caja L1'), names.join(','));
  const ana = wb.find((s) => s.name === 'Ana').rows;
  assert.ok(ana.some((r) => r.includes('ENTREGA') && r.includes('DEVOLUCIÓN') && r.includes('CONTEO') && r[r.length - 1] === 'SALDO'));
  const llave = ana.find((r) => r[1] === 'Llave');
  assert.deepEqual(llave.slice(2), [3, '', 2, '', 0.5, 1.5, -1], 'SALDO = 1,5 − (3 − 0,5): falta una llave');
  assert.equal(RESOLUTION_TONE.parcial, 'warn');
  const comp = wb.find((s) => s.name === 'Compras').rows;
  assert.ok(comp[0][0].includes("Villa D'agri"));
  assert.ok(comp.some((r) => r.includes('Hay en el pañol')));
  assert.ok(comp.some((r) => r.includes('Costo estimado')));
  // Sin costos: la columna no está.
  const S = fixture();
  const R2 = buildAuditReport(deriveState(S, { now: NOW }), ctxOf(S, { perms: { purchasesView: false, novedadesView: false } }), parseAuditSelection({ months: '2026-10,2026-11' }, { now: NOW }));
  const wb2 = auditWorkbook(R2);
  assert.ok(!wb2.find((s) => s.name === 'Compras').rows.some((r) => r.includes('Costo estimado')));
  assert.ok(!wb2.some((s) => s.name === 'Novedades'), 'sin novedades_view no hay hoja de novedades');
  // Solo las secciones elegidas.
  const wb3 = auditWorkbook(report({ sections: 'resumen,firmas' }));
  assert.deepEqual(wb3.map((s) => s.name), ['Resumen']);
});
