// Etapa 7: reglas puras de las solicitudes de compra (estados, pérdidas de un control, creación
// automática sin duplicados, costo, alta manual y filtros).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PURCHASE_STATUSES, OPEN_STATUSES, checkTransition, cleanDecision, cleanCost, cleanManualPurchase, lossesOf, countedPairs,
  planAutoPurchases, parsePurchaseFilters, purchaseLabel, sameKey, stripCosts, stripCostText, COST_MARK,
} from '../../src/domain/compras.js';

test('estados: pendiente -> aprobada | rechazada; aprobada -> comprada -> recibida (o recibida directo)', () => {
  assert.deepEqual(PURCHASE_STATUSES, ['pendiente', 'aprobada', 'rechazada', 'comprada', 'recibida']);
  assert.deepEqual(OPEN_STATUSES, ['pendiente', 'aprobada', 'comprada']);
  assert.equal(checkTransition({ status: 'pendiente' }, 'approve'), 'aprobada');
  assert.equal(checkTransition({ status: 'pendiente' }, 'reject'), 'rechazada');
  assert.equal(checkTransition({ status: 'aprobada' }, 'purchase'), 'comprada');
  assert.equal(checkTransition({ status: 'aprobada' }, 'receive'), 'recibida');
  assert.equal(checkTransition({ status: 'comprada' }, 'receive'), 'recibida');
  for (const [status, action] of [['aprobada', 'approve'], ['rechazada', 'approve'], ['recibida', 'receive'], ['pendiente', 'purchase'], ['pendiente', 'receive'], ['comprada', 'reject'], ['rechazada', 'receive']]) {
    assert.throws(() => checkTransition({ status }, action), (e) => e.code === 'invalid_transition' && e.status === 409, `${status} ${action}`);
  }
  assert.throws(() => checkTransition({ status: 'pendiente', archived: true }, 'approve'), (e) => e.code === 'archived' && e.status === 409);
  assert.throws(() => checkTransition({ status: 'pendiente' }, 'otra'), (e) => e.status === 400);
});

test('rechazar pide comentario; aprobar lo tiene opcional', () => {
  assert.throws(() => cleanDecision('reject', {}), (e) => e.code === 'comment_required' && e.status === 422);
  assert.throws(() => cleanDecision('reject', { comment: '   ' }), (e) => e.code === 'comment_required');
  assert.deepEqual(cleanDecision('reject', { comment: '  Hay stock en otra planta  ' }), { comment: 'Hay stock en otra planta' });
  assert.deepEqual(cleanDecision('approve', {}), { comment: '' });
  assert.throws(() => cleanDecision('approve', { comment: 'x'.repeat(2001) }), /hasta 2000/);
});

test('costo estimado opcional en pesos, con hasta dos decimales', () => {
  for (const v of [undefined, null, '']) assert.equal(cleanCost(v), null);
  assert.equal(cleanCost(1500), '1500.00');
  assert.equal(cleanCost('1500.5'), '1500.50');
  assert.equal(cleanCost('0'), '0.00');
  assert.equal(cleanCost(9999999999.99), '9999999999.99');
  for (const v of [-1, '1,5', '1.555', 'abc', 1e21, '12345678901', Infinity]) assert.throws(() => cleanCost(v), (e) => e.code === 'invalid_cost' && e.status === 422, String(v));
});

test('alta manual: motivo, cantidad, proveedor y observación', () => {
  const v = cleanManualPurchase({ toolId: 'tool-pinza', reason: 'faltante', qty: 2, estimatedCost: '100', supplier: '  Ferretería  ', observation: ' Se perdió ' });
  assert.deepEqual(v, { toolId: 'tool-pinza', assignmentId: null, reason: 'faltante', qty: 2, estimatedCost: '100.00', supplier: 'Ferretería', observation: 'Se perdió', origin: 'tool', alertKey: null });
  assert.equal(cleanManualPurchase({ toolId: 't', reason: 'cambio', qty: 1, origin: 'alert', alertKey: 'falt-a1-c1', assignmentId: 'a1' }).origin, 'alert');
  assert.throws(() => cleanManualPurchase({ toolId: 't', reason: 'otra', qty: 1 }), (e) => e.code === 'invalid_reason');
  assert.throws(() => cleanManualPurchase({ toolId: 't', reason: 'cambio', qty: 0 }), (e) => e.code === 'invalid_qty');
  assert.throws(() => cleanManualPurchase({ toolId: 't', reason: 'cambio', qty: 1.5 }), (e) => e.code === 'invalid_qty');
  assert.throws(() => cleanManualPurchase({ toolId: 't', reason: 'cambio', qty: 1, origin: 'control' }), (e) => e.code === 'invalid_origin');
});

const ASG = [{ id: 'a1', toolId: 'tool-pinza', unitId: null, qty: 3 }, { id: 'a2', toolId: 'tool-taladro', unitId: 'u1', qty: 1 }, { id: 'a3', toolId: 'tool-dest', unitId: null, qty: 2 }];
const ITEMS = {
  a1: { state: 'faltante', expected: 3, good: 1, change: 1, missing: 1, note: 'Se perdió' },
  a2: { state: 'cambio', expected: 1, good: 0, change: 1, missing: 0, note: '' },
  a3: { state: 'bueno', expected: 2, good: 2, change: 0, missing: 0, note: '' },
};

test('pérdidas de un control: faltante por las que faltan, cambio por las que requieren recambio', () => {
  assert.deepEqual(lossesOf(ITEMS, ASG), [
    { assignmentId: 'a1', unitId: null, toolId: 'tool-pinza', reason: 'faltante', qty: 1, note: 'Se perdió' },
    { assignmentId: 'a1', unitId: null, toolId: 'tool-pinza', reason: 'cambio', qty: 1, note: 'Se perdió' },
    { assignmentId: 'a2', unitId: 'u1', toolId: 'tool-taladro', reason: 'cambio', qty: 1, note: '' },
  ]);
  // Ítem viejo sin cantidades: el estado vale para todas las unidades.
  assert.deepEqual(lossesOf({ a3: { state: 'faltante', note: 'x' } }, ASG), [{ assignmentId: 'a3', unitId: null, toolId: 'tool-dest', reason: 'faltante', qty: 2, note: 'x' }]);
  assert.equal(countedPairs(ITEMS, ASG).length, 6);
  assert.deepEqual(countedPairs({ a3: ITEMS.a3 }, ASG), [{ assignmentId: 'a3', unitId: null, reason: 'faltante' }, { assignmentId: 'a3', unitId: null, reason: 'cambio' }]);
});

test('misma clave: asignación o unidad, y el mismo motivo (nunca la clave de la alerta)', () => {
  assert.equal(sameKey({ assignmentId: 'a1', unitId: null, reason: 'faltante' }, { assignmentId: 'a1', reason: 'faltante' }), true);
  assert.equal(sameKey({ assignmentId: 'a1', reason: 'cambio' }, { assignmentId: 'a1', reason: 'faltante' }), false);
  assert.equal(sameKey({ assignmentId: 'old', unitId: 'u1', reason: 'cambio' }, { assignmentId: 'a2', unitId: 'u1', reason: 'cambio' }), true);
  assert.equal(sameKey({ assignmentId: 'old', unitId: null, reason: 'cambio' }, { assignmentId: 'a2', unitId: null, reason: 'cambio' }), false);
});

const req = (o) => ({ id: 'r1', status: 'pendiente', reason: 'faltante', assignmentId: 'a1', unitId: null, qty: 1, origin: 'control', lossResolvedAt: null, linkedToSuperseded: false, onlyThisPeriod: false, maxLinkedPnum: 0, ...o });
const plan = (candidates, o = {}) => planAutoPurchases({ pnum: 20261121, losses: lossesOf(ITEMS, ASG), counted: countedPairs(ITEMS, ASG), candidates, ...o });

test('creación automática: una por asignación y motivo, sin duplicar si hay una abierta', () => {
  const p = plan([]);
  assert.deepEqual(p.create.map((l) => `${l.assignmentId}|${l.reason}`), ['a1|faltante', 'a1|cambio', 'a2|cambio']);
  assert.deepEqual([p.link, p.archive, p.resolve, p.blocked], [[], [], [], []]);
  // Abierta para a1 faltante (pendiente, de un control anterior): se vincula y sigue la cantidad.
  const q = plan([req({ qty: 3, maxLinkedPnum: 20261111 })]);
  assert.deepEqual(q.create.map((l) => `${l.assignmentId}|${l.reason}`), ['a1|cambio', 'a2|cambio']);
  assert.deepEqual(q.link, [{ id: 'r1', qty: 1 }]);
  // Aprobada: se vincula, la cantidad no cambia.
  assert.deepEqual(plan([req({ status: 'aprobada', qty: 3 })]).link, [{ id: 'r1', qty: null }]);
  // Pendiente con un control más nuevo vinculado (se corrige uno viejo): no le cambia la cantidad.
  assert.deepEqual(plan([req({ qty: 3, maxLinkedPnum: 20261131 })]).link, [{ id: 'r1', qty: null }]);
  // Misma cantidad: solo el vínculo.
  assert.deepEqual(plan([req({ qty: 1 })]).link, [{ id: 'r1', qty: null }]);
  // Por unidad: la abierta de la unidad u1 (otra asignación) cubre a2.
  assert.deepEqual(plan([req({ id: 'r2', reason: 'cambio', assignmentId: 'viejo', unitId: 'u1' })]).link, [{ id: 'r2', qty: null }]);
});

test('después de un rechazo no se abre otra hasta que un control muestre la pérdida resuelta', () => {
  const rej = req({ id: 'rx', status: 'rechazada' });
  const p = plan([rej]);
  assert.deepEqual(p.blocked, [{ assignmentId: 'a1', reason: 'faltante', requestId: 'rx' }]);
  assert.ok(!p.create.some((l) => l.assignmentId === 'a1' && l.reason === 'faltante'));
  // Ya resuelta por un control: se crea de nuevo.
  assert.ok(plan([{ ...rej, lossResolvedAt: '2026-11-01T00:00:00Z' }]).create.some((l) => l.assignmentId === 'a1' && l.reason === 'faltante'));
  // Un control sin esa pérdida la marca resuelta (a3 está bien; a1 sin cambio en este otro control).
  const ok = planAutoPurchases({ pnum: 20261121, losses: [], counted: countedPairs({ a1: { state: 'bueno', expected: 3, good: 3, change: 0, missing: 0 } }, ASG), candidates: [rej, req({ id: 'ry', status: 'rechazada', reason: 'cambio', assignmentId: 'a9' })] });
  assert.deepEqual(ok.resolve, ['rx']);
});

test('una corrección que quita la pérdida archiva la pendiente que solo venía del control corregido', () => {
  const counted = countedPairs({ a1: { state: 'bueno', expected: 3, good: 3, change: 0, missing: 0 } }, ASG);
  const only = req({ linkedToSuperseded: true, onlyThisPeriod: true });
  assert.deepEqual(planAutoPurchases({ pnum: 1, losses: [], counted, candidates: [only] }).archive, ['r1']);
  // Con otro control de otro período vinculado, o aprobada, o manual: no se toca.
  for (const r of [req({ linkedToSuperseded: true, onlyThisPeriod: false }), req({ linkedToSuperseded: true, onlyThisPeriod: true, status: 'aprobada' }), req({ linkedToSuperseded: true, onlyThisPeriod: true, origin: 'tool' }), req({ onlyThisPeriod: true })]) {
    assert.deepEqual(planAutoPurchases({ pnum: 1, losses: [], counted, candidates: [r] }).archive, [], JSON.stringify(r));
  }
  // La corrección mantiene la pérdida: se vincula y sigue la cantidad.
  const keep = planAutoPurchases({ pnum: 1, losses: [{ assignmentId: 'a1', unitId: null, toolId: 'tool-pinza', reason: 'faltante', qty: 2, note: '' }], counted, candidates: [{ ...only, qty: 1 }] });
  assert.deepEqual([keep.archive, keep.link, keep.create], [[], [{ id: 'r1', qty: 2 }], []]);
});

test('E7.V1: un control más nuevo sin la pérdida marca la pendiente; si la pérdida vuelve, se desmarca', () => {
  const counted = countedPairs({ a1: { state: 'bueno', expected: 3, good: 3, change: 0, missing: 0 } }, ASG);
  const run = (r, o = {}) => planAutoPurchases({ pnum: 20261121, losses: [], counted, candidates: [r], ...o });
  assert.deepEqual(run(req({ maxLinkedPnum: 20261111 })).flag, ['r1']);
  assert.deepEqual(run(req({ maxLinkedPnum: 20261121 })).flag, ['r1']);
  // Un control más viejo, una aprobada, ya marcada, de otra asignación (misma unidad) o archivada: no.
  for (const r of [req({ maxLinkedPnum: 20261131 }), req({ status: 'aprobada' }), req({ lossResolvedAt: '2026-11-01T00:00:00Z' }), req({ assignmentId: 'viejo', unitId: 'u9' })]) {
    assert.deepEqual(run(r).flag, [], JSON.stringify(r));
  }
  assert.deepEqual(run(req({ linkedToSuperseded: true, onlyThisPeriod: true })).flag, []);
  // La pérdida vuelve a figurar en un control igual o más nuevo: se quita la marca.
  const back = plan([req({ lossResolvedAt: '2026-11-01T00:00:00Z', maxLinkedPnum: 20261111 })]);
  assert.deepEqual([back.unflag, back.flag], [['r1'], []]);
  assert.deepEqual(plan([req({ lossResolvedAt: '2026-11-01T00:00:00Z', maxLinkedPnum: 20261131 })]).unflag, []);
});

test('E7.V1: sin purchases_view no se ven costos ni proveedores (fila y auditoría)', () => {
  const row = { id: 'p1', qty: 1, estimatedCost: 1500, supplier: 'Ferretería', observation: 'x' };
  assert.deepEqual(stripCosts(row), { id: 'p1', qty: 1, observation: 'x' });
  assert.equal(stripCostText(`Compra 1 aprobada: Pinza, extraviada, cantidad 1${COST_MARK}$ 1.500,00, proveedor Ferretería`), 'Compra 1 aprobada: Pinza, extraviada, cantidad 1');
  assert.equal(stripCostText('Compra 1 rechazada. Motivo: no'), 'Compra 1 rechazada. Motivo: no');
  assert.equal(stripCostText(null), null);
});

test('filtros de la lista: estado, mes, poseedor, herramienta, motivo, texto, eliminadas y página', () => {
  assert.deepEqual(parsePurchaseFilters({}), {
    status: null, month: null, plantillaId: null, techId: null, cajaId: null, toolId: null, reason: null, q: '', archived: 'exclude', scope: null, limit: 50, before: null,
  });
  const f = parsePurchaseFilters({ status: 'open', month: '2026-11', reason: 'cambio', q: ' pinza ', scope: 'receive', limit: '500', before: '2026-11-10T12:00:00.000000Z|pr1' });
  assert.deepEqual([f.status, f.month, f.reason, f.q, f.scope, f.limit, f.before], ['open', '2026-11', 'cambio', 'pinza', 'receive', 200, { at: '2026-11-10T12:00:00.000000Z', id: 'pr1' }]);
  assert.throws(() => parsePurchaseFilters({ month: '2026-13' }), (e) => e.code === 'invalid_month' && e.status === 400);
  assert.throws(() => parsePurchaseFilters({ before: 'x' }), (e) => e.code === 'invalid_cursor');
  assert.throws(() => parsePurchaseFilters({ status: 'otra' }), (e) => e.status === 400);
  assert.equal(purchaseLabel(4), 'Compra 4');
});
