// Etapa 5: eliminar (baja lógica), restaurar, eliminación definitiva, registros eliminados,
// anular movimientos, permisos, auditoría con motivo y `.txt` v2.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { HEAD, toTxt } from '../fixtures/v21.js';

let api;
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const ver = async (table, id) => (await api.q(`SELECT version FROM ${table} WHERE id = $1`, [id]))[0].version;
const pools = async (toolId) => (await api.call('admin', 'GET', '/api/inventory')).json().pools[toolId];
const R = { reason: 'Cargado por error' };
const newTech = async (name, legajo) => (await api.call('admin', 'POST', '/api/techs', { name, legajo })).json().tech;
const mov = async (body, user = 'responsable', h = {}) => api.call(user, 'POST', '/api/movements', body, h);

describe('permisos', () => {
  test('solo records_delete / movements_void (admin por defecto); configurable; usuarios solo admin', async () => {
    const v = await ver('techs', 't-carla');
    for (const u of ['supervisor', 'responsable', 'consulta', 'gerencia']) {
      assert.equal((await api.call(u, 'POST', '/api/techs/t-carla/archive', R, ifMatch(v))).statusCode, 403, u);
      assert.equal((await api.call(u, 'GET', '/api/archived')).statusCode, 403, u);
      assert.equal((await api.call(u, 'POST', '/api/movements/x/void', R)).statusCode, 403, u);
    }
    const perms = (await api.call('admin', 'GET', '/api/permissions')).json();
    const put = await api.call('admin', 'PUT', '/api/permissions', { overrides: { ...perms.overrides, supervisor: { ...(perms.overrides.supervisor || {}), records_delete: true } } });
    assert.equal(put.statusCode, 200);
    assert.equal((await api.call('supervisor', 'GET', '/api/techs/t-carla/delete-check')).statusCode, 200);
    // Aun con el permiso, los usuarios los administra un administrador.
    assert.equal((await api.call('supervisor', 'GET', '/api/users/u-consulta/delete-check')).statusCode, 403);
    await api.call('admin', 'PUT', '/api/permissions', { overrides: perms.overrides });
    assert.equal((await api.call('supervisor', 'GET', '/api/techs/t-carla/delete-check')).statusCode, 403);
  });

  test('motivo obligatorio, If-Match obligatorio', async () => {
    assert.equal((await api.call('admin', 'POST', '/api/techs/t-carla/archive', {}, ifMatch(await ver('techs', 't-carla')))).statusCode, 400);
    assert.equal((await api.call('admin', 'POST', '/api/techs/t-carla/archive', { reason: '   ' }, ifMatch(await ver('techs', 't-carla')))).statusCode, 422);
    assert.equal((await api.call('admin', 'POST', '/api/techs/t-carla/archive', R)).statusCode, 428);
    assert.equal((await api.call('admin', 'POST', '/api/techs/t-carla/archive', R, ifMatch(999))).statusCode, 409);
  });
});

describe('técnico con herramientas', () => {
  test('pide resolver cada asignación y aplica devoluciones, retiro y la baja en una transacción', async () => {
    const chk = (await api.call('admin', 'GET', '/api/techs/t-ana/delete-check')).json();
    assert.equal(chk.hasHistory, true);
    assert.equal(chk.canPurge, false);
    assert.equal(chk.assignments.length, 3);
    const byTool = Object.fromEntries(chk.assignments.map((a) => [a.toolId, a]));
    const v = await ver('techs', 't-ana');
    const p0 = await pools('tool-pinza');
    const part = await api.call('admin', 'POST', '/api/techs/t-ana/archive', { ...R, resolutions: [{ assignmentId: byTool['tool-pinza'].id, action: 'devolucion' }] }, ifMatch(v));
    assert.equal(part.statusCode, 409);
    assert.equal(part.json().error, 'pending_assignments');
    assert.equal(part.json().pending.length, 2);
    // Nada quedó escrito.
    assert.deepEqual(await pools('tool-pinza'), p0);
    const r = await api.call('admin', 'POST', '/api/techs/t-ana/archive', {
      reason: 'Renunció',
      resolutions: [
        { assignmentId: byTool['tool-pinza'].id, action: 'devolucion', cond: 'disponible' },
        { assignmentId: byTool['tool-destornillador'].id, action: 'devolucion', cond: 'reparacion' },
        { assignmentId: byTool['tool-taladro'].id, action: 'retiro' },
      ],
    }, ifMatch(v));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().movements.length, 3);
    const t = r.json().tech;
    assert.equal(t.archived, true);
    assert.equal(t.active, false);
    assert.equal(t.archiveReason, 'Renunció');
    assert.equal(t.archivedBy, 'u-admin');
    assert.equal((await api.q("SELECT count(*)::int AS n FROM assignments WHERE tech_id = 't-ana' AND active"))[0].n, 0);
    assert.equal((await pools('tool-pinza')).disponible, p0.disponible + 2);
    assert.equal((await api.q("SELECT status FROM units WHERE code = 'TAL-001'"))[0].status, 'retirado');
    const aud = await api.q("SELECT detail FROM audit_log WHERE action = 'tech_archive' AND entity_id = 't-ana'");
    assert.match(aud[0].detail, /Motivo: Renunció\. Herramientas resueltas: 3\./);
    // Oculto en selectores pero con nombre en el historial.
    const st = (await api.call('consulta', 'GET', '/api/state')).json();
    assert.equal(st.techs['t-ana'].archived, true);
    assert.equal(st.techs['t-ana'].name, 'Ana Prueba');
    assert.deepEqual((await api.call('admin', 'GET', '/api/integrity')).json().issues, []);
  });

  test('eliminado: no se edita, no recibe herramientas; se restaura con su versión', async () => {
    const v = await ver('techs', 't-ana');
    assert.equal((await api.call('admin', 'PATCH', '/api/techs/t-ana', { name: 'Otra' }, ifMatch(v))).json().error, 'archived');
    assert.equal((await mov({ type: 'entrega_inicial', techId: 't-ana', toolId: 'tool-pinza', qty: 1 })).statusCode, 422);
    assert.equal((await api.call('admin', 'POST', '/api/techs/t-ana/archive', R, ifMatch(v))).json().error, 'archived');
    assert.equal((await api.call('admin', 'POST', '/api/techs/t-ana/restore', {}, ifMatch(v))).statusCode, 400);
    const r = await api.call('admin', 'POST', '/api/techs/t-ana/restore', { reason: 'Volvió' }, ifMatch(v));
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().tech.archived, false);
    assert.equal(r.json().tech.active, true);
    assert.equal((await api.call('admin', 'POST', '/api/techs/t-ana/restore', R, ifMatch(r.json().tech.version))).json().error, 'not_archived');
    assert.equal((await api.q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'tech_restore' AND detail LIKE '%Motivo: Volvió%'"))[0].n, 1);
  });

  test('el legajo de un técnico eliminado sigue tomado (se restaura)', async () => {
    const t = await newTech('Legajo Viejo', 'LEG-77');
    await api.call('admin', 'POST', `/api/techs/${t.id}/archive`, R, ifMatch(t.version));
    const dup = await api.call('admin', 'POST', '/api/techs', { name: 'Otro', legajo: 'LEG-77' });
    assert.equal(dup.statusCode, 409);
    assert.match(dup.json().message, /\(eliminado; restauralo/);
  });

  test('referente de una caja activa: no se elimina', async () => {
    const l = (await api.call('admin', 'POST', '/api/lineas', { name: 'Línea R', kind: 'linea' })).json().linea;
    const k = (await api.call('admin', 'POST', '/api/cajas', { name: 'Caja R', lineaId: l.id, referenteTechId: 't-bruno' })).json().caja;
    const r = await api.call('admin', 'POST', '/api/techs/t-bruno/archive', R, ifMatch(await ver('techs', 't-bruno')));
    assert.equal(r.json().error, 'tech_is_referente');
    // Caja sin herramientas: se elimina y se restaura; con la línea eliminada no se restaura.
    const ka = await api.call('admin', 'POST', `/api/cajas/${k.id}/archive`, R, ifMatch(k.version));
    assert.equal(ka.statusCode, 200);
    const la = await api.call('admin', 'POST', `/api/lineas/${l.id}/archive`, R, ifMatch(l.version));
    assert.equal(la.statusCode, 200, la.body);
    const kr = await api.call('admin', 'POST', `/api/cajas/${k.id}/restore`, R, ifMatch(ka.json().caja.version));
    assert.equal(kr.json().error, 'parent_archived');
  });
});

describe('eliminación definitiva', () => {
  test('solo sin historial, escribiendo el nombre exacto; la auditoría guarda el nombre', async () => {
    const t = await newTech('Sin Historia', 'SH-1');
    const chk = (await api.call('admin', 'GET', `/api/techs/${t.id}/delete-check`)).json();
    assert.deepEqual([chk.hasHistory, chk.canPurge], [false, true]);
    assert.equal((await api.call('admin', 'DELETE', `/api/techs/${t.id}`, { reason: 'Duplicado', confirmName: 'sin historia' }, ifMatch(t.version))).json().error, 'confirm_name');
    assert.equal((await api.call('admin', 'DELETE', `/api/techs/${t.id}`, { reason: 'Duplicado' }, ifMatch(t.version))).statusCode, 400);
    const r = await api.call('admin', 'DELETE', `/api/techs/${t.id}`, { reason: 'Duplicado', confirmName: 'Sin Historia' }, ifMatch(t.version));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await api.q('SELECT count(*)::int AS n FROM techs WHERE id = $1', [t.id]))[0].n, 0);
    assert.equal((await api.q('SELECT count(*)::int AS n FROM tech_plantilla_history WHERE tech_id = $1', [t.id]))[0].n, 0);
    const a = await api.q("SELECT detail FROM audit_log WHERE action = 'tech_delete' AND entity_id = $1", [t.id]);
    assert.equal(a[0].detail, 'Eliminación definitiva de técnico Sin Historia. Motivo: Duplicado');
    // El historial de pertenencia sigue siendo de solo agregar fuera de esa transacción.
    await assert.rejects(api.q("DELETE FROM tech_plantilla_history WHERE tech_id = 't-bruno'"), (e) => e.code === '23001');
  });

  test('con historial: 409 con los motivos, aunque esté eliminado', async () => {
    const r = await api.call('admin', 'DELETE', '/api/techs/t-ana', { reason: 'x', confirmName: 'Ana Prueba' }, ifMatch(await ver('techs', 't-ana')));
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'has_history');
    assert.ok(r.json().history.includes('Tiene movimientos.'));
    // Una edición también es historial.
    const t = await newTech('Editado', 'ED-1');
    const e = await api.call('admin', 'PATCH', `/api/techs/${t.id}`, { name: 'Editado Dos' }, ifMatch(t.version));
    assert.equal((await api.call('admin', 'GET', `/api/techs/${t.id}/delete-check`)).json().hasHistory, true);
    assert.equal((await api.call('admin', 'DELETE', `/api/techs/${t.id}`, { reason: 'x', confirmName: 'Editado Dos' }, ifMatch(e.json().tech.version))).json().error, 'has_history');
  });
});

describe('herramientas y categorías', () => {
  test('una herramienta con stock asignado no se elimina; sin asignar sí, con sus unidades', async () => {
    const r = await api.call('admin', 'POST', '/api/tools/tool-multimetro/archive', R, ifMatch(await ver('tools', 'tool-multimetro')));
    assert.equal(r.json().error, 'tool_assigned');
    const t = (await api.call('admin', 'POST', '/api/tools', { name: 'Llave de prueba', categoryId: 'cat-manuales', serialized: true, codes: 'LLP-1' })).json().tool;
    const order0 = (await api.call('admin', 'GET', '/api/state')).json().orderVersions['tools:cat-manuales'];
    const a = await api.call('admin', 'POST', `/api/tools/${t.id}/archive`, R, ifMatch(await ver('tools', t.id)));
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json().tool.active, false);
    assert.ok((await api.q("SELECT archived_at FROM units WHERE code = 'LLP-1'"))[0].archived_at);
    // Sale del orden editable (sube la versión del alcance).
    const st = (await api.call('admin', 'GET', '/api/state')).json();
    assert.equal(st.orderVersions['tools:cat-manuales'], order0 + 1);
    // Otra herramienta activa puede usar el nombre; restaurar la eliminada choca con ella.
    const other = await api.call('admin', 'POST', '/api/tools', { name: 'Llave de prueba', categoryId: 'cat-manuales' });
    assert.equal(other.statusCode, 201);
    const back = await api.call('admin', 'POST', `/api/tools/${t.id}/restore`, R, ifMatch(a.json().tool.version));
    assert.equal(back.statusCode, 409);
    assert.match(back.json().message, /Ya hay otro registro activo con el nombre Llave de prueba/);
  });

  test('categoría: solo sin herramientas activas; eliminada no se elige', async () => {
    const g = (await api.call('admin', 'POST', '/api/categories', { name: 'Para eliminar' })).json().category;
    const a = await api.call('admin', 'POST', `/api/categories/${g.id}/archive`, R, ifMatch(g.version));
    assert.equal(a.statusCode, 200);
    assert.equal((await api.call('admin', 'POST', '/api/tools', { name: 'En eliminada', categoryId: g.id })).json().error, 'invalid_category');
    assert.equal((await api.call('admin', 'PATCH', `/api/categories/${g.id}`, { name: 'Otra categoría' }, ifMatch(a.json().category.version))).json().error, 'archived');
  });
});

describe('usuarios', () => {
  test('eliminar = desactivar y ocultar; no a uno mismo; restaurar deja desactivado', async () => {
    const self = await api.call('admin', 'POST', '/api/users/u-admin/archive', R, ifMatch(await ver('users', 'u-admin')));
    assert.equal(self.json().error, 'self_deactivate');
    await api.login('consulta');
    const r = await api.call('admin', 'POST', '/api/users/u-consulta/archive', R, ifMatch(await ver('users', 'u-consulta')));
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual([r.json().user.archived, r.json().user.active], [true, false]);
    assert.ok(!(await api.call('admin', 'GET', '/api/users')).json().users.some((u) => u.id === 'u-consulta'));
    assert.equal((await api.q("SELECT count(*)::int AS n FROM sessions WHERE user_id = 'u-consulta'"))[0].n, 0);
    assert.equal((await api.call('admin', 'POST', '/api/users/u-consulta/reactivate', undefined, ifMatch(r.json().user.version))).json().error, 'archived');
    const back = await api.call('admin', 'POST', '/api/users/u-consulta/restore', R, ifMatch(r.json().user.version));
    assert.deepEqual([back.json().user.archived, back.json().user.active], [false, false]);
    assert.equal((await api.call('admin', 'DELETE', '/api/users/u-consulta', { reason: 'x', confirmName: 'Consulta Desarrollo' }, ifMatch(back.json().user.version))).json().error, 'has_history');
  });

  test('un administrador desactivado se elimina; la desactivación cuenta como historial', async () => {
    const u = (await api.call('admin', 'POST', '/api/users', { username: 'otro.admin', name: 'Otro Admin', role: 'admin' })).json().user;
    await api.call('admin', 'POST', `/api/users/${u.id}/deactivate`, undefined, ifMatch(u.version));
    const v = await ver('users', u.id);
    const del = await api.call('admin', 'DELETE', `/api/users/${u.id}`, { reason: 'Prueba', confirmName: 'Otro Admin' }, ifMatch(v));
    assert.equal(del.json().error, 'has_history');
    const a = await api.call('admin', 'POST', `/api/users/${u.id}/archive`, R, ifMatch(v));
    assert.equal(a.statusCode, 200);
  });
});

describe('registros eliminados', () => {
  test('lista por tipo y búsqueda, con quién, cuándo y por qué', async () => {
    const all = (await api.call('admin', 'GET', '/api/archived')).json().records;
    assert.ok(all.some((r) => r.type === 'users' && r.id.length));
    const cats = (await api.call('admin', 'GET', '/api/archived?type=categories')).json().records;
    assert.ok(cats.length && cats.every((r) => r.type === 'categories'));
    const found = (await api.call('admin', 'GET', '/api/archived?q=llave')).json().records;
    assert.equal(found.length, 1);
    assert.deepEqual([found[0].type, found[0].archivedByName, found[0].reason, found[0].hasHistory], ['tools', 'Admin Desarrollo', 'Cargado por error', true]);
  });
});

let entrega;
describe('anular movimientos', () => {
  test('anular una entrega revierte el inventario; el original queda; una anulación no se anula', async () => {
    const p0 = await pools('tool-pinza');
    const r = await mov({ type: 'entrega_inicial', techId: 't-carla', toolId: 'tool-pinza', qty: 2 });
    assert.equal(r.statusCode, 201);
    entrega = r.json().movement;
    assert.equal((await api.call('responsable', 'POST', `/api/movements/${entrega.id}/void`, R)).statusCode, 403);
    const chk = (await api.call('admin', 'GET', `/api/movements/${entrega.id}/void-check`)).json();
    assert.deepEqual([chk.ok, chk.reason], [true, null]);
    const key = { 'idempotency-key': 'void-entrega-0001' };
    assert.equal((await api.call('admin', 'POST', `/api/movements/${entrega.id}/void`, {}, key)).statusCode, 400);
    const v = await api.call('admin', 'POST', `/api/movements/${entrega.id}/void`, R, key);
    assert.equal(v.statusCode, 201, v.body);
    const anul = v.json().movement;
    assert.deepEqual([anul.type, anul.voidsMovementId, anul.techId], ['anulacion', entrega.id, 't-carla']);
    assert.deepEqual(await pools('tool-pinza'), p0);
    const replay = await api.call('admin', 'POST', `/api/movements/${entrega.id}/void`, R, key);
    assert.equal(replay.headers['idempotent-replayed'], 'true');
    assert.equal((await api.q('SELECT count(*)::int AS n FROM movements WHERE voids_movement_id = $1', [entrega.id]))[0].n, 1);
    const a = (await api.q('SELECT active, end_reason FROM assignments WHERE id = $1', [entrega.newAssignmentId]))[0];
    assert.deepEqual([a.active, a.end_reason], [false, 'anulacion']);
    assert.equal((await api.q('SELECT count(*)::int AS n FROM movements WHERE id = $1', [entrega.id]))[0].n, 1);
    const again = await api.call('admin', 'POST', `/api/movements/${entrega.id}/void`, R);
    assert.equal(again.statusCode, 422);
    assert.equal(again.json().message, 'Este movimiento ya está anulado.');
    const vv = await api.call('admin', 'POST', `/api/movements/${anul.id}/void`, R);
    assert.equal(vv.json().message, 'Una anulación no se anula.');
    const st = (await api.call('gerencia', 'GET', '/api/state')).json();
    assert.equal(st.movements[anul.id].voidsMovementId, entrega.id);
    assert.equal((await api.q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'movement_void' AND detail LIKE '%Motivo: Cargado por error'"))[0].n, 1);
    assert.deepEqual((await api.call('admin', 'GET', '/api/integrity')).json().issues, []);
  });

  test('anular una devolución vuelve la asignación; no si un movimiento posterior depende', async () => {
    const e = (await mov({ type: 'entrega_inicial', techId: 't-carla', toolId: 'tool-pinza', qty: 1 })).json().movement;
    const d = (await mov({ type: 'devolucion', techId: 't-carla', asgId: e.newAssignmentId, cond: 'reparacion' })).json().movement;
    const blocked = await api.call('admin', 'POST', `/api/movements/${e.id}/void`, R);
    assert.equal(blocked.statusCode, 422);
    assert.match(blocked.json().message, /^No se puede anular: después se registró una Devolución \(\d{2}\/\d{2}\/\d{4}\) que depende de este movimiento\. Anulá primero ese movimiento\.$/);
    assert.equal((await api.call('admin', 'GET', `/api/movements/${e.id}/void-check`)).json().ok, false);
    const p0 = await pools('tool-pinza');
    const v = await api.call('admin', 'POST', `/api/movements/${d.id}/void`, R);
    assert.equal(v.statusCode, 201, v.body);
    const p1 = await pools('tool-pinza');
    assert.deepEqual([p1.reparacion, p1.asignado], [p0.reparacion - 1, p0.asignado + 1]);
    assert.equal((await api.q('SELECT active FROM assignments WHERE id = $1', [e.newAssignmentId]))[0].active, true);
    // Anulada la devolución, ya se puede anular la entrega.
    assert.equal((await api.call('admin', 'POST', `/api/movements/${e.id}/void`, R)).statusCode, 201);
    assert.deepEqual((await api.call('admin', 'GET', '/api/integrity')).json().issues, []);
  });

  test('la base: anulación única, una anulación no se anula, el libro sigue de solo agregar', async () => {
    const anul = (await api.q("SELECT id FROM movements WHERE type = 'anulacion' LIMIT 1"))[0].id;
    await assert.rejects(api.q("INSERT INTO movements (id, type, voids_movement_id) VALUES ('mx-1', 'anulacion', $1)", [anul]), (e) => e.code === '23514');
    await assert.rejects(api.q("INSERT INTO movements (id, type, voids_movement_id) VALUES ('mx-2', 'anulacion', $1)", [entrega.id]), (e) => e.code === '23505');
    await assert.rejects(api.q("INSERT INTO movements (id, type) VALUES ('mx-3', 'anulacion')"), (e) => e.code === '23514');
    await assert.rejects(api.q('DELETE FROM movements WHERE id = $1', [entrega.id]), (e) => e.code === '23001');
  });
});

describe('.txt v2', () => {
  test('marcas de borrado, inactivos, sin anulaciones; exportar e importar = 0 cambios; no restaura en silencio', async () => {
    const e = await api.call('admin', 'GET', '/api/export/txt');
    assert.equal(e.statusCode, 200);
    const p = JSON.parse(e.body.slice(HEAD.length));
    const archivedCat = (await api.q('SELECT id, archived_at FROM categories WHERE archived_at IS NOT NULL'))[0];
    assert.ok(!p.data.categories[archivedCat.id]);
    assert.ok(p.data.deleted[`categories/${archivedCat.id}`]);
    const purged = (await api.q("SELECT entity_id FROM audit_log WHERE action = 'tech_delete'"))[0].entity_id;
    assert.ok(p.data.deleted[`techs/${purged}`]);
    assert.ok(!Object.values(p.data.movements).some((m) => m.type === 'anulacion'));
    assert.ok(!p.data.movements[entrega.id]);
    const archivedTech = (await api.q('SELECT id FROM techs WHERE archived_at IS NOT NULL'))[0].id;
    assert.equal(p.data.techs[archivedTech].active, false);
    const dry = await api.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', toTxt(p), { 'content-type': 'text/plain' });
    assert.equal(dry.statusCode, 200, dry.body);
    assert.equal(dry.json().totalChanges, 0, JSON.stringify(dry.json().counts));
    // Un archivo más nuevo con el técnico activo no lo restaura: se informa.
    p.data.techs[archivedTech] = { ...p.data.techs[archivedTech], active: true, updatedAt: new Date().toISOString() };
    p.data.movements[entrega.id] = { type: 'entrega_inicial', techId: 't-carla', toolId: 'tool-pinza', qty: 2, at: new Date().toISOString(), transfers: [] };
    const rep = (await api.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', toTxt(p), { 'content-type': 'text/plain' })).json();
    assert.equal(rep.totalChanges, 0, JSON.stringify(rep.counts));
    assert.ok(rep.conflicts.some((c) => c.id === archivedTech && /eliminado en el servidor/.test(c.message)));
    assert.ok(rep.conflicts.some((c) => c.id === entrega.id && /anulado/.test(c.message)));
  });
});
