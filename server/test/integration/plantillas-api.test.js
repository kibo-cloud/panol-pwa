// Plantillas (etapa 2): historial de pertenencia sin superposición, mover uno o varios
// técnicos, cobertura temporal, rotación, supervisor, archivo, permisos, foto en controles,
// "Mi plantilla" e informes por plantilla.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { localDateISO, periodOf, prevP, pad } from '../../src/domain/period.js';

let api;
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const today = localDateISO();
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const hist = (techId) => api.q("SELECT id, plantilla_id, valid_from::text AS f, valid_to::text AS t, temporary, reason FROM tech_plantilla_history WHERE tech_id = $1 ORDER BY valid_from NULLS FIRST, created_at", [techId]);
const ver = async (table, id) => (await api.q(`SELECT version FROM ${table} WHERE id = $1`, [id]))[0].version;
const state = async (user = 'admin') => (await api.call(user, 'GET', '/api/state')).json();
const newTech = async (name, legajo, plantillaId) => (await api.call('admin', 'POST', '/api/techs', { name, legajo, plantillaId })).json().tech;

describe('base de datos', () => {
  test('la migración convierte los turnos en plantillas y cada técnico tiene su rango', async () => {
    const pl = await api.q('SELECT id, name, current_shift_label FROM plantillas ORDER BY sort_order');
    assert.deepEqual(pl.map((p) => p.id), ['manana', 'tarde', 'noche']);
    assert.equal(pl[0].current_shift_label, 'Turno mañana');
    const [s] = await api.q("SELECT value FROM app_settings WHERE key = 'plantillas.shift_labels'");
    assert.deepEqual(s.value, ['Mañana', 'Tarde', 'Noche']);
    assert.deepEqual((await hist('t-ana')).map((r) => [r.plantilla_id, r.f, r.t]), [['manana', null, null]]);
  });

  test('exclusión: dos rangos del mismo técnico no se superponen; el historial es de solo agregar', async () => {
    await assert.rejects(
      api.q("INSERT INTO tech_plantilla_history (id, tech_id, plantilla_id, valid_from) VALUES ('ph-x1', 't-dario', 'tarde', '2026-01-01')"),
      (e) => e.code === '23P01',
    );
    // Cerrar el rango abierto sí; cambiar la plantilla, reabrir o borrar, no.
    const [r] = await hist('t-dario');
    await assert.rejects(api.q('UPDATE tech_plantilla_history SET plantilla_id = $2 WHERE id = $1', [r.id, 'tarde']), /solo agregar/);
    await assert.rejects(api.q('DELETE FROM tech_plantilla_history WHERE id = $1', [r.id]), /solo agregar/);
    await assert.rejects(api.q('TRUNCATE tech_plantilla_history'), /solo agregar/);
    await api.q("UPDATE tech_plantilla_history SET valid_to = '2026-01-01' WHERE id = $1", [r.id]);
    await assert.rejects(api.q('UPDATE tech_plantilla_history SET valid_to = NULL WHERE id = $1', [r.id]), /solo agregar/);
    await assert.rejects(api.q("UPDATE tech_plantilla_history SET valid_to = '2026-02-01' WHERE id = $1", [r.id]), /solo agregar/);
    // Un rango nuevo que no se superpone entra.
    await api.q("INSERT INTO tech_plantilla_history (id, tech_id, plantilla_id, valid_from) VALUES ('ph-x2', 't-dario', 'manana', '2026-01-01')");
    for (const t of ['plantilla_rotations', 'plantilla_supervisor_history']) await assert.rejects(api.q(`TRUNCATE ${t}`), /solo agregar/);
    await assert.rejects(api.q("DELETE FROM plantilla_supervisor_history WHERE id = 'ps-seed-manana'"), /solo agregar/);
  });

  test('el rol de la app no puede modificar rotaciones ni el historial de supervisores', async () => {
    await assert.rejects(api.appPool.query("UPDATE plantilla_supervisor_history SET effective_from = '2020-01-01'"), (e) => e.code === '42501');
    await assert.rejects(api.appPool.query('DELETE FROM plantilla_rotations'), (e) => e.code === '42501');
    await assert.rejects(api.appPool.query('TRUNCATE tech_plantilla_history'), (e) => e.code === '42501');
  });
});

describe('plantillas: alta, edición y archivo', () => {
  test('alta: nombre por defecto con el supervisor; solo plantillas_edit; supervisor con perfil Supervisor', async () => {
    for (const u of ['supervisor', 'responsable', 'consulta', 'gerencia']) assert.equal((await api.call(u, 'POST', '/api/plantillas', { name: 'Norte' })).statusCode, 403, u);
    const r = await api.call('admin', 'POST', '/api/plantillas', { supervisorUserId: 'u-supervisor' });
    assert.equal(r.statusCode, 201);
    const p = r.json().plantilla;
    assert.equal(p.name, 'Plantilla de Supervisor Desarrollo');
    assert.equal(p.supervisorUserId, 'u-supervisor');
    assert.equal(r.headers.etag, `"${p.version}"`);
    const sh = await api.q('SELECT supervisor_user_id, created_by FROM plantilla_supervisor_history WHERE plantilla_id = $1', [p.id]);
    assert.deepEqual(sh, [{ supervisor_user_id: 'u-supervisor', created_by: 'u-admin' }]);
    assert.equal((await api.call('admin', 'POST', '/api/plantillas', { supervisorUserId: 'u-responsable' })).statusCode, 422);
    assert.equal((await api.call('admin', 'POST', '/api/plantillas', {})).json().message, 'Ingresá un nombre o elegí un supervisor.');
    assert.equal((await api.call('admin', 'POST', '/api/plantillas', { name: 'plantilla de supervisor desarrollo' })).statusCode, 409);
    assert.equal((await api.call('admin', 'POST', '/api/plantillas', { name: 'Norte', extra: 1 })).statusCode, 400);
    assert.equal((await api.q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'plantilla_create'"))[0].n, 1);
  });

  test('renombrar con If-Match: falta 428, vieja 409', async () => {
    const p = (await api.call('admin', 'POST', '/api/plantillas', { name: 'Sur' })).json().plantilla;
    assert.equal((await api.call('admin', 'PATCH', `/api/plantillas/${p.id}`, { name: 'Sur Uno' })).statusCode, 428);
    const ok = await api.call('admin', 'PATCH', `/api/plantillas/${p.id}`, { name: 'Sur Uno' }, ifMatch(p.version));
    assert.equal(ok.json().plantilla.name, 'Sur Uno');
    const stale = await api.call('admin', 'PATCH', `/api/plantillas/${p.id}`, { name: 'Sur Dos' }, ifMatch(p.version));
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().current.name, 'Sur Uno');
  });

  test('archivar: solo sin técnicos; archivada no recibe técnicos ni se edita', async () => {
    assert.equal((await api.call('admin', 'POST', '/api/plantillas/tarde/archive', undefined, ifMatch(await ver('plantillas', 'tarde')))).statusCode, 409);
    const p = (await api.call('admin', 'POST', '/api/plantillas', { name: 'Para archivar' })).json().plantilla;
    assert.equal((await api.call('supervisor', 'POST', `/api/plantillas/${p.id}/archive`, undefined, ifMatch(p.version))).statusCode, 403);
    const r = await api.call('admin', 'POST', `/api/plantillas/${p.id}/archive`, undefined, ifMatch(p.version));
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().plantilla.archivedAt);
    const t = await newTech('Archivo Uno', 'ARC-1', 'manana');
    const mv = await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: p.id, from: today, reason: 'x' });
    assert.equal(mv.statusCode, 422);
    assert.equal(mv.json().message, 'Elegí la plantilla destino.');
    assert.equal((await api.call('admin', 'PATCH', `/api/plantillas/${p.id}`, { name: 'Otra' }, ifMatch(p.version + 1))).statusCode, 409);
    assert.ok(!(await state()).shifts.some((s) => s.id === p.id));
  });
});

describe('mover técnicos', () => {
  test('mover uno: cierra el rango, abre el nuevo, sube la versión, audita y avisa', async () => {
    const t = await newTech('Mover Uno', 'MV-1', 'manana');
    const listener = await api.pool.connect();
    const got = [];
    listener.on('notification', (n) => got.push(JSON.parse(n.payload)));
    await listener.query('LISTEN panol_events');
    try {
      assert.equal((await api.call('responsable', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'tarde', from: today, reason: 'Pidió' })).statusCode, 403);
      assert.equal((await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'tarde', from: today })).statusCode, 400);
      const r = await api.call('supervisor', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'tarde', from: today, reason: 'Cambia de turno por su cuenta' });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().tech.plantillaId, 'tarde');
      assert.equal(r.json().tech.version, t.version + 1);
      assert.equal(r.headers.etag, `"${t.version + 1}"`);
      assert.deepEqual((await hist(t.id)).map((x) => [x.plantilla_id, x.f, x.t]), [['manana', null, today], ['tarde', today, null]]);
      const [a] = await api.q("SELECT detail, actor_id FROM audit_log WHERE action = 'tech_move' AND entity_id = $1", [t.id]);
      assert.match(a.detail, /Turno mañana a Turno tarde desde .*Motivo: Cambia de turno por su cuenta/);
      assert.equal(a.actor_id, 'u-supervisor');
      await new Promise((res) => setTimeout(res, 100));
      assert.ok(got.some((e) => e.entity === 'techs' && e.id === t.id));
      // Con If-Match viejo: 409. Mover otra vez el mismo día anula el rango de hoy (no borra).
      assert.equal((await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'noche', from: today, reason: 'x' }, ifMatch(t.version))).statusCode, 409);
      const again = await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'noche', from: today, reason: 'Corrección' }, ifMatch(t.version + 1));
      assert.equal(again.statusCode, 200);
      assert.deepEqual((await hist(t.id)).map((x) => [x.plantilla_id, x.f, x.t]), [['manana', null, today], ['tarde', today, today], ['noche', today, null]]);
      assert.equal((await state()).techs[t.id].shiftId, 'noche');
      // No se mueve antes del último cambio ni a la misma plantilla.
      assert.equal((await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'manana', from: addDays(today, -1), reason: 'x' })).statusCode, 422);
      assert.equal((await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'noche', from: addDays(today, 1), reason: 'x' })).json().message, 'El técnico ya está en esa plantilla.');
    } finally {
      listener.release();
    }
  });

  test('mover seleccionados: todos en una transacción; si uno falla no se mueve ninguno', async () => {
    const a = await newTech('Sel Uno', 'SEL-1', 'noche');
    const b = await newTech('Sel Dos', 'SEL-2', 'noche');
    const c = await newTech('Sel Tres', 'SEL-3', 'tarde');
    const body = { techIds: [a.id, b.id, c.id], targetPlantillaId: 'manana', from: today, reason: 'Reorganización' };
    assert.equal((await api.call('consulta', 'POST', '/api/plantillas/noche/move-selected', body)).statusCode, 403);
    const bad = await api.call('admin', 'POST', '/api/plantillas/noche/move-selected', body);
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().message, 'Sel Tres no está en esta plantilla.');
    assert.equal(bad.json().techId, c.id);
    for (const t of [a, b, c]) assert.equal((await hist(t.id)).length, 1, 'sin cambios: ' + t.name);
    const ok = await api.call('admin', 'POST', '/api/plantillas/noche/move-selected', { ...body, techIds: [b.id, a.id] }, { 'idempotency-key': 'move-sel-0001' });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json().moved.map((m) => m.techId).sort(), [a.id, b.id].sort());
    const s = await state();
    assert.equal(s.techs[a.id].plantillaId, 'manana');
    assert.equal(s.techs[b.id].plantillaId, 'manana');
    const replay = await api.call('admin', 'POST', '/api/plantillas/noche/move-selected', { ...body, techIds: [b.id, a.id] }, { 'idempotency-key': 'move-sel-0001' });
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    assert.equal((await hist(a.id)).length, 2);
    assert.equal((await api.q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'tech_move' AND entity_id = ANY($1)", [[a.id, b.id]]))[0].n, 2);
  });

  test('cobertura temporal: vuelve sola a su plantilla en la fecha hasta', async () => {
    const t = await newTech('Cubre Uno', 'COB-1', 'tarde');
    const from = addDays(today, -2);
    const until = addDays(today, 3);
    assert.equal((await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'noche', from, until: from, reason: 'x' })).statusCode, 422);
    const r = await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'noche', from, until, reason: 'Cubre vacaciones' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual((await hist(t.id)).map((x) => [x.plantilla_id, x.f, x.t, x.temporary]), [['tarde', null, from, false], ['noche', from, until, true], ['tarde', until, null, false]]);
    assert.equal((await state()).techs[t.id].plantillaId, 'noche');
    const on = async (d) => (await api.q('SELECT plantilla_on($1, $2::date) AS p', [t.id, d]))[0].p;
    assert.equal(await on(addDays(until, -1)), 'noche');
    assert.equal(await on(until), 'tarde');
    const [a] = await api.q("SELECT detail FROM audit_log WHERE action = 'tech_coverage' AND entity_id = $1", [t.id]);
    assert.match(a.detail, /Cobertura temporal de Cubre Uno: Turno tarde a Turno noche/);
    const h = (await api.call('consulta', 'GET', `/api/techs/${t.id}/plantilla-history`)).json();
    assert.equal(h.ranges.length, 3);
    assert.equal(h.current, 'noche');
  });
});

describe('rotación y supervisor', () => {
  test('rotación: el supervisor rota la suya y no otra; consulta y gerencia no; queda en el historial', async () => {
    const v = await ver('plantillas', 'manana');
    for (const u of ['consulta', 'gerencia', 'responsable']) assert.equal((await api.call(u, 'POST', '/api/plantillas/manana/rotate', { label: 'Tarde' }, ifMatch(v))).statusCode, 403, u);
    assert.equal((await api.call('supervisor', 'POST', '/api/plantillas/tarde/rotate', { label: 'Noche' }, ifMatch(await ver('plantillas', 'tarde')))).statusCode, 403);
    assert.equal((await api.call('supervisor', 'POST', '/api/plantillas/manana/rotate', { label: 'Franco' }, ifMatch(v))).statusCode, 422);
    assert.equal((await api.call('supervisor', 'POST', '/api/plantillas/manana/rotate', { label: 'Tarde' })).statusCode, 428);
    const r = await api.call('supervisor', 'POST', '/api/plantillas/manana/rotate', { label: 'Tarde' }, ifMatch(v));
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().plantilla.currentShiftLabel, 'Tarde');
    assert.equal(r.json().rotation.fromLabel, 'Turno mañana');
    const adm = await api.call('admin', 'POST', '/api/plantillas/tarde/rotate', { label: 'Noche', from: today }, ifMatch(await ver('plantillas', 'tarde')));
    assert.equal(adm.statusCode, 200);
    const rot = await api.q("SELECT shift_label, effective_from::text AS f, created_by FROM plantilla_rotations WHERE plantilla_id = 'manana'");
    assert.deepEqual(rot, [{ shift_label: 'Tarde', f: today, created_by: 'u-supervisor' }]);
    const h = (await api.call('consulta', 'GET', '/api/plantillas/manana/history')).json();
    assert.equal(h.rotations.length, 1);
    assert.ok(h.members.some((m) => m.techId === 't-ana'));
  });

  test('cambio de supervisor: solo plantillas_edit, perfil Supervisor, con fecha y actor', async () => {
    const v = await ver('plantillas', 'noche');
    assert.equal((await api.call('supervisor', 'POST', '/api/plantillas/noche/supervisor', { supervisorUserId: 'u-supervisor' }, ifMatch(v))).statusCode, 403);
    assert.equal((await api.call('admin', 'POST', '/api/plantillas/noche/supervisor', { supervisorUserId: 'u-gerencia' }, ifMatch(v))).statusCode, 422);
    const r = await api.call('admin', 'POST', '/api/plantillas/noche/supervisor', { supervisorUserId: 'u-supervisor', from: today }, ifMatch(v));
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().plantilla.supervisorUserId, 'u-supervisor');
    const off = await api.call('admin', 'POST', '/api/plantillas/noche/supervisor', { supervisorUserId: null }, ifMatch(v + 1));
    assert.equal(off.statusCode, 200);
    const sh = await api.q("SELECT from_user_id, supervisor_user_id, created_by FROM plantilla_supervisor_history WHERE plantilla_id = 'noche' ORDER BY created_at");
    assert.deepEqual(sh, [{ from_user_id: null, supervisor_user_id: 'u-supervisor', created_by: 'u-admin' }, { from_user_id: 'u-supervisor', supervisor_user_id: null, created_by: 'u-admin' }]);
    assert.equal((await api.q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'plantilla_supervisor'"))[0].n, 2);
  });
});

describe('controles, estado e informes', () => {
  test('cada control guarda la plantilla del técnico al crearse y al finalizarse', async () => {
    const t = await newTech('Foto Uno', 'FOTO-1', 'noche');
    await api.call('admin', 'POST', '/api/movements', { type: 'ingreso', toolId: 'tool-pinza', qty: 1 });
    const mv = await api.call('admin', 'POST', '/api/movements', { type: 'entrega_inicial', techId: t.id, toolId: 'tool-pinza', qty: 1 });
    const aid = mv.json().assignments[0];
    const cur = periodOf(new Date());
    const c = (await api.call('responsable', 'POST', '/api/controls', { techId: t.id, period: cur, items: { [aid]: { state: 'bueno' } } })).json().control;
    assert.equal(c.plantillaId, 'noche');
    await api.call('admin', 'POST', `/api/techs/${t.id}/move`, { plantillaId: 'tarde', from: today, reason: 'Cambio' });
    const fin = await api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, undefined, ifMatch(c.version));
    assert.equal(fin.statusCode, 200);
    assert.equal(fin.json().control.plantillaId, 'tarde');
    const [row] = await api.q('SELECT plantilla_id_snapshot, shift_id FROM controls WHERE id = $1', [c.id]);
    assert.deepEqual(row, { plantilla_id_snapshot: 'tarde', shift_id: 'tarde' });
    const byPl = (await api.call('consulta', 'GET', '/api/controls?plantillaId=tarde')).json().controls;
    assert.ok(byPl.some((x) => x.id === c.id));
  });

  test('informe histórico: el técnico sigue en la plantilla de su control aunque después se mueva', async () => {
    const prev = prevP(periodOf(new Date()));
    const ym = `${prev.y}-${pad(prev.m)}`;
    // El control de la semana anterior de Ana (semilla) es de la plantilla manana.
    await api.call('admin', 'POST', '/api/techs/t-ana/move', { plantillaId: 'noche', from: today, reason: 'Rota' });
    const R = (await api.call('gerencia', 'GET', `/api/reports?ym=${ym}&w=${prev.w}`)).json();
    const ana = R.rows.find((r) => r.id === 't-ana');
    assert.equal(ana.plantillaId, 'manana');
    assert.ok(R.plantillas.find((g) => g.id === 'manana').techs >= 1);
    const only = (await api.call('gerencia', 'GET', `/api/reports?ym=${ym}&w=${prev.w}&plantilla=noche`)).json();
    assert.ok(!only.rows.some((r) => r.id === 't-ana'));
  });

  test('estado: plantillas, historial, rotaciones y "Mi plantilla" del supervisor con sus alertas', async () => {
    const s = await state('supervisor');
    assert.ok(s.plantillas.manana);
    assert.equal(s.plantillas.manana.supervisorUserId, 'u-supervisor');
    assert.ok(Array.isArray(s.plantillaHistory['t-ana']));
    assert.ok(Array.isArray(s.plantillaRotations));
    assert.deepEqual(s.config.shiftLabels, ['Mañana', 'Tarde', 'Noche']);
    const my = s.derived.myPlantilla;
    assert.ok(my.plantillaIds.includes('manana'));
    for (const id of my.plantillaIds) assert.equal(s.plantillas[id].supervisorUserId, 'u-supervisor');
    const members = Object.entries(s.techs).filter(([, t]) => t.active !== false && my.plantillaIds.includes(t.plantillaId)).map(([id]) => id).sort();
    assert.ok(members.length > 0);
    assert.deepEqual(my.techIds.slice().sort(), members);
    for (const k of my.alertKeys) assert.ok(members.includes(s.derived.alerts.find((a) => a.key === k).techId));
    assert.deepEqual((await state('admin')).derived.myPlantilla.plantillaIds, []);
    // Cambios de turno derivados del historial (forma de 2.1) para la ficha del técnico.
    assert.ok(Object.values(s.shiftChanges).some((x) => x.techId === 't-ana' && x.to === 'noche' && x.from === 'manana'));
  });

  test('lista de turnos: plantillas_edit con If-Match', async () => {
    const g = await api.call('consulta', 'GET', '/api/settings/shift-labels');
    assert.equal(g.statusCode, 200);
    const v = Number(g.headers.etag.replace(/"/g, ''));
    assert.equal((await api.call('supervisor', 'PUT', '/api/settings/shift-labels', { labels: ['A1', 'B1'] }, ifMatch(v))).statusCode, 403);
    assert.equal((await api.call('admin', 'PUT', '/api/settings/shift-labels', { labels: ['Día', 'día'] }, ifMatch(v))).statusCode, 422);
    const ok = await api.call('admin', 'PUT', '/api/settings/shift-labels', { labels: ['Mañana', 'Tarde', 'Noche', 'Franco'] }, ifMatch(v));
    assert.equal(ok.statusCode, 200);
    assert.equal((await api.call('admin', 'PUT', '/api/settings/shift-labels', { labels: ['Día'] }, ifMatch(v))).statusCode, 409);
  });
});
