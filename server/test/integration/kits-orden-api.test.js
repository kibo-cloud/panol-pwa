// Etapa 3: especialidades (catálogo y campo del técnico, filtro y columna del informe), kits
// (base y por especialidad) con "Entregar kit" en un paso (un movimiento por herramienta, todo o
// nada), orden personalizado de categorías y herramientas (reordenar con If-Match por alcance,
// insertar en posición) y el .txt v2 sin estos datos.
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
const state = async (u = 'admin') => (await api.call(u, 'GET', '/api/state')).json();
const pools = async (toolId) => (await api.call('admin', 'GET', '/api/inventory')).json().pools[toolId];
const count = async (sql, p) => (await api.q(sql, p))[0].n;

describe('especialidades', () => {
  test('migración: 9 especialidades por defecto y el kit base vacío', async () => {
    const r = (await api.call('consulta', 'GET', '/api/especialidades')).json().especialidades;
    assert.deepEqual(r.map((e) => e.name), ['Mecánico', 'Electricista', 'Electro-mecánico', 'Refrigeración', 'Soldador', 'Edilicio', 'Servicios Generales', 'Ingeniería', 'Pañolero']);
    const kits = (await api.call('consulta', 'GET', '/api/kits')).json().kits;
    assert.deepEqual(kits.map((k) => [k.id, k.especialidadId, k.items.length]), [['kit-base', null, 0]]);
  });

  test('catálogo: techs_edit, nombre único, If-Match y baja lógica solo sin técnicos activos', async () => {
    for (const u of ['responsable', 'consulta', 'gerencia', 'supervisor']) assert.equal((await api.call(u, 'POST', '/api/especialidades', { name: 'Hidráulica' })).statusCode, 403, u);
    const c = await api.call('admin', 'POST', '/api/especialidades', { name: 'Hidráulica' });
    assert.equal(c.statusCode, 201);
    const e = c.json().especialidad;
    assert.equal((await api.call('admin', 'POST', '/api/especialidades', { name: 'hidráulica' })).statusCode, 409);
    assert.equal((await api.call('admin', 'PATCH', `/api/especialidades/${e.id}`, { name: 'Neumática' })).statusCode, 428);
    const ren = await api.call('admin', 'PATCH', `/api/especialidades/${e.id}`, { name: 'Neumática' }, ifMatch(e.version));
    assert.equal(ren.statusCode, 200);
    assert.equal((await api.call('admin', 'PATCH', `/api/especialidades/${e.id}`, { name: 'Otra' }, ifMatch(e.version))).statusCode, 409);
    // El técnico la usa: no se archiva.
    const t = (await api.q("SELECT version FROM techs WHERE id = 't-carla'"))[0];
    const set = await api.call('admin', 'PATCH', '/api/techs/t-carla', { especialidadId: e.id }, ifMatch(t.version));
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().tech.especialidadId, e.id);
    const v = ren.json().especialidad.version;
    const busy = await api.call('admin', 'POST', `/api/especialidades/${e.id}/archive`, undefined, ifMatch(v));
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().error, 'especialidad_in_use');
    const clear = await api.call('admin', 'PATCH', '/api/techs/t-carla', { especialidadId: null }, ifMatch(set.json().tech.version));
    assert.equal(clear.json().tech.especialidadId, null);
    const arch = await api.call('admin', 'POST', `/api/especialidades/${e.id}/archive`, undefined, ifMatch(v));
    assert.equal(arch.statusCode, 200);
    assert.ok(arch.json().especialidad.archivedAt);
    // Una especialidad archivada no se asigna.
    const bad = await api.call('admin', 'PATCH', '/api/techs/t-carla', { especialidadId: e.id }, ifMatch(clear.json().tech.version));
    assert.equal(bad.statusCode, 422);
  });

  test('técnico nuevo con especialidad; informe con filtro y columna', async () => {
    const r = await api.call('admin', 'POST', '/api/techs', { name: 'Eva Eléctrica', legajo: 'ESP-1', plantillaId: 'manana', especialidadId: 'esp-electricista' });
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().tech.especialidadId, 'esp-electricista');
    assert.equal((await api.call('admin', 'POST', '/api/techs', { name: 'Nadie Nada', legajo: 'ESP-2', especialidadId: 'no-existe' })).statusCode, 422);
    const st = await state('consulta');
    assert.equal(st.techs[r.json().tech.id].especialidadId, 'esp-electricista');
    assert.equal(st.especialidades['esp-mecanico'].name, 'Mecánico');
    const rep = (await api.call('consulta', 'GET', '/api/reports?especialidad=esp-electricista')).json();
    assert.deepEqual(rep.rows.map((x) => [x.name, x.especialidad]), [['Eva Eléctrica', 'Electricista']]);
    assert.match(rep.label, /Electricista/);
    const none = (await api.call('consulta', 'GET', '/api/reports?especialidad=none')).json();
    assert.ok(none.rows.length >= 3 && none.rows.every((x) => x.especialidadId === null && x.especialidad === ''));
  });
});

describe('orden personalizado', () => {
  test('sin posición, cada alta va al final (la semilla carga después de la migración); versiones en /api/state', async () => {
    const st = await state();
    const cats = Object.entries(st.categories).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
    assert.deepEqual(cats, ['cat-manuales', 'cat-electricas', 'cat-medicion']);
    assert.deepEqual([st.tools['tool-pinza'].order, st.tools['tool-destornillador'].order], [1, 2]);
    assert.equal(st.orderVersions.categories, 1);
    assert.equal(st.orderVersions['tools:cat-manuales'], 1);
    assert.equal(st.orderVersions['tools:'], 1);
  });

  test('reordenar categorías: tools_edit, If-Match del alcance, lista completa, 409 al concurrente', async () => {
    const ids = ['cat-medicion', 'cat-manuales', 'cat-electricas'];
    assert.equal((await api.call('responsable', 'PUT', '/api/categories/order', { ids }, ifMatch(1))).statusCode, 403);
    assert.equal((await api.call('admin', 'PUT', '/api/categories/order', { ids })).statusCode, 428);
    const before = (await api.q("SELECT version FROM categories WHERE id = 'cat-medicion'"))[0].version;
    const r = await api.call('admin', 'PUT', '/api/categories/order', { ids }, ifMatch(1));
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { scope: 'categories', ids, version: 2 });
    assert.equal(r.headers.etag, '"2"');
    // Solo cambió el orden: la versión de la categoría queda igual (nadie ve un conflicto al editarla).
    assert.equal((await api.q("SELECT version FROM categories WHERE id = 'cat-medicion'"))[0].version, before);
    // La otra sesión todavía tiene la versión 1.
    const stale = await api.call('admin', 'PUT', '/api/categories/order', { ids: ids.slice().reverse() }, ifMatch(1));
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json().current, { scope: 'categories', ids, version: 2 });
    const partial = await api.call('admin', 'PUT', '/api/categories/order', { ids: ids.slice(1) }, ifMatch(2));
    assert.equal(partial.statusCode, 409);
    assert.equal(partial.json().error, 'order_changed');
    assert.equal((await api.call('admin', 'PUT', '/api/categories/order', { ids: [ids[0], ids[0], ids[1]] }, ifMatch(2))).statusCode, 422);
    // Una categoría nueva va al final y sube la versión del alcance.
    const g = (await api.call('admin', 'POST', '/api/categories', { name: 'Seguridad' })).json().category;
    assert.equal(g.order, 4);
    assert.equal((await state()).orderVersions.categories, 3);
  });

  test('reordenar herramientas de una categoría y "sin categoría"; insertar en posición', async () => {
    const r = await api.call('admin', 'PUT', '/api/tools/order', { categoryId: 'cat-manuales', ids: ['tool-pinza', 'tool-destornillador'] }, ifMatch(1));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await api.call('admin', 'PUT', '/api/tools/order', { categoryId: 'cat-manuales', ids: ['tool-destornillador', 'tool-pinza'] }, ifMatch(1))).statusCode, 409);
    assert.equal((await api.call('admin', 'PUT', '/api/tools/order', { categoryId: 'nada', ids: [] }, ifMatch(1))).statusCode, 422);
    // Insertar en la posición 2: queda entre la pinza y el destornillador.
    const t = await api.call('admin', 'POST', '/api/tools', { name: 'Llave francesa', categoryId: 'cat-manuales', position: 2, stock: 3 });
    assert.equal(t.statusCode, 201, t.body);
    const ord = (await api.q("SELECT id FROM tools WHERE category_id = 'cat-manuales' ORDER BY sort_order")).map((x) => x.id);
    assert.deepEqual(ord, ['tool-pinza', t.json().tool.id, 'tool-destornillador']);
    assert.equal(t.json().tool.order, 2);
    assert.equal((await state()).orderVersions['tools:cat-manuales'], 3);
    // Sin categoría: alcance propio.
    const loose = (await api.call('admin', 'POST', '/api/tools', { name: 'Cinta métrica' })).json().tool;
    const loose2 = (await api.call('admin', 'POST', '/api/tools', { name: 'Linterna', position: 1 })).json().tool;
    const r2 = await api.call('admin', 'PUT', '/api/tools/order', { categoryId: null, ids: [loose.id, loose2.id] }, ifMatch(3));
    assert.equal(r2.statusCode, 200, r2.body);
    // Cambiar de categoría: va al final de la nueva y sube la versión de los dos alcances.
    const v = (await api.q('SELECT version FROM tools WHERE id = $1', [loose.id]))[0].version;
    const mv = await api.call('admin', 'PATCH', `/api/tools/${loose.id}`, { categoryId: 'cat-manuales' }, ifMatch(v));
    assert.equal(mv.statusCode, 200, mv.body);
    assert.equal(mv.json().tool.order, 4);
    const st = await state();
    assert.equal(st.orderVersions['tools:cat-manuales'], 4);
    assert.equal(st.orderVersions['tools:'], 5);
  });

  test('el orden se aplica en el informe (herramientas) y en la ficha del técnico', async () => {
    const rep = (await api.call('consulta', 'GET', '/api/reports')).json();
    const names = rep.tools.map((x) => x.name);
    // Categorías: medición, manuales, eléctricas; en manuales la pinza antes que el destornillador.
    assert.ok(names.indexOf('Multímetro digital') < names.indexOf('Pinza universal'));
    assert.ok(names.indexOf('Pinza universal') < names.indexOf('Destornillador plano'));
    assert.ok(names.indexOf('Destornillador plano') < names.indexOf('Taladro percutor'));
    const pinza = rep.tools.find((x) => x.id === 'tool-pinza');
    assert.equal(pinza.total, 3);
  });
});

describe('kits', () => {
  let kitElec;
  test('kit base: kits_edit, If-Match, lista ordenada con cantidades', async () => {
    const k = (await api.call('admin', 'GET', '/api/kits')).json().kits[0];
    const items = [{ toolId: 'tool-destornillador', qty: 2 }, { toolId: 'tool-pinza', qty: 1 }];
    for (const u of ['responsable', 'supervisor', 'consulta', 'gerencia']) assert.equal((await api.call(u, 'PUT', '/api/kits/kit-base', { items }, ifMatch(k.version))).statusCode, 403, u);
    assert.equal((await api.call('admin', 'PUT', '/api/kits/kit-base', { items })).statusCode, 428);
    const r = await api.call('admin', 'PUT', '/api/kits/kit-base', { items }, ifMatch(k.version));
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().kit.items, items);
    assert.equal(r.json().kit.version, k.version + 1);
    assert.equal((await api.call('admin', 'PUT', '/api/kits/kit-base', { items: [] }, ifMatch(k.version))).statusCode, 409);
    assert.equal((await api.call('admin', 'PUT', '/api/kits/kit-base', { items: [items[0], items[0]] }, ifMatch(k.version + 1))).statusCode, 422);
    assert.equal((await api.call('admin', 'PUT', '/api/kits/kit-base', { items: [{ toolId: 'tool-pinza', qty: 0 }] }, ifMatch(k.version + 1))).statusCode, 400);
    assert.equal((await api.call('admin', 'DELETE', '/api/kits/kit-base', undefined, ifMatch(k.version + 1))).statusCode, 409);
    assert.deepEqual((await state()).kits['kit-base'].items, items);
  });

  test('kit por especialidad: uno por especialidad, se puede eliminar', async () => {
    const r = await api.call('admin', 'POST', '/api/kits', { especialidadId: 'esp-electricista' });
    assert.equal(r.statusCode, 201);
    kitElec = r.json().kit;
    assert.equal(kitElec.name, 'Kit Electricista');
    assert.equal((await api.call('admin', 'POST', '/api/kits', { especialidadId: 'esp-electricista' })).statusCode, 409);
    const tmp = (await api.call('admin', 'POST', '/api/kits', { especialidadId: 'esp-soldador' })).json().kit;
    assert.equal((await api.call('admin', 'DELETE', `/api/kits/${tmp.id}`, undefined, ifMatch(tmp.version))).statusCode, 200);
    const up = await api.call('admin', 'PUT', `/api/kits/${kitElec.id}`, { items: [{ toolId: 'tool-pinza', qty: 1 }, { toolId: 'tool-taladro', qty: 1 }] }, ifMatch(kitElec.version));
    assert.equal(up.statusCode, 200);
    kitElec = up.json().kit;
  });

  test('entregar kit: un movimiento por herramienta en un paso (inicial o adicional), idempotente', async () => {
    const tech = (await api.call('admin', 'POST', '/api/techs', { name: 'Kit Nuevo', legajo: 'KIT-1', plantillaId: 'manana' })).json().tech;
    const before = await pools('tool-destornillador');
    const key = 'kit-deliver-0001';
    const body = { holder: { techId: tech.id } };
    // El responsable entrega kits (movements_do); consulta no.
    assert.equal((await api.call('consulta', 'POST', '/api/kits/kit-base/deliver', body)).statusCode, 403);
    const r = await api.call('responsable', 'POST', '/api/kits/kit-base/deliver', body, { 'idempotency-key': key });
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual(r.json().movements.map((m) => [m.type, m.toolId, m.qty, m.reason]), [['entrega_inicial', 'tool-destornillador', 2, 'Entrega del kit Kit base'], ['entrega_inicial', 'tool-pinza', 1, 'Entrega del kit Kit base']]);
    assert.equal((await pools('tool-destornillador')).disponible, before.disponible - 2);
    const again = await api.call('responsable', 'POST', '/api/kits/kit-base/deliver', body, { 'idempotency-key': key });
    assert.equal(again.statusCode, 201);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(await count('SELECT count(*)::int AS n FROM movements WHERE tech_id = $1', [tech.id]), 2);
    // Segunda vez: adicionales.
    const r2 = await api.call('responsable', 'POST', '/api/kits/kit-base/deliver', body);
    assert.deepEqual(r2.json().movements.map((m) => m.type), ['adicional', 'adicional']);
    assert.match((await api.q("SELECT detail FROM audit_log WHERE action = 'kit_deliver' ORDER BY at DESC LIMIT 1"))[0].detail, /Entrega del kit Kit base a Kit Nuevo: 2 herramientas, 2 movimientos/);
    // Con la versión vieja del kit (If-Match): 409.
    assert.equal((await api.call('responsable', 'POST', `/api/kits/${kitElec.id}/deliver`, body, ifMatch(kitElec.version - 1))).statusCode, 409);
    // Herramienta por código: unidad elegida.
    const units = await api.q("SELECT id FROM units WHERE tool_id = 'tool-taladro' AND status = 'disponible' ORDER BY code");
    const r3 = await api.call('responsable', 'POST', `/api/kits/${kitElec.id}/deliver`, { ...body, unitIds: { 'tool-taladro': [units[0].id] } }, ifMatch(kitElec.version));
    assert.equal(r3.statusCode, 201, r3.body);
    assert.deepEqual(r3.json().movements.map((m) => [m.type, m.toolId, m.unitId]), [['adicional', 'tool-pinza', null], ['entrega_inicial', 'tool-taladro', units[0].id]]);
  });

  test('entregar kit sin stock suficiente: no se escribe nada y cada herramienta queda nombrada', async () => {
    const tech = (await api.call('admin', 'POST', '/api/techs', { name: 'Kit Corto', legajo: 'KIT-2', plantillaId: 'manana' })).json().tech;
    const k = (await state()).kits['kit-base'];
    const disp = (await pools('tool-pinza')).disponible;
    await api.call('admin', 'PUT', '/api/kits/kit-base', { items: [{ toolId: 'tool-destornillador', qty: 1 }, { toolId: 'tool-pinza', qty: disp + 1 }, { toolId: 'tool-taladro', qty: 5 }] }, ifMatch(k.version));
    const movs = await count('SELECT count(*)::int AS n FROM movements');
    const audits = await count('SELECT count(*)::int AS n FROM audit_log');
    const r = await api.call('responsable', 'POST', '/api/kits/kit-base/deliver', { holder: { techId: tech.id } });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error, 'kit_stock');
    assert.match(r.json().message, /^No se entregó nada\./);
    assert.deepEqual(r.json().problems.map((p) => p.toolId), ['tool-pinza', 'tool-taladro']);
    assert.match(r.json().problems[0].message, new RegExp(`Pinza universal: se necesitan ${disp + 1} y hay ${disp} disponibles`));
    assert.equal(await count('SELECT count(*)::int AS n FROM movements'), movs);
    assert.equal(await count('SELECT count(*)::int AS n FROM audit_log'), audits);
    assert.equal(await count('SELECT count(*)::int AS n FROM assignments WHERE tech_id = $1', [tech.id]), 0);
  });

  test('entregar kit a una caja compartida', async () => {
    const linea = (await api.call('admin', 'POST', '/api/lineas', { name: 'Línea Kits', kind: 'linea' })).json().linea;
    const caja = (await api.call('admin', 'POST', '/api/cajas', { name: 'Caja Kits', lineaId: linea.id })).json().caja;
    const k = (await state()).kits['kit-base'];
    await api.call('admin', 'PUT', '/api/kits/kit-base', { items: [{ toolId: 'tool-destornillador', qty: 1 }] }, ifMatch(k.version));
    const r = await api.call('responsable', 'POST', '/api/kits/kit-base/deliver', { holder: { cajaId: caja.id } });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().movements[0].cajaId, caja.id);
  });
});

describe('.txt v2', () => {
  test('la exportación no lleva especialidad ni orden; exportar e importar = 0 cambios y el orden se conserva', async () => {
    const e = await api.call('admin', 'GET', '/api/export/txt');
    assert.equal(e.statusCode, 200);
    const p = JSON.parse(e.body.slice(HEAD.length));
    assert.ok(Object.values(p.data.techs).every((t) => !('especialidadId' in t)));
    assert.ok(Object.values(p.data.tools).every((t) => !('order' in t)));
    assert.ok(Object.values(p.data.categories).every((t) => !('order' in t)));
    assert.ok(!('kits' in p.data) && !('especialidades' in p.data));
    const before = await api.q('SELECT id, sort_order FROM tools ORDER BY id');
    const dry = await api.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', toTxt(p), { 'content-type': 'text/plain' });
    assert.equal(dry.statusCode, 200, dry.body);
    assert.equal(dry.json().totalChanges, 0, JSON.stringify(dry.json().counts));
    // Una herramienta nueva en el archivo entra al final de su categoría.
    p.data.tools['h-txt-nueva'] = { name: 'Martillo importado', categoryId: 'cat-manuales', serialized: false, active: true, updatedAt: new Date().toISOString() };
    const rep = (await api.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', toTxt(p), { 'content-type': 'text/plain' })).json();
    assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
    const ap = await api.call('admin', 'POST', `/api/import/txt?mode=merge&token=${encodeURIComponent(rep.token)}`, toTxt(p), { 'content-type': 'text/plain' });
    assert.equal(ap.statusCode, 200, ap.body);
    const max = (await api.q("SELECT max(sort_order) AS m FROM tools WHERE category_id = 'cat-manuales' AND id <> 'h-txt-nueva'"))[0].m;
    assert.equal((await api.q("SELECT sort_order FROM tools WHERE id = 'h-txt-nueva'"))[0].sort_order, max + 1);
    const after = await api.q('SELECT id, sort_order FROM tools WHERE id <> $1 ORDER BY id', ['h-txt-nueva']);
    assert.deepEqual(after, before);
  });
});
