// Worker del importador del Excel (E9.V1): lee el libro y arma el plan fuera del hilo principal,
// para que ningún archivo bloquee el servidor. Recibe { file, server, decisions, today, now } y
// devuelve { ok: true, plan } o { ok: false, error: { message, code } }.
import { parentPort, workerData } from 'node:worker_threads';
import { readWorkbook, WorkbookError } from './workbook.js';
import { parseBook } from './layout.js';
import { planExcelImport } from './plan.js';

const { file, server, decisions, today, now } = workerData;
try {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  const plan = planExcelImport(parseBook(readWorkbook(buf)), server, { decisions: decisions || {}, today, now });
  parentPort.postMessage({ ok: true, plan });
} catch (err) {
  if (err instanceof WorkbookError) parentPort.postMessage({ ok: false, error: { message: err.message, code: err.code } });
  else parentPort.postMessage({ ok: false, error: { message: String((err && err.stack) || err), code: 'internal' } });
}
