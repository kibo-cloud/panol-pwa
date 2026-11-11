// Importador del Excel anterior (E9.T2): vista previa sin escribir, confirmación en una
// transacción atada al hash del archivo y a la versión del plan, decisiones por caso,
// conflictos, re-importación rechazada, marcas de importación, sin compras automáticas y
// auditoría con cantidades. Libros inventados (test/fixtures/excel.js).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi } from './api.js';
import { buildWorkbook, sampleSpec } from '../fixtures/excel.js';
import { MISSING_NOTE } from '../../src/importers/excel-v1/index.js';
import { periodOf } from '../../src/domain/period.js';

let api;
const b64 = (buf) => Buffer.from(buf).toString('base64');
const preview = (user, buf, extra = {}) => api.call(user, 'POST', '/api/import/excel/preview', { fileName: 'herramientas.xlsm', file: b64(buf), ...extra });
const confirm = (user, buf, extra = {}) => api.call(user, 'POST', '/api/import/excel/confirm', { fileName: 'herramientas.xlsm', file: b64(buf), ...extra });
const count = async (table, where = 'true', params = []) => (await api.q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n;
const LEDGER = ['techs', 'tools', 'movements', 'controls', 'novedades', 'kit_items', 'audit_log', 'purchase_requests', 'import_batches'];
const snapshot = async () => Object.fromEntries(await Promise.all(LEDGER.map(async (t) => [t, await count(t)])));

// Ejemplo + un legajo del servidor con historial (DEV-001) y uno inactivo (DEV-004).
function spec() {
  const s = sampleSpec();
  s.techs.push({ legajo: 'DEV-001', name: 'Ana del Excel', especialidad: 'Mecánico' }, { legajo: 'DEV-004', name: 'Darío del Excel', especialidad: '' });
  s.sheets['DEV-001'] = { blocks: [{ date: '2025-10-01', cells: { Alicate: { e: 1, c: 1 } } }] };
  return s;
}

before(async () => {
  api = await setupApi({ env: { APP_ORIGIN: 'http://localhost' } });
});
after(async () => {
  await api?.close();
});

describe('permisos y archivo', () => {
  test('solo con import_excel (admin por defecto); un override lo habilita', async () => {
    const buf = buildWorkbook(sampleSpec());
    for (const u of ['responsable', 'supervisor', 'gerencia', 'consulta']) assert.equal((await preview(u, buf)).statusCode, 403, u);
    assert.equal((await api.call(null, 'POST', '/api/import/excel/preview', { fileName: 'x.xlsx', file: b64(buf) })).statusCode, 401);
    await api.q("INSERT INTO role_permissions (role, perm, allowed) VALUES ('responsable', 'import_excel', true)");
    assert.equal((await preview('responsable', buf)).statusCode, 200);
    await api.q("DELETE FROM role_permissions WHERE role = 'responsable' AND perm = 'import_excel'");
  });
  test('archivo que no es un libro, base64 inválido o nombre sin extensión de Excel', async () => {
    let r = await preview('admin', Buffer.from('esto no es un excel'));
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error, 'invalid_workbook');
    r = await api.call('admin', 'POST', '/api/import/excel/preview', { fileName: 'x.xlsx', file: '***' });
    assert.equal(r.statusCode, 400);
    r = await preview('admin', buildWorkbook(sampleSpec()), { fileName: 'datos.txt' });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().error, 'invalid_file_name');
    r = await api.call('admin', 'POST', '/api/import/excel/preview', { fileName: 'x.xlsx', file: b64(buildWorkbook(sampleSpec())), extra: 1 });
    assert.equal(r.statusCode, 400);
  });
  test('libro sin el formato del Excel de herramientas: informe con error y no se puede confirmar', async () => {
    const buf = buildWorkbook({ tools: ['Alicate'], resumen: false, blanco: false, sheets: {}, extra: { Hoja1: [[0, 0, 'x']] } });
    const r = await preview('admin', buf);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().canApply, false);
    const c = await confirm('admin', buf, { token: r.json().token });
    assert.equal(c.statusCode, 422);
  });
});

describe('vista previa y confirmación', () => {
  const buf = buildWorkbook(spec());
  let rep;

  test('la vista previa no escribe nada y lista los casos con su token', async () => {
    const before0 = await snapshot();
    const r = await preview('admin', buf);
    assert.equal(r.statusCode, 200, r.body);
    rep = r.json();
    assert.deepEqual(await snapshot(), before0);
    assert.equal(rep.canApply, true);
    assert.match(rep.token, /^[0-9a-f]{64}$/);
    assert.match(rep.fileHash, /^[0-9a-f]{64}$/);
    const types = rep.caseCounts;
    assert.equal(types.conflicto, 2);
    assert.equal(types.tecnico_nuevo, 3);
    assert.equal(types.ajuste, 1);
    assert.equal(types.semana_duplicada, 1);
    assert.equal(types.devolucion, 1);
    assert.equal(types.devolucion_05, 1);
    assert.equal(types.novedad_sin_tecnico, 1);
    // Destornillador Plano coincide con "Destornillador plano" del servidor.
    assert.equal(rep.totals.toolsMatched, 1);
    assert.equal(rep.totals.toolsCreate, 4);
    const again = (await preview('admin', buf)).json();
    assert.equal(again.token, rep.token);
  });

  test('confirmar con un token viejo (el servidor cambió) pide volver a previsualizar', async () => {
    const t = await api.call('admin', 'POST', '/api/techs', { name: 'Caja de otro lado', legajo: '9103' });
    assert.equal(t.statusCode, 201, t.body);
    const r = await confirm('admin', buf, { token: rep.token });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'import_changed');
    assert.match(r.json().message, /previsualiz/i);
    assert.equal(await count('import_batches'), 0);
    // Con la vista previa nueva, el 9103 existe sin historial: recibe los datos.
    rep = (await preview('admin', buf)).json();
    assert.equal(rep.caseCounts.tecnico_existente, 1);
  });

  test('decisiones: omitir un caso cambia el plan y su token; una decisión que no nombra un caso se informa', async () => {
    const r = await preview('admin', buf, { decisions: { 'herr:t2': 'skip', 'nada:x': 'skip' } });
    assert.equal(r.statusCode, 200);
    const p = r.json();
    assert.notEqual(p.token, rep.token);
    assert.deepEqual(p.effectiveDecisions, { 'herr:t2': 'skip' });
    assert.deepEqual(p.staleDecisions, ['nada:x']);
    assert.equal(p.totals.toolsCreate, 3);
    // El token de una decisión no sirve para otra.
    const c = await confirm('admin', buf, { token: p.token });
    assert.equal(c.statusCode, 409);
    rep = p;
  });

  test('confirmar aplica todo en una transacción con las marcas de importación', async () => {
    const before0 = await snapshot();
    const r = await confirm('admin', buf, { token: rep.token, decisions: { 'herr:t2': 'skip', 'nada:x': 'skip' } });
    assert.equal(r.statusCode, 200, r.body);
    const out = r.json();
    assert.equal(out.applied, true);
    const batch = (await api.q('SELECT * FROM import_batches'))[0];
    assert.equal(batch.id, out.batch.id);
    assert.equal(batch.file_hash, rep.fileHash);
    assert.equal(batch.created_by, 'u-admin');
    // Técnicos nuevos sin plantilla, con la marca; el existente no se toca.
    const techs = await api.q('SELECT legajo, name, especialidad_id, import_batch_id FROM techs WHERE legajo IN ($1, $2, $3) ORDER BY legajo', ['9101', '9102', '9103']);
    assert.deepEqual(techs.map((t) => [t.legajo, t.import_batch_id]), [['9101', batch.id], ['9102', batch.id], ['9103', null]]);
    assert.equal(await count('tech_plantilla_history', "tech_id IN (SELECT id FROM techs WHERE legajo IN ('9101', '9102'))"), 0);
    // Herramientas nuevas al final del orden, en el orden del Excel; Martillo omitida.
    const tools = await api.q('SELECT name FROM tools WHERE import_batch_id = $1 ORDER BY sort_order', [batch.id]);
    assert.deepEqual(tools.map((t) => t.name), ['Alicate', 'Pinza', 'Cinta Métrica']);
    // Kit base = BLANCO sin la omitida.
    const kit = await api.q('SELECT t.name, ki.qty FROM kit_items ki JOIN kits k ON k.id = ki.kit_id JOIN tools t ON t.id = ki.tool_id WHERE k.especialidad_id IS NULL ORDER BY ki.sort_order');
    assert.deepEqual(kit.map((k) => k.name), ['Alicate', 'Pinza', 'Destornillador plano', 'Cinta Métrica']);
    // Movimientos y controles importados, con su fecha.
    assert.equal(await count('movements', 'import_batch_id = $1 AND imported', [batch.id]), (await snapshot()).movements - before0.movements);
    const ctls = await api.q("SELECT c.*, t.legajo FROM controls c JOIN techs t ON t.id = c.tech_id WHERE c.import_batch_id = $1 ORDER BY c.finished_at", [batch.id]);
    assert.ok(ctls.every((c) => c.status === 'finalizado' && c.imported && c.cleaning_status === null && c.plantilla_id_snapshot === null));
    const ana = ctls.filter((c) => c.legajo === '9101');
    assert.deepEqual(ana.map((c) => [c.period_m, c.period_w, c.correction]), [[10, 1, false], [10, 3, false], [10, 3, true]]);
    assert.equal(ana[2].supersedes_id, ana[1].id);
    const fal = await api.q("SELECT note, qty_missing FROM control_items WHERE control_id = $1 AND qty_missing > 0", [ana[2].id]);
    assert.equal(fal.length, 0, 'Martillo se omitió: no hay faltante');
    const rec = await api.q('SELECT qty_change FROM control_items WHERE control_id = $1 AND qty_change > 0', [ana[2].id]);
    assert.equal(rec.length, 1);
    // Un ítem por herramienta asignada, cada uno con su herramienta.
    const its = await api.q('SELECT tool_name, qty_good, qty_change FROM control_items WHERE control_id = $1 ORDER BY tool_name', [ana[2].id]);
    assert.deepEqual(its.map((i) => [i.tool_name, i.qty_good, i.qty_change]), [['Alicate', 1, 0], ['Pinza', 0, 1]]);
    // Beto: devolución de Alicate a disponible y Cinta Métrica para recambio.
    const dev = await api.q("SELECT condition FROM movements WHERE import_batch_id = $1 AND type = 'devolucion'", [batch.id]);
    assert.deepEqual(dev.map((m) => m.condition), ['disponible']);
    // Novedades con fecha y hora de la hoja, autor = quien importa, marca de importación.
    const nov = await api.q('SELECT occurred_at, author_id, tech_id, comment FROM novedades WHERE import_batch_id = $1 ORDER BY occurred_at', [batch.id]);
    assert.equal(nov.length, 2);
    assert.equal(nov[0].occurred_at.toISOString(), '2025-10-15T15:00:00.000Z');
    assert.ok(nov.every((n) => n.author_id === 'u-admin'));
    assert.match(nov[1].comment, /^\[Legajo 7777\] /);
    // Nada para los legajos en conflicto.
    assert.equal(await count('controls', "tech_id IN (SELECT id FROM techs WHERE legajo IN ('DEV-001', 'DEV-004')) AND import_batch_id IS NOT NULL"), 0);
    // Sin solicitudes de compra automáticas por los controles importados.
    assert.equal((await snapshot()).purchase_requests, before0.purchase_requests);
    // Auditoría del lote solo con cantidades.
    const aud = await api.q("SELECT detail FROM audit_log WHERE action = 'import_excel'");
    assert.equal(aud.length, 1);
    assert.doesNotMatch(aud[0].detail, /Ana|Beto|Alicate|herramientas\.xlsm/);
    assert.match(aud[0].detail, /\d+ controles/);
  });

  test('el estado, la existencia y el inventario usan lo importado', async () => {
    const st = (await api.call('admin', 'GET', '/api/state')).json();
    const ana = Object.entries(st.techs).find(([, t]) => t.legajo === '9101')[0];
    const ctl = Object.values(st.controls).filter((c) => c.techId === ana);
    assert.ok(ctl.every((c) => c.importBatchId));
    const mv = Object.values(st.movements).filter((m) => m.techId === ana);
    assert.ok(mv.length && mv.every((m) => m.importBatchId));
    // Integridad: lo asignado del inventario coincide con las asignaciones activas.
    const asg = Object.values(st.assignments).filter((a) => a.active);
    for (const [toolId, p] of Object.entries(st.derived.pools)) {
      const n = asg.filter((a) => a.toolId === toolId).reduce((s, a) => s + (a.qty || 1), 0);
      assert.equal(p.asignado, n, toolId);
    }
    const ex = (await api.call('admin', 'GET', '/api/existencia?cajas=0')).json();
    const h = ex.holders.find((x) => x.id === ana);
    assert.equal(h.lastControlAt.slice(0, 10), '2025-10-16');
    assert.ok(h.total >= 2);
    // La alerta de faltante de un control importado sale como la de cualquier control efectivo.
    const beto = Object.entries(st.techs).find(([, t]) => t.legajo === '9102')[0];
    assert.ok(st.derived.alerts.some((a) => a.techId === beto && a.type === 'cambio'));
  });

  test('re-importar el mismo archivo se rechaza (vista previa y confirmación)', async () => {
    const p = await preview('admin', buf);
    assert.equal(p.statusCode, 409);
    assert.equal(p.json().error, 'already_imported');
    const c = await confirm('admin', buf, { token: rep.token, decisions: { 'herr:t2': 'skip' } });
    assert.equal(c.statusCode, 409);
    assert.equal(c.json().error, 'already_imported');
    assert.equal(await count('import_batches'), 1);
    const l = await api.call('admin', 'GET', '/api/import/excel/batches');
    assert.equal(l.statusCode, 200);
    assert.equal(l.json().batches.length, 1);
    assert.equal(l.json().batches[0].fileName, 'herramientas.xlsm');
  });

  test('el lote y las marcas no se modifican', async () => {
    await assert.rejects(api.q("UPDATE import_batches SET file_name = 'x.xlsx'"), /solo agregar/);
    await assert.rejects(api.appPool.query('DELETE FROM import_batches'), /permission denied|solo agregar/);
    await assert.rejects(api.q('UPDATE novedades SET import_batch_id = NULL WHERE import_batch_id IS NOT NULL'), /no se modifican/);
  });

  test('un control nuevo hecho en la app sobre lo importado sí crea su solicitud de compra', async () => {
    const st = (await api.call('admin', 'GET', '/api/state')).json();
    const ana = Object.entries(st.techs).find(([, t]) => t.legajo === '9101')[0];
    const asgs = Object.entries(st.assignments).filter(([, a]) => a.active && a.techId === ana).map(([id]) => id);
    const items = Object.fromEntries(asgs.map((id, i) => [id, i === 0 ? { state: 'faltante', note: 'No estaba' } : { state: 'bueno' }]));
    const c = await api.call('responsable', 'POST', '/api/controls', { techId: ana, period: periodOf(new Date()), items, cleaning: { status: 'limpio' } }, { 'idempotency-key': 'k-excel-ctl-1' });
    assert.equal(c.statusCode, 201, c.body);
    const f = await api.call('responsable', 'POST', `/api/controls/${c.json().control.id}/finalize`, {}, { 'idempotency-key': 'k-excel-fin-1', 'if-match': `"${c.json().control.version}"` });
    assert.equal(f.statusCode, 200, f.body);
    assert.equal(await count('purchase_requests', 'assignment_id = $1', [asgs[0]]), 1);
  });
});

describe('otros casos', () => {
  test('un técnico existente sin historial recibe los datos con la foto de su plantilla', async () => {
    const t = await api.call('admin', 'POST', '/api/techs', { name: 'Fede Existente', legajo: '9301', plantillaId: 'manana' });
    assert.equal(t.statusCode, 201, t.body);
    const buf = buildWorkbook({ tools: ['Nivel'], techs: [{ legajo: 9301, name: 'Otro Nombre' }], sheets: { 9301: { blocks: [{ date: '2025-10-01', cells: { Nivel: { e: 1, c: 1 } } }] } } });
    const p = (await preview('admin', buf)).json();
    assert.equal(p.caseCounts.tecnico_existente, 1);
    const r = await confirm('admin', buf, { token: p.token });
    assert.equal(r.statusCode, 200, r.body);
    const tech = (await api.q("SELECT id, name, import_batch_id FROM techs WHERE legajo = '9301'"))[0];
    assert.deepEqual([tech.name, tech.import_batch_id], ['Fede Existente', null]);
    const ctl = await api.q('SELECT plantilla_id_snapshot FROM controls WHERE tech_id = $1', [tech.id]);
    assert.deepEqual(ctl.map((c) => c.plantilla_id_snapshot), ['manana']);
  });
  test('dos confirmaciones a la vez del mismo archivo: una sola se aplica', async () => {
    const buf = buildWorkbook({ tools: ['Serrucho'], techs: [{ legajo: 9401, name: 'Gina Inventada' }], sheets: { 9401: { blocks: [{ date: '2025-10-01', cells: { Serrucho: { e: 1, c: 1 } } }] } } });
    const p = (await preview('admin', buf)).json();
    const rs = await Promise.all([confirm('admin', buf, { token: p.token }), confirm('admin', buf, { token: p.token })]);
    assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(await count('techs', "legajo = '9401'"), 1);
  });
});

describe('nota de faltante', () => {
  test('un conteo 0 de una herramienta asignada queda faltante con la nota del Excel', async () => {
    const buf = buildWorkbook({ tools: ['Llave Francesa'], techs: [{ legajo: 9201, name: 'Eva Inventada' }], sheets: { 9201: { blocks: [{ date: '2025-11-03', cells: { 'Llave Francesa': { c: 0, d: 0 } } }, { date: '2025-10-27', cells: { 'Llave Francesa': { e: 2, c: 2 } } }] } } });
    // El bloque del 3/11 tiene todo en 0: está vacío. Con otra herramienta contada, cuenta.
    const buf2 = buildWorkbook({ tools: ['Llave Francesa', 'Sierra'], techs: [{ legajo: 9202, name: 'Eva Inventada' }], sheets: { 9202: { blocks: [{ date: '2025-11-03', cells: { 'Llave Francesa': { c: 1 }, Sierra: { c: 1 } } }, { date: '2025-10-27', cells: { 'Llave Francesa': { e: 2, c: 2 }, Sierra: { e: 1, c: 1 } } }] } } });
    const p1 = (await preview('admin', buf)).json();
    assert.equal(p1.caseCounts.bloque_vacio, 1);
    const p = (await preview('admin', buf2)).json();
    const r = await confirm('admin', buf2, { token: p.token });
    assert.equal(r.statusCode, 200, r.body);
    const it = await api.q("SELECT ci.note, ci.qty_missing, ci.qty_expected FROM control_items ci JOIN controls c ON c.id = ci.control_id WHERE c.import_batch_id = $1 AND ci.qty_missing > 0", [r.json().batch.id]);
    assert.deepEqual(it.map((x) => [x.note, x.qty_missing, x.qty_expected]), [[MISSING_NOTE, 1, 2]]);
  });
});

// E9.V1: hallazgos de la revisión de la etapa 9.
describe('E9.V1', () => {
  test('dos bloques el mismo día con más de 60 herramientas y una devolución de lo entregado en el primero', async () => {
    const tools = Array.from({ length: 65 }, (_, i) => `Pieza ${String(i).padStart(2, '0')}`);
    const first = Object.fromEntries(tools.map((t) => [t, { e: 1, c: 1 }]));
    const second = Object.fromEntries(tools.map((t, i) => [t, i === 0 ? { d: 1, c: 0 } : { c: 1 }]));
    const buf = buildWorkbook({ tools, techs: [{ legajo: 9501, name: 'Hugo Inventado' }], sheets: { 9501: { blocks: [{ date: '2025-10-08', cells: second }, { date: '2025-10-08', cells: first }] } } });
    const p = (await preview('admin', buf)).json();
    const r = await confirm('admin', buf, { token: p.token });
    assert.equal(r.statusCode, 200, r.body);
    const ctls = await api.q("SELECT c.id, c.correction, (SELECT count(*)::int FROM control_items ci WHERE ci.control_id = c.id) AS n FROM controls c WHERE c.import_batch_id = $1 ORDER BY c.finished_at", [r.json().batch.id]);
    assert.deepEqual(ctls.map((c) => [c.correction, c.n]), [[false, 65], [true, 64]]);
    assert.equal(await count('movements', "import_batch_id = $1 AND type = 'devolucion'", [r.json().batch.id]), 1);
  });
  test('conteo vacío probable: el ítem queda sin dato en ese control (sin faltante ni nota)', async () => {
    const buf = buildWorkbook({ tools: ['Sierra Sable', 'Taladro'], techs: [{ legajo: 9502, name: 'Iris Inventada' }], sheets: { 9502: { blocks: [
      { date: '2025-10-15', cells: { 'Sierra Sable': { c: 1 }, Taladro: { c: 1 } } },
      { date: '2025-10-08', cells: { 'Sierra Sable': { c: 0 }, Taladro: { c: 1 } } },
      { date: '2025-10-01', cells: { 'Sierra Sable': { e: 1, c: 1 }, Taladro: { e: 1, c: 1 } } },
    ] } } });
    const p = (await preview('admin', buf)).json();
    assert.equal(p.caseCounts.conteo_vacio_probable, 1);
    assert.equal(p.caseCounts.faltante, undefined);
    const r = await confirm('admin', buf, { token: p.token });
    assert.equal(r.statusCode, 200, r.body);
    const its = await api.q("SELECT c.period_w, ci.tool_name, ci.qty_missing FROM control_items ci JOIN controls c ON c.id = ci.control_id WHERE c.import_batch_id = $1 ORDER BY c.finished_at, ci.tool_name", [r.json().batch.id]);
    assert.deepEqual(its.map((i) => [i.period_w, i.tool_name, i.qty_missing]), [[1, 'Sierra Sable', 0], [1, 'Taladro', 0], [2, 'Taladro', 0], [3, 'Sierra Sable', 0], [3, 'Taladro', 0]]);
  });
  test('una sola importación a la vez: la segunda vista previa simultánea responde import_busy', async () => {
    const buf = buildWorkbook(sampleSpec());
    const rs = await Promise.all([preview('admin', buf), preview('admin', buf)]);
    assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(rs.find((r) => r.statusCode === 409).json().error, 'import_busy');
    assert.equal((await preview('admin', buf)).statusCode, 200);
  });
  test('sin kit base en el servidor, se crea con BLANCO', async () => {
    await api.q('DELETE FROM kits WHERE especialidad_id IS NULL');
    const buf = buildWorkbook({ tools: ['Escuadra', 'Nivel Láser'], techs: [{ legajo: 9503, name: 'Juan Inventado' }], sheets: { 9503: { blocks: [{ date: '2025-10-01', cells: { Escuadra: { e: 1, c: 1 } } }] } } });
    const p = (await preview('admin', buf)).json();
    assert.match(p.cases.find((c) => c.type === 'kit_base').message, /Se crea el kit base/);
    const r = await confirm('admin', buf, { token: p.token });
    assert.equal(r.statusCode, 200, r.body);
    const kit = await api.q('SELECT t.name FROM kit_items ki JOIN kits k ON k.id = ki.kit_id JOIN tools t ON t.id = ki.tool_id WHERE k.especialidad_id IS NULL ORDER BY ki.sort_order');
    assert.deepEqual(kit.map((k) => k.name), ['Escuadra', 'Nivel Láser']);
  });
});
