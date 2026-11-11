// Libros de Excel de prueba con el diseño del Excel anterior de herramientas, generados con la
// dependencia de desarrollo `xlsx` y datos inventados (nunca el archivo real de `privado/`).
// - RESUMEN: nombre, especialidad y legajo por columna (desde E), ÚLTIMO CONTROL y la lista de
//   herramientas.
// - BLANCO y una hoja por legajo: rótulos ENTREGA / DEVOLUCIÓN / CONTEO / SALDO, TOTAL
//   HERRAMIENTAS, una fila por herramienta y un bloque de 3 columnas por control desde H, con
//   la fecha arriba (los bloques van en el orden de columnas que se pida: en el Excel real el
//   más nuevo queda a la izquierda).
// - NOVEDADES: FECHA, HORA, LEGAJO, COMENTARIO.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// Número de serie de Excel (sistema 1900) de un día 'AAAA-MM-DD'.
export const serial = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
};

const cellOf = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return { t: 'n', v };
  if (typeof v === 'boolean') return { t: 'b', v };
  if (typeof v === 'object' && v.date) return { t: 'n', v: serial(v.date), z: 'dd/mm/yyyy' };
  if (typeof v === 'object' && 'time' in v) return { t: 'n', v: v.time, z: 'hh:mm' };
  return { t: 's', v: String(v) };
};

function sheetFrom(cells) {
  const ws = {};
  let maxR = 0;
  let maxC = 0;
  for (const [r, c, v] of cells) {
    const x = cellOf(v);
    if (!x) continue;
    ws[XLSX.utils.encode_cell({ r, c })] = x;
    maxR = Math.max(maxR, r);
    maxC = Math.max(maxC, c);
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  return ws;
}

// Hoja de legajo (o BLANCO): label en B6, herramientas desde la fila 8, bloques desde H.
// blocks: [{ date: 'AAAA-MM-DD' | null | valor crudo, cells: { [herramienta]: { e, d, c } } }]
export function legajoSheet(label, tools, blocks = []) {
  const cells = [[4, 1, 'HERRAMIENTAS\r\nPOR TÉCNICO'], [4, 2, 'RESUMEN HASTA\r\nÚLTIMO CONTEO'], [5, 1, label], [5, 2, 'ENTREGA'], [5, 3, 'DEVOLUCIÓN'], [5, 4, 'CONTEO'], [5, 5, 'SALDO'], [6, 1, 'TOTAL HERRAMIENTAS']];
  tools.forEach((t, i) => { cells.push([7 + i, 1, t], [7 + i, 2, 0], [7 + i, 3, 0], [7 + i, 4, 0], [7 + i, 5, 0]); });
  blocks.forEach((b, j) => {
    const c0 = 7 + j * 3;
    const date = b.date === null || b.date === undefined ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? { date: b.date } : b.date;
    cells.push([4, c0, date], [5, c0, 'ENTREGA'], [5, c0 + 1, 'DEVOLUCIÓN'], [5, c0 + 2, 'CONTEO']);
    tools.forEach((t, i) => {
      const v = (b.cells || {})[t];
      if (!v) return;
      cells.push([7 + i, c0, v.e], [7 + i, c0 + 1, v.d], [7 + i, c0 + 2, v.c]);
    });
  });
  return sheetFrom(cells);
}

export function resumenSheet(tools, techs) {
  const cells = [[2, 1, 'EXISTENCIA DE HERRAMIENTAS\r\nPOR TÉCNICO'], [5, 1, 'ÚLTIMO CONTROL'], [6, 1, 'DÍAS DESDE ÚLTIMO CONTROL'], [7, 1, 'HERRAMIENTAS FALTANTES'], [8, 1, 'HERRAMIENTAS'], [8, 2, 'TOTAL'], [8, 3, 'MAL ESTADO']];
  techs.forEach((t, j) => cells.push([2, 4 + j, t.name], [3, 4 + j, t.especialidad ?? ''], [4, 4 + j, t.legajo], [5, 4 + j, 0], [6, 4 + j, 0]));
  tools.forEach((t, i) => cells.push([9 + i, 1, t], [9 + i, 2, 0], [9 + i, 3, 0]));
  return sheetFrom(cells);
}

export function novedadesSheet(rows) {
  const cells = [[1, 3, 'REGISTRO DE NOVEDADES'], [6, 1, 'FECHA'], [6, 2, 'HORA'], [6, 3, 'LEGAJO'], [6, 4, 'COMENTARIO']];
  rows.forEach((r, i) => cells.push([7 + i, 1, r.fecha ? { date: r.fecha } : r.fechaRaw ?? null], [7 + i, 2, r.hora != null ? { time: r.hora } : null], [7 + i, 3, r.legajo ?? null], [7 + i, 4, r.comentario ?? null]));
  return sheetFrom(cells);
}

// spec: { tools: [nombre], techs: [{ legajo, name, especialidad }], sheets: { [legajo]: { blocks,
//   tools? } }, novedades?: [{ fecha, hora (fracción del día), legajo, comentario }], blanco?: false,
//   resumen?: false, extra?: { [nombre]: celdas } }
export function buildWorkbook(spec, { bookType = 'xlsx' } = {}) {
  const wb = XLSX.utils.book_new();
  if (spec.novedades) XLSX.utils.book_append_sheet(wb, novedadesSheet(spec.novedades), 'NOVEDADES');
  if (spec.resumen !== false) XLSX.utils.book_append_sheet(wb, resumenSheet(spec.tools, spec.techs || []), 'RESUMEN');
  if (spec.blanco !== false) XLSX.utils.book_append_sheet(wb, legajoSheet('BLANCO', spec.tools), 'BLANCO');
  for (const [legajo, s] of Object.entries(spec.sheets || {})) XLSX.utils.book_append_sheet(wb, legajoSheet(legajo, s.tools || spec.tools, s.blocks), legajo);
  for (const [name, cells] of Object.entries(spec.extra || {})) XLSX.utils.book_append_sheet(wb, sheetFrom(cells), name);
  return XLSX.write(wb, { type: 'buffer', bookType });
}

// Libro de ejemplo (inventado) con los casos típicos: entrega inicial, conteos sin entrega,
// 0,5 con y sin su par en DEVOLUCIÓN, faltante, devolución, dos bloques en una semana y
// novedades. Lo usan las pruebas de integración y la E2E.
export const SAMPLE_TOOLS = ['Alicate', 'Pinza', 'Martillo', 'Destornillador Plano', 'Cinta Métrica'];
export function sampleSpec() {
  return {
    tools: SAMPLE_TOOLS,
    techs: [
      { legajo: 9101, name: 'Ana Prueba', especialidad: 'Mecánico' },
      { legajo: 9102, name: 'Beto Ensayo', especialidad: 'Electricista' },
      { legajo: 9103, name: 'Caja Producción', especialidad: '' },
    ],
    sheets: {
      // El bloque más nuevo a la izquierda, como en el Excel real.
      9101: {
        blocks: [
          { date: '2025-10-16', cells: { Alicate: { c: 1 }, Pinza: { c: 0.5, d: 0.5 }, Martillo: { c: 0 } } },
          { date: '2025-10-15', cells: { Alicate: { c: 1 }, Pinza: { c: 1 }, Martillo: { c: 1 } } },
          { date: '2025-10-02', cells: { Alicate: { e: 1, c: 1 }, Pinza: { c: 1 }, Martillo: { e: 1, c: 1 } } },
        ],
      },
      9102: {
        blocks: [
          { date: '2025-10-20', cells: { Alicate: { d: 1, c: 0 }, 'Cinta Métrica': { c: 0.5 } } },
          { date: '2025-10-06', cells: { Alicate: { e: 1, c: 1 }, 'Cinta Métrica': { e: 1, c: 1 } } },
        ],
      },
    },
    novedades: [
      { fecha: '2025-10-15', hora: 0.5, legajo: 9101, comentario: 'Pidió una pinza nueva' },
      { fecha: '2025-10-21', hora: 0.375, legajo: 7777, comentario: 'Aviso de un legajo que no está' },
    ],
  };
}
