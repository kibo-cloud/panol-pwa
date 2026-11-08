import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { periodOf, pkeyOf } from '../../src/domain/period.js';

let api;
const cur = periodOf(new Date());
const ym = `${cur.y}-${String(cur.m).padStart(2, '0')}`;
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

test('estado completo: requiere sesión y trae las colecciones de 2.1 más los derivados', async () => {
  assert.equal((await api.call(null, 'GET', '/api/state')).statusCode, 401);
  const r = await api.call('consulta', 'GET', '/api/state');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const s = r.json();
  for (const k of ['techs', 'shiftChanges', 'categories', 'tools', 'units', 'assignments', 'controls', 'movements', 'alertRes', 'users', 'shifts', 'config', 'derived']) assert.ok(k in s, k);
  assert.equal(s.techs['t-ana'].name, 'Ana Prueba');
  assert.equal(typeof s.techs['t-ana'].version, 'number');
  assert.deepEqual(s.config.turnos.list.map((x) => x.id), ['manana', 'tarde', 'noche']);
  assert.equal(s.derived.pools['tool-pinza'].disponible, 17);
  assert.equal(s.derived.curKey, pkeyOf(cur));
  assert.equal(s.derived.drafts[`t-bruno|${pkeyOf(cur)}`], `c-t-bruno-${pkeyOf(cur)}`);
  assert.ok(Object.values(s.movements).every((m) => Array.isArray(m.transfers) && m.transfers.length));
  assert.doesNotMatch(r.body, /password_hash|argon2|csrf/i);
  assert.deepEqual((await api.call('consulta', 'GET', '/api/integrity')).json().issues, []);
});

test('informe: números sobre un fixture armado con la API', async () => {
  const tech = (await api.call('admin', 'POST', '/api/techs', { name: 'Informe Prueba', legajo: 'REP-1', shiftId: 'noche' })).json().tech;
  const ent = await api.call('responsable', 'POST', '/api/movements', { type: 'entrega_inicial', techId: tech.id, toolId: 'tool-pinza', qty: 3 });
  const asgId = ent.json().assignments[0];
  let c = (await api.call('responsable', 'POST', '/api/controls', { techId: tech.id, period: cur, items: { [asgId]: { state: 'cambio', note: 'Mordaza gastada' } } })).json().control;
  c = (await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, undefined, ifMatch(c.version))).json().control;

  // Alerta "para cambio": se resuelve y se reabre.
  const key = `camb-${asgId}-${c.id}`;
  assert.ok((await api.call('consulta', 'GET', '/api/alerts')).json().open.some((a) => a.key === key));
  assert.equal((await api.call('consulta', 'POST', `/api/alerts/${key}/resolution`, { note: 'x' })).statusCode, 403);
  const res = await api.call('responsable', 'POST', `/api/alerts/${key}/resolution`, { note: 'Se pidió cambio' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().resolution.title, 'Para cambio, reposición pendiente');
  assert.equal((await api.call('responsable', 'POST', `/api/alerts/${key}/resolution`, {})).statusCode, 409);
  let al = (await api.call('consulta', 'GET', '/api/alerts')).json();
  assert.ok(!al.open.some((a) => a.key === key));
  assert.equal(al.resolved[0].key, key);
  assert.equal((await api.call('responsable', 'DELETE', `/api/alerts/${key}/resolution`)).statusCode, 428);
  assert.equal((await api.call('responsable', 'DELETE', `/api/alerts/${key}/resolution`, undefined, ifMatch(res.json().resolution.version))).statusCode, 200);
  al = (await api.call('consulta', 'GET', '/api/alerts')).json();
  assert.ok(al.open.some((a) => a.key === key));
  assert.equal((await api.call('responsable', 'POST', '/api/alerts/no-existe/resolution', {})).statusCode, 404);

  await api.call('responsable', 'POST', '/api/movements', { type: 'reposicion', techId: tech.id, asgId, returned: true, oldDest: 'reparacion' });
  const rep = await api.call('gerencia', 'GET', `/api/reports?ym=${ym}&tech=${tech.id}`);
  assert.equal(rep.statusCode, 200);
  const R = rep.json();
  assert.equal(R.rows.length, 1);
  const { bueno, cambio, faltante, pct, ctl, expected, repos, recup, total, fromControl } = R.rows[0];
  assert.deepEqual({ bueno, cambio, faltante, pct, ctl, expected, repos, recup, total, fromControl }, { bueno: 0, cambio: 3, faltante: 0, pct: 0, ctl: 1, expected: cur.w, repos: 1, recup: 0, total: 3, fromControl: true });
  const noche = R.shifts.find((s) => s.id === 'noche');
  assert.deepEqual([noche.techs, noche.ctl, noche.pend, noche.repos], [1, 1, cur.w - 1, 1]);
  assert.equal(R.totals.repos, 1);
  assert.equal(R.evo.length, 6);
  const w = await api.call('gerencia', 'GET', `/api/reports?ym=${ym}&w=${cur.w}&shift=noche`);
  assert.equal(w.json().rows.find((r) => r.id === tech.id).expected, 1);
  for (const bad of ['ym=2026-13', 'w=5', 'tech=../x', 'otra=1']) assert.equal((await api.call('gerencia', 'GET', `/api/reports?${bad}`)).statusCode, 400, bad);
});

test('auditoría: solo admin, paginada', async () => {
  assert.equal((await api.call('responsable', 'GET', '/api/audit')).statusCode, 403);
  const p1 = (await api.call('admin', 'GET', '/api/audit?limit=2')).json();
  assert.equal(p1.items.length, 2);
  assert.ok(p1.next);
  const p2 = (await api.call('admin', 'GET', `/api/audit?limit=2&before=${encodeURIComponent(p1.next)}`)).json();
  assert.equal(p2.items.length, 2);
  assert.ok(p2.items.every((x) => !p1.items.some((y) => y.id === x.id)));
  assert.ok(p2.items[0].at <= p1.items[1].at);
  assert.equal((await api.call('admin', 'GET', '/api/audit?before=basura')).statusCode, 400);
});

test('SSE: un usuario con sesión recibe el aviso después de una escritura', async () => {
  const addr = await api.app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await fetch(`${addr}/api/events`)).status, 401);
  const s = await api.login('consulta');
  const ac = new AbortController();
  const res = await fetch(`${addr}/api/events`, { headers: { cookie: s.cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const wait = async (re) => {
    const until = Date.now() + 10000;
    while (!re.test(buf)) {
      if (Date.now() > until) throw new Error(`sin evento: ${buf}`);
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    return buf;
  };
  await wait(/conectado/);
  const t = (await api.call('admin', 'POST', '/api/techs', { name: 'Evento Prueba', legajo: 'SSE-1' })).json().tech;
  const got = await wait(/event: change\ndata: .*"techs"/);
  const data = JSON.parse(/event: change\ndata: (.*)\n/.exec(got)[1]);
  assert.deepEqual(data, { entity: 'techs', id: t.id, version: t.version, action: 'create' });
  ac.abort();
  await reader.cancel().catch(() => {});
});

test('datos de demostración: cargar, marcar y borrar sin tocar lo real', async () => {
  const count = async (t) => (await api.q(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
  const before = { techs: await count('techs'), movements: await count('movements'), controls: await count('controls'), units: await count('units') };
  assert.equal((await api.call('responsable', 'POST', '/api/demo')).statusCode, 403);
  const r = await api.call('admin', 'POST', '/api/demo');
  assert.equal(r.statusCode, 201);
  assert.equal((await api.call('admin', 'POST', '/api/demo')).statusCode, 409);
  let st = (await api.call('consulta', 'GET', '/api/state')).json();
  assert.equal(st.derived.hasDemo, true);
  assert.equal(await count('techs'), before.techs + 6);
  assert.equal((await api.q('SELECT count(*)::int AS n FROM controls WHERE demo AND status = $1', ['finalizado']))[0].n, 12);
  assert.ok(Object.values(st.techs).some((t) => t.demo && t.name === 'Martín Gómez'));
  assert.deepEqual((await api.call('consulta', 'GET', '/api/integrity')).json().issues, []);
  // Los códigos que ya existían en datos reales no chocan.
  assert.ok((await api.q("SELECT 1 FROM units WHERE code = 'DEMO-TAL-001'")).length);

  const del = await api.call('admin', 'DELETE', '/api/demo');
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().deleted.techs, 6);
  st = (await api.call('consulta', 'GET', '/api/state')).json();
  assert.equal(st.derived.hasDemo, false);
  assert.deepEqual({ techs: await count('techs'), movements: await count('movements'), controls: await count('controls'), units: await count('units') }, before);
  assert.equal((await api.q("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('demo_load', 'demo_clear')"))[0].n, 2);
  // Fuera del borrado de demo, el libro sigue cerrado aunque la fila sea demo.
  await api.call('admin', 'POST', '/api/demo');
  await assert.rejects(api.q('DELETE FROM movements WHERE demo'), { code: '23001' });
  // Un movimiento real sobre un técnico demo impide borrar (no se pierde historial real).
  const [demoTech] = await api.q('SELECT id FROM techs WHERE demo LIMIT 1');
  assert.equal((await api.call('admin', 'POST', '/api/movements', { type: 'adicional', techId: demoTech.id, toolId: (await api.q('SELECT tool_id FROM assignments WHERE tech_id = $1 AND unit_id IS NULL LIMIT 1', [demoTech.id]))[0].tool_id, qty: 1 })).statusCode, 201);
  const blocked = await api.call('admin', 'DELETE', '/api/demo');
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error, 'demo_in_use');
});
