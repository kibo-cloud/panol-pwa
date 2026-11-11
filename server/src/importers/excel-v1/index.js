// Importador del Excel anterior de herramientas (.xlsx / .xlsm), puro: lectura del libro como
// datos, estructura de las hojas y plan de importación. Ver plan.js para las reglas.
import { readWorkbook, WorkbookError } from './workbook.js';
import { parseBook } from './layout.js';

export { WorkbookError };
export { planExcelImport, caseCounts, CASE_TYPES, PLAN_VERSION, MISSING_NOTE, NOTES } from './plan.js';

export const MAX_EXCEL_BYTES = 10 * 1024 * 1024;

// Buffer del archivo -> estructura del Excel de herramientas (parseBook).
export function readExcelBook(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new WorkbookError('El archivo está vacío.');
  if (buf.length > MAX_EXCEL_BYTES) throw new WorkbookError(`El archivo supera ${MAX_EXCEL_BYTES / 1024 / 1024} MB.`, 'too_large');
  return parseBook(readWorkbook(buf));
}
