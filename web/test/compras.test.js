// Etapa 7: piezas puras del apartado de Gerencia (estados, filtros, importes, compras de una
// herramienta, compras recibidas para la reposición y acciones posibles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CMP_ST, CMP_REASON, CMP_EMPTY, cmpQuery, activeCmpFilters, money, parseCost, pendingCount, toolPurchases, receivableFor, cmpActions, alertPurchase, TL_LABEL,
} from '../src/state/compras.js';

test('estados y motivos con texto e ícono (además del color)', () => {
  assert.deepEqual(Object.keys(CMP_ST), ['pendiente', 'aprobada', 'rechazada', 'comprada', 'recibida']);
  for (const s of Object.values(CMP_ST)) assert.ok(s.label && s.cls && s.ic);
  assert.deepEqual(CMP_REASON, { cambio: 'Dañada (cambio)', faltante: 'Extraviada (faltante)' });
  assert.equal(TL_LABEL.purchase_approve, 'Aprobada');
});

test('query de la lista: solo los filtros cargados; el poseedor elige técnico o caja', () => {
  assert.equal(cmpQuery(CMP_EMPTY), '');
  assert.equal(cmpQuery({ ...CMP_EMPTY, status: 'pendiente', holder: 't-ana', q: ' pinza ' }, { limit: 30 }), 'status=pendiente&q=pinza&techId=t-ana&limit=30');
  assert.equal(cmpQuery({ ...CMP_EMPTY, holder: 'caja:k1', month: '2026-11', archived: true }, { before: 'a|b' }), 'month=2026-11&cajaId=k1&archived=include&before=a%7Cb');
  assert.equal(cmpQuery(CMP_EMPTY, { scope: 'receive' }), 'scope=receive');
  assert.equal(activeCmpFilters({ ...CMP_EMPTY, reason: 'cambio', holder: 't-ana', archived: true }), 3);
});

test('importes en pesos y costo estimado con coma o punto', () => {
  assert.equal(money(1500.5), '$ 1.500,50');
  assert.equal(money(0), '$ 0,00');
  assert.equal(money(null), 'Sin costo');
  assert.equal(parseCost(''), null);
  assert.equal(parseCost(' 1500,5 '), '1500.5');
  assert.equal(parseCost('1500.50'), '1500.50');
  for (const v of ['1.500,50', '-3', 'abc', '1,555']) assert.throws(() => parseCost(v), /importe/, v);
});

const SUM = [
  { id: 'p1', status: 'pendiente', reason: 'faltante', toolId: 'tool-a', assignmentId: 'a1', techId: 't1', cajaId: null },
  { id: 'p2', status: 'recibida', reason: 'cambio', toolId: 'tool-a', assignmentId: 'a2', techId: 't1', cajaId: null, receivedQty: 1 },
  { id: 'p3', status: 'recibida', reason: 'cambio', toolId: 'tool-a', assignmentId: null, techId: null, cajaId: null, receivedQty: 2 },
  { id: 'p4', status: 'recibida', reason: 'cambio', toolId: 'tool-a', assignmentId: 'a9', techId: null, cajaId: 'k1' },
  { id: 'p5', status: 'rechazada', reason: 'cambio', toolId: 'tool-b', assignmentId: 'a3', techId: 't2', decisionComment: 'No' },
  { id: 'p6', status: 'pendiente', reason: 'cambio', toolId: 'tool-b', assignmentId: 'a4', techId: 't2' },
];

test('pendientes, compras de una herramienta y recibidas para la reposición del poseedor', () => {
  assert.equal(pendingCount(SUM), 2);
  assert.deepEqual(toolPurchases(SUM, 'tool-b').map((p) => p.id), ['p5', 'p6']);
  assert.deepEqual(receivableFor(SUM, 't1', 'tool-a').map((p) => p.id), ['p2', 'p3']);
  assert.deepEqual(receivableFor(SUM, 'caja:k1', 'tool-a').map((p) => p.id), ['p3', 'p4']);
  assert.deepEqual(receivableFor(SUM, 't1', 'tool-b'), []);
});

test('la compra de una alerta: la abierta o la rechazada, con su texto', () => {
  assert.equal(alertPurchase(null), null);
  assert.deepEqual(alertPurchase({ id: 'p5', name: 'Compra 5', status: 'rechazada', decisionComment: 'Hay stock' }), { cls: 'bad', ic: 'x', label: 'Compra rechazada', detail: 'Motivo: Hay stock', href: '#compra-p5' });
  assert.equal(alertPurchase({ id: 'p1', name: 'Compra 1', status: 'pendiente' }).label, 'Compra pendiente');
});

test('acciones según el estado y los permisos', () => {
  const can = (set) => (k) => set.includes(k);
  const ger = can(['purchases_view', 'purchases_decide']);
  const resp = can(['purchases_create', 'purchases_receive']);
  assert.deepEqual(cmpActions({ status: 'pendiente' }, ger), { approve: true, reject: true, purchase: false, receive: false, edit: true, qty: true });
  assert.deepEqual(cmpActions({ status: 'aprobada' }, resp), { approve: false, reject: false, purchase: true, receive: true, edit: true, qty: false });
  assert.deepEqual(cmpActions({ status: 'comprada' }, ger), { approve: false, reject: false, purchase: false, receive: false, edit: true, qty: false });
  assert.deepEqual(cmpActions({ status: 'recibida' }, resp), { approve: false, reject: false, purchase: false, receive: false, edit: false, qty: false });
  assert.deepEqual(cmpActions({ status: 'pendiente', archived: true }, ger), { approve: false, reject: false, purchase: false, receive: false, edit: false, qty: false });
});
