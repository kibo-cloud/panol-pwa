// Etapa 4: control por cantidad, línea opcional y limpieza (API), alertas, informes y .txt v2.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setupApi, ifMatch } from './api.js';
import { HEAD, toTxt } from '../fixtures/v21.js';
import { periodOf, prevP, pkeyOf } from '../../src/domain/period.js';

let api;
const cur = periodOf(new Date());
const LIMPIO = { status: 'limpio' };
let asg; // asignaciones de Ana: pinza x2, destornillador x1, taladro (unidad)
let linea;
let archived;

before(async () => {
  api = await setupApi();
  const rows = await api.q("SELECT id, tool_id, qty FROM assignments WHERE tech_id = 't-ana' AND active ORDER BY id");
  asg = Object.fromEntries(rows.map((r) => [r.tool_id.replace('tool-', ''), r]));
  linea = (await api.call('admin', 'POST', '/api/lineas', { name: 'Línea Conteo', kind: 'linea' })).json().linea;
  archived = (await api.call('admin', 'POST', '/api/lineas', { name: 'Línea Vieja', kind: 'linea' })).json().linea;
  await api.call('admin', 'POST', `/api/lineas/${archived.id}/archive`, undefined, ifMatch(archived.version));
});
after(async () => {
  await api?.close();
});

const patch = (c, body) => api.call('responsable', 'PATCH', `/api/controls/${c.id}`, body, ifMatch(c.version));
const finalize = (c, body) => api.call('responsable', 'POST', `/api/controls/${c.id}/finalize`, body, ifMatch(c.version));

describe('control por cantidad', () => {
  let c;
  test('buen estado + recambio: faltan el resto; estado derivado y totales en unidades', async () => {
    assert.equal(asg.pinza.qty, 2);
    const r = await api.call('responsable', 'POST', '/api/controls', { techId: 't-ana', period: cur, items: { [asg.pinza.id]: { good: 1, change: 0, expected: 2 } } });
    assert.equal(r.statusCode, 201, r.body);
    c = r.json().control;
    const it = c.items[asg.pinza.id];
    assert.deepEqual([it.state, it.expected, it.good, it.change, it.missing, it.qty, it.lineaId], ['faltante', 2, 1, 0, 1, 2, null]);
    assert.deepEqual(c.counts, { bueno: 1, cambio: 0, faltante: 1 });
    assert.deepEqual(c.cleaning, { status: null, note: '' });
    const db = (await api.q('SELECT state, qty, qty_expected, qty_good, qty_change, qty_missing FROM control_items WHERE control_id = $1', [c.id]))[0];
    assert.deepEqual(db, { state: 'faltante', qty: 2, qty_expected: 2, qty_good: 1, qty_change: 0, qty_missing: 1 });
  });

  test('esquema estricto y reglas de cantidades, línea y limpieza', async () => {
    const bad = async (body, status, code) => {
      const r = await patch(c, body);
      assert.equal(r.statusCode, status, `${JSON.stringify(body)} ${r.body}`);
      if (code) assert.equal(r.json().error, code);
      return r.json();
    };
    await bad({ items: { [asg.pinza.id]: { good: 1 } } }, 400);
    await bad({ items: { [asg.pinza.id]: { good: -1, change: 0 } } }, 400);
    await bad({ items: { [asg.pinza.id]: { good: 1.5, change: 0 } } }, 400);
    await bad({ items: { [asg.pinza.id]: { good: 1, change: 0, extra: 1 } } }, 400);
    await bad({ cleaning: { status: 'sucio' } }, 400);
    await bad({ cleaning: { note: 'x' } }, 400);
    await bad({}, 400);
    assert.match((await bad({ items: { [asg.pinza.id]: { good: 2, change: 1 } } }, 422, 'invalid_count')).message, /no pueden superar 2/);
    await bad({ items: { [asg.pinza.id]: { good: 1, change: 0, missing: 0 } } }, 422, 'invalid_count');
    await bad({ items: { [asg.pinza.id]: { good: 2, change: 0, state: 'cambio' } } }, 422, 'invalid_count');
    // Nada cambió con los rechazos.
    const now = (await api.call('consulta', 'GET', `/api/controls/${c.id}`)).json().control;
    assert.equal(now.version, c.version);
  });

  test('línea archivada o desconocida al guardar: se guarda sin línea y avisa (no se pierde el borrador)', async () => {
    let r = await patch(c, { items: { [asg.pinza.id]: { good: 1, change: 0, expected: 2, lineaId: archived.id } } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().warnings, [{ code: 'linea_dropped', assignmentId: asg.pinza.id }]);
    c = r.json().control;
    assert.deepEqual([c.items[asg.pinza.id].good, c.items[asg.pinza.id].missing, c.items[asg.pinza.id].lineaId], [1, 1, null]);
    const db = (await api.q('SELECT linea_id FROM control_items WHERE control_id = $1 AND assignment_id = $2', [c.id, asg.pinza.id]))[0];
    assert.equal(db.linea_id, null);
    // Sin faltantes ni recambios la línea no se mira: sin aviso.
    r = await patch(c, { items: { [asg.pinza.id]: { good: 2, change: 0, expected: 2, lineaId: 'no-existe' } } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().warnings, undefined);
    c = r.json().control;
    assert.equal(c.items[asg.pinza.id].lineaId, null);
    r = await patch(c, { items: { [asg.pinza.id]: { good: 1, change: 0, expected: 2, lineaId: 'no-existe' } } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().warnings, [{ code: 'linea_dropped', assignmentId: asg.pinza.id }]);
    c = r.json().control;
  });

  test('finalizar exige motivo del faltante y limpieza (con nota si requiere)', async () => {
    const s = await patch(c, { items: { [asg.pinza.id]: { good: 1, change: 0, expected: 2, lineaId: linea.id }, [asg.destornillador.id]: { state: 'cambio' } } });
    assert.equal(s.statusCode, 200, s.body);
    c = s.json().control;
    assert.equal(c.items[asg.pinza.id].lineaId, linea.id);
    const taladro = (await api.call('consulta', 'GET', '/api/state')).json();
    const taladroAsg = Object.entries(taladro.assignments).find(([, a]) => a.techId === 't-ana' && a.toolId === 'tool-taladro')[0];
    c = (await patch(c, { items: { [taladroAsg]: { state: 'bueno', lineaId: linea.id } } })).json().control;
    // La línea solo queda en ítems con faltantes o recambios.
    assert.equal(c.items[taladroAsg].lineaId, null);
    let r = await finalize(c);
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().message, 'Completá el motivo de 1 faltante.');
    c = (await patch(c, { items: { [asg.pinza.id]: { good: 1, change: 0, expected: 2, lineaId: linea.id, note: 'Extraviada en el trabajo' } } })).json().control;
    r = await finalize(c);
    assert.equal(r.json().message, 'Indicá la limpieza de herramientas y caja.');
    assert.equal(r.json().cleaning, 'pending');
    c = (await patch(c, { cleaning: { status: 'requiere_limpieza', note: '  ' } })).json().control;
    r = await finalize(c);
    assert.equal(r.json().message, 'Completá la nota de limpieza.');
    // Finaliza en un paso con la nota de limpieza en el cuerpo.
    r = await finalize(c, { cleaning: { status: 'requiere_limpieza', note: 'Grasa en la caja' } });
    assert.equal(r.statusCode, 200, r.body);
    c = r.json().control;
    assert.equal(c.status, 'finalizado');
    assert.deepEqual(c.cleaning, { status: 'requiere_limpieza', note: 'Grasa en la caja' });
    assert.deepEqual(c.counts, { bueno: 2, cambio: 1, faltante: 1 });
    const audit = (await api.q("SELECT detail FROM audit_log WHERE action = 'control_finish' AND entity_id = $1", [c.id]))[0].detail;
    assert.match(audit, /1 para cambio, 1 faltantes, requiere limpieza/);
    // Inmutable: ni ítems ni limpieza.
    await assert.rejects(api.q("UPDATE controls SET cleaning_status = 'limpio' WHERE id = $1", [c.id]), { code: '23001' });
    await assert.rejects(api.q('UPDATE control_items SET qty_good = 2, qty_missing = 0 WHERE control_id = $1', [c.id]), { code: '23001' });
  });

  test('alerta de faltante y de cambio por cantidad', async () => {
    const open = (await api.call('consulta', 'GET', '/api/alerts')).json().open;
    const f = open.find((a) => a.key === `falt-${asg.pinza.id}-${c.id}`);
    assert.ok(f, JSON.stringify(open.map((a) => a.key)));
    assert.equal(f.text, 'Pinza universal, Ana Prueba: faltan 1 de 2. Extraviada en el trabajo');
    assert.equal(f.qty, 1);
    // El destornillador (1 unidad, botón Cambio) da la alerta de cambio.
    assert.ok(open.some((a) => a.asgId === asg.destornillador.id && a.type === 'cambio'));
  });

  test('corrección: copia cantidades, línea y limpieza; la cantidad cambiada queda pendiente', async () => {
    const r = await api.call('responsable', 'POST', '/api/controls', { correctionOf: c.id });
    assert.equal(r.statusCode, 201, r.body);
    let k = r.json().control;
    const it = k.items[asg.pinza.id];
    assert.deepEqual([it.good, it.change, it.missing, it.lineaId, it.note], [1, 0, 1, linea.id, 'Extraviada en el trabajo']);
    assert.deepEqual(k.cleaning, { status: 'requiere_limpieza', note: 'Grasa en la caja' });
    // Contado con otra cantidad (el cliente contó 3, hoy hay 2): queda pendiente, sin error.
    k = (await patch(k, { items: { [asg.pinza.id]: { good: 3, change: 0, expected: 3 } } })).json().control;
    assert.equal(k.items[asg.pinza.id], undefined);
    // Finalizar sigue la misma regla: una línea archivada se deja sin línea y se avisa.
    const fin = await finalize(k, { items: { [asg.pinza.id]: { good: 2, change: 0, expected: 2 }, [asg.destornillador.id]: { state: 'cambio', lineaId: archived.id } }, cleaning: LIMPIO });
    assert.equal(fin.statusCode, 200, fin.body);
    assert.deepEqual(fin.json().warnings, [{ code: 'linea_dropped', assignmentId: asg.destornillador.id }]);
    assert.equal(fin.json().control.items[asg.destornillador.id].lineaId, null);
    assert.deepEqual(fin.json().control.cleaning, { status: 'limpio', note: '' });
    assert.equal(fin.json().control.items[asg.pinza.id].lineaId, null);
    // La corrección (efectiva) ya no tiene faltante: la alerta de la pinza desaparece.
    const open = (await api.call('consulta', 'GET', '/api/alerts')).json().open;
    assert.ok(!open.some((a) => a.asgId === asg.pinza.id && a.type === 'faltante'));
  });
});

describe('limpieza en controles consecutivos', () => {
  test('dos controles seguidos que requieren limpieza abren la alerta; se resuelve', async () => {
    const [carla] = await api.q("SELECT id FROM assignments WHERE tech_id = 't-carla' AND active");
    const p1 = prevP(prevP(cur));
    const p2 = prevP(cur);
    let last;
    for (const [p, note] of [[p1, 'Barro'], [p2, 'Aceite en la caja']]) {
      const c = (await api.call('responsable', 'POST', '/api/controls', { techId: 't-carla', period: p, items: { [carla.id]: { state: 'bueno' } } })).json().control;
      const r = await finalize(c, { cleaning: { status: 'requiere_limpieza', note } });
      assert.equal(r.statusCode, 200, r.body);
      last = r.json().control;
    }
    const key = `limp-t-carla-${last.id}`;
    const open = (await api.call('consulta', 'GET', '/api/alerts')).json().open;
    const a = open.find((x) => x.key === key);
    assert.ok(a, JSON.stringify(open.map((x) => x.key)));
    assert.deepEqual([a.type, a.title, a.text, a.techId], ['limpieza', 'Requiere limpieza en controles consecutivos', 'Carla Demo. Aceite en la caja', 't-carla']);
    const res = await api.call('responsable', 'POST', `/api/alerts/${encodeURIComponent(key)}/resolution`, { note: 'Se limpió' });
    assert.equal(res.statusCode, 201, res.body);
    assert.ok(!(await api.call('consulta', 'GET', '/api/alerts')).json().open.some((x) => x.key === key));
  });
});

describe('informes y .txt v2', () => {
  test('informe: unidades, recambio no es faltante, % limpio y pérdidas por línea', async () => {
    const ym = `${cur.y}-${String(cur.m).padStart(2, '0')}`;
    const R = (await api.call('consulta', 'GET', `/api/reports?ym=${ym}&w=${cur.w}`)).json();
    const ana = R.rows.find((r) => r.id === 't-ana');
    // Corrección efectiva: pinza 2 buenas, destornillador 1 para cambio, taladro bueno.
    assert.deepEqual([ana.bueno, ana.cambio, ana.faltante, ana.pct], [3, 1, 0, 75]);
    assert.deepEqual([ana.limpio, ana.sucio, ana.pctLimpio], [1, 0, 100]);
    const sin = R.lineas.find((l) => l.id === null);
    assert.deepEqual([sin.faltante, sin.cambio], [0, 1]);
    assert.ok(!R.lineas.some((l) => l.id === linea.id), 'la corrección quitó el faltante de la línea');
    const pinza = R.tools.find((t) => t.id === 'tool-pinza');
    assert.equal(pinza.faltante, 0);
  });

  test('exportar: estado derivado y qty, sin cantidades, línea ni limpieza; exportar e importar = 0 cambios', async () => {
    const e = await api.call('admin', 'GET', '/api/export/txt');
    const p = JSON.parse(e.body.slice(HEAD.length));
    const ctls = Object.values(p.data.controls);
    assert.ok(ctls.length >= 3);
    for (const c of ctls) {
      assert.ok(!('cleaning' in c));
      for (const it of Object.values(c.items)) {
        for (const k of ['good', 'change', 'missing', 'expected', 'lineaId']) assert.ok(!(k in it), k);
        assert.ok(['bueno', 'cambio', 'faltante'].includes(it.state));
      }
    }
    const orig = Object.entries(p.data.controls).find(([, c]) => c.techId === 't-ana' && !c.correction && c.status === 'finalizado' && c.period.w === cur.w && c.period.m === cur.m);
    assert.ok(orig);
    assert.equal(orig[1].items[asg.pinza.id].state, 'faltante');
    assert.equal(orig[1].items[asg.pinza.id].qty, 2);
    const dry = await api.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', toTxt(p), { 'content-type': 'text/plain' });
    assert.equal(dry.statusCode, 200, dry.body);
    assert.equal(dry.json().totalChanges, 0, JSON.stringify(dry.json().counts));
  });

  test('importar ítems v2: estado -> cantidades (como la migración)', async () => {
    const e = await api.call('admin', 'GET', '/api/export/txt');
    const p = JSON.parse(e.body.slice(HEAD.length));
    const [bruno] = await api.q("SELECT id FROM assignments WHERE tech_id = 't-bruno' AND tool_id = 'tool-pinza' AND active");
    const p3 = prevP(prevP(prevP(cur)));
    const at = new Date().toISOString();
    p.data.controls['c-txt-conteo'] = {
      techId: 't-bruno', techName: 'Bruno Ejemplo', shiftId: 'tarde', period: p3, status: 'finalizado', correction: false, supersedes: null,
      items: { [bruno.id]: { state: 'faltante', note: 'perdida', toolId: 'tool-pinza', toolName: 'Pinza universal', category: 'Herramientas manuales', unitId: null, unitCode: null, qty: 3 } },
      counts: { bueno: 0, cambio: 0, faltante: 3 }, startedAt: at, finishedAt: at, updatedAt: at,
    };
    const rep = (await api.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', toTxt(p), { 'content-type': 'text/plain' })).json();
    assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
    const ap = await api.call('admin', 'POST', `/api/import/txt?mode=merge&token=${encodeURIComponent(rep.token)}`, toTxt(p), { 'content-type': 'text/plain' });
    assert.equal(ap.statusCode, 200, ap.body);
    const row = (await api.q("SELECT state, qty_expected, qty_good, qty_change, qty_missing, linea_id FROM control_items WHERE control_id = 'c-txt-conteo'"))[0];
    assert.deepEqual(row, { state: 'faltante', qty_expected: 3, qty_good: 0, qty_change: 0, qty_missing: 3, linea_id: null });
    assert.equal((await api.q("SELECT cleaning_status FROM controls WHERE id = 'c-txt-conteo'"))[0].cleaning_status, null);
  });

  test('.txt v2: al importar, los totales del control salen de los ítems (el .txt pierde las cantidades por unidad)', async () => {
    const tech = (await api.call('admin', 'POST', '/api/techs', { name: 'Txt Conteo', legajo: 'TXT-3', shiftId: 'noche' })).json().tech;
    const ent = await api.call('responsable', 'POST', '/api/movements', { type: 'entrega_inicial', techId: tech.id, toolId: 'tool-pinza', qty: 3 });
    assert.equal(ent.statusCode, 201, ent.body);
    const asgId = ent.json().assignments[0];
    let k = (await api.call('responsable', 'POST', '/api/controls', { techId: tech.id, period: cur, items: { [asgId]: { good: 2, change: 0, expected: 3, note: 'Se perdió una' } } })).json().control;
    k = (await finalize(k, { cleaning: LIMPIO })).json().control;
    assert.deepEqual(k.counts, { bueno: 2, cambio: 0, faltante: 1 });
    const p = JSON.parse((await api.call('admin', 'GET', '/api/export/txt')).body.slice(HEAD.length));
    assert.deepEqual(p.data.controls[k.id].counts, { bueno: 2, cambio: 0, faltante: 1 });
    const fresh = await setupApi();
    try {
      const rep = (await fresh.call('admin', 'POST', '/api/import/txt?mode=merge&dryRun=1', toTxt(p), { 'content-type': 'text/plain' })).json();
      assert.equal(rep.canApply, true, JSON.stringify(rep.errors));
      const ap = await fresh.call('admin', 'POST', `/api/import/txt?mode=merge&token=${encodeURIComponent(rep.token)}`, toTxt(p), { 'content-type': 'text/plain' });
      assert.equal(ap.statusCode, 200, ap.body);
      const ctl = (await fresh.q('SELECT count_bueno AS b, count_cambio AS c, count_faltante AS f FROM controls WHERE id = $1', [k.id]))[0];
      const sum = (await fresh.q('SELECT sum(qty_good)::int AS b, sum(qty_change)::int AS c, sum(qty_missing)::int AS f FROM control_items WHERE control_id = $1', [k.id]))[0];
      assert.deepEqual(sum, { b: 0, c: 0, f: 3 }, 'el .txt v2 solo tiene el estado: faltante -> faltan las 3');
      assert.deepEqual(ctl, sum);
    } finally {
      await fresh.close();
    }
  });
});

describe('limpieza en correcciones', () => {
  test('la corrección de un control sin dato de limpieza se finaliza sin limpieza (queda sin dato)', async () => {
    const r = await api.call('responsable', 'POST', '/api/controls', { correctionOf: 'c-txt-conteo' });
    assert.equal(r.statusCode, 201, r.body);
    const k = r.json().control;
    assert.equal(k.cleaning.status, null);
    const bruno = await api.q("SELECT id FROM assignments WHERE tech_id = 't-bruno' AND active");
    const fin = await finalize(k, { items: Object.fromEntries(bruno.map((a) => [a.id, { state: 'bueno' }])) });
    assert.equal(fin.statusCode, 200, fin.body);
    assert.deepEqual(fin.json().control.cleaning, { status: null, note: '' });
  });

  test('la corrección de un control con limpieza y un original nuevo la siguen exigiendo', async () => {
    const [src] = await api.q("SELECT id FROM controls WHERE tech_id = 't-ana' AND status = 'finalizado' AND correction AND cleaning_status IS NOT NULL ORDER BY finished_at DESC LIMIT 1");
    const k = (await api.call('responsable', 'POST', '/api/controls', { correctionOf: src.id })).json().control;
    const fin = await finalize(k, { cleaning: null });
    assert.equal(fin.statusCode, 422, fin.body);
    assert.equal(fin.json().cleaning, 'pending');
    const [carla] = await api.q("SELECT id FROM assignments WHERE tech_id = 't-carla' AND active");
    const o = (await api.call('responsable', 'POST', '/api/controls', { techId: 't-carla', period: prevP(prevP(prevP(cur))), items: { [carla.id]: { state: 'bueno' } } })).json().control;
    const f2 = await finalize(o);
    assert.equal(f2.statusCode, 422, f2.body);
    assert.equal(f2.json().message, 'Indicá la limpieza de herramientas y caja.');
  });
});
