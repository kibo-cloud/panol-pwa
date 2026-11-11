// Etapa 8: existencia por técnico (GET /api/existencia), el umbral de "Sin control hace N días"
// (Administración › Configuración, GET/PUT /api/settings/alerts) y la alerta en /api/state.
// Base sembrada: Ana tiene un control de la semana anterior (hace 7 días); Bruno y Carla nunca
// tuvieron controles (primeras entregas hace 29 y 28 días); Darío está inactivo.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { periodOf, prevP, pkeyOf } from '../../src/domain/period.js';

let api;
const cur = periodOf(new Date());
const anaCtl = `c-t-ana-${pkeyOf(prevP(cur))}`;

before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const overdue = async (user = 'consulta') => (await api.call(user, 'GET', '/api/state')).json().derived.alerts.filter((a) => a.type === 'sin_control');
const settings = async () => {
  const r = await api.call('consulta', 'GET', '/api/settings/alerts');
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const put = (user, body, version) => api.call(user, 'PUT', '/api/settings/alerts', body, version == null ? {} : ifMatch(version));

describe('umbral de días sin control', () => {
  test('por defecto 14: Bruno y Carla (nunca controlados) tienen la alerta, Ana no', async () => {
    const s = await settings();
    assert.deepEqual(s, { controlOverdueDays: 14, version: 0 });
    const st = (await api.call('gerencia', 'GET', '/api/state')).json();
    assert.equal(st.settings.controlOverdueDays, 14);
    const a = await overdue('gerencia');
    assert.deepEqual(a.map((x) => x.key).sort(), ['sinctl-t-bruno-nunca', 'sinctl-t-carla-nunca']);
    const bruno = a.find((x) => x.techId === 't-bruno');
    assert.deepEqual([bruno.title, bruno.text, bruno.days, bruno.controlId], ['Sin control hace 29 días', 'Bruno Ejemplo. Sin controles desde la primera entrega', 29, null]);
  });

  test('cambiarlo: plantillas_edit, If-Match, 0 a 365, auditoría y conflicto', async () => {
    assert.equal((await put('responsable', { controlOverdueDays: 5 }, 0)).statusCode, 403);
    assert.equal((await put('gerencia', { controlOverdueDays: 5 }, 0)).statusCode, 403);
    assert.equal((await put('admin', { controlOverdueDays: 5 })).statusCode, 428);
    assert.equal((await put('admin', { controlOverdueDays: 1.5 }, 0)).statusCode, 400);
    assert.equal((await put('admin', { controlOverdueDays: '5' }, 0)).statusCode, 400);
    assert.equal((await put('admin', {}, 0)).statusCode, 400);
    const bad = await put('admin', { controlOverdueDays: 366 }, 0);
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error, 'invalid_setting');
    const ok = await put('admin', { controlOverdueDays: 5 }, 0);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json(), { controlOverdueDays: 5, version: 1 });
    assert.equal(ok.headers.etag, '"1"');
    const au = await api.q("SELECT detail FROM audit_log WHERE action = 'alert_settings' ORDER BY at DESC LIMIT 1");
    assert.equal(au[0].detail, 'Alerta de días sin control: más de 5 días');
    // Versión vieja: 409 y no se pisa.
    assert.equal((await put('admin', { controlOverdueDays: 30 }, 0)).statusCode, 409);
    assert.equal((await settings()).controlOverdueDays, 5);
  });

  test('con 5 días también Ana (7 días); la clave lleva su último control y se puede resolver', async () => {
    const a = await overdue();
    const ana = a.find((x) => x.techId === 't-ana');
    assert.ok(ana, 'alerta de Ana');
    assert.equal(ana.key, `sinctl-t-ana-${anaCtl}`);
    assert.deepEqual([ana.title, ana.days, ana.controlId], ['Sin control hace 7 días', 7, anaCtl]);
    assert.match(ana.text, /^Ana Prueba\. Último control: \d{1,2}\/\d{1,2}\/\d{4}$/);
    const r = await api.call('responsable', 'POST', `/api/alerts/${encodeURIComponent(ana.key)}/resolution`, { note: 'Se controla mañana' });
    assert.equal(r.statusCode, 201, r.body);
    assert.ok(!(await overdue()).some((x) => x.key === ana.key));
  });

  test('un control nuevo cierra la alerta sola (la clave cambia)', async () => {
    const draft = (await api.q('SELECT id, version FROM controls WHERE tech_id = $1 AND status = $2', ['t-bruno', 'borrador']))[0];
    const asg = await api.q("SELECT id FROM assignments WHERE tech_id = 't-bruno' AND active ORDER BY id");
    const items = Object.fromEntries(asg.map((a) => [a.id, { state: 'bueno' }]));
    const f = await api.call('responsable', 'POST', `/api/controls/${draft.id}/finalize`, { items, cleaning: { status: 'limpio' } }, ifMatch(draft.version));
    assert.equal(f.statusCode, 200, f.body);
    const keys = (await overdue()).map((x) => x.key);
    assert.ok(!keys.some((k) => k.startsWith('sinctl-t-bruno-')), keys.join(','));
    assert.ok(keys.includes('sinctl-t-carla-nunca'));
  });

  test('0 desactiva la alerta', async () => {
    const { version } = await settings();
    assert.equal((await put('admin', { controlOverdueDays: 0 }, version)).statusCode, 200);
    assert.deepEqual(await overdue(), []);
  });
});

describe('existencia por técnico', () => {
  test('cualquier perfil la ve: herramientas en orden, poseedores, celdas, marcas y totales', async () => {
    for (const u of ['consulta', 'gerencia', 'responsable']) assert.equal((await api.call(u, 'GET', '/api/existencia')).statusCode, 200, u);
    const X = (await api.call('gerencia', 'GET', '/api/existencia')).json();
    assert.deepEqual(X.holders.filter((h) => h.kind === 'tech').map((h) => h.id), ['t-ana', 't-bruno', 't-carla']);
    assert.deepEqual(X.rows.map((r) => r.toolId).sort(), ['tool-destornillador', 'tool-multimetro', 'tool-pinza', 'tool-taladro']);
    const row = (id) => X.rows.find((r) => r.toolId === id);
    assert.equal(row('tool-pinza').cells['t-ana'].qty, 2);
    assert.equal(row('tool-pinza').cells['t-bruno'].qty, 1);
    assert.equal(row('tool-destornillador').cells['t-carla'].qty, 2);
    assert.equal(row('tool-pinza').disponible, 17);
    // Ana: su control de la semana anterior marcó una asignación para recambio; nada faltante.
    const ana = X.holders.find((h) => h.id === 't-ana');
    assert.deepEqual([ana.total, ana.faltante, ana.lastControlId, ana.never, ana.days], [4, 0, anaCtl, false, 7]);
    assert.ok(ana.cambio >= 1);
    const carla = X.holders.find((h) => h.id === 't-carla');
    assert.deepEqual([carla.never, carla.days, carla.total], [true, 28, 2]);
    assert.deepEqual(X.totals, { total: 8, cambio: ana.cambio, faltante: 0, disponible: X.rows.reduce((s, r) => s + r.disponible, 0) });
  });

  test('filtros: plantilla, sin cajas y solo con herramientas; parámetros inválidos 400', async () => {
    const X = (await api.call('consulta', 'GET', '/api/existencia?plantilla=tarde&cajas=0')).json();
    assert.deepEqual(X.holders.map((h) => h.key), ['t-bruno']);
    assert.deepEqual(X.filters, { plantilla: 'tarde', cajas: false, withTools: false });
    const M = (await api.call('consulta', 'GET', '/api/existencia?plantilla=manana&withTools=1')).json();
    assert.deepEqual(M.holders.map((h) => h.key), ['t-ana']);
    assert.equal((await api.call('consulta', 'GET', '/api/existencia?cajas=si')).statusCode, 400);
    assert.equal((await api.call('consulta', 'GET', '/api/existencia?otro=1')).statusCode, 400);
  });
});
