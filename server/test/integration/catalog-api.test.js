import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';

let api;
before(async () => {
  api = await setupApi();
});
after(async () => {
  await api?.close();
});

const audits = (action) => api.q('SELECT * FROM audit_log WHERE action = $1 ORDER BY at', [action]);

describe('técnicos', () => {
  test('solo techs_edit crea: consulta, gerencia y responsable no pueden', async () => {
    for (const u of ['consulta', 'gerencia', 'responsable']) {
      const r = await api.call(u, 'POST', '/api/techs', { name: 'Nuevo Técnico', legajo: 'X-1' });
      assert.equal(r.statusCode, 403, u);
    }
    assert.equal((await api.call(null, 'POST', '/api/techs', { name: 'Nuevo Técnico', legajo: 'X-1' })).statusCode, 401);
  });

  test('alta con turno por defecto, ETag, auditoría y legajo único (409 claro)', async () => {
    const r = await api.call('admin', 'POST', '/api/techs', { name: '  Elena Nueva ', legajo: 'NEW-1', alta: '2026-01-15' });
    assert.equal(r.statusCode, 201);
    const t = r.json().tech;
    assert.equal(t.name, 'Elena Nueva');
    assert.equal(t.shiftId, 'manana');
    assert.equal(t.alta, '2026-01-15');
    assert.equal(r.headers.etag, `"${t.version}"`);
    assert.equal((await audits('tech_create')).length, 1);
    const dup = await api.call('admin', 'POST', '/api/techs', { name: 'Otro Técnico', legajo: 'new-1' });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().message, 'El legajo new-1 ya pertenece a Elena Nueva.');
    const dup2 = await api.call('admin', 'POST', '/api/techs', { name: 'Otro Técnico', legajo: 'DEV-001' });
    assert.equal(dup2.json().message, 'El legajo DEV-001 ya pertenece a Ana Prueba.');
  });

  test('validación estricta: campos extra, límites LIM, fechas e ids', async () => {
    const bad = [
      { name: 'Ana Prueba', legajo: 'Z1', extra: 1 },
      { name: 'x'.repeat(121), legajo: 'Z1' },
      { name: 'Ana Prueba', legajo: 'Z'.repeat(51) },
      { name: 'Ana Prueba', legajo: 'Z1', alta: '15/01/2026' },
      { name: 'Ana Prueba', legajo: 'Z1', shiftId: '../x' },
      { name: 12, legajo: 'Z1' },
    ];
    for (const b of bad) assert.equal((await api.call('admin', 'POST', '/api/techs', b)).statusCode, 400, JSON.stringify(b).slice(0, 60));
    const r = await api.call('admin', 'POST', '/api/techs', { name: 'Ana Prueba', legajo: 'Z1', alta: '2026-02-30' });
    assert.equal(r.statusCode, 422);
    assert.equal((await api.call('admin', 'POST', '/api/techs', { name: 'An', legajo: 'Z1' })).json().message, 'Ingresá nombre y apellido.');
  });

  test('edición con If-Match: falta -> 428, vieja -> 409 con el registro actual', async () => {
    const [t] = await api.q("SELECT version FROM techs WHERE id = 't-carla'");
    assert.equal((await api.call('admin', 'PATCH', '/api/techs/t-carla', { name: 'Carla Cambiada' })).statusCode, 428);
    const ok = await api.call('admin', 'PATCH', '/api/techs/t-carla', { name: 'Carla Cambiada' }, ifMatch(t.version));
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().tech.version, t.version + 1);
    const stale = await api.call('admin', 'PATCH', '/api/techs/t-carla', { name: 'Carla Otra' }, ifMatch(t.version));
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'conflict');
    assert.equal(stale.json().current.name, 'Carla Cambiada');
    const off = await api.call('admin', 'PATCH', '/api/techs/t-carla', { active: false }, ifMatch(t.version + 1));
    assert.equal(off.json().tech.active, false);
    assert.equal((await audits('tech_deactivate')).length, 1);
    await api.call('admin', 'PATCH', '/api/techs/t-carla', { active: true }, ifMatch(t.version + 2));
    assert.equal((await api.call('admin', 'PATCH', '/api/techs/nadie', { name: 'Nadie Nunca' }, ifMatch(1))).statusCode, 404);
  });

  test('cambio de turno: shift_change, guarda historial y auditoría', async () => {
    const [t] = await api.q("SELECT version FROM techs WHERE id = 't-ana'");
    assert.equal((await api.call('responsable', 'POST', '/api/techs/t-ana/shift-change', { to: 'noche' }, ifMatch(t.version))).statusCode, 403);
    const r = await api.call('supervisor', 'POST', '/api/techs/t-ana/shift-change', { to: 'noche', note: 'Rotación' }, ifMatch(t.version));
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().tech.shiftId, 'noche');
    const [sc] = await api.q("SELECT * FROM shift_changes WHERE tech_id = 't-ana'");
    assert.equal(sc.from_shift_id, 'manana');
    assert.equal(sc.to_name, 'Turno noche');
    assert.equal(sc.created_by, 'u-supervisor');
    const [a] = await audits('shift_change');
    assert.match(a.detail, /Turno mañana a Turno noche/);
    assert.equal((await api.call('supervisor', 'POST', '/api/techs/t-ana/shift-change', { to: 'nada' }, ifMatch(t.version + 1))).statusCode, 422);
  });
});

describe('turnos, categorías, herramientas y unidades', () => {
  test('turnos: alta con orden, nombre repetido 409, no se borra con técnicos', async () => {
    assert.equal((await api.call('responsable', 'POST', '/api/shifts', { name: 'Turno franco' })).statusCode, 403);
    const r = await api.call('admin', 'POST', '/api/shifts', { name: 'Turno franco' });
    assert.equal(r.statusCode, 201);
    const s = r.json().shift;
    assert.equal(s.order, 4);
    assert.equal((await api.call('admin', 'POST', '/api/shifts', { name: 'turno FRANCO' })).statusCode, 409);
    const ren = await api.call('admin', 'PATCH', `/api/shifts/${s.id}`, { name: 'Turno fin de semana' }, ifMatch(s.version));
    assert.equal(ren.json().shift.name, 'Turno fin de semana');
    const [m] = await api.q("SELECT version FROM shifts WHERE id = 'tarde'");
    const busy = await api.call('admin', 'DELETE', '/api/shifts/tarde', undefined, ifMatch(m.version));
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().message, 'El turno tiene técnicos.');
    assert.equal((await api.call('admin', 'DELETE', `/api/shifts/${s.id}`, undefined, ifMatch(s.version))).statusCode, 409);
    assert.equal((await api.call('admin', 'DELETE', `/api/shifts/${s.id}`, undefined, ifMatch(s.version + 1))).statusCode, 200);
    assert.equal((await api.q('SELECT 1 FROM shifts WHERE id = $1', [s.id])).length, 0);
  });

  test('categorías: única, no se borra con herramientas', async () => {
    const r = await api.call('admin', 'POST', '/api/categories', { name: 'Neumáticas' });
    assert.equal(r.statusCode, 201);
    assert.equal((await api.call('admin', 'POST', '/api/categories', { name: 'neumáticas' })).json().message, 'Ya existe esa categoría.');
    const [c] = await api.q("SELECT version FROM categories WHERE id = 'cat-manuales'");
    const busy = await api.call('admin', 'DELETE', '/api/categories/cat-manuales', undefined, ifMatch(c.version));
    assert.equal(busy.json().message, 'La categoría tiene herramientas.');
    const g = r.json().category;
    assert.equal((await api.call('admin', 'DELETE', `/api/categories/${g.id}`, undefined, ifMatch(g.version))).statusCode, 200);
  });

  test('herramientas: alta con stock o códigos iniciales (ingreso en el libro), seguimiento fijo con movimientos', async () => {
    const qty = await api.call('admin', 'POST', '/api/tools', { name: 'Martillo', categoryId: 'cat-manuales', stock: 7 });
    assert.equal(qty.statusCode, 201);
    const ser = await api.call('admin', 'POST', '/api/tools', { name: 'Amoladora', serialized: true, codes: 'AMO-1\nAMO-2' });
    assert.equal(ser.statusCode, 201);
    const inv = (await api.call('consulta', 'GET', '/api/inventory')).json();
    assert.equal(inv.pools[qty.json().tool.id].disponible, 7);
    assert.equal(inv.pools[ser.json().tool.id].disponible, 2);
    assert.equal((await api.call('admin', 'POST', '/api/tools', { name: 'martillo' })).statusCode, 409);
    const dupCode = await api.call('admin', 'POST', '/api/tools', { name: 'Sierra', serialized: true, codes: 'amo-1' });
    assert.equal(dupCode.statusCode, 422);
    assert.equal(dupCode.json().message, 'El código amo-1 ya existe.');
    assert.equal((await api.q("SELECT 1 FROM tools WHERE name = 'Sierra'")).length, 0, 'la transacción se deshace entera');
    const t = qty.json().tool;
    const fixed = await api.call('admin', 'PATCH', `/api/tools/${t.id}`, { serialized: true }, ifMatch(t.version));
    assert.equal(fixed.statusCode, 409);
    const off = await api.call('admin', 'PATCH', `/api/tools/${t.id}`, { active: false, description: 'Mango de madera' }, ifMatch(t.version));
    assert.equal(off.json().tool.active, false);
    assert.equal((await audits('tool_toggle')).length, 1);
    assert.equal((await audits('tool_edit')).length, 1);
  });

  test('unidades: corregir el código, único sin distinguir mayúsculas', async () => {
    const [u] = await api.q("SELECT id, version FROM units WHERE code = 'MUL-003'");
    const dup = await api.call('admin', 'PATCH', `/api/units/${u.id}`, { code: 'mul-001' }, ifMatch(u.version));
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().message, 'El código mul-001 ya existe.');
    const ok = await api.call('admin', 'PATCH', `/api/units/${u.id}`, { code: 'MUL-099' }, ifMatch(u.version));
    assert.equal(ok.json().unit.code, 'MUL-099');
    assert.equal((await api.call('responsable', 'PATCH', `/api/units/${u.id}`, { code: 'MUL-100' }, ifMatch(u.version + 1))).statusCode, 403);
  });
});
