// Etapa 6: novedades (alta con temas y vínculo, permisos, filtros, edición con auditoría,
// eliminar / restaurar / eliminación definitiva con el modelo genérico e historial).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';

let api, linea;
before(async () => {
  api = await setupApi();
  linea = (await api.call('admin', 'POST', '/api/lineas', { name: 'Línea Novedades', kind: 'linea' })).json().linea;
});
after(async () => {
  await api?.close();
});

const post = (user, body, h = {}) => api.call(user, 'POST', '/api/novedades', body, h);
const list = async (user, qs = '') => api.call(user, 'GET', `/api/novedades${qs ? '?' + qs : ''}`);
const ids = (r) => r.json().novedades.map((n) => n.id);
const R = { reason: 'Cargada por error' };
const ver = async (table, id) => (await api.q(`SELECT version FROM ${table} WHERE id = $1`, [id]))[0].version;

describe('permisos', () => {
  test('ver y cargar: quien opera el pañol; gerencia y consulta no (configurable)', async () => {
    for (const u of ['gerencia', 'consulta']) {
      assert.equal((await list(u)).statusCode, 403, u);
      assert.equal((await post(u, { comment: 'Hola' })).statusCode, 403, u);
    }
    for (const u of ['admin', 'supervisor', 'responsable']) assert.equal((await list(u)).statusCode, 200, u);
    const perms = (await api.call('admin', 'GET', '/api/permissions')).json();
    await api.call('admin', 'PUT', '/api/permissions', { overrides: { ...perms.overrides, consulta: { ...(perms.overrides.consulta || {}), novedades_view: true } } });
    assert.equal((await list('consulta')).statusCode, 200);
    assert.equal((await post('consulta', { comment: 'Hola' })).statusCode, 403);
    await api.call('admin', 'PUT', '/api/permissions', { overrides: perms.overrides });
    assert.equal((await list('consulta')).statusCode, 403);
  });
});

let plain, full;
describe('alta', () => {
  test('sin temas: fecha y autor del servidor, comentario obligatorio, auditoría', async () => {
    assert.equal((await post('responsable', {})).statusCode, 400);
    assert.equal((await post('responsable', { comment: '   ' })).json().error, 'comment_required');
    assert.equal((await post('responsable', { comment: 'x'.repeat(2001) })).statusCode, 400);
    const t0 = Date.now();
    const r = await post('responsable', { comment: '  Se cortó la luz en el pañol  ', occurredAt: '2020-01-01T00:00:00Z' });
    assert.equal(r.statusCode, 400, 'occurredAt no se acepta del cliente');
    const ok = await post('responsable', { comment: '  Se cortó la luz en el pañol  ' });
    assert.equal(ok.statusCode, 201, ok.body);
    plain = ok.json().novedad;
    assert.equal(plain.comment, 'Se cortó la luz en el pañol');
    assert.equal(plain.authorId, 'u-responsable');
    assert.equal(plain.authorName, 'Responsable Desarrollo');
    assert.match(plain.name, /^Novedad \d+$/);
    assert.ok(Math.abs(Date.parse(plain.occurredAt) - t0) < 60000);
    assert.deepEqual([plain.techId, plain.plantillaId, plain.lineaId, plain.movementId, plain.archived], [null, null, null, null, false]);
    assert.equal(ok.headers.etag, `"${plain.version}"`);
    const a = await api.q("SELECT actor_id, detail FROM audit_log WHERE action = 'novedad_create' AND entity_id = $1", [plain.id]);
    assert.equal(a[0].actor_id, 'u-responsable');
    assert.match(a[0].detail, /Se cortó la luz/);
  });

  test('con técnico, plantilla y línea (activos), cualquier combinación', async () => {
    const r = await post('supervisor', { comment: 'Ana avisó que falta el taladro', techId: 't-ana', plantillaId: 'manana', lineaId: linea.id });
    assert.equal(r.statusCode, 201, r.body);
    full = r.json().novedad;
    assert.deepEqual([full.techName, full.plantillaId, full.lineaName], ['Ana Prueba', 'manana', 'Línea Novedades']);
    assert.equal((await post('supervisor', { comment: 'Solo línea', lineaId: linea.id })).statusCode, 201);
    assert.equal((await post('supervisor', { comment: 'Inactivo', techId: 't-dario' })).json().error, 'invalid_tech');
    assert.equal((await post('supervisor', { comment: 'No existe', techId: 't-nadie' })).json().error, 'invalid_tech');
    assert.equal((await post('supervisor', { comment: 'No existe', plantillaId: 'nada' })).json().error, 'invalid_plantilla');
    const ln = (await api.call('admin', 'POST', '/api/lineas', { name: 'Línea Vieja', kind: 'sector' })).json().linea;
    await api.call('admin', 'POST', `/api/lineas/${ln.id}/archive`, R, ifMatch(ln.version));
    assert.equal((await post('supervisor', { comment: 'Archivada', lineaId: ln.id })).json().error, 'invalid_linea');
  });

  test('Idempotency-Key: el reintento devuelve la misma novedad', async () => {
    const h = { 'idempotency-key': 'novedad-retry-0001' };
    const a = await post('responsable', { comment: 'Reintento' }, h);
    const b = await post('responsable', { comment: 'Reintento' }, h);
    assert.equal(a.statusCode, 201);
    assert.equal(b.statusCode, 201);
    assert.equal(b.headers['idempotent-replayed'], 'true');
    assert.equal(b.json().novedad.id, a.json().novedad.id);
    assert.equal((await api.q("SELECT count(*)::int AS n FROM novedades WHERE comment = 'Reintento'"))[0].n, 1);
  });
});

let entrega, linked;
describe('vínculo a una entrega o reposición', () => {
  test('vincula una entrega; no una devolución, una anulación ni un movimiento anulado', async () => {
    entrega = (await api.q("SELECT id FROM movements WHERE tech_id = 't-bruno' AND type = 'entrega_inicial' ORDER BY at LIMIT 1"))[0];
    const r = await post('responsable', { comment: 'Entregada con el estuche roto', techId: 't-bruno', movementId: entrega.id });
    assert.equal(r.statusCode, 201, r.body);
    linked = r.json().novedad;
    assert.equal(linked.movement.type, 'entrega_inicial');
    assert.equal(linked.movement.voided, false);
    assert.ok(linked.movement.toolName);
    assert.equal((await post('responsable', { comment: 'x', movementId: 'm-nada' })).statusCode, 404);
    // Una entrega que se anula: ni ella ni su anulación se vinculan.
    const e = (await api.call('responsable', 'POST', '/api/movements', { type: 'entrega_inicial', techId: 't-carla', toolId: 'tool-pinza', qty: 1 })).json().movement;
    const v = (await api.call('admin', 'POST', `/api/movements/${e.id}/void`, R)).json().movement;
    assert.equal((await post('responsable', { comment: 'x', movementId: e.id })).json().error, 'movement_voided');
    assert.equal((await post('responsable', { comment: 'x', movementId: v.id })).json().error, 'invalid_movement');
    const dev = (await api.q("SELECT id FROM movements WHERE type NOT IN ('entrega_inicial', 'adicional', 'reposicion', 'anulacion') LIMIT 1"))[0];
    if (dev) assert.equal((await post('responsable', { comment: 'x', movementId: dev.id })).json().error, 'invalid_movement');
    // El movimiento vinculado que se anula después queda marcado.
    assert.equal((await api.call('responsable', 'GET', `/api/novedades/${linked.id}`)).json().novedad.movement.voided, false);
  });

  test('el vínculo espera a una anulación en curso del mismo movimiento (mismo bloqueo)', async () => {
    const c = await api.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`movements.void:${entrega.id}`]);
      let done = false;
      const p = post('responsable', { comment: 'Durante la anulación', movementId: entrega.id }).then((r) => { done = true; return r; });
      await new Promise((res) => setTimeout(res, 400));
      assert.equal(done, false);
      await c.query('COMMIT');
      assert.equal((await p).statusCode, 201);
    } finally {
      c.release();
    }
  });
});

describe('lista y filtros', () => {
  test('más nuevas primero; técnico, plantilla, línea, autor, texto, vínculo y período', async () => {
    const all = await list('responsable');
    assert.equal(all.statusCode, 200);
    const l = all.json().novedades;
    assert.ok(l.length >= 5);
    assert.equal(all.json().total, l.length);
    for (let i = 1; i < l.length; i++) assert.ok(l[i - 1].occurredAt >= l[i].occurredAt);
    assert.deepEqual(ids(await list('responsable', 'techId=t-ana')), [full.id]);
    assert.deepEqual(ids(await list('responsable', 'plantillaId=manana')), [full.id]);
    assert.equal(ids(await list('responsable', `lineaId=${linea.id}`)).length, 2);
    assert.ok(ids(await list('responsable', 'authorId=u-supervisor')).every((id) => l.find((n) => n.id === id).authorId === 'u-supervisor'));
    assert.deepEqual(ids(await list('responsable', 'q=LUZ')), [plain.id]);
    assert.deepEqual(ids(await list('responsable', 'q=Ana%20Prueba')), [full.id]);
    assert.deepEqual(ids(await list('responsable', 'q=100%25')), []);
    const yes = ids(await list('responsable', 'linked=yes'));
    assert.ok(yes.includes(linked.id) && !yes.includes(plain.id));
    const no = ids(await list('responsable', 'linked=no'));
    assert.ok(no.includes(plain.id) && !no.includes(linked.id));
    assert.deepEqual(ids(await list('responsable', `movementId=${entrega.id}`)).sort(), l.filter((n) => n.movementId === entrega.id).map((n) => n.id).sort());
    const today = (await api.q("SELECT to_char(current_date, 'YYYY-MM-DD') AS d"))[0].d;
    assert.equal(ids(await list('responsable', `from=${today}&to=${today}`)).length, l.length);
    assert.equal(ids(await list('responsable', 'from=2020-01-01&to=2020-01-31')).length, 0);
    assert.equal((await list('responsable', 'from=2026-02-30')).statusCode, 400);
    assert.equal((await list('responsable', 'from=2026-11-10&to=2026-11-01')).statusCode, 400);
  });

  test('páginas con cursor, sin repetir ni saltear', async () => {
    const all = ids(await list('responsable'));
    const seen = [];
    let next = null;
    do {
      const r = (await list('responsable', `limit=2${next ? '&before=' + encodeURIComponent(next) : ''}`)).json();
      assert.ok(r.novedades.length <= 2);
      seen.push(...r.novedades.map((n) => n.id));
      next = r.next;
    } while (next);
    assert.deepEqual(seen, all);
  });
});

describe('edición', () => {
  test('el autor edita la suya; otro sin novedades_edit no; admin edita cualquiera; auditoría con lo anterior', async () => {
    const path = `/api/novedades/${plain.id}`;
    assert.equal((await api.call('responsable', 'PATCH', path, { comment: 'Nuevo' })).statusCode, 428);
    assert.equal((await api.call('responsable', 'PATCH', path, { comment: 'Nuevo' }, ifMatch(99))).statusCode, 409);
    assert.equal((await api.call('responsable2', 'PATCH', path, { comment: 'Ajeno' }, ifMatch(plain.version))).statusCode, 403);
    assert.equal((await api.call('consulta', 'PATCH', path, { comment: 'Ajeno' }, ifMatch(plain.version))).statusCode, 403);
    const r = await api.call('responsable', 'PATCH', path, { comment: 'Se cortó la luz dos horas', techId: 't-carla' }, ifMatch(plain.version));
    assert.equal(r.statusCode, 200, r.body);
    const n = r.json().novedad;
    assert.deepEqual([n.comment, n.techId, n.version, n.occurredAt, n.authorId], ['Se cortó la luz dos horas', 't-carla', plain.version + 1, plain.occurredAt, 'u-responsable']);
    const a = (await api.q("SELECT detail FROM audit_log WHERE action = 'novedad_edit' AND entity_id = $1", [plain.id]))[0].detail;
    assert.match(a, /comentario anterior: «Se cortó la luz en el pañol»/);
    assert.match(a, /técnico: \(ninguno\) → Carla Demo/);
    const adm = await api.call('admin', 'PATCH', path, { techId: null }, ifMatch(n.version));
    assert.equal(adm.statusCode, 200);
    assert.equal(adm.json().novedad.techId, null);
    // Nada cambia: misma versión, sin auditoría.
    const same = await api.call('admin', 'PATCH', path, { comment: 'Se cortó la luz dos horas' }, ifMatch(adm.json().novedad.version));
    assert.equal(same.json().novedad.version, adm.json().novedad.version);
    plain = same.json().novedad;
  });

  test('un tema nuevo tiene que estar activo; uno eliminado después se conserva al editar', async () => {
    const t = (await api.call('admin', 'POST', '/api/techs', { name: 'Técnico Novedad', legajo: 'NOV-001' })).json().tech;
    const r = (await post('responsable', { comment: 'Sobre el técnico nuevo', techId: t.id })).json().novedad;
    assert.equal((await api.call('admin', 'POST', `/api/techs/${t.id}/archive`, R, ifMatch(await ver('techs', t.id)))).statusCode, 200);
    const g = (await api.call('responsable', 'GET', `/api/novedades/${r.id}`)).json().novedad;
    assert.deepEqual([g.techId, g.techArchived], [t.id, true]);
    const e = await api.call('responsable', 'PATCH', `/api/novedades/${r.id}`, { comment: 'Sobre el técnico (editada)' }, ifMatch(g.version));
    assert.equal(e.statusCode, 200, e.body);
    assert.equal(e.json().novedad.techId, t.id);
    assert.equal((await api.call('responsable', 'PATCH', `/api/novedades/${plain.id}`, { techId: t.id }, ifMatch(plain.version))).json().error, 'invalid_tech');
    // El técnico nombrado en una novedad tiene historial.
    const chk = (await api.call('admin', 'GET', `/api/techs/${t.id}/delete-check`)).json();
    assert.deepEqual([chk.canPurge, chk.history], [false, ['Tiene novedades.']]);
  });
});

describe('eliminar, restaurar y eliminación definitiva', () => {
  test('modelo genérico: records_delete, motivo, oculta de la lista, restaura y borra con la etiqueta', async () => {
    const n = (await post('responsable', { comment: 'Para eliminar' })).json().novedad;
    const path = `/api/novedades/${n.id}`;
    assert.equal((await api.call('responsable', 'POST', `${path}/archive`, R, ifMatch(n.version))).statusCode, 403);
    const chk = (await api.call('admin', 'GET', `${path}/delete-check`)).json();
    assert.deepEqual([chk.name, chk.canPurge, chk.hasHistory, chk.blockers.length], [n.name, true, false, 0]);
    const a = await api.call('admin', 'POST', `${path}/archive`, { reason: 'Duplicada' }, ifMatch(n.version));
    assert.equal(a.statusCode, 200, a.body);
    const arch = a.json().novedad;
    assert.deepEqual([arch.archived, arch.archiveReason, arch.archivedBy], [true, 'Duplicada', 'u-admin']);
    assert.ok(!ids(await list('responsable')).includes(n.id));
    assert.equal((await api.call('responsable', 'GET', path)).statusCode, 404);
    assert.equal((await list('responsable', 'archived=include')).statusCode, 403);
    assert.deepEqual(ids(await list('admin', 'archived=only')), [n.id]);
    assert.ok(ids(await list('admin', 'archived=include')).includes(n.id));
    const del = (await api.call('admin', 'GET', '/api/archived?type=novedades')).json().records;
    assert.deepEqual(del.map((x) => [x.id, x.name, x.comment, x.hasHistory]), [[n.id, n.name, 'Para eliminar', false]]);
    assert.equal((await api.call('responsable', 'PATCH', path, { comment: 'x' }, ifMatch(arch.version))).json().error, 'archived');
    const rs = await api.call('admin', 'POST', `${path}/restore`, { reason: 'Era válida' }, ifMatch(arch.version));
    assert.equal(rs.statusCode, 200);
    assert.ok(ids(await list('responsable')).includes(n.id));
    const v = rs.json().novedad.version;
    assert.equal((await api.call('admin', 'DELETE', path, { reason: 'Prueba', confirmName: 'Novedad' }, ifMatch(v))).json().error, 'confirm_name');
    const d = await api.call('admin', 'DELETE', path, { reason: 'Prueba', confirmName: n.name }, ifMatch(v));
    assert.equal(d.statusCode, 200, d.body);
    assert.equal((await api.q('SELECT count(*)::int AS n FROM novedades WHERE id = $1', [n.id]))[0].n, 0);
    const audit = (await api.q("SELECT detail FROM audit_log WHERE action = 'novedad_delete' AND entity_id = $1", [n.id]))[0].detail;
    assert.match(audit, new RegExp(`${n.name}. Motivo: Prueba`));
  });

  test('plantilla, línea y autor nombrados en una novedad tienen historial', async () => {
    const ln = (await api.call('admin', 'GET', `/api/lineas/${linea.id}/delete-check`)).json();
    assert.ok(ln.history.includes('Tiene novedades.'));
    assert.ok((await api.call('admin', 'GET', '/api/plantillas/manana/delete-check')).json().history.includes('Tiene novedades.'));
    assert.ok((await api.call('admin', 'GET', '/api/users/u-supervisor/delete-check')).json().history.includes('Escribió novedades.'));
  });
});

describe('datos de demostración', () => {
  test('una novedad real sobre un técnico demo impide borrar la demostración', async () => {
    assert.equal((await api.call('admin', 'POST', '/api/demo')).statusCode, 201);
    const t = (await api.q('SELECT id FROM techs WHERE demo AND active LIMIT 1'))[0];
    const n = (await post('admin', { comment: 'Sobre un técnico demo', techId: t.id })).json().novedad;
    const r = await api.call('admin', 'DELETE', '/api/demo');
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'demo_in_use');
    await api.call('admin', 'DELETE', `/api/novedades/${n.id}`, { reason: 'Prueba', confirmName: n.name }, ifMatch(n.version));
    assert.equal((await api.call('admin', 'DELETE', '/api/demo')).statusCode, 200);
  });
});
