import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { periodOf, prevP, pkeyOf } from '../../src/domain/period.js';

let api;
const cur = periodOf(new Date());
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const asgOf = async (techId) => (await api.q('SELECT id, qty FROM assignments WHERE tech_id = $1 AND active ORDER BY id', [techId]));

test('permisos: consulta y gerencia no hacen controles; leer sí', async () => {
  for (const u of ['consulta', 'gerencia']) {
    assert.equal((await api.call(u, 'POST', '/api/controls', { techId: 't-carla', period: cur })).statusCode, 403, u);
  }
  const r = await api.call('consulta', 'GET', '/api/controls?techId=t-ana');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().controls.length, 1);
});

test('borrador, guardado con If-Match, finalizar e inmutable', async () => {
  const asg = await asgOf('t-carla');
  assert.equal(asg.length, 1);
  const r = await api.call('responsable', 'POST', '/api/controls', { techId: 't-carla', period: cur });
  assert.equal(r.statusCode, 201);
  const c = r.json().control;
  assert.equal(c.id, `c-t-carla-${pkeyOf(cur)}`);
  assert.equal(c.status, 'borrador');
  assert.equal(r.headers.etag, `"${c.version}"`);

  // Un solo original por técnico y período.
  const dup = await api.call('responsable2', 'POST', '/api/controls', { techId: 't-carla', period: cur });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error, 'control_exists');
  assert.equal(dup.json().current.id, c.id);

  // Finalizar con ítems pendientes: 422 con el motivo de 2.1.
  const early = await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, undefined, ifMatch(c.version));
  assert.equal(early.statusCode, 422);
  assert.equal(early.json().message, 'Falta 1 herramienta por controlar.');

  assert.equal((await api.call('responsable', 'PATCH', `/api/controls/${c.id}`, { items: {} })).statusCode, 428);
  const s1 = await api.call('responsable', 'PATCH', `/api/controls/${c.id}`, { items: { [asg[0].id]: { state: 'faltante' } } }, ifMatch(c.version));
  assert.equal(s1.statusCode, 200);
  const v1 = s1.json().control.version;
  assert.equal(s1.json().control.counts.faltante, asg[0].qty);
  const stale = await api.call('responsable2', 'PATCH', `/api/controls/${c.id}`, { items: { [asg[0].id]: { state: 'bueno' } } }, ifMatch(c.version));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().current.version, v1);

  const noNote = await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, undefined, ifMatch(v1));
  assert.equal(noNote.json().message, 'Completá el motivo de 1 faltante.');
  assert.deepEqual(noNote.json().missingNote, [asg[0].id]);

  const s2 = await api.call('responsable', 'PATCH', `/api/controls/${c.id}`, { items: { [asg[0].id]: { state: 'faltante', note: 'No está en el pañol' } } }, ifMatch(v1));
  const fin = await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, { cleaning: { status: 'limpio' } }, ifMatch(s2.json().control.version));
  assert.equal(fin.statusCode, 200);
  assert.equal(fin.json().control.status, 'finalizado');
  assert.ok(fin.json().control.finishedAt);
  assert.equal((await api.q("SELECT 1 FROM audit_log WHERE action = 'control_finish' AND entity_id = $1", [c.id])).length, 1);

  const v = fin.json().control.version;
  const after1 = await api.call('responsable', 'PATCH', `/api/controls/${c.id}`, { items: { [asg[0].id]: { state: 'bueno' } } }, ifMatch(v));
  assert.equal(after1.statusCode, 409);
  assert.equal(after1.json().error, 'control_finalized');
  assert.equal((await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, undefined, ifMatch(v))).statusCode, 409);
  await assert.rejects(api.q("UPDATE controls SET count_bueno = 9 WHERE id = $1", [c.id]), { code: '23001' });
  const again = await api.call('responsable', 'POST', '/api/controls', { techId: 't-carla', period: cur });
  assert.equal(again.json().message, 'Ya existe un control finalizado para ese período. Registrá una corrección.');

  // La alerta del faltante aparece.
  const open = (await api.call('consulta', 'GET', '/api/alerts')).json().open;
  assert.ok(open.some((a) => a.key === `falt-${asg[0].id}-${c.id}`));
});

test('corrección: registro nuevo que reemplaza, con ítems copiados; el original queda', async () => {
  const id = `c-t-carla-${pkeyOf(cur)}`;
  const asg = await asgOf('t-carla');
  const r = await api.call('responsable', 'POST', '/api/controls', { correctionOf: id });
  assert.equal(r.statusCode, 201);
  const k = r.json().control;
  assert.equal(k.correction, true);
  assert.equal(k.supersedes, id);
  assert.equal(k.items[asg[0].id].state, 'faltante');
  assert.equal(k.items[asg[0].id].note, 'No está en el pañol');
  assert.equal((await api.call('responsable', 'POST', '/api/controls', { correctionOf: id })).statusCode, 409);
  const s = await api.call('responsable', 'PATCH', `/api/controls/${k.id}`, { items: { [asg[0].id]: { state: 'bueno' } } }, ifMatch(k.version));
  const fin = await api.call('responsable', 'POST', `/api/controls/${k.id}/finalize`, { cleaning: { status: 'limpio' } }, ifMatch(s.json().control.version));
  assert.equal(fin.statusCode, 200);
  assert.equal((await api.q("SELECT 1 FROM audit_log WHERE action = 'control_correct' AND entity_id = $1", [k.id])).length, 1);
  const st = (await api.call('consulta', 'GET', '/api/state')).json();
  assert.equal(st.derived.effective[`t-carla|${pkeyOf(cur)}`], k.id);
  assert.equal(st.derived.supersededBy[id], k.id);
  assert.equal(st.controls[id].status, 'finalizado');
  const hist = (await api.call('consulta', 'GET', '/api/controls?techId=t-carla')).json().controls;
  assert.deepEqual(hist.map((c) => [c.id, c.effective]).sort(), [[id, false], [k.id, true]].sort());
});

test('reglas: período futuro, técnico inactivo, sin herramientas, ids y estados inválidos', async () => {
  const next = cur.w < 4 ? { ...cur, w: cur.w + 1 } : { y: cur.m === 12 ? cur.y + 1 : cur.y, m: cur.m === 12 ? 1 : cur.m + 1, w: 1 };
  assert.equal((await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: next })).json().message, 'No se puede controlar un período futuro.');
  assert.equal((await api.call('responsable', 'POST', '/api/controls', { techId: 't-dario', period: cur })).json().message, 'Elegí un técnico activo.');
  assert.equal((await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: { ...cur, w: 5 } })).statusCode, 400);
  assert.equal((await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: cur, items: { x: { state: 'roto' } } })).statusCode, 400);
  assert.equal((await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: cur, items: { x: { state: 'bueno', note: 'n'.repeat(2001) } } })).statusCode, 400);
  const tech = (await api.call('admin', 'POST', '/api/techs', { name: 'Sin Herramientas', legajo: 'SH-1' })).json().tech;
  const c = (await api.call('responsable', 'POST', '/api/controls', { techId: tech.id, period: prevP(cur) })).json().control;
  const fin = await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, { cleaning: { status: 'limpio' } }, ifMatch(c.version));
  assert.equal(fin.json().message, 'Este técnico no tiene herramientas asignadas.');
});

test('idempotencia del guardado automático', async () => {
  const asg = await asgOf('t-ana');
  const c = (await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: cur }, { 'idempotency-key': 'ctl-create-0001' })).json().control;
  const replay = await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: cur }, { 'idempotency-key': 'ctl-create-0001' });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.headers['idempotent-replayed'], 'true');
  const body = { items: { [asg[0].id]: { state: 'bueno' } } };
  const h = { ...ifMatch(c.version), 'idempotency-key': 'ctl-save-0001' };
  const a = await api.call('responsable', 'PATCH', `/api/controls/${c.id}`, body, h);
  const b = await api.call('responsable', 'PATCH', `/api/controls/${c.id}`, body, h);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  assert.equal(b.json().control.version, a.json().control.version);
  assert.equal(b.headers.etag, a.headers.etag);
});
