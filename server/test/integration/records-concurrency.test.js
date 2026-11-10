// E5.V1: bloqueos de eliminar (archivar) contra controles, entregas de kit y alertas, con dos
// conexiones y de forma determinista: una conexión de afuera retiene un bloqueo, se espera a que
// los pedidos queden esperando (pg_stat_activity) y se suelta.
// Orden global: alcances -> plantilla -> poseedor -> filas por id -> herramientas por id.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { periodOf } from '../../src/domain/period.js';
import { archiveRecord } from '../../src/application/records.js';
import { createEspecialidad, createKit, updateKit, deliverKit } from '../../src/application/kits.js';
import { createTool, createTech } from '../../src/application/catalog.js';
import { resolveAlert } from '../../src/application/alerts.js';

let api;
let actor;
before(async () => {
  api = await setupApi();
  actor = { id: (await api.login('admin')).id, ip: '127.0.0.1' };
});
after(async () => {
  await api?.close();
});

const one = async (sql, p) => (await api.q(sql, p))[0];
const outcome = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

async function waitForWaiters(n) {
  for (let i = 0; i < 400; i++) {
    const { n: w } = await one("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (w >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No hubo ${n} sesiones esperando un bloqueo.`);
}

async function outside(sqls) {
  const c = await api.pool.connect();
  await c.query('BEGIN');
  for (const [sql, p] of sqls) await c.query(sql, p);
  return {
    end: async (extra = [], how = 'COMMIT') => {
      for (const [sql, p] of extra) await c.query(sql, p);
      await c.query(how);
      c.release();
    },
  };
}

describe('controles y técnicos eliminados', () => {
  test('un control espera al técnico que se está eliminando y después lo rechaza', async () => {
    const t = await createTech(api.appPool, actor, { name: 'Control Concurrente', legajo: 'CC-1' });
    // La conexión de afuera es la eliminación en curso: retiene al técnico.
    const o = await outside([['SELECT id FROM techs WHERE id = $1 FOR UPDATE', [t.id]]]);
    const p = api.call('responsable', 'POST', '/api/controls', { techId: t.id, period: periodOf(new Date()) });
    try {
      await waitForWaiters(1);
    } finally {
      await o.end([["UPDATE techs SET archived_at = now(), archived_by = 'u-admin', archive_reason = 'Prueba', active = false WHERE id = $1", [t.id]]]);
    }
    const r = await p;
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'archived');
    assert.equal((await one('SELECT count(*)::int AS n FROM controls WHERE tech_id = $1', [t.id])).n, 0);
  });

  test('el borrador de un técnico eliminado no se guarda ni se finaliza', async () => {
    const t = (await api.call('admin', 'POST', '/api/techs', { name: 'Borrador Eliminado', legajo: 'BE-1' })).json().tech;
    const c = (await api.call('responsable', 'POST', '/api/controls', { techId: t.id, period: periodOf(new Date()) })).json().control;
    const a = await api.call('admin', 'POST', `/api/techs/${t.id}/archive`, { reason: 'Prueba' }, ifMatch(t.version));
    assert.equal(a.statusCode, 200, a.body);
    const s = await api.call('responsable', 'PATCH', `/api/controls/${c.id}`, { items: {} }, ifMatch(c.version));
    assert.equal(s.json().error, 'archived', s.body);
    const f = await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, {}, ifMatch(c.version));
    assert.equal(f.json().error, 'archived', f.body);
  });
});

describe('herramienta en un kit', () => {
  test('eliminar la herramienta mientras se entrega el kit: sin bloqueo mutuo (kits antes que la herramienta)', async () => {
    const esp = await createEspecialidad(api.appPool, actor, { name: 'Especialidad concurrente' });
    const kit = await createKit(api.appPool, actor, { especialidadId: esp.id });
    const tool = await createTool(api.appPool, actor, { name: 'Herramienta concurrente', stock: 5 });
    const k = await updateKit(api.appPool, actor, kit.id, { items: [{ toolId: tool.id, qty: 1 }] }, kit.version);
    const tech = await createTech(api.appPool, actor, { name: 'Poseedor concurrente', legajo: 'PC-1' });
    const toolVersion = (await one('SELECT version FROM tools WHERE id = $1', [tool.id])).version;

    // Afuera se retiene al poseedor: la entrega toma el kit (FOR SHARE) y espera al poseedor.
    const o = await outside([['SELECT id FROM techs WHERE id = $1 FOR UPDATE', [tech.id]]]);
    const deliver = outcome(deliverKit(api.appPool, actor, kit.id, { holder: { techId: tech.id } }, { path: `/api/kits/${kit.id}/deliver`, version: k.version }));
    await waitForWaiters(1);
    // Eliminar la herramienta: antes bloqueaba la herramienta y después esperaba el kit.
    const archive = outcome(archiveRecord(api.appPool, actor, 'tools', tool.id, { reason: 'Prueba' }, toolVersion));
    await waitForWaiters(2);
    await o.end();
    const [d, a] = await Promise.all([deliver, archive]);
    assert.ok(d.ok, `entregar: ${d.e?.code} ${d.e?.message}`);
    // La entrega terminó primero: la herramienta quedó asignada y no se elimina (409 claro, no 40P01).
    assert.equal(a.ok, false);
    assert.equal(a.e.code, 'tool_assigned', `${a.e?.code} ${a.e?.message}`);
  });
});

describe('alertas', () => {
  test('resolver una alerta toma al poseedor FOR SHARE (no se elimina en el medio)', async () => {
    const tech = (await api.call('admin', 'POST', '/api/techs', { name: 'Alerta Concurrente', legajo: 'AC-1' })).json().tech;
    const asg = (await api.call('responsable', 'POST', '/api/movements', { type: 'entrega_inicial', techId: tech.id, toolId: 'tool-pinza', qty: 1 })).json().assignments[0];
    let c = (await api.call('responsable', 'POST', '/api/controls', { techId: tech.id, period: periodOf(new Date()), items: { [asg]: { state: 'cambio', note: 'Gastada' } } })).json().control;
    c = (await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, { cleaning: { status: 'limpio' } }, ifMatch(c.version))).json().control;
    const key = `camb-${asg}-${c.id}`;
    const o = await outside([['SELECT id FROM techs WHERE id = $1 FOR UPDATE', [tech.id]]]);
    const p = outcome(resolveAlert(api.appPool, actor, key, { note: 'Visto' }));
    try {
      await waitForWaiters(1);
    } finally {
      await o.end();
    }
    const r = await p;
    assert.ok(r.ok, `${r.e?.code} ${r.e?.message}`);
  });
});
