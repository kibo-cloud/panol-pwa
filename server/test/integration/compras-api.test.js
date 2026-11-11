// Etapa 7: solicitudes de compra. Creación automática al finalizar y corregir controles (sin
// duplicar, con la cantidad que sigue al último control y la cancelación de "Corregido en el
// control"), concurrencia de dos controles de la misma asignación, rechazo que frena la creación
// hasta que un control muestra la pérdida resuelta, aprobación (idempotente, con versión), compra,
// recepción con el ingreso, reposición vinculada, alta manual, edición, listas, totales, eliminar
// y restaurar (modelo genérico), novedad vinculada y la consulta por período.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { periodOf, prevP, pkeyOf } from '../../src/domain/period.js';
import { purchasesOfPeriod } from '../../src/application/compras.js';

let api;
let asg; // asignaciones de Ana: pinza x2, destornillador x1, taladro (unidad)
const cur = periodOf(new Date());
const prevId = `c-t-ana-${pkeyOf(prevP(cur))}`;
const LIMPIO = { status: 'limpio' };

before(async () => {
  api = await setupApi();
  const rows = await api.q("SELECT id, tool_id, unit_id, qty FROM assignments WHERE tech_id = 't-ana' AND active ORDER BY id");
  asg = Object.fromEntries(rows.map((r) => [r.tool_id.replace('tool-', ''), r]));
});
after(async () => {
  await api?.close();
});

const one = async (sql, p) => (await api.q(sql, p))[0];
const items = (o = {}) => ({
  [asg.pinza.id]: { good: 2, change: 0, expected: 2 },
  [asg.destornillador.id]: { state: 'bueno' },
  [asg.taladro.id]: { state: 'bueno' },
  ...o,
});
const finalize = (c, body) => api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, body, ifMatch(c.version));
async function correct(id, its) {
  const r = await api.call('responsable', 'POST', '/api/controls', { correctionOf: id });
  assert.equal(r.statusCode, 201, r.body);
  const f = await finalize(r.json().control, { items: its, cleaning: LIMPIO });
  assert.equal(f.statusCode, 200, f.body);
  return f.json();
}
const openOf = (asgId, reason) => api.q("SELECT * FROM purchase_requests WHERE assignment_id = $1 AND reason = $2 AND archived_at IS NULL AND status IN ('pendiente', 'aprobada', 'comprada')", [asgId, reason]);
const links = async (id) => (await api.q('SELECT control_id FROM purchase_request_controls WHERE request_id = $1 ORDER BY linked_at', [id])).map((r) => r.control_id);
const get = async (user, id) => api.call(user, 'GET', `/api/compras/${id}`);
const act = (user, id, action, body, version, h = {}) => api.call(user, 'POST', `/api/compras/${id}/${action}`, body, { ...ifMatch(version), ...h });
const verOf = async (id) => (await one('SELECT version FROM purchase_requests WHERE id = $1', [id])).version;

const PIN_NOTE = 'Se perdió en la línea 2';
let C; // control de esta semana de Ana (el vigente cambia con cada corrección)
let rPin; // pinza, faltante
let rDest; // destornillador, cambio
let rTal; // taladro, cambio

describe('permisos por defecto', () => {
  test('Gerencia ve y decide; el responsable crea y recibe; consulta no ve compras', async () => {
    assert.equal((await api.call('gerencia', 'GET', '/api/compras')).statusCode, 200);
    assert.equal((await api.call('admin', 'GET', '/api/compras')).statusCode, 200);
    for (const u of ['responsable', 'supervisor', 'consulta']) assert.equal((await api.call(u, 'GET', '/api/compras')).statusCode, 403, u);
    assert.equal((await api.call('responsable', 'GET', '/api/compras?scope=receive')).statusCode, 200);
    assert.equal((await api.call('supervisor', 'GET', '/api/compras?scope=receive')).statusCode, 403);
    assert.equal((await api.call('gerencia', 'GET', '/api/compras/totals')).statusCode, 200);
    assert.equal((await api.call('responsable', 'GET', '/api/compras/totals')).statusCode, 403);
    assert.equal((await api.call('gerencia', 'POST', '/api/compras', { toolId: 'tool-pinza', reason: 'cambio', qty: 1 })).statusCode, 403);
  });
});

describe('creación automática', () => {
  test('al finalizar: una por asignación y motivo, con la foto del poseedor y la observación', async () => {
    const r = await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: cur });
    assert.equal(r.statusCode, 201, r.body);
    const f = await finalize(r.json().control, {
      items: items({ [asg.pinza.id]: { good: 1, change: 0, expected: 2, note: PIN_NOTE }, [asg.destornillador.id]: { state: 'cambio', note: 'Punta gastada' } }), cleaning: LIMPIO,
    });
    assert.equal(f.statusCode, 200, f.body);
    C = f.json().control;
    assert.equal(f.json().purchases.created.length, 2);
    [rPin] = await openOf(asg.pinza.id, 'faltante');
    [rDest] = await openOf(asg.destornillador.id, 'cambio');
    assert.deepEqual(
      [rPin.status, rPin.qty, rPin.tool_id, rPin.tech_id, rPin.plantilla_id, rPin.holder_name, rPin.observation, rPin.origin, rPin.origin_control_id, rPin.created_by, rPin.estimated_cost],
      ['pendiente', 1, 'tool-pinza', 't-ana', 'manana', 'Ana Prueba', PIN_NOTE, 'control', C.id, 'u-responsable', null],
    );
    assert.deepEqual([rDest.reason, rDest.qty, rDest.observation], ['cambio', 1, 'Punta gastada']);
    assert.match(rPin.name, /^Compra \d+$/);
    assert.deepEqual(await links(rPin.id), [C.id]);
    assert.equal((await one("SELECT count(*)::int AS n FROM audit_log WHERE action = 'purchase_create' AND entity_id = $1", [rPin.id])).n, 1);
    // Estado para todos (sin costos) y la alerta de faltante con su compra.
    const st = (await api.call('consulta', 'GET', '/api/state')).json();
    const s = st.purchases.find((p) => p.id === rPin.id);
    assert.deepEqual([s.status, s.reason, s.assignmentId, s.estimatedCost], ['pendiente', 'faltante', asg.pinza.id, undefined]);
    const al = st.derived.alerts.find((a) => a.type === 'faltante' && a.asgId === asg.pinza.id);
    assert.deepEqual(al.purchase, { id: rPin.id, name: rPin.name, status: 'pendiente', decisionComment: '' });
  });

  test('una corrección con la misma pérdida se vincula y la cantidad sigue al último control', async () => {
    const r = await correct(C.id, items({ [asg.pinza.id]: { good: 0, change: 0, expected: 2, note: PIN_NOTE }, [asg.destornillador.id]: { state: 'cambio', note: 'Punta gastada' } }));
    assert.deepEqual([r.purchases.created, r.purchases.linked.sort()], [[], [rPin.id, rDest.id].sort()]);
    C = r.control;
    const p = await one('SELECT qty, version FROM purchase_requests WHERE id = $1', [rPin.id]);
    assert.equal(p.qty, 2);
    assert.equal((await openOf(asg.pinza.id, 'faltante')).length, 1);
    assert.equal((await links(rPin.id)).length, 2);
  });

  test('corregir un control de un período anterior vincula sin cambiar la cantidad', async () => {
    const r = await correct(prevId, items({ [asg.pinza.id]: { good: 1, change: 0, expected: 2, note: 'Ya faltaba' } }));
    assert.deepEqual(r.purchases.linked, [rPin.id]);
    assert.equal((await one('SELECT qty FROM purchase_requests WHERE id = $1', [rPin.id])).qty, 2);
    assert.equal((await links(rPin.id)).length, 3);
  });

  test('una corrección que quita la pérdida cancela la pendiente que solo venía de ese control', async () => {
    const r = await correct(C.id, items({ [asg.pinza.id]: { good: 0, change: 0, expected: 2, note: PIN_NOTE } }));
    C = r.control;
    assert.deepEqual(r.purchases.archived, [rDest.id]);
    const d = await one('SELECT status, archived_at, archive_reason, archived_by FROM purchase_requests WHERE id = $1', [rDest.id]);
    assert.deepEqual([d.status, d.archive_reason, d.archived_by], ['pendiente', 'Corregido en el control', 'u-responsable']);
    assert.ok(d.archived_at);
    // La pinza tiene controles de otro período: no se toca.
    assert.equal((await openOf(asg.pinza.id, 'faltante')).length, 1);
  });

  test('dos controles que finalizan a la vez para la misma asignación abren una sola solicitud', async () => {
    const a = (await api.call('responsable', 'POST', '/api/controls', { correctionOf: C.id })).json().control;
    const b = (await api.call('responsable', 'POST', '/api/controls', { correctionOf: (await one('SELECT id FROM controls WHERE supersedes_id = $1', [prevId])).id })).json().control;
    const its = items({ [asg.pinza.id]: { good: 0, change: 0, expected: 2, note: PIN_NOTE }, [asg.taladro.id]: { state: 'cambio', note: 'No enciende' } });
    // Una conexión de afuera retiene el bloqueo por nombre de la asignación; los dos quedan esperando.
    const out = await api.pool.connect();
    await out.query('BEGIN');
    await out.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchases.asg:${asg.taladro.id}`]);
    const pa = finalize(a, { items: its, cleaning: LIMPIO });
    const pb = finalize(b, { items: its, cleaning: LIMPIO });
    let waited = false;
    for (let i = 0; i < 400 && !waited; i++) {
      const { n } = await one("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      waited = n >= 2;
      if (!waited) await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(waited, 'los dos finalizar quedaron esperando el bloqueo');
    await out.query('COMMIT');
    out.release();
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.deepEqual([ra.statusCode, rb.statusCode], [200, 200], ra.body + rb.body);
    C = ra.json().control;
    const open = await openOf(asg.taladro.id, 'cambio');
    assert.equal(open.length, 1);
    rTal = open[0];
    assert.equal((await links(rTal.id)).length, 2);
    // El índice único parcial es el respaldo: una segunda abierta igual no entra.
    await assert.rejects(
      api.q("INSERT INTO purchase_requests (id, tool_id, assignment_id, tech_id, reason, qty, origin, created_by) VALUES ('pr-dup', 'tool-taladro', $1, 't-ana', 'cambio', 1, 'tool', 'u-admin')", [asg.taladro.id]),
      (e) => e.code === '23505',
    );
  });

  test('la base protege el historial: sin DELETE para la app, sin saltos de estado ni cambios de origen', async () => {
    await assert.rejects(api.appPool.query('DELETE FROM purchase_requests WHERE id = $1', [rPin.id]), (e) => e.code === '42501');
    await assert.rejects(api.appPool.query('DELETE FROM purchase_request_controls'), (e) => e.code === '42501');
    await assert.rejects(api.appPool.query("UPDATE purchase_requests SET status = 'recibida' WHERE id = $1", [rPin.id]), (e) => e.code === '23514');
    await assert.rejects(api.appPool.query("UPDATE purchase_requests SET reason = 'cambio' WHERE id = $1", [rPin.id]), (e) => e.code === '23001');
    await assert.rejects(api.appPool.query("UPDATE purchase_requests SET status = 'rechazada', decided_at = now(), decided_by = 'u-gerencia' WHERE id = $1", [rPin.id]), (e) => e.code === '23514');
  });
});

describe('decisión', () => {
  test('rechazar pide comentario y solo Gerencia; la alerta queda como compra rechazada', async () => {
    let v = await verOf(rPin.id);
    assert.equal((await act('responsable', rPin.id, 'reject', { comment: 'No' }, v)).statusCode, 403);
    assert.equal((await act('gerencia', rPin.id, 'reject', {}, v)).statusCode, 400);
    assert.equal((await act('gerencia', rPin.id, 'reject', { comment: '   ' }, v)).json().error, 'comment_required');
    const r = await act('gerencia', rPin.id, 'reject', { comment: 'Hay en el depósito central' }, v);
    assert.equal(r.statusCode, 200, r.body);
    const p = r.json().compra;
    assert.deepEqual([p.status, p.decidedBy, p.decisionComment, p.decidedByName], ['rechazada', 'u-gerencia', 'Hay en el depósito central', 'Gerencia Desarrollo']);
    assert.ok(p.decidedAt);
    assert.equal(r.headers.etag, `"${p.version}"`);
    const al = (await api.call('responsable', 'GET', '/api/state')).json().derived.alerts.find((a) => a.type === 'faltante' && a.asgId === asg.pinza.id);
    assert.deepEqual([al.purchase.status, al.purchase.decisionComment], ['rechazada', 'Hay en el depósito central']);
    v = p.version;
    assert.equal((await act('gerencia', rPin.id, 'approve', {}, v)).json().error, 'invalid_transition');
  });

  test('después del rechazo no se abre otra hasta que un control muestra la pérdida resuelta', async () => {
    let r = await correct(C.id, items({ [asg.pinza.id]: { good: 0, change: 0, expected: 2, note: PIN_NOTE }, [asg.taladro.id]: { state: 'cambio', note: 'No enciende' } }));
    C = r.control;
    assert.deepEqual(r.purchases.created, []);
    assert.equal((await openOf(asg.pinza.id, 'faltante')).length, 0);
    r = await correct(C.id, items({ [asg.taladro.id]: { state: 'cambio', note: 'No enciende' } }));
    C = r.control;
    const rej = await one('SELECT loss_resolved_at, loss_resolved_control_id FROM purchase_requests WHERE id = $1', [rPin.id]);
    assert.ok(rej.loss_resolved_at);
    assert.equal(rej.loss_resolved_control_id, C.id);
    r = await correct(C.id, items({ [asg.pinza.id]: { good: 1, change: 0, expected: 2, note: 'Otra vez' }, [asg.taladro.id]: { state: 'cambio', note: 'No enciende' } }));
    C = r.control;
    assert.equal(r.purchases.created.length, 1);
    const [again] = await openOf(asg.pinza.id, 'faltante');
    assert.notEqual(again.id, rPin.id);
    rPin = again;
  });

  test('aprobar: un toque, idempotente, con versión; Gerencia puede cargar costo y proveedor', async () => {
    const v = await verOf(rTal.id);
    const h = { 'idempotency-key': 'compra-aprobar-0001' };
    const a = await act('gerencia', rTal.id, 'approve', {}, v, h);
    assert.equal(a.statusCode, 200, a.body);
    const b = await act('gerencia', rTal.id, 'approve', {}, v, h);
    assert.equal(b.headers['idempotent-replayed'], 'true');
    assert.equal(b.json().compra.version, a.json().compra.version);
    assert.equal((await act('gerencia', rTal.id, 'approve', {}, a.json().compra.version)).json().error, 'invalid_transition');
    assert.equal((await act('gerencia', rPin.id, 'approve', {}, 999)).json().error, 'conflict');
    assert.equal((await one("SELECT count(*)::int AS n FROM audit_log WHERE action = 'purchase_approve' AND entity_id = $1", [rTal.id])).n, 1);
  });

  test('comprada (opcional) y recepción con el ingreso al inventario', async () => {
    let v = await verOf(rTal.id);
    assert.equal((await act('consulta', rTal.id, 'purchase', {}, v)).statusCode, 403);
    // E7.V1: después de la decisión, el costo y el proveedor solo los cambia Gerencia.
    assert.equal((await act('responsable', rTal.id, 'purchase', { supplier: 'Herramientas SA', estimatedCost: 85000 }, v)).statusCode, 403);
    const g = await api.call('gerencia', 'PATCH', `/api/compras/${rTal.id}`, { supplier: 'Herramientas SA', estimatedCost: 85000 }, ifMatch(v));
    assert.equal(g.statusCode, 200, g.body);
    const p = await act('responsable', rTal.id, 'purchase', {}, g.json().compra.version);
    assert.equal(p.statusCode, 200, p.body);
    assert.equal(p.json().compra.status, 'comprada');
    const gp = (await get('gerencia', rTal.id)).json().compra;
    assert.deepEqual([gp.supplier, gp.estimatedCost], ['Herramientas SA', 85000]);
    v = p.json().compra.version;
    assert.equal((await act('supervisor', rTal.id, 'receive', { codes: 'TAL-900' }, v)).statusCode, 403);
    assert.equal((await act('responsable', rTal.id, 'receive', {}, v)).json().error, 'codes_required');
    const r = await act('responsable', rTal.id, 'receive', { codes: 'TAL-900', note: 'Llegó con garantía' }, v);
    assert.equal(r.statusCode, 200, r.body);
    const c = r.json().compra;
    assert.deepEqual([c.status, c.receivedQty, c.receivedBy, c.receptionNote], ['recibida', 1, 'u-responsable', 'Llegó con garantía']);
    const m = await one('SELECT type, tool_id, qty, notes FROM movements WHERE id = $1', [c.ingresoMovementId]);
    assert.deepEqual([m.type, m.tool_id, m.qty], ['ingreso', 'tool-taladro', 1]);
    assert.match(m.notes, new RegExp(`Recepción de ${c.name}`));
    assert.equal((await one("SELECT status FROM units WHERE code = 'TAL-900'")).status, 'disponible');
    assert.equal((await act('responsable', rTal.id, 'receive', { codes: 'TAL-901' }, c.version)).json().error, 'invalid_transition');
    // Cerrada: no se edita.
    assert.equal((await api.call('gerencia', 'PATCH', `/api/compras/${rTal.id}`, { supplier: 'Otro' }, ifMatch(c.version))).json().error, 'closed');
  });

  test('la reposición al técnico se vincula a la compra recibida', async () => {
    const unit = await one("SELECT id FROM units WHERE code = 'TAL-900'");
    const repo = (asgId, extra = {}) => api.call('responsable', 'POST', '/api/movements', { type: 'reposicion', techId: 't-ana', asgId, newUnitId: unit.id, returned: true, oldDest: 'reparacion', purchaseRequestId: rTal.id, ...extra });
    // Otra herramienta: se rechaza sin registrar nada.
    const before = (await one('SELECT count(*)::int AS n FROM movements')).n;
    const bad = await api.call('responsable', 'POST', '/api/movements', { type: 'reposicion', techId: 't-ana', asgId: asg.destornillador.id, returned: true, oldDest: 'reparacion', purchaseRequestId: rTal.id });
    assert.equal(bad.json().error, 'invalid_purchase');
    assert.equal((await one('SELECT count(*)::int AS n FROM movements')).n, before);
    assert.equal((await api.call('responsable', 'POST', '/api/movements', { type: 'devolucion', techId: 't-ana', asgId: asg.pinza.id, purchaseRequestId: rTal.id })).json().error, 'invalid_purchase');
    const r = await repo(asg.taladro.id);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().purchaseRequestId, rTal.id);
    const p = await one('SELECT reposicion_movement_id FROM purchase_requests WHERE id = $1', [rTal.id]);
    assert.equal(p.reposicion_movement_id, r.json().movement.id);
    // Ya vinculada: otra reposición no la toma.
    const newAsg = r.json().assignments[0];
    const again = await api.call('responsable', 'POST', '/api/movements', { type: 'reposicion', techId: 't-ana', asgId: newAsg, newUnitId: (await one("SELECT id FROM units WHERE code = 'TAL-002'")).id, returned: true, purchaseRequestId: rTal.id });
    assert.equal(again.statusCode, 409, again.body);
    const st = (await api.call('responsable', 'GET', '/api/state')).json();
    assert.ok(!st.purchases.some((x) => x.id === rTal.id), 'recibida y repuesta ya no está en el resumen');
  });
});

let manual;
describe('alta manual, edición, listas y totales', () => {
  test('desde la ficha de la herramienta (sin poseedor) y desde una alerta (con la asignación)', async () => {
    const r = await api.call('responsable', 'POST', '/api/compras', { toolId: 'tool-pinza', reason: 'cambio', qty: 3, estimatedCost: '1500.5', supplier: ' Ferretería ' }, { 'idempotency-key': 'compra-manual-0001' });
    assert.equal(r.statusCode, 201, r.body);
    // Sin purchases_view, la respuesta no trae el costo ni el proveedor (Gerencia sí los ve).
    assert.equal('estimatedCost' in r.json().compra, false);
    manual = (await get('gerencia', r.json().compra.id)).json().compra;
    assert.deepEqual([manual.origin, manual.techId, manual.assignmentId, manual.estimatedCost, manual.supplier, manual.status], ['tool', null, null, 1500.5, 'Ferretería', 'pendiente']);
    // Ya hay una abierta para la pinza de Ana por faltante.
    const dup = await api.call('responsable', 'POST', '/api/compras', { toolId: 'tool-pinza', assignmentId: asg.pinza.id, reason: 'faltante', qty: 1, origin: 'alert', alertKey: 'falt-x' });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error, 'purchase_exists');
    const al = await api.call('supervisor', 'POST', '/api/compras', { toolId: 'tool-destornillador', assignmentId: asg.destornillador.id, reason: 'faltante', qty: 1, origin: 'alert', alertKey: 'falt-y', observation: 'Pedido desde la alerta' });
    assert.equal(al.statusCode, 201, al.body);
    assert.deepEqual([al.json().compra.origin, al.json().compra.techId, al.json().compra.plantillaId, al.json().compra.alertKey], ['alert', 't-ana', 'manana', 'falt-y']);
    assert.equal((await api.call('responsable', 'POST', '/api/compras', { toolId: 'tool-pinza', assignmentId: asg.destornillador.id, reason: 'cambio', qty: 1 })).json().error, 'invalid_assignment');
    assert.equal((await api.call('responsable', 'POST', '/api/compras', { toolId: 'tool-pinza', reason: 'cambio', qty: 0 })).statusCode, 400);
    assert.equal((await api.call('responsable', 'POST', '/api/compras', { toolId: 'tool-pinza', reason: 'cambio', qty: 1, estimatedCost: '1,5' })).json().error, 'invalid_cost');
  });

  test('editar costo y proveedor (y la cantidad mientras está pendiente), con la auditoría', async () => {
    assert.equal((await api.call('consulta', 'PATCH', `/api/compras/${manual.id}`, { supplier: 'x' }, ifMatch(manual.version))).statusCode, 403);
    const r = await api.call('gerencia', 'PATCH', `/api/compras/${manual.id}`, { estimatedCost: 2000, qty: 4 }, ifMatch(manual.version));
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual([r.json().compra.estimatedCost, r.json().compra.qty], [2000, 4]);
    assert.match((await one("SELECT detail FROM audit_log WHERE action = 'purchase_edit' AND entity_id = $1", [manual.id])).detail, /cantidad: 3 → 4/);
    assert.equal((await api.call('gerencia', 'PATCH', `/api/compras/${manual.id}`, { qty: 5 }, ifMatch(manual.version))).json().error, 'conflict');
    const a = await act('gerencia', manual.id, 'approve', { comment: 'Urgente', estimatedCost: '1500.50' }, r.json().compra.version);
    assert.equal(a.statusCode, 200, a.body);
    manual = a.json().compra;
    assert.equal((await api.call('gerencia', 'PATCH', `/api/compras/${manual.id}`, { qty: 9 }, ifMatch(manual.version))).json().error, 'qty_locked');
  });

  test('lista con filtros en el servidor; el responsable ve solo las que puede recibir', async () => {
    const ids = async (user, qs) => (await api.call(user, 'GET', `/api/compras?${qs}`)).json().compras.map((x) => x.id);
    assert.deepEqual(await ids('gerencia', 'status=rechazada'), [(await one("SELECT id FROM purchase_requests WHERE status = 'rechazada'")).id]);
    assert.ok((await ids('gerencia', 'status=pendiente')).includes(rPin.id));
    assert.ok(!(await ids('gerencia', 'status=pendiente')).includes(manual.id));
    const falt = (await api.call('gerencia', 'GET', '/api/compras?reason=faltante&techId=t-ana')).json().compras;
    assert.ok(falt.length && falt.every((x) => x.reason === 'faltante' && x.techId === 't-ana'));
    assert.ok((await ids('gerencia', 'q=Ferreter')).includes(manual.id));
    const ym = `${cur.y}-${String(cur.m).padStart(2, '0')}`;
    assert.deepEqual(await ids('gerencia', `toolId=tool-taladro&month=${ym}`), [rTal.id]);
    assert.deepEqual(await ids('gerencia', 'toolId=tool-taladro&month=2001-01'), []);
    const rec = await api.call('responsable', 'GET', '/api/compras?scope=receive');
    assert.deepEqual(rec.json().compras.map((x) => x.status), ['aprobada']);
    assert.equal((await api.call('responsable', 'GET', '/api/compras?scope=receive&archived=include')).statusCode, 403);
    // Página con cursor (empates de fecha resueltos por id).
    const p1 = (await api.call('gerencia', 'GET', '/api/compras?limit=1')).json();
    assert.equal(p1.compras.length, 1);
    const p2 = (await api.call('gerencia', 'GET', `/api/compras?limit=1&before=${encodeURIComponent(p1.next)}`)).json();
    assert.notEqual(p2.compras[0].id, p1.compras[0].id);
  });

  test('totales aprobados por mes: cantidad, suma de los costos conocidos y sin costo aparte', async () => {
    const r = (await api.call('gerencia', 'GET', '/api/compras/totals')).json();
    const m = r.months[r.months.length - 1];
    assert.deepEqual([m.approved, m.withCost, m.withoutCost, m.costSum, m.rejected], [2, 2, 0, 86500.5, 1]);
    assert.equal(r.pending, (await one("SELECT count(*)::int AS n FROM purchase_requests WHERE status = 'pendiente' AND archived_at IS NULL")).n);
    assert.equal((await api.call('gerencia', 'GET', '/api/compras/totals?from=2026-12&to=2026-01')).statusCode, 400);
  });
});

describe('eliminar, restaurar, novedad y detalle', () => {
  test('cancelar solo mientras está pendiente; nunca definitivo; restaurar si no hay otra abierta', async () => {
    const del = (id) => api.call('admin', 'GET', `/api/compras/${id}/delete-check`);
    assert.equal((await del(manual.id)).json().blockers[0].code, 'purchase_not_pending');
    assert.equal((await api.call('gerencia', 'POST', `/api/compras/${rPin.id}/archive`, { reason: 'x' }, ifMatch(await verOf(rPin.id)))).statusCode, 403);
    const dc = (await del(rPin.id)).json();
    assert.deepEqual([dc.canPurge, dc.hasHistory], [false, true]);
    const a = await api.call('admin', 'POST', `/api/compras/${rPin.id}/archive`, { reason: 'Se encontró' }, ifMatch(await verOf(rPin.id)));
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json().compra.archived, true);
    assert.equal((await get('gerencia', rPin.id)).statusCode, 404);
    assert.equal((await act('gerencia', rPin.id, 'approve', {}, a.json().compra.version)).statusCode, 404);
    assert.ok((await api.call('admin', 'GET', '/api/archived?type=compras')).json().records.some((x) => x.id === rPin.id));
    // Otra abierta para la misma asignación y motivo: no se restaura.
    const o = await api.call('responsable', 'POST', '/api/compras', { toolId: 'tool-pinza', assignmentId: asg.pinza.id, reason: 'faltante', qty: 1, origin: 'alert' });
    assert.equal(o.statusCode, 201, o.body);
    const rs = await api.call('admin', 'POST', `/api/compras/${rPin.id}/restore`, { reason: 'Error' }, ifMatch(a.json().compra.version));
    assert.deepEqual([rs.statusCode, rs.json().error], [409, 'duplicate']);
    await api.call('admin', 'POST', `/api/compras/${o.json().compra.id}/archive`, { reason: 'Repetida' }, ifMatch(o.json().compra.version));
    const ok = await api.call('admin', 'POST', `/api/compras/${rPin.id}/restore`, { reason: 'Error' }, ifMatch(a.json().compra.version));
    assert.equal(ok.statusCode, 200, ok.body);
    const pg = await api.call('admin', 'DELETE', `/api/compras/${rPin.id}`, { reason: 'x', confirmName: rPin.name }, ifMatch(ok.json().compra.version));
    assert.equal(pg.json().error, 'has_history');
    assert.equal((await api.call('admin', 'POST', `/api/compras/${manual.id}/archive`, { reason: 'x' }, ifMatch(manual.version))).json().error, 'purchase_not_pending');
  });

  test('una novedad se vincula a una solicitud; vinculada = movimiento o compra', async () => {
    assert.equal((await api.call('responsable', 'POST', '/api/novedades', { comment: 'x', purchaseRequestId: 'pr-nada' })).json().error, 'invalid_purchase');
    const r = await api.call('responsable', 'POST', '/api/novedades', { comment: 'Gerencia pidió otra marca', purchaseRequestId: manual.id });
    assert.equal(r.statusCode, 201, r.body);
    const n = r.json().novedad;
    assert.deepEqual([n.purchaseRequestId, n.purchase.name, n.movementId], [manual.id, manual.name, null]);
    const linked = (await api.call('responsable', 'GET', '/api/novedades?linked=yes')).json().novedades.map((x) => x.id);
    assert.ok(linked.includes(n.id));
    assert.ok(!(await api.call('responsable', 'GET', '/api/novedades?linked=no')).json().novedades.some((x) => x.id === n.id));
    assert.deepEqual((await api.call('responsable', 'GET', `/api/novedades?purchaseRequestId=${manual.id}`)).json().novedades.map((x) => x.id), [n.id]);
    const d = (await get('gerencia', manual.id)).json().compra;
    assert.deepEqual(d.novedades.map((x) => x.id), [n.id]);
  });

  test('detalle con controles vinculados y la línea de tiempo; consulta por período', async () => {
    assert.equal((await get('consulta', rTal.id)).statusCode, 403);
    const r = await get('responsable', rTal.id);
    assert.equal(r.statusCode, 200);
    const d = r.json().compra;
    assert.equal(r.headers.etag, `"${d.version}"`);
    // Los dos controles concurrentes y las tres correcciones siguientes con el mismo recambio.
    assert.equal(d.controls.length, 5);
    assert.deepEqual(d.timeline.map((x) => x.action), ['purchase_create', 'purchase_link', 'purchase_link', 'purchase_link', 'purchase_link', 'purchase_approve', 'purchase_edit', 'purchase_purchase', 'purchase_receive', 'purchase_reposicion']);
    const actor = { id: 'u-gerencia', role: 'gerencia' };
    const all = await purchasesOfPeriod(api.appPool, actor, {});
    const st = all.map((x) => x.status).sort();
    assert.deepEqual(st, ['aprobada', 'rechazada', 'recibida']);
    assert.equal((await purchasesOfPeriod(api.appPool, actor, { from: '2000-01-01', to: '2000-01-31' })).length, 0);
    assert.equal((await purchasesOfPeriod(api.appPool, actor, { reason: 'faltante' })).length, 1);
  });
});
