// Importador del Excel anterior de herramientas (.xlsx / .xlsm), puro: lectura del libro como
// datos, estructura de las hojas y plan de importación. Ver plan.js para las reglas. El servidor
// usa planInWorker (run.js): lectura y plan en un worker con tiempo y memoria máximos.
import { readWorkbook, WorkbookError } from './workbook.js';
import { parseBook } from './layout.js';
import { MAX_EXCEL_BYTES } from './run.js';

export { WorkbookError, MAX_EXCEL_BYTES };
export { planInWorker, WORKER_LIMITS } from './run.js';
export { planExcelImport, caseCounts, CASE_TYPES, PLAN_VERSION, MISSING_NOTE, NOTES } from './plan.js';

// Buffer del archivo -> estructura del Excel de herramientas (parseBook), en este hilo.
export function readExcelBook(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new WorkbookError('El archivo está vacío.');
  if (buf.length > MAX_EXCEL_BYTES) throw new WorkbookError(`El archivo supera ${MAX_EXCEL_BYTES / 1024 / 1024} MB.`, 'too_large');
  return parseBook(readWorkbook(buf));
}
