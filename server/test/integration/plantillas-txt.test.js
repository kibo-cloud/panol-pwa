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
