// Etapa 7, revisión (E7.V1): costo y proveedor después de la decisión solo con purchases_decide
// (también en la base), costos solo para purchases_view, la marca "la pérdida ya no figura" en
// una pendiente, recepción repetida con la misma clave, la reposición vinculada solo a la misma
// asignación, el resumen de recibidas (con poseedor, últimos 90 días), la deduplicación por unidad
// cuando la unidad pasó a otra asignación, restaurar con la asignación inactiva y la demo en uso.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { periodOf, prevP, pkeyOf } from '../../src/domain/period.js';

let api;
let asg; // asignaciones de Ana: pinza x2, destornillador x1, taladro (unidad TAL-001)
const cur = periodOf(new Date());
const prevId = `c-t-ana-${pkeyOf(prevP(cur))}`;
const LIMPIO = { status: 'limpio' };
const SECRET = 'Proveedor Reservado';
const PIN = { good: 1, change: 0, expected: 2, note: 'Falta una' };
const DEST = { state: 'cambio', note: 'Punta gastada' };
const TAL = { state: 'cambio', note: 'No enciende' };

before(async () => {
  api = await setupApi();
  const rows = await api.q("SELECT id, tool_id, unit_id, qty FROM assignments WHERE tech_id = 't-ana' AND active ORDER BY id");
  asg = Object.fromEntries(rows.map((r) => [r.tool_id.replace('tool-', ''), r]));
});
after(async () => {
  await api?.close();
});

const one = async (sql, p) => (await api.q(sql, p))[0];
const finalize = (c, body) => api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, body, ifMatch(c.version));
async function correct(id, its) {
  const r = await api.call('responsable', 'POST', '/api/controls', { correctionOf: id });
  assert.equal(r.statusCode, 201, r.body);
  const f = await finalize(r.json().control, { items: its, cleaning: LIMPIO });
  assert.equal(f.statusCode, 200, f.body);
  return f.json();
}
const items = (o = {}) => ({
  [asg.pinza.id]: { good: 2, change: 0, expected: 2 },
  [asg.destornillador.id]: { state: 'bueno' },
  [asg.taladro.id]: { state: 'bueno' },
  ...o,
});
const openOf = async (asgId, reason) => one("SELECT * FROM purchase_requests WHERE assignment_id = $1 AND reason = $2 AND archived_at IS NULL AND status IN ('pendiente', 'aprobada', 'comprada')", [asgId, reason]);
const verOf = async (id) => (await one('SELECT version FROM purchase_requests WHERE id = $1', [id])).version;
const act = (user, id, action, body, version, h = {}) => api.call(user, 'POST', `/api/compras/${id}/${action}`, body, { ...ifMatch(version), ...h });
const patch = async (user, id, body) => api.call(user, 'PATCH', `/api/compras/${id}`, body, ifMatch(await verOf(id)));
const mov = (user, body) => api.call(user, 'POST', '/api/movements', body);
const disponible = async (toolId) => (await one(`SELECT coalesce(sum(CASE WHEN to_pool = 'disponible' THEN qty WHEN from_pool = 'disponible' THEN -qty ELSE 0 END), 0)::int AS n
  FROM movement_transfers WHERE tool_id = $1`, [toolId])).n;
const summary = async (user = 'responsable') => (await api.call(user, 'GET', '/api/state')).json().purchases;

let C; // control vigente de esta semana de Ana
let rPin; // pinza, faltante
let rDest; // destornillador, cambio
let rTal; // taladro (unidad TAL-001), cambio

describe('marca "la pérdida ya no figura en el último control"', () => {
  test('un control más nuevo sin la pérdida marca la pendiente (no la cancela); si vuelve, se desmarca', async () => {
    const r = await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: cur });
    assert.equal(r.statusCode, 201, r.body);
    const f = await finalize(r.json().control, {
      items: items({ [asg.pinza.id]: PIN, [asg.destornillador.id]: DEST, [asg.taladro.id]: TAL }), cleaning: LIMPIO,
    });
    assert.equal(f.statusCode, 200, f.body);
    C = f.json().control;
    rPin = await openOf(asg.pinza.id, 'faltante');
    rDest = await openOf(asg.destornillador.id, 'cambio');
    rTal = await openOf(asg.taladro.id, 'cambio');
    assert.ok(rPin && rDest && rTal);
    // Un control de un período anterior con la pérdida: se vincula (otro período).
    await correct(prevId, items({ [asg.destornillador.id]: DEST }));
    // Una corrección de este período sin la pérdida: queda pendiente, marcada.
    let x = await correct(C.id, items({ [asg.pinza.id]: PIN, [asg.taladro.id]: TAL }));
    C = x.control;
    assert.deepEqual(x.purchases.archived, []);
    let d = await one('SELECT status, archived_at, loss_resolved_at, loss_resolved_control_id FROM purchase_requests WHERE id = $1', [rDest.id]);
    assert.deepEqual([d.status, d.archived_at, d.loss_resolved_control_id], ['pendiente', null, C.id]);
    assert.ok(d.loss_resolved_at);
    // Las otras dos siguen con la pérdida: sin marca.
    assert.equal((await one('SELECT loss_resolved_at FROM purchase_requests WHERE id = $1', [rPin.id])).loss_resolved_at, null);
    const inbox = (await api.call('gerencia', 'GET', '/api/compras?status=pendiente')).json().compras;
    assert.ok(inbox.find((p) => p.id === rDest.id).lossResolvedAt);
    assert.equal(inbox.find((p) => p.id === rPin.id).lossResolvedAt, null);
    assert.ok((await api.call('gerencia', 'GET', `/api/compras/${rDest.id}`)).json().compra.lossResolvedAt);
    // El control vuelve a mostrar la pérdida: se quita la marca.
    x = await correct(C.id, items({ [asg.pinza.id]: PIN, [asg.destornillador.id]: DEST, [asg.taladro.id]: TAL }));
    C = x.control;
    d = await one('SELECT loss_resolved_at, loss_resolved_control_id FROM purchase_requests WHERE id = $1', [rDest.id]);
    assert.deepEqual([d.loss_resolved_at, d.loss_resolved_control_id], [null, null]);
  });
});

describe('costo y proveedor', () => {
  test('después de la decisión solo los cambia quien decide (API y base)', async () => {
    const a = await act('gerencia', rPin.id, 'approve', { estimatedCost: 1000, supplier: SECRET }, await verOf(rPin.id));
    assert.equal(a.statusCode, 200, a.body);
    assert.equal((await patch('responsable', rPin.id, { estimatedCost: 5 })).statusCode, 403);
    assert.equal((await patch('responsable', rPin.id, { supplier: 'Otro' })).statusCode, 403);
    assert.equal((await act('responsable', rPin.id, 'purchase', { estimatedCost: 1 }, await verOf(rPin.id))).statusCode, 403);
    assert.equal((await act('responsable', rPin.id, 'purchase', { supplier: 'Otro' }, await verOf(rPin.id))).statusCode, 403);
    const obs = await patch('responsable', rPin.id, { observation: 'Se pidió por teléfono' });
    assert.equal(obs.statusCode, 200, obs.body);
    assert.equal('estimatedCost' in obs.json().compra, false);
    // La base también lo impide sin la marca de quien decide.
    await assert.rejects(api.appPool.query('UPDATE purchase_requests SET estimated_cost = 1 WHERE id = $1', [rPin.id]), (e) => e.code === '23001');
    await assert.rejects(api.appPool.query("UPDATE purchase_requests SET supplier = 'x' WHERE id = $1", [rPin.id]), (e) => e.code === '23001');
    const g = await patch('gerencia', rPin.id, { estimatedCost: 1200 });
    assert.equal(g.statusCode, 200, g.body);
    assert.deepEqual([g.json().compra.estimatedCost, g.json().compra.supplier], [1200, SECRET]);
    // Mientras está pendiente, quien crea puede cargar el costo.
    assert.equal((await patch('responsable', rTal.id, { estimatedCost: 300 })).statusCode, 200);
  });

  test('sin purchases_view no se ven costos ni proveedores: detalle, línea de tiempo, listas y resumen', async () => {
    const det = (await api.call('responsable', 'GET', `/api/compras/${rPin.id}`)).json().compra;
    assert.equal('estimatedCost' in det, false);
    assert.equal('supplier' in det, false);
    const tl = JSON.stringify(det.timeline);
    assert.doesNotMatch(tl, new RegExp(SECRET));
    assert.doesNotMatch(tl, /\$ 1\.|costo/i);
    assert.ok(det.timeline.some((x) => x.action === 'purchase_approve'));
    const ger = (await api.call('gerencia', 'GET', `/api/compras/${rPin.id}`)).json().compra;
    assert.equal(ger.estimatedCost, 1200);
    assert.match(JSON.stringify(ger.timeline), new RegExp(SECRET));
    const rec = (await api.call('responsable', 'GET', '/api/compras?scope=receive')).json().compras;
    const row = rec.find((p) => p.id === rPin.id);
    assert.ok(row);
    assert.equal('estimatedCost' in row || 'supplier' in row, false);
    assert.equal((await api.call('responsable', 'GET', `/api/compras?scope=receive&q=${encodeURIComponent('Reservado')}`)).json().compras.length, 0);
    const st = await summary();
    assert.ok(st.length && st.every((p) => !('estimatedCost' in p) && !('supplier' in p)));
    const p = await act('responsable', rPin.id, 'purchase', { note: 'Orden 12' }, await verOf(rPin.id));
    assert.equal(p.statusCode, 200, p.body);
    assert.equal('estimatedCost' in p.json().compra, false);
  });
});

describe('recepción y reposición vinculada', () => {
  test('recibir dos veces con la misma clave: un solo ingreso y el stock no cambia', async () => {
    const before = await disponible('tool-pinza');
    const h = { 'idempotency-key': 'compra-recibir-e7v1' };
    const v = await verOf(rPin.id);
    const a = await act('responsable', rPin.id, 'receive', { qty: 1 }, v, h);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(await disponible('tool-pinza'), before + 1);
    const b = await act('responsable', rPin.id, 'receive', { qty: 1 }, v, h);
    assert.equal(b.statusCode, 200, b.body);
    assert.equal(b.headers['idempotent-replayed'], 'true');
    assert.equal(b.json().compra.ingresoMovementId, a.json().compra.ingresoMovementId);
    assert.equal((await one("SELECT count(*)::int AS n FROM movements WHERE type = 'ingreso' AND notes LIKE $1", [`Recepción de ${rPin.name}%`])).n, 1);
    assert.equal(await disponible('tool-pinza'), before + 1);
  });

  test('solo a la misma asignación: otro poseedor u otra asignación se rechazan; sin poseedor no se vincula', async () => {
    const bruno = await one("SELECT id FROM assignments WHERE tech_id = 't-bruno' AND tool_id = 'tool-pinza' AND active");
    const repo = (techId, asgId, prId) => mov('responsable', { type: 'reposicion', techId, asgId, returned: true, oldDest: 'reparacion', purchaseRequestId: prId });
    const other = await repo('t-bruno', bruno.id, rPin.id);
    assert.equal(other.json().error, 'invalid_purchase', other.body);
    const ad = await mov('responsable', { type: 'adicional', techId: 't-ana', toolId: 'tool-pinza', qty: 1 });
    assert.equal(ad.statusCode, 201, ad.body);
    const a2 = ad.json().assignments[0];
    assert.notEqual(a2, asg.pinza.id);
    const otherAsg = await repo('t-ana', a2, rPin.id);
    assert.equal(otherAsg.json().error, 'invalid_purchase', otherAsg.body);
    // Una compra para stock (sin poseedor), recibida: no está en el resumen ni se vincula.
    const m = await api.call('responsable', 'POST', '/api/compras', { toolId: 'tool-pinza', reason: 'cambio', qty: 1 });
    assert.equal(m.statusCode, 201, m.body);
    const s = m.json().compra;
    const ap = await act('gerencia', s.id, 'approve', {}, s.version);
    const rc = await act('responsable', s.id, 'receive', { qty: 1 }, ap.json().compra.version);
    assert.equal(rc.statusCode, 200, rc.body);
    assert.ok(!(await summary()).some((p) => p.id === s.id));
    assert.equal((await repo('t-ana', a2, s.id)).json().error, 'invalid_purchase');
    const ok = await repo('t-ana', asg.pinza.id, rPin.id);
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal((await one('SELECT reposicion_movement_id FROM purchase_requests WHERE id = $1', [rPin.id])).reposicion_movement_id, ok.json().movement.id);
  });
});

describe('deduplicación por unidad y resumen de recibidas', () => {
  test('la unidad pasó a otra asignación: el control del nuevo poseedor se vincula a la abierta', async () => {
    const dev = await mov('responsable', { type: 'devolucion', techId: 't-ana', asgId: asg.taladro.id });
    assert.equal(dev.statusCode, 201, dev.body);
    const ent = await mov('responsable', { type: 'entrega_inicial', techId: 't-carla', toolId: 'tool-taladro', unitId: asg.taladro.unit_id });
    assert.equal(ent.statusCode, 201, ent.body);
    const carla = await api.q("SELECT id, tool_id FROM assignments WHERE tech_id = 't-carla' AND active ORDER BY id");
    const its = Object.fromEntries(carla.map((a) => [a.id, a.tool_id === 'tool-taladro' ? { state: 'cambio', note: 'No enciende' } : { state: 'bueno' }]));
    const r = await api.call('responsable', 'POST', '/api/controls', { techId: 't-carla', period: cur });
    assert.equal(r.statusCode, 201, r.body);
    const f = await finalize(r.json().control, { items: its, cleaning: LIMPIO });
    assert.equal(f.statusCode, 200, f.body);
    assert.deepEqual(f.json().purchases.created, []);
    assert.deepEqual(f.json().purchases.linked, [rTal.id]);
    assert.equal((await one("SELECT count(*)::int AS n FROM purchase_requests WHERE unit_id = $1 AND reason = 'cambio' AND archived_at IS NULL", [asg.taladro.unit_id])).n, 1);
  });

  test('el resumen trae las recibidas sin reposición de los últimos 90 días', async () => {
    const ap = await act('gerencia', rTal.id, 'approve', {}, await verOf(rTal.id));
    const rc = await act('responsable', rTal.id, 'receive', { codes: 'TAL-500' }, ap.json().compra.version);
    assert.equal(rc.statusCode, 200, rc.body);
    assert.ok((await summary()).some((p) => p.id === rTal.id));
    await api.q('ALTER TABLE purchase_requests DISABLE TRIGGER purchase_requests_guard');
    try {
      await api.q("UPDATE purchase_requests SET received_at = now() - interval '100 days' WHERE id = $1", [rTal.id]);
    } finally {
      await api.q('ALTER TABLE purchase_requests ENABLE TRIGGER purchase_requests_guard');
    }
    assert.ok(!(await summary()).some((p) => p.id === rTal.id));
  });
});

describe('restaurar y demo', () => {
  test('restaurar se impide con la asignación ya inactiva', async () => {
    const a = await api.call('admin', 'POST', `/api/compras/${rDest.id}/archive`, { reason: 'Se encontró' }, ifMatch(await verOf(rDest.id)));
    assert.equal(a.statusCode, 200, a.body);
    const dev = await mov('responsable', { type: 'devolucion', techId: 't-ana', asgId: asg.destornillador.id });
    assert.equal(dev.statusCode, 201, dev.body);
    const rs = await api.call('admin', 'POST', `/api/compras/${rDest.id}/restore`, { reason: 'Error' }, ifMatch(a.json().compra.version));
    assert.equal(rs.statusCode, 409, rs.body);
    assert.equal(rs.json().error, 'assignment_inactive');
    assert.equal((await one('SELECT archived_at FROM purchase_requests WHERE id = $1', [rDest.id])).archived_at != null, true);
  });

  test('borrar la demo se rechaza si una compra nombra datos de demostración', async () => {
    assert.equal((await api.call('admin', 'POST', '/api/demo')).statusCode, 201);
    const tool = await one('SELECT id FROM tools WHERE demo AND NOT serialized ORDER BY id LIMIT 1');
    const p = await api.call('responsable', 'POST', '/api/compras', { toolId: tool.id, reason: 'cambio', qty: 1 });
    assert.equal(p.statusCode, 201, p.body);
    const del = await api.call('admin', 'DELETE', '/api/demo');
    assert.equal(del.statusCode, 409, del.body);
    assert.equal(del.json().error, 'demo_in_use');
    assert.ok((await one('SELECT count(*)::int AS n FROM tools WHERE demo')).n > 0);
  });
});
