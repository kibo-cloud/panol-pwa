// Líneas, sectores y cajas compartidas (etapa 2): catálogo, poseedor técnico XOR caja, alta de
// asignación en un solo formulario, control de una caja, un original por poseedor y período,
// stock por poseedor, bajas lógicas y permisos.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { periodOf } from '../../src/domain/period.js';

let api;
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const pools = async (toolId) => (await api.call('admin', 'GET', '/api/inventory')).json().pools[toolId];
let linea;
let caja;

describe('catálogo', () => {
  test('líneas y sectores: solo lineas_edit; nombre único; If-Match', async () => {
    for (const u of ['supervisor', 'responsable', 'consulta', 'gerencia']) assert.equal((await api.call(u, 'POST', '/api/lineas', { name: 'Línea 1', kind: 'linea' })).statusCode, 403, u);
    const r = await api.call('admin', 'POST', '/api/lineas', { name: 'Línea 1', kind: 'linea' });
    assert.equal(r.statusCode, 201);
    linea = r.json().linea;
    assert.equal(r.headers.etag, `"${linea.version}"`);
    assert.equal((await api.call('admin', 'POST', '/api/lineas', { name: 'línea 1', kind: 'sector' })).statusCode, 409);
    assert.equal((await api.call('admin', 'POST', '/api/lineas', { name: 'Envasado', kind: 'otra' })).statusCode, 400);
    const sector = (await api.call('admin', 'POST', '/api/lineas', { name: 'Mantenimiento central', kind: 'sector' })).json().linea;
    assert.equal((await api.call('admin', 'PATCH', `/api/lineas/${sector.id}`, { name: 'Taller' })).statusCode, 428);
    const ren = await api.call('admin', 'PATCH', `/api/lineas/${sector.id}`, { name: 'Taller' }, ifMatch(sector.version));
    assert.equal(ren.json().linea.name, 'Taller');
    assert.equal((await api.call('admin', 'PATCH', `/api/lineas/${sector.id}`, { name: 'Otro' }, ifMatch(sector.version))).statusCode, 409);
    const list = (await api.call('consulta', 'GET', '/api/lineas')).json().lineas;
    assert.deepEqual(list.map((l) => l.name).sort(), ['Línea 1', 'Taller']);
  });

  test('cajas: de una línea activa, con un técnico referente activo', async () => {
    assert.equal((await api.call('responsable', 'POST', '/api/cajas', { name: 'Caja A', lineaId: linea.id })).statusCode, 403);
    assert.equal((await api.call('admin', 'POST', '/api/cajas', { name: 'Caja A', lineaId: 'nada' })).statusCode, 422);
    assert.equal((await api.call('admin', 'POST', '/api/cajas', { name: 'Caja A', lineaId: linea.id, referenteTechId: 't-dario' })).statusCode, 422);
    const r = await api.call('admin', 'POST', '/api/cajas', { name: 'Caja A', lineaId: linea.id, referenteTechId: 't-ana' });
    assert.equal(r.statusCode, 201);
    caja = r.json().caja;
    assert.deepEqual([caja.lineaId, caja.referenteTechId], [linea.id, 't-ana']);
    assert.equal((await api.call('admin', 'POST', '/api/cajas', { name: 'caja a', lineaId: linea.id })).statusCode, 409);
    const s = (await api.call('consulta', 'GET', '/api/state')).json();
    assert.equal(s.cajas[caja.id].name, 'Caja A');
    assert.equal(s.lineas[linea.id].kind, 'linea');
    assert.equal((await api.q("SELECT count(*)::int AS n FROM audit_log WHERE action IN ('linea_create', 'caja_create')"))[0].n, 3);
  });
});

describe('poseedor técnico o caja', () => {
  test('la base exige exactamente un poseedor', async () => {
    await assert.rejects(api.q("INSERT INTO assignments (id, tech_id, caja_id, tool_id) VALUES ('ax1', 't-ana', $1, 'tool-pinza')", [caja.id]), (e) => e.code === '23514');
    await assert.rejects(api.q("INSERT INTO assignments (id, tool_id) VALUES ('ax2', 'tool-pinza')"), (e) => e.code === '23514');
    await assert.rejects(api.q("INSERT INTO controls (id, period_y, period_m, period_w, status) VALUES ('cx1', 2026, 1, 1, 'borrador')"), (e) => e.code === '23514');
  });

  test('alta de asignación en un solo formulario: por cantidad a una caja (entrega inicial y luego adicional)', async () => {
    const before = await pools('tool-pinza');
    assert.equal((await api.call('consulta', 'POST', '/api/assignments', { holder: { cajaId: caja.id }, toolId: 'tool-pinza', qty: 2 })).statusCode, 403);
    assert.equal((await api.call('admin', 'POST', '/api/assignments', { holder: { cajaId: caja.id, techId: 't-ana' }, toolId: 'tool-pinza', qty: 2 })).statusCode, 400);
    const r = await api.call('responsable', 'POST', '/api/assignments', { holder: { cajaId: caja.id }, toolId: 'tool-pinza', qty: 2, reason: 'Caja nueva' }, { 'idempotency-key': 'alta-caja-0001' });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().movements.length, 1);
    assert.equal(r.json().movements[0].type, 'entrega_inicial');
    assert.equal(r.json().movements[0].cajaId, caja.id);
    const replay = await api.call('responsable', 'POST', '/api/assignments', { holder: { cajaId: caja.id }, toolId: 'tool-pinza', qty: 2, reason: 'Caja nueva' }, { 'idempotency-key': 'alta-caja-0001' });
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    const more = await api.call('responsable', 'POST', '/api/assignments', { holder: { cajaId: caja.id }, toolId: 'tool-pinza', qty: 1 });
    assert.equal(more.json().movements[0].type, 'adicional');
    const after = await pools('tool-pinza');
    assert.equal(after.disponible, before.disponible - 3);
    assert.equal(after.asignado, before.asignado + 3);
    const asg = await api.q('SELECT tech_id, caja_id, qty FROM assignments WHERE caja_id = $1 AND active ORDER BY qty DESC', [caja.id]);
    assert.deepEqual(asg, [{ tech_id: null, caja_id: caja.id, qty: 2 }, { tech_id: null, caja_id: caja.id, qty: 1 }]);
    const tooMany = await api.call('responsable', 'POST', '/api/assignments', { holder: { cajaId: caja.id }, toolId: 'tool-pinza', qty: 1000 });
    assert.equal(tooMany.statusCode, 422);
  });

  test('alta de varias unidades a la vez: todas o ninguna', async () => {
    await api.call('admin', 'POST', '/api/movements', { type: 'ingreso', toolId: 'tool-taladro', codes: 'TAL-101\nTAL-102' });
    const units = await api.q("SELECT id FROM units WHERE code IN ('TAL-101', 'TAL-102') ORDER BY code");
    const bad = await api.call('admin', 'POST', '/api/assignments', { holder: { cajaId: caja.id }, toolId: 'tool-taladro', unitIds: [units[0].id, 'no-existe'] });
    assert.equal(bad.statusCode, 422);
    assert.equal((await api.q('SELECT count(*)::int AS n FROM assignments WHERE caja_id = $1 AND tool_id = $2', [caja.id, 'tool-taladro']))[0].n, 0);
    const ok = await api.call('admin', 'POST', '/api/assignments', { holder: { cajaId: caja.id }, toolId: 'tool-taladro', unitIds: units.map((u) => u.id) });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.deepEqual(ok.json().movements.map((m) => m.type), ['entrega_inicial', 'adicional']);
    const u = await api.q('SELECT status, tech_id, caja_id FROM units WHERE id = ANY($1)', [units.map((x) => x.id)]);
    for (const x of u) assert.deepEqual(x, { status: 'asignado', tech_id: null, caja_id: caja.id });
    // Para un técnico, el mismo formulario.
    const t = await api.call('admin', 'POST', '/api/assignments', { holder: { techId: 't-carla' }, toolId: 'tool-pinza', qty: 1 });
    assert.equal(t.statusCode, 201);
    assert.equal(t.json().movements[0].techId, 't-carla');
  });

  test('control de una caja: mismas rutas con cajaId; un original por poseedor y período', async () => {
    const cur = periodOf(new Date());
    const asgs = await api.q('SELECT id FROM assignments WHERE caja_id = $1 AND active ORDER BY id', [caja.id]);
    const items = Object.fromEntries(asgs.map((a, i) => [a.id, i === 0 ? { state: 'faltante', note: 'No estaba en la caja' } : { state: 'bueno' }]));
    assert.equal((await api.call('consulta', 'POST', '/api/controls', { cajaId: caja.id, period: cur, items })).statusCode, 403);
    assert.equal((await api.call('responsable', 'POST', '/api/controls', { cajaId: caja.id, techId: 't-ana', period: cur })).statusCode, 422);
    const r = await api.call('responsable', 'POST', '/api/controls', { cajaId: caja.id, period: cur, items });
    assert.equal(r.statusCode, 201, r.body);
    const c = r.json().control;
    assert.deepEqual([c.cajaId, c.techId, c.techName, c.plantillaId], [caja.id, null, 'Caja A', null]);
    const dup = await api.call('responsable', 'POST', '/api/controls', { cajaId: caja.id, period: cur });
    assert.equal(dup.statusCode, 409);
    // Un técnico y una caja pueden tener su control del mismo período.
    const tc = await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: cur });
    assert.notEqual(tc.statusCode, 500);
    await assert.rejects(api.q("INSERT INTO controls (id, caja_id, period_y, period_m, period_w, status) VALUES ('cx2', $1, $2, $3, $4, 'borrador')", [caja.id, cur.y, cur.m, cur.w]), (e) => e.code === '23505');
    const fin = await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, undefined, ifMatch(c.version));
    assert.equal(fin.statusCode, 200, fin.body);
    const s = (await api.call('consulta', 'GET', '/api/state')).json();
    assert.equal(s.derived.effective[`caja:${caja.id}|${s.derived.curKey}`], c.id);
    assert.equal(s.derived.cajaInfo[caja.id].faltante, 2);
    const alert = s.derived.alerts.find((a) => a.type === 'faltante' && a.cajaId === caja.id);
    assert.ok(alert);
    const list = (await api.call('consulta', 'GET', `/api/controls?cajaId=${caja.id}`)).json().controls;
    assert.deepEqual(list.map((x) => x.id), [c.id]);
    // Resolver la alerta de la caja guarda la caja.
    const res = await api.call('responsable', 'POST', `/api/alerts/${alert.key}/resolution`, { note: 'Apareció' });
    assert.equal(res.statusCode, 201);
    assert.equal((await api.q('SELECT caja_id FROM alert_resolutions WHERE key = $1', [alert.key]))[0].caja_id, caja.id);
  });

  test('devolución desde la caja y stock por poseedor', async () => {
    const [a] = await api.q("SELECT id, qty FROM assignments WHERE caja_id = $1 AND tool_id = 'tool-pinza' AND active ORDER BY qty DESC LIMIT 1", [caja.id]);
    const before = await pools('tool-pinza');
    const r = await api.call('responsable', 'POST', '/api/movements', { type: 'devolucion', cajaId: caja.id, asgId: a.id, qty: 1, cond: 'disponible' });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().movement.cajaId, caja.id);
    assert.equal((await pools('tool-pinza')).disponible, before.disponible + 1);
    // La asignación de la caja no se mueve como si fuera de un técnico.
    assert.equal((await api.call('responsable', 'POST', '/api/movements', { type: 'devolucion', techId: 't-ana', asgId: a.id, cond: 'disponible' })).statusCode, 422);
    assert.deepEqual((await api.call('admin', 'GET', '/api/integrity')).json().issues, []);
  });
});

describe('bajas lógicas', () => {
  test('una caja con herramientas no se archiva; una línea con cajas activas tampoco', async () => {
    const v = (await api.q('SELECT version FROM cajas WHERE id = $1', [caja.id]))[0].version;
    const busy = await api.call('admin', 'POST', `/api/cajas/${caja.id}/archive`, undefined, ifMatch(v));
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().message, 'La caja tiene herramientas asignadas.');
    const lv = (await api.q('SELECT version FROM lineas WHERE id = $1', [linea.id]))[0].version;
    assert.equal((await api.call('admin', 'POST', `/api/lineas/${linea.id}/archive`, undefined, ifMatch(lv))).json().message, 'La línea tiene cajas activas.');
    const empty = (await api.call('admin', 'POST', '/api/cajas', { name: 'Caja vacía', lineaId: linea.id })).json().caja;
    const ar = await api.call('admin', 'POST', `/api/cajas/${empty.id}/archive`, undefined, ifMatch(empty.version));
    assert.equal(ar.statusCode, 200);
    assert.ok(ar.json().caja.archivedAt);
    const cur = periodOf(new Date());
    assert.equal((await api.call('admin', 'POST', '/api/assignments', { holder: { cajaId: empty.id }, toolId: 'tool-pinza', qty: 1 })).json().message, 'Elegí una caja activa.');
    assert.equal((await api.call('responsable', 'POST', '/api/controls', { cajaId: empty.id, period: cur })).statusCode, 422);
  });

  test('el .txt v2 no lleva lo de las cajas y exportar/importar sigue sin cambios', async () => {
    const r = await api.call('admin', 'GET', '/api/export/txt');
    const HEAD_LEN = r.body.indexOf('{');
    const p = JSON.parse(r.body.slice(HEAD_LEN));
    assert.ok(Object.values(p.data.assignments).every((a) => a.techId));
    assert.ok(Object.values(p.data.controls).every((c) => c.techId));
    assert.ok(Object.values(p.data.movements).every((m) => !m.cajaId));
    const dry = await api.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', r.body, { 'content-type': 'text/plain' });
    assert.equal(dry.statusCode, 200, dry.body);
    assert.equal(dry.json().totalChanges, 0, JSON.stringify(dry.json().counts));
  });
});

describe('datos de demostración', () => {
  test('borrar la demo deja sin referente a una caja real cuyo referente era un técnico demo (auditado)', async () => {
    assert.equal((await api.call('admin', 'POST', '/api/demo')).statusCode, 201);
    const [demoTech] = await api.q('SELECT id FROM techs WHERE demo ORDER BY id LIMIT 1');
    const l = (await api.call('admin', 'POST', '/api/lineas', { name: 'Línea demo-ref', kind: 'linea' })).json().linea;
    const cr = await api.call('admin', 'POST', '/api/cajas', { name: 'Caja con referente demo', lineaId: l.id, referenteTechId: demoTech.id });
    assert.equal(cr.statusCode, 201, cr.body);
    const cj = cr.json().caja;
    const del = await api.call('admin', 'DELETE', '/api/demo');
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(del.json().deleted.cajasReferente, 1);
    const [row] = await api.q('SELECT referente_tech_id, version FROM cajas WHERE id = $1', [cj.id]);
    assert.equal(row.referente_tech_id, null);
    assert.ok(row.version > cj.version);
    const [a] = await api.q("SELECT detail FROM audit_log WHERE action = 'caja_edit' AND entity_id = $1", [cj.id]);
    assert.match(a.detail, /sin referente: su referente era un técnico de demostración/);
    assert.equal((await api.q('SELECT count(*)::int AS n FROM techs WHERE demo'))[0].n, 0);
  });
});
