import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi } from './api.js';

let api;
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const pools = async (toolId) => (await api.call('admin', 'GET', '/api/inventory')).json().pools[toolId];
const countMov = async () => (await api.q('SELECT count(*)::int AS n FROM movements'))[0].n;

test('permisos por tipo: responsable entrega, no ajusta inventario; consulta y gerencia no escriben', async () => {
  const entrega = { type: 'entrega_inicial', techId: 't-carla', toolId: 'tool-pinza', qty: 1 };
  for (const u of ['consulta', 'gerencia']) assert.equal((await api.call(u, 'POST', '/api/movements', entrega)).statusCode, 403, u);
  assert.equal((await api.call('responsable', 'POST', '/api/movements', { type: 'ingreso', toolId: 'tool-pinza', qty: 5 })).statusCode, 403);
  const r = await api.call('responsable', 'POST', '/api/movements', entrega);
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().movement.type, 'entrega_inicial');
  assert.equal(r.json().assignments.length, 1);
  const [m] = await api.q('SELECT created_by FROM movements WHERE id = $1', [r.json().movement.id]);
  assert.equal(m.created_by, 'u-responsable');
  assert.equal((await api.q("SELECT 1 FROM audit_log WHERE entity = 'movements' AND entity_id = $1", [r.json().movement.id])).length, 1);
  assert.equal((await api.call('admin', 'POST', '/api/movements', { type: 'ingreso', toolId: 'tool-pinza', qty: 5 })).statusCode, 201);
});

test('validación: tipo, cantidad, campos extra; reglas de 2.1 como 422', async () => {
  for (const b of [{ type: 'regalo' }, { type: 'entrega_inicial', qty: 0 }, { type: 'entrega_inicial', qty: '2' }, { type: 'ingreso', toolId: 'tool-pinza', qty: 1, at: '2020-01-01' }]) {
    assert.equal((await api.call('admin', 'POST', '/api/movements', b)).statusCode, 400, JSON.stringify(b));
  }
  const r = await api.call('admin', 'POST', '/api/movements', { type: 'entrega_inicial', techId: 't-ana', toolId: 'tool-pinza', qty: 1 });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().message, 'El técnico ya tiene esta herramienta. Usá Entrega adicional o Reposición.');
  const over = await api.call('admin', 'POST', '/api/movements', { type: 'adicional', techId: 't-ana', toolId: 'tool-pinza', qty: 999 });
  assert.match(over.json().message, /^Solo hay \d+ disponibles/);
});

test('reposición, devolución y recepción de pendiente actualizan el libro y el inventario', async () => {
  const [a] = await api.q("SELECT id FROM assignments WHERE tech_id = 't-bruno' AND tool_id = 'tool-pinza' AND active");
  const before = await pools('tool-pinza');
  const rep = await api.call('responsable', 'POST', '/api/movements', { type: 'reposicion', techId: 't-bruno', asgId: a.id, returned: false });
  assert.equal(rep.statusCode, 201);
  const mid = rep.json().movement.id;
  let p = await pools('tool-pinza');
  assert.equal(p.pendiente, before.pendiente + 1);
  assert.equal(p.disponible, before.disponible - 1);
  const alerts = (await api.call('consulta', 'GET', '/api/alerts')).json().open;
  assert.ok(alerts.some((x) => x.key === `dev-${mid}`));
  const recv = await api.call('responsable', 'POST', '/api/movements', { type: 'recepcion', resolvesMovementId: mid, cond: 'disponible' });
  assert.equal(recv.statusCode, 201);
  const again = await api.call('responsable', 'POST', '/api/movements', { type: 'recepcion', resolvesMovementId: mid, cond: 'disponible' });
  assert.equal(again.statusCode, 422);
  assert.equal(again.json().message, 'Ya fue registrada.');
  p = await pools('tool-pinza');
  assert.equal(p.pendiente, before.pendiente);
  assert.equal(p.disponible, before.disponible);
});

// Retiene la fila de la herramienta desde otra conexión hasta que `waiting` pedidos estén
// esperando el lock, así los pedidos quedan realmente superpuestos.
async function contended(toolId, waiting, fire) {
  const c = await api.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM tools WHERE id = $1 FOR UPDATE', [toolId]);
    const pending = fire();
    for (let i = 0; i < 200; i++) {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
      if (rows[0].n >= waiting) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await c.query('COMMIT');
    return await pending;
  } finally {
    c.release();
  }
}

test('carrera: dos entregas simultáneas de la última unidad, solo una pasa', async () => {
  const tool = (await api.call('admin', 'POST', '/api/tools', { name: 'Medidor láser', serialized: true, codes: 'LAS-1' })).json().tool;
  const [u] = await api.q('SELECT id FROM units WHERE tool_id = $1', [tool.id]);
  const n0 = await countMov();
  await api.login('responsable');
  const rs = await contended(tool.id, 2, () => Promise.all(['t-ana', 't-bruno'].map((techId) => api.call('responsable', 'POST', '/api/movements', { type: 'entrega_inicial', techId, toolId: tool.id, unitId: u.id }))));
  const codes = rs.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [201, 422]);
  assert.equal(rs.find((r) => r.statusCode === 422).json().message, 'Elegí una unidad disponible.');
  assert.equal(await countMov(), n0 + 1);
  assert.equal((await pools(tool.id)).asignado, 1);

  // Por cantidad: queda 1 y se piden 1 + 1 a la vez.
  const qtool = (await api.call('admin', 'POST', '/api/tools', { name: 'Cinta métrica', stock: 1 })).json().tool;
  const qs = await contended(qtool.id, 3, () => Promise.all(['t-ana', 't-bruno', 't-carla'].map((techId) => api.call('responsable', 'POST', '/api/movements', { type: 'entrega_inicial', techId, toolId: qtool.id, qty: 1 }))));
  assert.deepEqual(qs.map((r) => r.statusCode).sort(), [201, 422, 422]);
  const p = await pools(qtool.id);
  assert.equal(p.disponible, 0);
  assert.equal(p.asignado, 1);
});

test('idempotencia: el reintento devuelve la misma respuesta sin repetir el movimiento', async () => {
  const body = { type: 'adicional', techId: 't-ana', toolId: 'tool-destornillador', qty: 1 };
  const key = { 'idempotency-key': 'mov-retry-0001' };
  const n0 = await countMov();
  const r1 = await api.call('responsable', 'POST', '/api/movements', body, key);
  const r2 = await api.call('responsable', 'POST', '/api/movements', body, key);
  assert.equal(r1.statusCode, 201);
  assert.equal(r2.statusCode, 201);
  assert.equal(r2.headers['idempotent-replayed'], 'true');
  assert.deepEqual(r2.json(), r1.json());
  assert.equal(await countMov(), n0 + 1);
  // Simultáneos con la misma clave: uno aplica, el otro espera y repite la respuesta.
  const k2 = { 'idempotency-key': 'mov-retry-0002' };
  const [a, b] = await Promise.all([api.call('responsable', 'POST', '/api/movements', body, k2), api.call('responsable', 'POST', '/api/movements', body, k2)]);
  assert.deepEqual(a.json(), b.json());
  assert.equal(await countMov(), n0 + 2);
  const other = await api.call('responsable', 'POST', '/api/movements', { ...body, qty: 2 }, key);
  assert.equal(other.statusCode, 422);
  assert.equal(other.json().error, 'idempotency_mismatch');
  assert.equal((await api.call('responsable', 'POST', '/api/movements', body, { 'idempotency-key': 'corta' })).statusCode, 400);
  // La clave es por usuario: otro usuario con la misma clave hace su propio movimiento.
  assert.equal((await api.call('admin', 'POST', '/api/movements', body, key)).headers['idempotent-replayed'], undefined);
});

test('el libro sigue siendo de solo agregar', async () => {
  await assert.rejects(api.q('DELETE FROM movements'), { code: '23001' });
  await assert.rejects(api.q("UPDATE movement_transfers SET qty = 99"), { code: '23001' });
});
