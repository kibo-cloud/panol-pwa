// Etapa 3 (E3.V1): bloqueos entre reordenar, entregar kit, cambiar de categoría y archivar una
// especialidad, con dos conexiones y de forma determinista: una conexión de afuera retiene un
// bloqueo, se espera a que los pedidos queden esperando (pg_stat_activity) y se suelta.
// Orden global de bloqueos: versión del alcance (order_versions) -> filas por id.
// También: importar un .txt sube la versión de los alcances de orden que cambia.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi } from './api.js';
import { HEAD, toTxt } from '../fixtures/v21.js';
import { reorderTools } from '../../src/application/orden.js';
import { createCategory, createTool, updateTool, updateTech } from '../../src/application/catalog.js';
import { createEspecialidad, archiveEspecialidad, createKit, updateKit, deliverKit } from '../../src/application/kits.js';

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
const scopeVersion = async (scope) => (await one('SELECT version FROM order_versions WHERE scope = $1', [scope]))?.version ?? 1;

// Espera a que haya `n` sesiones esperando un bloqueo.
async function waitForWaiters(n) {
  for (let i = 0; i < 400; i++) {
    const { n: w } = await one("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (w >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No hubo ${n} sesiones esperando un bloqueo.`);
}

// Conexión de afuera con una transacción abierta.
async function outside(sqls) {
  const c = await api.pool.connect();
  await c.query('BEGIN');
  for (const [sql, p] of sqls) await c.query(sql, p);
  return {
    c,
    end: async (extra = [], how = 'COMMIT') => {
      for (const [sql, p] of extra) await c.query(sql, p);
      await c.query(how);
      c.release();
    },
  };
}

const outcome = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

async function twoTools(prefix) {
  const cat = await createCategory(api.appPool, actor, { name: `${prefix} categoría` });
  const t1 = await createTool(api.appPool, actor, { name: `${prefix} uno`, categoryId: cat.id, stock: 5 });
  const t2 = await createTool(api.appPool, actor, { name: `${prefix} dos`, categoryId: cat.id, stock: 5 });
  const [a, b] = [t1.id, t2.id].sort();
  return { cat, a, b };
}

describe('orden de bloqueos', () => {
  test('reordenar y entregar kit a la vez: sin bloqueo mutuo (las herramientas se bloquean por id)', async () => {
    const { cat, a, b } = await twoTools('Conc');
    const scope = `tools:${cat.id}`;
    await reorderTools(api.appPool, actor, cat.id, [a, b], await scopeVersion(scope));
    const kit = await one("SELECT version FROM kits WHERE id = 'kit-base'");
    await updateKit(api.appPool, actor, 'kit-base', { items: [{ toolId: a, qty: 1 }, { toolId: b, qty: 1 }] }, kit.version);

    // La conexión de afuera retiene la herramienta b (la de id mayor).
    const o = await outside([['SELECT id FROM tools WHERE id = $1 FOR UPDATE', [b]]]);
    // Reordenar [b, a] escribe b y después a; entregar el kit bloquea a y después b.
    const p1 = outcome(reorderTools(api.appPool, actor, cat.id, [b, a], await scopeVersion(scope)));
    await waitForWaiters(1);
    const p2 = outcome(deliverKit(api.appPool, actor, 'kit-base', { holder: { techId: 't-carla' } }, { path: '/api/kits/kit-base/deliver' }));
    await waitForWaiters(2);
    await o.end();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.ok, `reordenar: ${r1.e?.code} ${r1.e?.message}`);
    assert.ok(r2.ok, `entregar: ${r2.e?.code} ${r2.e?.message}`);
    assert.deepEqual((await api.q('SELECT id FROM tools WHERE category_id = $1 ORDER BY sort_order', [cat.id])).map((r) => r.id), [b, a]);
    assert.equal(r2.v.body.movements.length, 2);
  });

  test('reordenar y cambiar de categoría a la vez: el alcance se bloquea antes que la herramienta', async () => {
    const { cat, a, b } = await twoTools('Mover');
    const dest = await createCategory(api.appPool, actor, { name: 'Mover destino' });
    const scope = `tools:${cat.id}`;
    const tool = await one('SELECT version FROM tools WHERE id = $1', [a]);
    // La conexión de afuera retiene el alcance de la categoría de origen.
    const o = await outside([['SELECT version FROM order_versions WHERE scope = $1 FOR UPDATE', [scope]]]);
    const p1 = outcome(reorderTools(api.appPool, actor, cat.id, [b, a], await scopeVersion(scope)));
    await waitForWaiters(1);
    const p2 = outcome(updateTool(api.appPool, actor, a, { categoryId: dest.id }, tool.version));
    await waitForWaiters(2);
    await o.end([], 'ROLLBACK');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.ok, `reordenar: ${r1.e?.code} ${r1.e?.message}`);
    assert.ok(r2.ok, `mover: ${r2.e?.code} ${r2.e?.message}`);
    assert.equal((await one('SELECT category_id FROM tools WHERE id = $1', [a])).category_id, dest.id);
  });

  test('cambio de categoría que cambió entre la lectura y el bloqueo: 409 y ningún alcance cambia', async () => {
    const { cat, a } = await twoTools('Carrera');
    const otra = await createCategory(api.appPool, actor, { name: 'Carrera otra' });
    const dest = await createCategory(api.appPool, actor, { name: 'Carrera destino' });
    const tool = await one('SELECT version FROM tools WHERE id = $1', [a]);
    const vs = async () => Promise.all([`tools:${cat.id}`, `tools:${otra.id}`, `tools:${dest.id}`].map(scopeVersion));
    const v0 = await vs();
    // Otra conexión mueve la herramienta a "otra" y retiene la fila.
    const o = await outside([['UPDATE tools SET category_id = $2 WHERE id = $1', [a, otra.id]]]);
    const p = outcome(updateTool(api.appPool, actor, a, { categoryId: dest.id }, tool.version));
    await waitForWaiters(1);
    await o.end();
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.e.status, 409, r.e.message);
    assert.equal((await one('SELECT category_id FROM tools WHERE id = $1', [a])).category_id, otra.id);
    assert.deepEqual(await vs(), v0);
  });
});

describe('archivar una especialidad mientras se asigna', () => {
  // La conexión de afuera hace de "archivar": bloquea la especialidad, espera y la archiva.
  const archiving = (id) => outside([['SELECT id FROM especialidades WHERE id = $1 FOR UPDATE', [id]]]);
  const archive = (o, id) => o.end([['UPDATE especialidades SET archived_at = now() WHERE id = $1', [id]]]);

  test('asignarla a un técnico espera al archivo y se rechaza (no queda un técnico con una especialidad archivada)', async () => {
    const e = await createEspecialidad(api.appPool, actor, { name: 'Carrera técnico' });
    const t = await one("SELECT version FROM techs WHERE id = 't-dario'");
    const o = await archiving(e.id);
    const p = outcome(updateTech(api.appPool, actor, 't-dario', { especialidadId: e.id }, t.version));
    await waitForWaiters(1);
    await archive(o, e.id);
    const r = await p;
    assert.equal(r.ok, false, 'el técnico quedó con una especialidad archivada');
    assert.equal(r.e.code, 'invalid_especialidad');
    assert.equal((await one("SELECT especialidad_id FROM techs WHERE id = 't-dario'")).especialidad_id, null);
  });

  test('crear su kit espera al archivo y se rechaza', async () => {
    const e = await createEspecialidad(api.appPool, actor, { name: 'Carrera kit' });
    const o = await archiving(e.id);
    const p = outcome(createKit(api.appPool, actor, { especialidadId: e.id }));
    await waitForWaiters(1);
    await archive(o, e.id);
    const r = await p;
    assert.equal(r.ok, false, 'quedó un kit de una especialidad archivada');
    assert.equal(r.e.code, 'invalid_especialidad');
    assert.equal((await one('SELECT count(*)::int AS n FROM kits WHERE especialidad_id = $1', [e.id])).n, 0);
  });

  test('archivar espera a una asignación en curso y la ve (409 especialidad_in_use)', async () => {
    const e = await createEspecialidad(api.appPool, actor, { name: 'Carrera archivo' });
    const o = await outside([
      ['SELECT id FROM especialidades WHERE id = $1 FOR SHARE', [e.id]],
      ["UPDATE techs SET especialidad_id = $1 WHERE id = 't-bruno'", [e.id]],
    ]);
    const p = outcome(archiveEspecialidad(api.appPool, actor, e.id, e.version));
    await waitForWaiters(1);
    await o.end();
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.e.code, 'especialidad_in_use');
    assert.equal((await one('SELECT archived_at FROM especialidades WHERE id = $1', [e.id])).archived_at, null);
  });
});

describe('.txt v2 y versiones de orden', () => {
  test('importar sube la versión de los alcances que cambia (un reordenar abierto recibe 409)', async () => {
    const e = await api.call('admin', 'GET', '/api/export/txt');
    const p = JSON.parse(e.body.slice(HEAD.length));
    const st0 = (await api.call('admin', 'GET', '/api/state')).json().orderVersions;
    const v = (k) => st0[k] ?? 1;
    p.data.tools['h-txt-orden'] = { name: 'Llave importada', categoryId: 'cat-manuales', serialized: false, active: true, updatedAt: new Date().toISOString() };
    p.data.categories['g-txt-orden'] = { name: 'Categoría importada', updatedAt: new Date().toISOString() };
    const rep = (await api.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', toTxt(p), { 'content-type': 'text/plain' })).json();
    assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
    const ap = await api.call('admin', 'POST', `/api/import/txt?mode=merge&token=${encodeURIComponent(rep.token)}`, toTxt(p), { 'content-type': 'text/plain' });
    assert.equal(ap.statusCode, 200, ap.body);
    const st1 = (await api.call('admin', 'GET', '/api/state')).json().orderVersions;
    assert.equal(st1['tools:cat-manuales'], v('tools:cat-manuales') + 1);
    assert.equal(st1.categories, v('categories') + 1);
    // Un alcance que no cambió queda igual.
    assert.equal(st1['tools:cat-medicion'] ?? 1, v('tools:cat-medicion'));
    // Quien tenía abierta la pantalla de orden con la versión vieja recibe un 409 limpio.
    const ids = (await api.q("SELECT id FROM tools WHERE category_id = 'cat-manuales' ORDER BY sort_order")).map((r) => r.id);
    const stale = await api.call('admin', 'PUT', '/api/tools/order', { categoryId: 'cat-manuales', ids }, { 'if-match': `"${v('tools:cat-manuales')}"` });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'conflict');
  });
});
