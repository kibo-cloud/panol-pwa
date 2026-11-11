// Etapa 10: informe para auditoría (dominio puro) y datos de la empresa (logo).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState } from '../../src/domain/derive.js';
import { buildAuditReport, parseAuditSelection, periodLabel, cellOf, planillaCount, MAX_AUDIT_MONTHS } from '../../src/domain/auditoria.js';
import { sniffImage, checkLogo, cleanCompanyName, MAX_LOGO_BYTES } from '../../src/domain/empresa.js';
import { fixture, ctxOf, NOW } from '../fixtures/auditoria.js';

const sel = (q = {}) => parseAuditSelection({ months: '2026-10,2026-11', ...q }, { now: NOW });
const build = (q = {}, extra = {}) => {
  const S = fixture();
  return buildAuditReport(deriveState(S, { now: NOW }), ctxOf(S, extra), sel(q));
};
const holder = (R, key) => R.holders.find((h) => h.key === key);

describe('selección', () => {
  test('meses sueltos o rango, orden y límites', () => {
    assert.deepEqual(sel().months.map((m) => m.key), ['2026-10', '2026-11']);
    assert.deepEqual(parseAuditSelection({ from: '2026-08', to: '2026-10' }, { now: NOW }).months.map((m) => m.key), ['2026-08', '2026-09', '2026-10']);
    assert.deepEqual(parseAuditSelection({ months: '2026-11,2026-01,2026-11' }, { now: NOW }).months.map((m) => m.key), ['2026-01', '2026-11']);
    assert.throws(() => parseAuditSelection({ from: '2024-01', to: '2026-01' }, { now: NOW }), (e) => e.code === 'report_too_large' && e.status === 422 && e.message.includes(`${MAX_AUDIT_MONTHS} meses`));
    assert.throws(() => parseAuditSelection({ months: '2026-12' }, { now: NOW }), (e) => e.code === 'invalid_months');
    assert.throws(() => parseAuditSelection({}, { now: NOW }), (e) => e.code === 'invalid_months' && e.status === 400);
    assert.throws(() => parseAuditSelection({ months: '2026-13' }, { now: NOW }), (e) => e.code === 'invalid_months');
    assert.throws(() => sel({ sections: 'resumen,otra' }), (e) => e.code === 'invalid_selection');
    assert.throws(() => sel({ techs: 'a b' }), (e) => e.code === 'invalid_selection');
    assert.deepEqual(sel({ sections: 'firmas,resumen' }).sections, ['resumen', 'firmas']);
    assert.equal(sel({ cajas: 'none' }).cajas, 'none');
    assert.equal(periodLabel(sel().months), 'octubre 2026 a noviembre 2026');
    assert.equal(periodLabel(parseAuditSelection({ months: '2026-01,2026-03' }, { now: NOW }).months), 'enero 2026, marzo 2026');
  });
});

describe('informe', () => {
  test('poseedores: activos con herramientas o con historial; el eliminado marcado; esperados por período con herramientas', () => {
    const R = build();
    assert.deepEqual(R.holders.map((h) => h.key), ['tA', 'tB', 'tX', 'caja:k1'], 'Nadie (sin herramientas ni controles) no entra');
    assert.equal(R.periods, 7, 'octubre 4 semanas + noviembre semanas 1 a 3 (hoy es la semana 3)');
    const x = holder(R, 'tX');
    assert.equal(x.name, 'Xenia (eliminado)');
    assert.equal(x.expected, 5, 'eliminada el 3/11: octubre y la semana 1 de noviembre');
    assert.equal(holder(R, 'tA').expected, 7);
    assert.equal(R.summary.expected, 26, 'Ana, Beto y la caja 7 cada uno; Xenia 5');
    assert.equal(R.summary.done, 4, 'cA1, cA2 (vigente), cB1, cX1');
    assert.equal(R.summary.pctDone, Math.round((4 / 26) * 100));
    assert.ok(holder(R, 'tA').plantillas.includes('Tarde') && holder(R, 'tA').plantillas.includes('Mañana'));
  });

  test('controles vigentes con símbolos, correcciones marcadas, importado y "sin dato"', () => {
    const R = build();
    const a = holder(R, 'tA');
    assert.deepEqual(a.columns.map((c) => c.id), ['cA1', 'cA2'], 'el original corregido no es columna');
    const corr = a.columns[1];
    assert.equal(corr.correction, true);
    assert.equal(corr.byName, 'Admin Uno');
    assert.deepEqual(corr.corrects.map((o) => [o.id, o.byName]), [['cA2o', 'Rita Responsable']]);
    assert.deepEqual(corr.cleaning, { status: 'requiere_limpieza', note: 'Grasa' });
    // Filas en el orden personalizado: Llave (2) y Taladro (3) con su código.
    assert.deepEqual(a.rows.map((r) => [r.n, r.name, r.unitCode]), [[2, 'Llave', null], [3, 'Taladro', 'TAL-1']]);
    assert.equal(a.rows[0].cells.cA1.text, '✓2 F1');
    assert.equal(a.rows[0].cells.cA2.text, '✓1 C1 F1');
    assert.equal(a.rows[1].cells.cA1.text, 'F');
    assert.equal(a.rows[1].cells.cA2.text, '✓');
    assert.deepEqual(a.notes.map((n) => n.note), ['Se perdió una', 'No está']);
    const b = holder(R, 'tB');
    assert.equal(b.columns[0].imported, true);
    assert.equal(b.columns[0].cleaning.status, null);
    assert.equal(b.rows[0].cells.cB1.text, '—', 'pinza sin contar en el control importado');
    assert.equal(cellOf({ expected: 1, good: 0, change: 1, missing: 0 }).text, 'C');
    assert.equal(R.summary.imported, 1);
    assert.equal(R.summary.corrections, 1);
  });

  test('resumen: % en condiciones del último control, limpieza y reposiciones', () => {
    const R = build();
    // Últimos: Ana cA2 (2 bien de 4: llave 1 + taladro 1; 1 cambio; 1 falta), Beto cB1 (nada), Xenia cX1 (1).
    assert.deepEqual([R.summary.bueno, R.summary.cambio, R.summary.faltante], [3, 1, 1]);
    assert.equal(R.summary.pctCond, 60);
    assert.deepEqual([R.summary.limpio, R.summary.sucio, R.summary.sinDatoLimpieza, R.summary.pctLimpio], [2, 1, 1, 67]);
    assert.equal(R.summary.reposiciones, 1);
    assert.deepEqual(R.summary.perMonth.map((m) => [m.key, m.done, m.expected]), [['2026-10', 3, 16], ['2026-11', 1, 10]]);
  });

  test('faltantes con su resolución: reposición, compra y sin resolver', () => {
    const R = build();
    const f = R.faltantes.map((x) => [x.toolName, x.missing, x.resolution.kind]);
    assert.deepEqual(f, [['Llave', 1, 'compra'], ['Taladro', 1, 'reposicion']]);
    assert.equal(R.faltantes[0].purchase.name, 'Compra 1');
    assert.equal(R.faltantes[0].controls, 2, 'la llave sigue faltando en el control siguiente: un solo episodio');
    const S = fixture();
    const R2 = buildAuditReport(deriveState(S, { now: NOW }), ctxOf(S, { purchaseLinks: [] }), sel());
    assert.equal(R2.faltantes[0].resolution.kind, 'sin_resolver');
    assert.equal(R2.summary.sinResolver, 1);
  });

  test('movimientos con anulación marcada (y planilla sin el anulado)', () => {
    const R = build();
    assert.deepEqual(R.movements.map((m) => [m.id, m.type, !!m.voided]), [['m1', 'entrega_inicial', false], ['m3', 'entrega_inicial', false], ['m2', 'reposicion', false], ['m4', 'adicional', true], ['m5', 'anulacion', false]]);
    assert.equal(R.movements[4].voids.typeLabel, 'Entrega adicional');
    assert.equal(R.movements[2].unitCode, 'TAL-1');
    assert.equal(R.movementTotals.adicional.count, 0, 'la adicional anulada no cuenta');
    assert.equal(R.movementTotals.anuladas, 1);
    assert.ok(!R.movements.some((m) => m.type === 'ingreso'));
  });

  test('formato planilla: ENTREGA / DEVOLUCIÓN / CONTEO con 1 / 0,5 / 0', () => {
    const a = holder(build(), 'tA');
    assert.deepEqual(a.planilla.blocks.map((b) => b.controlId), ['cA1', 'cA2']);
    const llave = a.planilla.rows.find((r) => r.toolId === 'llave');
    assert.deepEqual(llave.cells[0], { entrega: 3, devolucion: null, conteo: 2 });
    assert.deepEqual(llave.cells[1], { entrega: null, devolucion: 0.5, conteo: 1.5 });
    const tal = a.planilla.rows.find((r) => r.toolId === 'taladro');
    assert.deepEqual(tal.cells[1], { entrega: 1, devolucion: 1, conteo: 1 }, 'la reposición: sale la vieja y entra la nueva');
    assert.equal(planillaCount({ good: 2, change: 1, missing: 0 }), 2.5);
    const b = holder(build(), 'tB');
    assert.deepEqual(b.planilla.blocks.map((x) => x.controlId), ['cB1'], 'la adicional anulada no genera bloque');
  });

  test('compras: costos solo con purchases_view; rechazo con su motivo', () => {
    const R = build();
    assert.equal(R.purchases.length, 2);
    assert.equal(R.purchases[0].estimatedCost, 1500.5);
    assert.equal(R.purchases[1].decisionComment, 'Hay en el pañol');
    assert.deepEqual(R.purchaseTotals, { aprobadas: 1, rechazadas: 1, costoConocido: 1500.5, sinCosto: 0 });
    const S = fixture();
    const R2 = buildAuditReport(deriveState(S, { now: NOW }), ctxOf(S, { perms: { purchasesView: false, novedadesView: false } }), sel());
    assert.equal(R2.costsShown, false);
    assert.ok(R2.purchases.every((p) => !('estimatedCost' in p) && !('supplier' in p)));
    assert.deepEqual(R2.purchaseTotals, { aprobadas: 1, rechazadas: 1 });
    assert.equal(R2.novedades, null, 'sin novedades_view la sección no trae datos');
  });

  test('novedades del período, cambios de plantilla y filtros', () => {
    const R = build();
    assert.deepEqual(R.novedades.map((n) => n.id), ['n1']);
    assert.deepEqual(R.plantillas.moves.map((m) => [m.techName, m.fromName, m.toName]), [['Ana', 'Tarde', 'Mañana']]);
    assert.equal(R.plantillas.rotations[0].label, 'Noche');
    assert.equal(R.plantillas.supervisors[0].toName, 'Rita Responsable');
    // Solo la plantilla tarde: Ana (estuvo en tarde) y Beto; sin cajas.
    const T = build({ plantillas: 'tarde', cajas: 'none' });
    assert.deepEqual(T.holders.map((h) => h.key), ['tA', 'tB']);
    assert.deepEqual(T.plantillas.supervisors, []);
    assert.deepEqual(T.purchases.map((p) => p.id), ['p1', 'p2']);
    const B = build({ techs: 'tB', cajas: 'none' });
    assert.deepEqual(B.holders.map((h) => h.key), ['tB']);
    assert.deepEqual(B.purchases.map((p) => p.id), ['p2']);
    assert.deepEqual(B.novedades, []);
    assert.deepEqual(B.movements.map((m) => m.id), ['m3', 'm4', 'm5']);
  });
});

describe('empresa', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(20)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20), Buffer.from([0xff, 0xd9])]);
  test('tipo por los primeros bytes: PNG y JPEG, nunca SVG', () => {
    assert.equal(sniffImage(png), 'image/png');
    assert.equal(sniffImage(jpg), 'image/jpeg');
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
    assert.equal(checkLogo(png), 'image/png');
    assert.throws(() => checkLogo(Buffer.from('<svg></svg>          ')), (e) => e.code === 'invalid_image' && e.status === 422);
    assert.throws(() => checkLogo(Buffer.concat([png, Buffer.alloc(MAX_LOGO_BYTES)])), (e) => e.code === 'too_large' && e.status === 413);
  });
  test('nombre de la empresa', () => {
    assert.equal(cleanCompanyName('  Villa   D\'agri  '), "Villa D'agri");
    assert.throws(() => cleanCompanyName('  '), (e) => e.code === 'invalid_name');
    assert.throws(() => cleanCompanyName('x'.repeat(121)), (e) => e.code === 'invalid_name');
  });
});

// Revisión E10.V1: casos chicos armados a mano (marzo y abril de 2026; hoy es noviembre).
describe('revisión de la etapa 10', () => {
  const T = (d) => `2026-${d}T15:00:00.000Z`;
  const item = (toolId, expected, good, change, missing) => ({ toolId, toolName: toolId, state: missing ? 'faltante' : change ? 'cambio' : 'bueno', expected, qty: expected, good, change, missing, note: '', unitCode: null });
  const ctl = (techId, w, day, items, extra = {}) => {
    const m = Number(day.slice(0, 2));
    const counts = { bueno: 0, cambio: 0, faltante: 0 };
    for (const x of Object.values(items)) { counts.bueno += x.good; counts.cambio += x.change; counts.faltante += x.missing; }
    return { techId, plantillaId: 'manana', period: { y: 2026, m, w }, status: 'finalizado', finishedAt: T(day), counts, items, cleaning: { status: 'limpio', note: '' }, by: 'u-resp', ...extra };
  };
  const tr = (toolId, qty, from, to) => ({ toolId, qty, from, to, unitId: null });
  const mv = (type, day, qty, extra = {}) => ({ type, techId: 'tM', toolId: 'llave', qty, at: T(day), by: 'u-resp', ...extra });
  const give = (day, qty, type = 'adicional') => mv(type, day, qty, { transfers: [tr('llave', qty, 'disponible', 'asignado')] });
  const back = (day, qty, extra = {}) => mv('devolucion', day, qty, { transfers: [tr('llave', qty, 'asignado', 'disponible')], ...extra });
  const base = ({ techs, assignments, controls = {}, movements = {} }) => ({
    shifts: [{ id: 'manana', name: 'Mañana', order: 1 }], plantillas: { manana: { name: 'Mañana', order: 1 } }, plantillaHistory: {},
    users: { 'u-resp': { name: 'Rita Responsable' } }, especialidades: {}, cajas: {}, lineas: {}, units: {},
    categories: { cat: { name: 'Manuales', order: 1 } }, tools: { llave: { name: 'Llave', categoryId: 'cat', order: 1, serialized: false } },
    techs: techs || { tM: { name: 'Mara', legajo: '1', shiftId: 'manana', plantillaId: 'manana', active: true } },
    assignments: assignments || { aM: { techId: 'tM', toolId: 'llave', qty: 1, active: true, since: T('03-01') } },
    controls, movements, alertRes: {},
  });
  const run = (S, months = '2026-03') => buildAuditReport(deriveState(S, { now: NOW }), ctxOf(S, { purchases: [], purchaseLinks: [], novedades: [] }), parseAuditSelection({ months }, { now: NOW }));

  test('planilla: un control corregido tarde no corre los límites de los bloques', () => {
    const S = base({
      controls: {
        p1o: ctl('tM', 1, '03-05', { aM: item('llave', 1, 1, 0, 0) }),
        p2: ctl('tM', 2, '03-12', { aM: item('llave', 1, 1, 0, 0) }),
        p1c: ctl('tM', 1, '03-20', { aM: item('llave', 1, 1, 0, 0) }, { supersedes: 'p1o', correction: true }),
      },
      movements: { e1: give('03-03', 1, 'entrega_inicial'), e2: give('03-08', 1), e3: give('03-15', 1), d1: back('03-22', 1) },
    });
    const m = holder(run(S), 'tM');
    assert.deepEqual(m.planilla.blocks.map((b) => b.controlId), ['p1c', 'p2', null]);
    const llave = m.planilla.rows.find((r) => r.toolId === 'llave');
    assert.deepEqual(llave.cells.map((c) => c.entrega), [1, 1, 1], 'cada entrega en su bloque, ninguna dos veces');
    assert.deepEqual(llave.cells.map((c) => c.devolucion), [null, null, 1]);
  });

  test('faltante: la reposición anterior a una corrección resuelve el episodio (desde el original)', () => {
    const S = base({
      assignments: { aM: { techId: 'tM', toolId: 'llave', qty: 1, active: false, since: T('03-01') }, aM2: { techId: 'tM', toolId: 'llave', qty: 1, active: true, since: T('03-06') } },
      controls: {
        p1o: ctl('tM', 1, '03-05', { aM: item('llave', 1, 0, 0, 1) }),
        p1c: ctl('tM', 1, '03-10', { aM: item('llave', 1, 0, 0, 1) }, { supersedes: 'p1o', correction: true }),
      },
      movements: { r1: mv('reposicion', '03-06', 1, { oldAssignmentId: 'aM', newAssignmentId: 'aM2', returned: false, transfers: [tr('llave', 1, 'asignado', 'baja'), tr('llave', 1, 'disponible', 'asignado')] }) },
    });
    const R = run(S);
    assert.equal(R.faltantes.length, 1);
    assert.equal(R.faltantes[0].resolution.kind, 'reposicion');
    assert.equal(R.faltantes[0].firstDay, '2026-03-05');
  });

  test('esperados por período: solo con herramientas asignadas y hasta la baja del poseedor', () => {
    const S = base({
      techs: {
        tArch: { name: 'Archi', legajo: '1', shiftId: 'manana', plantillaId: 'manana', active: false, archived: true, archivedAt: T('03-10') },
        tLate: { name: 'Tardío', legajo: '2', shiftId: 'manana', plantillaId: 'manana', active: true },
        tIdle: { name: 'Quieto', legajo: '3', shiftId: 'manana', plantillaId: 'manana', active: true },
      },
      assignments: {
        a1: { techId: 'tArch', toolId: 'llave', qty: 1, active: false, since: T('02-01') },
        a2: { techId: 'tLate', toolId: 'llave', qty: 1, active: true, since: T('04-09') },
        a3: { techId: 'tIdle', toolId: 'llave', qty: 1, active: false, since: T('01-01'), until: T('02-15') },
      },
      controls: {
        x1: ctl('tArch', 1, '03-05', { a1: item('llave', 1, 1, 0, 0) }),
        l1: ctl('tLate', 3, '04-16', { a2: item('llave', 1, 1, 0, 0) }),
        i1: ctl('tIdle', 1, '03-06', {}),
      },
    });
    const R = run(S, '2026-03,2026-04');
    const h = (k) => holder(R, k);
    assert.deepEqual([h('tArch').expected, h('tLate').expected, h('tIdle').expected], [2, 3, 0], 'baja el 10/3; asignado desde el 9/4; sin herramientas en el período');
    assert.deepEqual([h('tArch').done, h('tLate').done, h('tIdle').done], [1, 1, 0]);
    assert.equal(R.summary.expected, 5);
    assert.equal(R.summary.done, 2, 'realizados y esperados sobre los mismos poseedores');
    assert.deepEqual(R.summary.perMonth.map((x) => [x.key, x.done, x.expected]), [['2026-03', 1, 2], ['2026-04', 1, 3]]);
    assert.ok(R.summary.perMonth.every((x) => x.done <= x.expected) && R.summary.done <= R.summary.expected);
    assert.equal(R.summary.pctDone, 40);
  });

  test('planilla: el 0,5 del recambio va en DEVOLUCIÓN solo en el primer bloque, y SALDO por fila', () => {
    const S = base({
      controls: {
        p1: ctl('tM', 1, '03-05', { aM: item('llave', 1, 0, 1, 0) }),
        p2: ctl('tM', 2, '03-12', { aM: item('llave', 1, 0, 1, 0) }),
      },
      movements: { e1: give('03-02', 1, 'entrega_inicial') },
    });
    const llave = holder(run(S), 'tM').planilla.rows.find((r) => r.toolId === 'llave');
    assert.deepEqual(llave.cells, [{ entrega: 1, devolucion: 0.5, conteo: 0.5 }, { entrega: null, devolucion: null, conteo: 0.5 }]);
    assert.equal(llave.saldo, 0, 'último conteo − (entregas − devoluciones)');
  });

  test('faltante: una devolución parcial no lo resuelve', () => {
    const mk = (qty) => base({
      assignments: { aM: { techId: 'tM', toolId: 'llave', qty: 3, active: true, since: T('03-01') } },
      controls: { p1: ctl('tM', 1, '03-05', { aM: item('llave', 3, 1, 0, 2) }) },
      movements: { d1: back('03-08', qty, { oldAssignmentId: 'aM' }) },
    });
    const part = run(mk(1)).faltantes[0].resolution;
    assert.equal(part.kind, 'parcial');
    assert.equal(part.label, 'Parcial (1 de 2)');
    assert.equal(run(mk(2)).faltantes[0].resolution.kind, 'devolucion');
  });
});
