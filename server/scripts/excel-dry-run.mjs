// Vista previa local del importador del Excel anterior, sin base de datos: lee el libro como
// datos, arma el plan contra un servidor vacío (todos los legajos nuevos, kit base vacío) e
// imprime SOLO CANTIDADES (casos por tipo y totales). Nunca imprime nombres, legajos ni
// comentarios, y no escribe ningún archivo: el libro real vive en `privado/` y no se copia.
// Uso: node server/scripts/excel-dry-run.mjs [ruta.xlsm]   (por defecto, el primero de privado/)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readExcelBook, planInWorker, caseCounts, CASE_TYPES } from '../src/importers/excel-v1/index.js';
import { localDateISO } from '../src/domain/period.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESPECIALIDADES = ['Mecánico', 'Electricista', 'Electro-mecánico', 'Refrigeración', 'Soldador', 'Edilicio', 'Servicios Generales', 'Ingeniería', 'Pañolero'];

function defaultFile() {
  const dir = path.join(ROOT, 'privado');
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => /\.xls[xm]$/i.test(n)) : null;
  return f ? path.join(dir, f) : null;
}

const file = process.argv[2] || defaultFile();
if (!file) {
  console.error('No hay un .xlsx/.xlsm en privado/ (pasá la ruta como argumento).');
  process.exit(2);
}
const buf = fs.readFileSync(file);
const book = readExcelBook(buf);
const server = { techs: [], tools: [], especialidades: ESPECIALIDADES.map((name, i) => ({ id: `e${i}`, name })), baseKit: { id: 'kit-base', items: [] } };
// El plan, como en el servidor: en el worker con tiempo máximo.
const t0 = performance.now();
const plan = await planInWorker({ file: buf, server, decisions: {}, today: localDateISO(), now: Date.now() });
const workerMs = Math.round(performance.now() - t0);
const counts = caseCounts(plan.cases);
const out = {
  bytes: buf.length,
  workerMs,
  sha256Prefix: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8),
  sheets: { legajo: book.legajoSheets.length, sinFormato: book.legajoSheets.filter((s) => !s.layout).length, ignoradas: book.ignoredSheets.length, resumen: !!book.resumen, blanco: !!book.blanco, novedades: !!book.novedades },
  resumenColumns: book.resumen ? book.resumen.techs.length : 0,
  blancoTools: book.blanco ? book.blanco.tools.length : 0,
  novedadRows: book.novedades ? book.novedades.rows.length : 0,
  errors: plan.errors.map((e) => e.code),
  totals: plan.totals,
  cases: Object.fromEntries(CASE_TYPES.filter((t) => counts[t]).map((t) => [t, counts[t]])),
  skippableDefaultSkip: plan.cases.filter((c) => c.skippable && c.decision === 'skip').length,
};
console.log(JSON.stringify(out, null, 2));
