// Estructura del Excel anterior de herramientas (puro): hojas RESUMEN, BLANCO, NOVEDADES y una
// hoja por legajo con bloques de 3 columnas (ENTREGA, DEVOLUCIÓN, CONTEO) bajo una fecha.
// Detecta las filas y columnas por sus rótulos (no por posición fija) y devuelve los valores
// tal como están; la interpretación (fechas, 0,5, reglas) es de plan.js.
//
// Diseño de las hojas (el del instructivo):
// - Hoja de legajo y BLANCO: fila de rótulos con C=ENTREGA, D=DEVOLUCIÓN, E=CONTEO, F=SALDO
//   (resumen) y, desde H, un bloque por control (ENTREGA, DEVOLUCIÓN, CONTEO); la fecha del
//   bloque está en la fila de arriba (celdas combinadas: el valor queda en la primera). Debajo,
//   TOTAL HERRAMIENTAS y una fila por herramienta (nombre en B). El + de Excel agrega el bloque
//   nuevo a la izquierda, así que los bloques no siempre están en orden de fecha.
// - RESUMEN: B=ÚLTIMO CONTROL; arriba de esa fila, legajo, especialidad y nombre de cada técnico
//   (una columna por técnico desde E); debajo, HERRAMIENTAS y la lista de herramientas.
// - NOVEDADES: rótulos FECHA, HORA, LEGAJO, COMENTARIO y una novedad por fila.

export const KNOWN_SHEETS = ['RESUMEN', 'BLANCO', 'NOVEDADES', 'CRONOGRAMA'];
const MAX_SCAN = 40;

// Texto comparable: sin tildes, mayúsculas, espacios simples.
export function norm(v) {
  return String(v ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
// Texto para mostrar o guardar: espacios simples (los rótulos de Excel traen saltos de línea).
export const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Legajo como texto: los números enteros sin decimales.
export function legajoOf(v) {
  return typeof v === 'number' ? String(v) : clean(v);
}

function findRow(sh, test, from = 0, to = MAX_SCAN) {
  for (let r = from; r <= Math.min(sh.maxR, to); r++) if (test(r)) return r;
  return -1;
}

// Hoja con el diseño de legajo (o BLANCO): { header, dateRow, tools: [{ row, name }], blocks:
// [{ col, date, rows: { [row]: { e, d, c } } }] } o null si no tiene ese diseño.
export function parseLegajoSheet(sh) {
  const header = findRow(sh, (r) => norm(sh.get(r, 2)) === 'ENTREGA' && norm(sh.get(r, 3)).startsWith('DEVOLUCI') && norm(sh.get(r, 4)) === 'CONTEO');
  if (header < 1) return null;
  const tools = [];
  for (let r = header + 1; r <= sh.maxR; r++) {
    const v = sh.get(r, 1);
    const name = clean(v);
    if (!name || norm(name).startsWith('TOTAL')) continue;
    tools.push({ row: r, name });
  }
  const blocks = [];
  for (let c = 6; c <= sh.maxC; c++) {
    if (norm(sh.get(header, c)) !== 'ENTREGA' || !norm(sh.get(header, c + 1)).startsWith('DEVOLUCI') || norm(sh.get(header, c + 2)) !== 'CONTEO') continue;
    const date = [c, c + 1, c + 2].map((x) => sh.get(header - 1, x)).find((x) => x !== null) ?? null;
    const rows = {};
    for (const t of tools) rows[t.row] = { e: sh.get(t.row, c), d: sh.get(t.row, c + 1), c: sh.get(t.row, c + 2) };
    blocks.push({ col: c, date, rows });
    c += 2;
  }
  return { header, dateRow: header - 1, tools, blocks };
}

// RESUMEN: { techs: [{ col, legajo, name, especialidad }], tools: [nombre] } o null.
export function parseResumen(sh) {
  const rU = findRow(sh, (r) => norm(sh.get(r, 1)) === 'ULTIMO CONTROL');
  if (rU < 3) return null;
  const techs = [];
  for (let c = 4; c <= sh.maxC; c++) {
    const raw = sh.get(rU - 1, c);
    if (raw === null || clean(raw) === '') continue;
    techs.push({ col: c, legajo: legajoOf(raw), name: clean(sh.get(rU - 3, c)), especialidad: clean(sh.get(rU - 2, c)) });
  }
  const rH = findRow(sh, (r) => norm(sh.get(r, 1)) === 'HERRAMIENTAS', rU + 1, rU + 10);
  const tools = [];
  if (rH >= 0) for (let r = rH + 1; r <= sh.maxR; r++) { const n = clean(sh.get(r, 1)); if (n) tools.push(n); }
  return { techs, tools };
}

// NOVEDADES: { rows: [{ row, fecha, hora, legajo, comentario }] } o null.
export function parseNovedades(sh) {
  let head = -1;
  let cols = null;
  for (let r = 0; r <= Math.min(sh.maxR, MAX_SCAN) && head < 0; r++) {
    const m = {};
    for (let c = 0; c <= Math.min(sh.maxC, 30); c++) {
      const n = norm(sh.get(r, c));
      if (n === 'FECHA' && m.fecha == null) m.fecha = c;
      else if (n === 'HORA' && m.hora == null) m.hora = c;
      else if (n === 'LEGAJO' && m.legajo == null) m.legajo = c;
      else if (n.startsWith('COMENTARIO') && m.comentario == null) m.comentario = c;
    }
    if (m.fecha != null && m.comentario != null) { head = r; cols = m; }
  }
  if (head < 0) return null;
  const at = (r, k) => (cols[k] == null ? null : sh.get(r, cols[k]));
  const rows = [];
  for (let r = head + 1; r <= sh.maxR; r++) {
    const row = { row: r, fecha: at(r, 'fecha'), hora: at(r, 'hora'), legajo: at(r, 'legajo'), comentario: at(r, 'comentario') };
    if ([row.fecha, row.hora, row.legajo, row.comentario].some((v) => v !== null && clean(v) !== '')) rows.push(row);
  }
  return { rows };
}

// Libro completo -> estructura del Excel de herramientas.
export function parseBook(wb) {
  const byName = new Map(wb.sheets.map((s) => [norm(s.name), s]));
  const res = byName.get('RESUMEN') ? parseResumen(byName.get('RESUMEN')) : null;
  const blancoSheet = byName.get('BLANCO');
  const blanco = blancoSheet ? parseLegajoSheet(blancoSheet) : null;
  const nov = byName.get('NOVEDADES') ? parseNovedades(byName.get('NOVEDADES')) : null;
  const resLegajos = new Set((res ? res.techs : []).map((t) => norm(t.legajo)));
  const legajoSheets = [];
  const ignored = [];
  for (const s of wb.sheets) {
    const n = norm(s.name);
    if (KNOWN_SHEETS.includes(n)) continue;
    if (!/^\d+$/.test(n) && !resLegajos.has(n)) { ignored.push(clean(s.name)); continue; }
    legajoSheets.push({ name: clean(s.name), legajo: clean(s.name), layout: parseLegajoSheet(s) });
  }
  return {
    date1904: !!wb.date1904,
    resumen: res,
    blanco: blanco ? { tools: blanco.tools.map((t) => t.name) } : null,
    novedades: nov,
    legajoSheets,
    ignoredSheets: ignored,
  };
}
