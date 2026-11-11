// Importador del Excel anterior (E9.T1): lectura del libro como datos, estructura de las hojas y
// reglas del plan, con libros inventados generados por test/fixtures/excel.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkbook, WorkbookError } from '../../src/importers/excel-v1/workbook.js';
import { parseBook } from '../../src/importers/excel-v1/layout.js';
import { readExcelBook, planExcelImport, caseCounts, MISSING_NOTE, MAX_EXCEL_BYTES } from '../../src/importers/excel-v1/index.js';
import { numOf, dateOf, timeOf } from '../../src/importers/excel-v1/plan.js';
import { buildWorkbook, sampleSpec, serial, SAMPLE_TOOLS } from '../fixtures/excel.js';

const TODAY = '2025-11-30';
const EMPTY = { techs: [], tools: [], especialidades: [{ id: 'esp-mec', name: 'Mecánico' }, { id: 'esp-ele', name: 'Electricista' }], baseKit: { id: 'kit-base', items: [] } };
const plan = (spec, server = EMPTY, opts = {}) => planExcelImport(readExcelBook(buildWorkbook(spec)), server, { today: TODAY, ...opts });
const ops = (p, kind, legajo) => p.ops.filter((o) => o.kind === kind && (!legajo || o.legajo === legajo));
const caseOf = (p, type) => p.cases.filter((c) => c.type === type);
const one = (tools, blocks, extra = {}) => ({ tools, techs: [{ legajo: 1, name: 'Tito Inventado', especialidad: 'Mecánico' }], sheets: { 1: { blocks } }, ...extra });
const lastControl = (p) => ops(p, 'control').at(-1);
const itemOf = (p, ctl, toolName) => { const idx = p.tools.find((t) => t.name === toolName).idx; return ctl.items.filter((i) => i.tool === idx); };

describe('lectura del libro', () => {
  test('lee hojas, textos, números y fechas como datos', () => {
    const wb = readWorkbook(buildWorkbook(sampleSpec(), { bookType: 'xlsm' }));
    assert.deepEqual(wb.sheets.map((s) => s.name), ['NOVEDADES', 'RESUMEN', 'BLANCO', '9101', '9102']);
    const b = wb.sheets.find((s) => s.name === '9101');
    assert.equal(b.get(5, 2), 'ENTREGA');
    assert.equal(b.get(7, 1), 'Alicate');
    assert.equal(b.get(4, 7), serial('2025-10-16'));
    assert.equal(b.get(8, 9), 0.5);
    assert.equal(b.get(100, 100), null);
  });
  test('rechaza lo que no es un libro de Excel', () => {
    assert.throws(() => readWorkbook(Buffer.from('hola, esto es texto')), WorkbookError);
    assert.throws(() => readWorkbook(Buffer.alloc(0)), WorkbookError);
    const good = buildWorkbook(sampleSpec());
    assert.throws(() => readWorkbook(good.subarray(0, good.length - 200)), WorkbookError);
    // Un ZIP sin xl/workbook.xml (se cambia el nombre de la parte en los dos índices).
    const bad = Buffer.from(good);
    const from = Buffer.from('xl/workbook.xml');
    const to = Buffer.from('xl/workbook.xmX');
    for (let i = bad.indexOf(from); i >= 0; i = bad.indexOf(from, i + 1)) to.copy(bad, i);
    assert.throws(() => readWorkbook(bad), /no es un libro de Excel/);
  });
  test('rechaza un libro cifrado y uno demasiado grande', () => {
    const good = buildWorkbook(sampleSpec());
    const enc = Buffer.from(good);
    // Marca de cifrado en cada entrada del índice central.
    for (let i = 0; i < enc.length - 4; i++) if (enc.readUInt32LE(i) === 0x02014b50) enc.writeUInt16LE(enc.readUInt16LE(i + 8) | 1, i + 8);
    assert.throws(() => readWorkbook(enc), /contraseña/);
    assert.throws(() => readExcelBook(Buffer.alloc(MAX_EXCEL_BYTES + 1)), (e) => e.code === 'too_large');
  });
});

describe('estructura de las hojas', () => {
  test('RESUMEN, BLANCO, hojas de legajo con sus bloques y NOVEDADES', () => {
    const book = parseBook(readWorkbook(buildWorkbook({ ...sampleSpec(), extra: { CRONOGRAMA: [[0, 0, 'x']], Notas: [[0, 0, 'y']] } })));
    assert.deepEqual(book.resumen.techs.map((t) => [t.legajo, t.name, t.especialidad]), [['9101', 'Ana Prueba', 'Mecánico'], ['9102', 'Beto Ensayo', 'Electricista'], ['9103', 'Caja Producción', '']]);
    assert.deepEqual(book.blanco.tools, SAMPLE_TOOLS);
    assert.deepEqual(book.legajoSheets.map((s) => s.legajo), ['9101', '9102']);
    assert.deepEqual(book.ignoredSheets, ['Notas']);
    const s = book.legajoSheets[0].layout;
    assert.deepEqual(s.blocks.map((b) => b.col), [7, 10, 13]);
    assert.equal(s.blocks[0].date, serial('2025-10-16'));
    assert.equal(book.novedades.rows.length, 2);
  });
  test('valores: coma decimal, fechas de Excel y de texto, horas', () => {
    assert.equal(numOf('0,5'), 0.5);
    assert.equal(numOf(' 1 '), 1);
    assert.equal(numOf(''), null);
    assert.equal(numOf('x'), undefined);
    assert.equal(dateOf(serial('2025-09-10')), '2025-09-10');
    assert.equal(dateOf(serial('2025-09-10') - 1462, true), '2025-09-10');
    assert.equal(dateOf('10/09/2025'), '2025-09-10');
    assert.equal(dateOf('31/02/2025'), null);
    assert.equal(dateOf('2025-9-1'), '2025-09-01');
    assert.deepEqual(timeOf(0.5645833333333333), { h: 13, mi: 33 });
    assert.deepEqual(timeOf('08:05'), { h: 8, mi: 5 });
    assert.equal(timeOf('25:00'), null);
  });
});

describe('plan: técnicos y herramientas', () => {
  test('crea técnicos de RESUMEN sin plantilla; el que no tiene hoja queda sin herramientas', () => {
    const p = plan(sampleSpec());
    assert.deepEqual(p.errors, []);
    const techs = ops(p, 'tech');
    assert.deepEqual(techs.map((t) => [t.legajoText, t.name, t.especialidadId]), [['9101', 'Ana Prueba', 'esp-mec'], ['9102', 'Beto Ensayo', 'esp-ele'], ['9103', 'Caja Producción', null]]);
    assert.equal(techs[0].alta, '2025-10-02');
    assert.equal(techs[2].alta, null);
    assert.match(p.cases.find((c) => c.id === 'tec:l2').message, /No tiene hoja/);
    assert.equal(ops(p, 'control', 'l2').length, 0);
  });
  test('legajo con historial, eliminado o inactivo: conflicto sin datos; existente sin historial: recibe los datos', () => {
    const server = { ...EMPTY, techs: [{ id: 't-a', legajo: '9101', name: 'Ana Servidor', active: true, hasHistory: true }, { id: 't-b', legajo: '9102', name: 'Beto Servidor', active: true, hasHistory: false }, { id: 't-c', legajo: '9103', name: 'Caja', active: false, archived: true }] };
    const p = plan(sampleSpec(), server);
    assert.deepEqual(caseOf(p, 'conflicto').map((c) => c.legajo), ['9101', '9103']);
    assert.equal(ops(p, 'tech').length, 0);
    assert.deepEqual(ops(p, 'attach').map((o) => o.techId), ['t-b']);
    assert.equal(ops(p, 'control', 'l0').length, 0);
    assert.ok(ops(p, 'control', 'l1').length > 0);
    assert.equal(caseOf(p, 'tecnico_existente')[0].skippable, true);
  });
  test('hoja que no está en RESUMEN: omitida por defecto, se puede aceptar', () => {
    const spec = { ...one(['Alicate'], [{ date: '2025-10-01', cells: { Alicate: { e: 1, c: 1 } } }]), techs: [] };
    let p = plan(spec);
    assert.equal(caseOf(p, 'legajo_sin_resumen')[0].decision, 'skip');
    assert.equal(ops(p, 'tech').length, 0);
    p = plan(spec, EMPTY, { decisions: { 'tec:l0': 'accept' } });
    assert.equal(ops(p, 'tech')[0].name, 'Legajo 1');
    assert.equal(ops(p, 'control').length, 1);
  });
  test('herramientas: coinciden por nombre normalizado; las nuevas se crean en el orden del Excel; por unidad no se importa', () => {
    const server = { ...EMPTY, tools: [{ id: 'h-al', name: 'ALICATE ', active: true }, { id: 'h-ci', name: 'cinta metrica', active: true, serialized: true }] };
    const p = plan(sampleSpec(), server);
    assert.deepEqual(ops(p, 'tool').map((o) => o.name), ['Pinza', 'Martillo', 'Destornillador Plano']);
    assert.equal(p.tools.find((t) => t.serverId === 'h-al').name, 'ALICATE ');
    assert.equal(caseOf(p, 'herramienta_no_importable').length, 1);
    assert.equal(p.tools.some((t) => t.serverId === 'h-ci'), false);
    // Omitir una herramienta nueva: sus celdas no se importan.
    const q = plan(sampleSpec(), server, { decisions: { 'herr:t1': 'skip' } });
    assert.equal(q.tools.some((t) => t.name === 'Pinza'), false);
    assert.ok(ops(q, 'control').every((c) => c.items.every((i) => i.tool !== 1)));
  });
  test('BLANCO es el kit base: se carga si está vacío; si ya tiene herramientas, se reemplaza solo aceptando', () => {
    let p = plan(sampleSpec());
    assert.equal(caseOf(p, 'kit_base')[0].decision, 'accept');
    assert.deepEqual(ops(p, 'kit')[0].items.map((i) => i.qty), [1, 1, 1, 1, 1]);
    p = plan(sampleSpec(), { ...EMPTY, baseKit: { id: 'kit-base', items: [{ toolId: 'x', qty: 2 }] } });
    assert.equal(caseOf(p, 'kit_base')[0].decision, 'skip');
    assert.equal(ops(p, 'kit').length, 0);
  });
});

describe('plan: bloques', () => {
  test('primer bloque: entrega inicial y control bueno; stock con un ingreso antes de la entrega', () => {
    const p = plan(one(['Alicate'], [{ date: '2025-10-01', cells: { Alicate: { e: 1, c: 1 } } }]));
    const [ing] = ops(p, 'ingreso');
    const [ent] = ops(p, 'entrega');
    assert.equal(ing.qty, 1);
    assert.ok(ing.at < ent.at);
    assert.equal(ent.type, 'entrega_inicial');
    assert.equal(ent.adjust, undefined);
    const ctl = lastControl(p);
    assert.deepEqual(ctl.period, { y: 2025, m: 10, w: 1 });
    assert.deepEqual(ctl.items.map(({ good, change, missing, expected }) => ({ good, change, missing, expected })), [{ good: 1, change: 0, missing: 0, expected: 1 }]);
    assert.ok(ent.at < ctl.at);
  });
  test('conteo sin entrega: entrega de ajuste (un caso por técnico y herramienta); omitida, el conteo se recorta', () => {
    const spec = one(['Pinza'], [{ date: '2025-10-08', cells: { Pinza: { c: 1 } } }, { date: '2025-10-01', cells: { Pinza: { c: 1 } } }]);
    let p = plan(spec);
    const aj = caseOf(p, 'ajuste');
    assert.equal(aj.length, 1);
    assert.equal(aj[0].id, 'aj:l0:t0');
    assert.deepEqual(ops(p, 'entrega').map((o) => [o.type, o.adjust, o.qty]), [['entrega_inicial', true, 1]]);
    assert.equal(ops(p, 'control').length, 2);
    p = plan(spec, EMPTY, { decisions: { 'aj:l0:t0': 'skip' } });
    assert.equal(ops(p, 'entrega').length, 0);
    assert.equal(ops(p, 'control').length, 0);
  });
  test('0,5 = recambio con o sin el 0,5 en DEVOLUCIÓN (que se ignora); 0 = faltante con nota', () => {
    const p = plan(one(['Pinza', 'Martillo', 'Llave'], [
      { date: '2025-10-08', cells: { Pinza: { c: 0.5, d: 0.5 }, Martillo: { c: '0,5' }, Llave: { c: 0 } } },
      { date: '2025-10-01', cells: { Pinza: { e: 1, c: 1 }, Martillo: { e: 1, c: 1 }, Llave: { e: 2, c: 2 } } },
    ]));
    const ctl = lastControl(p);
    assert.deepEqual(itemOf(p, ctl, 'Pinza').map((i) => [i.good, i.change, i.missing]), [[0, 1, 0]]);
    assert.deepEqual(itemOf(p, ctl, 'Martillo').map((i) => [i.good, i.change, i.missing]), [[0, 1, 0]]);
    assert.deepEqual(itemOf(p, ctl, 'Llave').map((i) => [i.good, i.change, i.missing, i.expected]), [[0, 0, 2, 2]]);
    assert.equal(caseOf(p, 'devolucion_05').length, 1);
    assert.equal(ops(p, 'devolucion').length, 0);
    assert.equal(caseOf(p, 'recambio').length, 2);
    assert.match(caseOf(p, 'faltante')[0].message, new RegExp(MISSING_NOTE));
  });
  test('cantidades: 1,5 = 1 buena y 1 para recambio; 2 contra 3 asignadas = 1 faltante', () => {
    const p = plan(one(['Llave'], [{ date: '2025-10-08', cells: { Llave: { c: 1.5 } } }, { date: '2025-10-01', cells: { Llave: { e: 3, c: 3 } } }]));
    assert.deepEqual(itemOf(p, lastControl(p), 'Llave').map((i) => [i.good, i.change, i.missing]), [[1, 1, 1]]);
  });
  test('DEVOLUCIÓN igual al conteo previo: devolución a disponible, o baja si era un recambio', () => {
    const p = plan(one(['Alicate', 'Pinza'], [
      { date: '2025-10-15', cells: { Alicate: { d: 1, c: 0 }, Pinza: { d: 0.5, c: 0 } } },
      { date: '2025-10-08', cells: { Alicate: { c: 1 }, Pinza: { c: 0.5 } } },
      { date: '2025-10-01', cells: { Alicate: { e: 1, c: 1 }, Pinza: { e: 1, c: 1 } } },
    ]));
    assert.deepEqual(ops(p, 'devolucion').map((o) => [o.cond, o.qty]), [['disponible', 1], ['baja', 1]]);
    assert.equal(caseOf(p, 'devolucion').length, 2);
    // Sin herramientas asignadas después de las devoluciones, ese bloque no es un control.
    assert.equal(ops(p, 'control').length, 2);
    const q = plan(one(['Alicate'], [{ date: '2025-10-15', cells: { Alicate: { d: 1, c: 0 } } }, { date: '2025-10-08', cells: { Alicate: { e: 1, c: 1 } } }]), EMPTY, { decisions: { 'dev:l0:c7:t0': 'skip' } });
    assert.equal(ops(q, 'devolucion').length, 0);
    assert.deepEqual(itemOf(q, lastControl(q), 'Alicate').map((i) => i.missing), [1]);
  });
  test('DEVOLUCIÓN que no coincide con el conteo previo: caso dudoso omitido por defecto', () => {
    const spec = one(['Llave'], [{ date: '2025-10-15', cells: { Llave: { d: 1, c: 1 } } }, { date: '2025-10-08', cells: { Llave: { e: 2, c: 2 } } }]);
    let p = plan(spec);
    const c = caseOf(p, 'devolucion_dudosa')[0];
    assert.equal(c.decision, 'skip');
    assert.equal(ops(p, 'devolucion').length, 0);
    p = plan(spec, EMPTY, { decisions: { [c.id]: 'accept' } });
    assert.deepEqual(ops(p, 'devolucion').map((o) => [o.cond, o.qty]), [['disponible', 1]]);
  });
  test('ENTREGA en bloques posteriores: reposición después de un faltante o recambio, si no adicional', () => {
    const p = plan(one(['Alicate', 'Pinza'], [
      { date: '2025-10-15', cells: { Alicate: { e: 1, c: 1 }, Pinza: { e: 1, c: 2 } } },
      { date: '2025-10-08', cells: { Alicate: { c: 0 }, Pinza: { c: 1 } } },
      { date: '2025-10-01', cells: { Alicate: { e: 1, c: 1 }, Pinza: { e: 1, c: 1 } } },
    ]));
    assert.deepEqual(ops(p, 'reposicion').map((o) => o.qty), [1]);
    assert.equal(caseOf(p, 'reposicion').length, 1);
    assert.deepEqual(ops(p, 'entrega').map((o) => o.type), ['entrega_inicial', 'entrega_inicial', 'adicional']);
    assert.deepEqual(ops(p, 'ingreso').map((o) => o.qty).sort(), [2, 2]);
    // Dos asignaciones de Pinza: cada una con su ítem.
    assert.deepEqual(itemOf(p, lastControl(p), 'Pinza').map((i) => [i.expected, i.good]), [[1, 1], [1, 1]]);
  });
  // Un bloque fechado con todo en 0 se toma como vacío (el + del Excel lo crea con ceros).
  test('dos bloques en la misma semana: el último es corrección del anterior; orden por fecha, no por columna', () => {
    const p = plan(one(['Alicate'], [
      { date: '2025-10-01', cells: { Alicate: { e: 1, c: 1 } } },
      { date: '2025-10-16', cells: { Alicate: { c: 0.5 } } },
      { date: '2025-10-15', cells: { Alicate: { c: 1 } } },
    ]));
    const ctls = ops(p, 'control');
    assert.deepEqual(ctls.map((c) => c.day), ['2025-10-01', '2025-10-15', '2025-10-16']);
    assert.equal(ctls[2].correctionOf, ctls[1].ref);
    assert.equal(ctls[1].correctionOf, null);
    assert.equal(caseOf(p, 'semana_duplicada').length, 1);
    assert.equal(p.totals.corrections, 1);
  });
  test('bloques sin fecha, con fecha futura o inválida, vacíos, y hojas sin bloques', () => {
    const p = plan({
      tools: ['Alicate'],
      techs: [{ legajo: 1, name: 'Uno' }, { legajo: 2, name: 'Dos' }],
      sheets: {
        1: { blocks: [{ date: null, cells: { Alicate: { c: 1 } } }, { date: '2026-01-05', cells: { Alicate: { c: 1 } } }, { date: 'ayer', cells: { Alicate: { c: 1 } } }, { date: '2025-10-08', cells: { Alicate: { c: 0 } } }, { date: null, cells: {} }, { date: '2025-10-01', cells: { Alicate: { e: 1, c: 1 } } }] },
        2: { blocks: [{ date: '2025-10-01', cells: {} }] },
      },
    });
    const n = caseCounts(p.cases);
    assert.equal(n.bloque_sin_fecha, 1);
    assert.equal(n.fecha_invalida, 2);
    assert.equal(n.bloque_vacio, 2);
    assert.equal(n.hoja_sin_bloques, 1);
    assert.equal(ops(p, 'control', 'l0').length, 1);
  });
  test('un valor que no es un número se toma como vacío y queda como caso', () => {
    const p = plan(one(['Alicate'], [{ date: '2025-10-01', cells: { Alicate: { e: 1, c: 'bien' } } }]));
    assert.equal(caseOf(p, 'valor_invalido').length, 1);
    assert.deepEqual(itemOf(p, lastControl(p), 'Alicate').map((i) => i.missing), [1]);
  });
});

describe('plan: novedades, decisiones y estabilidad', () => {
  test('novedades: fecha y hora de la hoja, técnico por legajo; legajo desconocido va al comentario', () => {
    const p = plan(sampleSpec());
    const nov = ops(p, 'novedad');
    assert.equal(nov.length, 2);
    assert.equal(nov[0].legajo, 'l0');
    assert.equal(nov[0].at, '2025-10-15T15:00:00.000Z');
    assert.equal(nov[1].legajo, null);
    assert.equal(nov[1].comment, '[Legajo 7777] Aviso de un legajo que no está');
    assert.equal(caseOf(p, 'novedad_sin_tecnico').length, 1);
  });
  test('decisiones: solo las explícitas cuentan; las que no nombran un caso se informan', () => {
    const p = plan(sampleSpec(), EMPTY, { decisions: { 'tec:l2': 'skip', 'aj:l0:t1': 'accept', 'nada:x': 'skip', 'fal:l0:c7:t2': 'skip' } });
    assert.deepEqual(p.effectiveDecisions, { 'tec:l2': 'skip', 'aj:l0:t1': 'accept' });
    assert.deepEqual(p.staleDecisions, ['fal:l0:c7:t2', 'nada:x']);
    assert.equal(ops(p, 'tech').length, 2);
  });
  test('el mismo libro y el mismo servidor dan el mismo plan', () => {
    assert.equal(JSON.stringify(plan(sampleSpec())), JSON.stringify(plan(sampleSpec())));
  });
  test('libro sin RESUMEN ni hojas de legajo: error', () => {
    const p = plan({ tools: ['Alicate'], resumen: false, blanco: false, sheets: {}, extra: { Hoja1: [[0, 0, 'x']] } });
    assert.equal(p.errors[0].code, 'not_panol_excel');
    assert.deepEqual(p.ops, []);
  });
  test('ejemplo completo: totales', () => {
    const p = plan(sampleSpec());
    assert.deepEqual(p.totals, { techsCreate: 3, techsAttach: 0, toolsCreate: 5, toolsMatched: 0, kitItems: 5, controls: 5, corrections: 1, entregas: 4, ajustes: 1, reposiciones: 0, devoluciones: 1, bajas: 0, ingresos: 4, novedades: 2 });
  });
});
