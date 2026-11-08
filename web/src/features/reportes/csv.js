// Celdas de CSV como 2.1 (separador `;`, comillas solo cuando hacen falta), con las fórmulas
// neutralizadas: una celda de texto que empieza con = + - @ tab o CR lleva un apóstrofo
// adelante, así una planilla la muestra como texto y no la ejecuta. Los números van tal cual.
// Puro: se prueba con node --test.
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(v) {
  let s = String(v ?? '');
  if (typeof v !== 'number' && FORMULA.test(s)) s = "'" + s;
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
