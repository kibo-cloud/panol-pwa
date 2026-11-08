// .txt v2 y plantillas (etapa 2): la exportación muestra las plantillas como turnos de 2.1, la
// plantilla actual como techs.shiftId y el historial como shiftChanges; la importación los
// vuelve a convertir en plantillas e historial; exportar y volver a importar = 0 cambios.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { HEAD, toTxt } from '../fixtures/v21.js';
import { localDateISO } from '../../src/domain/period.js';

let api;
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const today = localDateISO();
const exportPayload = async () => {
  const r = await api.call('admin', 'GET', '/api/export/txt');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.startsWith(HEAD));
  return JSON.parse(r.body.slice(HEAD.length));
};
const importTxt = (text, { mode = 'merge', dryRun = false, token } = {}) => {
  const qs = new URLSearchParams({ mode, ...(dryRun ? { dryRun: '1' } : {}), ...(token ? { token } : {}) });
  return api.call('admin', 'POST', `/api/import/txt?${qs}`, text, { 'content-type': 'text/plain' });
};
const dry = async (text) => {
  const r = await importTxt(text, { dryRun: true });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};

test('exportar: plantillas activas como turnos, plantilla actual y cambios del historial', async () => {
  const v = (await api.q("SELECT version FROM plantillas WHERE id = 'tarde'"))[0].version;
  await api.call('admin', 'PATCH', '/api/plantillas/tarde', { name: 'Plantilla Tarde' }, ifMatch(v));
  const mv = await api.call('admin', 'POST', '/api/techs/t-bruno/move', { plantillaId: 'noche', from: today, reason: 'Rota de turno' });
  assert.equal(mv.statusCode, 200);
  const p = await exportPayload();
  assert.deepEqual(p.data.config.turnos.list.map((s) => [s.id, s.name]), [['manana', 'Turno mañana'], ['tarde', 'Plantilla Tarde'], ['noche', 'Turno noche']]);
  assert.equal(p.data.techs['t-bruno'].shiftId, 'noche');
  assert.equal(p.data.techs['t-ana'].shiftId, 'manana');
  const sc = Object.entries(p.data.shiftChanges).filter(([, x]) => x.techId === 't-bruno');
  assert.equal(sc.length, 1);
  const [id, x] = sc[0];
  assert.equal(id, mv.json().ranges[0].id);
  assert.deepEqual([x.from, x.to, x.fromName, x.toName, x.effectiveFrom, x.note], ['tarde', 'noche', 'Plantilla Tarde', 'Turno noche', today, 'Rota de turno']);
  // Exportar y volver a importar: nada cambia.
  const rep = await dry(toTxt(p));
  assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
  assert.equal(rep.totalChanges, 0, JSON.stringify(rep.counts));
});

test('importar: turno nuevo = plantilla, cambio de turno nuevo = rango del historial, y vuelta sin cambios', async () => {
  const p = await exportPayload();
  const soon = new Date(Date.now() + 3600e3).toISOString();
  p.data.config.turnos = { list: [...p.data.config.turnos.list, { id: 'franco', name: 'Franco', order: 9 }], updatedAt: soon };
  p.data.techs['t-carla'] = { ...p.data.techs['t-carla'], shiftId: 'franco', updatedAt: soon };
  p.data.shiftChanges.scCarla = { techId: 't-carla', from: 'noche', to: 'franco', fromName: 'Turno noche', toName: 'Franco', effectiveFrom: today, note: 'Desde 2.1', at: soon };
  const rep = await dry(toTxt(p));
  assert.deepEqual(rep.changes.shifts.create.ids, ['franco']);
  assert.deepEqual(rep.changes.shiftChanges.create.ids, ['scCarla']);
  const r = await importTxt(toTxt(p), { token: rep.token });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await api.q("SELECT name FROM plantillas WHERE id = 'franco'"))[0].name, 'Franco');
  const h = await api.q("SELECT id, plantilla_id AS p, valid_from::text AS f, valid_to::text AS t, reason FROM tech_plantilla_history WHERE tech_id = 't-carla' ORDER BY valid_from NULLS FIRST");
  assert.deepEqual(h.map((x) => [x.id, x.p, x.f, x.t]), [['ph-t-carla', 'noche', null, today], ['scCarla', 'franco', today, null]]);
  assert.equal(h[1].reason, 'Desde 2.1');
  const s = (await api.call('admin', 'GET', '/api/state')).json();
  assert.equal(s.techs['t-carla'].plantillaId, 'franco');
  const again = await dry(toTxt(await exportPayload()));
  assert.equal(again.totalChanges, 0, JSON.stringify(again.counts));
});

test('importar: un turno que ya no está archiva la plantilla y su gente queda sin plantilla', async () => {
  const p = await exportPayload();
  const soon = new Date(Date.now() + 7200e3).toISOString();
  p.data.config.turnos = { list: p.data.config.turnos.list.filter((x) => x.id !== 'franco'), updatedAt: soon };
  const rep = await dry(toTxt(p));
  assert.deepEqual(rep.changes.shifts.delete.ids, ['franco']);
  const r = await importTxt(toTxt(p), { token: rep.token });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await api.q("SELECT count(*)::int AS n FROM plantillas WHERE id = 'franco' AND archived_at IS NOT NULL"))[0].n, 1);
  assert.equal((await api.q("SELECT plantilla_on('t-carla', current_date) AS p"))[0].p, null);
  // Nada se borró del historial.
  assert.equal((await api.q("SELECT count(*)::int AS n FROM tech_plantilla_history WHERE tech_id = 't-carla'"))[0].n, 2);
});

// ---------------------------------------------------------------- E2.V1
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const histOf = (techId) => api.q("SELECT id, plantilla_id AS p, valid_from::text AS f, valid_to::text AS t, temporary FROM tech_plantilla_history WHERE tech_id = $1 ORDER BY valid_from NULLS FIRST, created_at", [techId]);
const applyFile = async (p) => {
  const rep = await dry(toTxt(p));
  assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
  return importTxt(toTxt(p), { token: rep.token });
};

test('importar con un técnico en una cobertura en curso: la cobertura termina hoy y entra la plantilla del archivo', async () => {
  const from = addDays(today, -2);
  const until = addDays(today, 3);
  assert.equal((await api.call('admin', 'POST', '/api/techs/t-ana/move', { plantillaId: 'tarde', from, until, reason: 'Cubre' })).statusCode, 200);
  const p = await exportPayload();
  assert.equal(p.data.techs['t-ana'].shiftId, 'tarde');
  const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
  p.data.techs['t-ana'] = { ...p.data.techs['t-ana'], shiftId: 'noche', updatedAt: soon };
  const r = await applyFile(p);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual((await histOf('t-ana')).map((x) => [x.p, x.f, x.t, x.temporary]), [
    ['manana', null, from, false], ['tarde', from, today, true], ['noche', today, null, false], ['manana', until, until, false],
  ]);
  assert.equal((await api.q("SELECT plantilla_on('t-ana', $1::date) AS p", [addDays(until, 1)]))[0].p, 'noche');
});

test('importar con un técnico en una cobertura programada: el cambio se omite y se cuenta, la importación sigue', async () => {
  const from = addDays(today, 2);
  const until = addDays(today, 5);
  assert.equal((await api.call('admin', 'POST', '/api/techs/t-bruno/move', { plantillaId: 'manana', from, until, reason: 'Cubre' })).statusCode, 200);
  const before = await histOf('t-bruno');
  const p = await exportPayload();
  const soon = new Date(Date.now() + 4 * 3600e3).toISOString();
  p.data.techs['t-bruno'] = { ...p.data.techs['t-bruno'], shiftId: 'tarde', updatedAt: soon };
  p.data.config.turnos = { ...p.data.config.turnos, list: p.data.config.turnos.list.map((s) => (s.id === 'noche' ? { ...s, name: 'Turno noche (importado)' } : s)), updatedAt: soon };
  const r = await applyFile(p);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().report.membershipSkipped, 1);
  // Lo demás del archivo entró; el historial del técnico quedó igual.
  assert.equal((await api.q("SELECT name FROM plantillas WHERE id = 'noche'"))[0].name, 'Turno noche (importado)');
  assert.deepEqual(await histOf('t-bruno'), before);
  const [a] = await api.q("SELECT detail FROM audit_log WHERE action = 'import_txt' ORDER BY at DESC, id DESC LIMIT 1");
  assert.match(a.detail, /1 cambios de plantilla omitidos/);
});

test('importar un cambio de turno con el id de un rango que ya existe (no exportado): entra con un id nuevo', async () => {
  const p = await exportPayload();
  const soon = new Date(Date.now() + 5 * 3600e3).toISOString();
  // t-carla no tiene plantilla desde hoy; su rango "desde siempre" (ph-t-carla) no se exporta.
  assert.equal(p.data.shiftChanges['ph-t-carla'], undefined);
  p.data.techs['t-carla'] = { ...p.data.techs['t-carla'], shiftId: 'manana', updatedAt: soon };
  p.data.shiftChanges['ph-t-carla'] = { techId: 't-carla', from: null, to: 'manana', fromName: '', toName: 'Turno mañana', effectiveFrom: today, note: 'Forjado', at: soon };
  // Técnico nuevo cuyo cambio de turno reusa el id del rango base de otro técnico.
  p.data.techs['t-zeta'] = { ...p.data.techs['t-ana'], name: 'Zeta Nueva', legajo: 'DEV-099', shiftId: 'tarde', createdAt: soon, updatedAt: soon };
  p.data.shiftChanges['ph-t-ana'] = { techId: 't-zeta', from: 'manana', to: 'tarde', fromName: 'Turno mañana', toName: 'Turno tarde', effectiveFrom: addDays(today, -1), note: 'Forjado 2', at: soon };
  const r = await applyFile(p);
  assert.equal(r.statusCode, 200, r.body);
  const carla = await api.q("SELECT id, valid_from::text AS f, reason FROM tech_plantilla_history WHERE tech_id = 't-carla' AND plantilla_id = 'manana'");
  assert.equal(carla.length, 1);
  assert.notEqual(carla[0].id, 'ph-t-carla');
  assert.deepEqual([carla[0].f, carla[0].reason], [today, 'Forjado']);
  const zeta = await api.q("SELECT id, plantilla_id AS p FROM tech_plantilla_history WHERE tech_id = 't-zeta'");
  assert.ok(zeta.length >= 1 && zeta.every((x) => x.id !== 'ph-t-ana'), JSON.stringify(zeta));
  assert.equal((await api.q("SELECT tech_id FROM tech_plantilla_history WHERE id = 'ph-t-ana'"))[0].tech_id, 't-ana');
});

test('plantillas activas con nombre único: el informe avisa y la base lo exige al reactivar una archivada', async () => {
  // franco está archivada (test anterior); otra plantilla activa toma su nombre.
  assert.equal((await api.call('admin', 'POST', '/api/plantillas', { name: 'Franco' })).statusCode, 201);
  const p = await exportPayload();
  const soon = new Date(Date.now() + 6 * 3600e3).toISOString();
  p.data.config.turnos = { list: [...p.data.config.turnos.list, { id: 'franco', name: 'FRANCO', order: 9 }], updatedAt: soon };
  const rep = await dry(toTxt(p));
  assert.equal(rep.canApply, false);
  assert.ok(rep.errors.some((e) => e.collection === 'shifts' && e.field === 'name' && /nombre de plantilla repetido/.test(e.message)), JSON.stringify(rep.errors));
  const r = await importTxt(toTxt(p), { token: 'a'.repeat(64) });
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().error, 'import_invalid');
  // La base también lo exige (índice único parcial).
  await assert.rejects(api.q("UPDATE plantillas SET archived_at = NULL WHERE id = 'franco'"), (e) => e.code === '23505' && e.constraint === 'plantillas_active_name_key');
});
