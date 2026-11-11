// Lector del Excel contra archivos hostiles (E9.V1): XML lineal (sin cerrar, mal cerrado, muy
// largo), índice del ZIP cortado o fuera del archivo, tamaños declarados falsos, bombas de
// compresión, cifrado, ZIP64, partes demasiado grandes, textos compartidos inexistentes y la
// lectura aislada en un worker con tiempo máximo.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readWorkbook, WorkbookError, scanXml } from '../../src/importers/excel-v1/workbook.js';
import { ZIP_LIMITS } from '../../src/importers/excel-v1/zip.js';
import { planInWorker } from '../../src/importers/excel-v1/run.js';
import { planExcelImport, readExcelBook } from '../../src/importers/excel-v1/index.js';
import { buildZip, xlsxEntries, xlsxZip } from '../fixtures/zip.js';
import { buildWorkbook, sampleSpec } from '../fixtures/excel.js';

const EMPTY = { techs: [], tools: [], especialidades: [], baseKit: { id: 'kit-base', items: [] } };
const fast = (fn, ms = 1000) => {
  const t0 = performance.now();
  let err = null;
  try { fn(); } catch (e) { err = e; }
  const dt = performance.now() - t0;
  assert.ok(dt < ms, `tardó ${Math.round(dt)} ms`);
  return err;
};
const sheet = (rows) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

describe('XML lineal', () => {
  test('400 KB de <row> sin cerrar se rechaza en menos de 1 s', () => {
    const err = fast(() => readWorkbook(xlsxZip({ sheetXml: sheet('<row>'.repeat(80_000)) })));
    assert.ok(err instanceof WorkbookError, String(err));
    assert.match(err.message, /no se cierra|mal cerrada/);
  });
  test('400 KB de <si> sin cerrar se rechaza en menos de 1 s', () => {
    const err = fast(() => readWorkbook(xlsxZip({ sst: `<sst>${'<si><t>a'.repeat(50_000)}` })));
    assert.ok(err instanceof WorkbookError, String(err));
  });
  test('etiquetas y atributos sin cerrar o enormes no tardan', () => {
    for (const x of [`<row ${'a'.repeat(400_000)}>`, `<row r="${'1'.repeat(400_000)}`, '<sheet '.repeat(60_000), '<c r="A1"><v>'.repeat(40_000)]) {
      const err = fast(() => readWorkbook(xlsxZip({ sheetXml: sheet(x), workbookXml: x.startsWith('<sheet') ? `<workbook><sheets>${x}` : null })));
      assert.ok(err instanceof WorkbookError, String(err));
    }
  });
  test('una etiqueta sin cerrar o mal cerrada es un libro dañado', () => {
    assert.throws(() => readWorkbook(xlsxZip({ sheetXml: '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c>' })), /no se cierra/);
    assert.throws(() => readWorkbook(xlsxZip({ sheetXml: sheet('<row r="1"><c r="A1"><v>1</v></row></c>') })), /mal cerrada/);
    assert.throws(() => readWorkbook(xlsxZip({ sheetXml: '<!DOCTYPE x [<!ENTITY a "b">]><worksheet/>' })), WorkbookError);
  });
  test('el escáner lee etiquetas, atributos con > entre comillas, comentarios y CDATA', () => {
    const seen = [];
    scanXml('<?xml version="1.0"?><!-- <x> --><a k="1>2" j=\'b\'><b/>t<![CDATA[<z>]]></a>', {
      open: (name, at, self) => seen.push(['open', name, at.k ?? null, self]),
      close: (name) => seen.push(['close', name]),
      text: (s) => seen.push(['text', s]),
    });
    assert.deepEqual(seen, [['open', 'a', '1>2', false], ['open', 'b', null, true], ['close', 'b'], ['text', 't'], ['text', '<z>'], ['close', 'a']]);
  });
  test('un índice de texto compartido inexistente es un libro dañado', () => {
    const cell = (v) => sheet(`<row r="1"><c r="A1" t="s"><v>${v}</v></c></row>`);
    for (const v of ['3', '-1', '1.5', 'x']) assert.throws(() => readWorkbook(xlsxZip({ sheetXml: cell(v), sst: '<sst><si><t>a</t></si></sst>' })), /texto que no existe/, v);
    assert.equal(readWorkbook(xlsxZip({ sheetXml: cell('0'), sst: '<sst><si><t>a</t></si></sst>' })).sheets[0].get(0, 0), 'a');
  });
});

describe('ZIP hostil', () => {
  test('índice cortado o que apunta fuera del archivo', () => {
    const good = xlsxZip();
    assert.throws(() => readWorkbook(buildZip(xlsxEntries(), { eocd: { offset: good.length * 2 } })), /fuera del archivo/);
    assert.throws(() => readWorkbook(buildZip(xlsxEntries(), { eocd: { count: 9 } })), /índice incompleto|fuera del archivo/);
    assert.throws(() => readWorkbook(buildZip(xlsxEntries({ over: { 'xl/workbook.xml': { local: 1_000_000 } } }))), /no se puede leer/);
  });
  test('tamaño declarado distinto del real y bomba de compresión más grande que lo declarado', () => {
    assert.throws(() => readWorkbook(buildZip(xlsxEntries({ over: { 'xl/workbook.xml': { usize: 5000 } } }))), /no coincide/);
    const bomb = zlib.deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
    assert.throws(() => readWorkbook(buildZip(xlsxEntries({ over: { 'xl/worksheets/sheet1.xml': { raw: bomb, usize: 1000 } } }))), /descomprimir/);
  });
  test('parte XML de más de 16 MB descomprimida: se rechaza sin descomprimirla', () => {
    assert.equal(ZIP_LIMITS.entryBytes, 16 * 1024 * 1024);
    const big = zlib.deflateRawSync(Buffer.alloc(17 * 1024 * 1024, 0x20));
    const err = fast(() => readWorkbook(buildZip(xlsxEntries({ over: { 'xl/worksheets/sheet1.xml': { raw: big, usize: 17 * 1024 * 1024 } } }))));
    assert.match(String(err && err.message), /demasiado grande/);
  });
  test('parte cifrada y ZIP64 (en el final o en una entrada)', () => {
    assert.throws(() => readWorkbook(buildZip(xlsxEntries({ over: { 'xl/workbook.xml': { flags: 1 } } }))), /contraseña/);
    assert.throws(() => readWorkbook(buildZip(xlsxEntries(), { eocd: { count: 0xffff } })), /ZIP64/);
    assert.throws(() => readWorkbook(buildZip(xlsxEntries({ over: { 'xl/workbook.xml': { usize: 0xffffffff } } }))), /ZIP64/);
  });
});

describe('worker', () => {
  test('arma el mismo plan que en el hilo principal', async () => {
    const buf = buildWorkbook(sampleSpec());
    const now = Date.parse('2025-11-30T15:00:00Z');
    const p = await planInWorker({ file: buf, server: EMPTY, decisions: {}, today: '2025-11-30', now });
    assert.deepEqual(p, planExcelImport(readExcelBook(buf), EMPTY, { today: '2025-11-30', now }));
  });
  test('un libro dañado vuelve como WorkbookError', async () => {
    await assert.rejects(planInWorker({ file: xlsxZip({ sheetXml: sheet('<row>') }), server: EMPTY, today: '2025-11-30' }), (e) => e instanceof WorkbookError && e.code === 'invalid_workbook');
  });
  test('si tarda más que el máximo, se corta el worker: import_timeout', async () => {
    await assert.rejects(planInWorker({ file: buildWorkbook(sampleSpec()), server: EMPTY, today: '2025-11-30' }, { timeoutMs: 1 }), (e) => e instanceof WorkbookError && e.code === 'import_timeout');
  });
});
