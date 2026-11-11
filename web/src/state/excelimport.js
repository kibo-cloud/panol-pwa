// Importar el Excel anterior (etapa 9), lógica pura de la pantalla: grupos de casos de la vista
// previa, decisiones locales (aceptar u omitir) contra las de la última vista previa, totales y
// chequeo del archivo antes de mandarlo.

export const MAX_EXCEL_BYTES = 10 * 1024 * 1024;

// Tipos de caso del servidor (importers/excel-v1/plan.js), en el mismo orden: título, tono e ícono.
export const CASE_INFO = {
  conflicto: { label: 'Legajos en conflicto (no se importan)', tone: 'bad', icon: 'x' },
  tecnico_nuevo: { label: 'Técnicos nuevos (sin plantilla)', tone: 'ok', icon: 'users' },
  tecnico_existente: { label: 'Técnicos existentes sin historial', tone: 'ok', icon: 'users' },
  legajo_sin_resumen: { label: 'Hojas de legajos que no están en RESUMEN', tone: 'warn', icon: 'alert' },
  legajo_repetido: { label: 'Legajos repetidos en RESUMEN', tone: 'warn', icon: 'alert' },
  legajo_invalido: { label: 'Legajos vacíos o inválidos', tone: 'warn', icon: 'alert' },
  especialidad_desconocida: { label: 'Especialidades que no existen', tone: 'warn', icon: 'info' },
  herramienta_nueva: { label: 'Herramientas nuevas', tone: 'ok', icon: 'box' },
  herramienta_no_importable: { label: 'Herramientas que no se pueden importar', tone: 'bad', icon: 'x' },
  kit_base: { label: 'Kit base (hoja BLANCO)', tone: 'ok', icon: 'box' },
  ajuste: { label: 'Entregas de ajuste (conteo sin entrega)', tone: 'warn', icon: 'swap' },
  faltante: { label: 'Faltantes (conteo menor a lo entregado)', tone: 'bad', icon: 'x' },
  conteo_vacio_probable: { label: 'Conteos probablemente sin llenar (quedan sin dato; Importar = faltante)', tone: 'pend', icon: 'info' },
  recambio: { label: 'Recambios (0,5)', tone: 'warn', icon: 'wrench' },
  devolucion: { label: 'Devoluciones y bajas', tone: 'ok', icon: 'swap' },
  devolucion_dudosa: { label: 'Devoluciones dudosas', tone: 'warn', icon: 'alert' },
  devolucion_05: { label: '0,5 en DEVOLUCIÓN ignorados', tone: 'pend', icon: 'info' },
  reposicion: { label: 'Reposiciones', tone: 'ok', icon: 'swap' },
  semana_duplicada: { label: 'Dos bloques en la misma semana', tone: 'warn', icon: 'cal' },
  bloque_sin_fecha: { label: 'Bloques sin fecha (no se importan)', tone: 'warn', icon: 'cal' },
  fecha_invalida: { label: 'Fechas inválidas o futuras (no se importan)', tone: 'warn', icon: 'cal' },
  bloque_vacio: { label: 'Bloques vacíos', tone: 'pend', icon: 'info' },
  hoja_sin_bloques: { label: 'Hojas sin bloques fechados', tone: 'pend', icon: 'info' },
  hoja_sin_formato: { label: 'Hojas sin el formato esperado', tone: 'warn', icon: 'alert' },
  hoja_ignorada: { label: 'Hojas que no son de legajos', tone: 'pend', icon: 'info' },
  valor_invalido: { label: 'Valores que no son números', tone: 'warn', icon: 'alert' },
  novedad_sin_tecnico: { label: 'Novedades sin técnico', tone: 'warn', icon: 'note' },
  novedad_invalida: { label: 'Novedades que no se importan', tone: 'warn', icon: 'note' },
  novedad_recortada: { label: 'Novedades recortadas', tone: 'pend', icon: 'note' },
};
const ORDER = Object.keys(CASE_INFO);

// Decisión vigente de un caso: la local, si no la que vino en la vista previa.
export const decisionOf = (c, local) => (c.skippable ? local[c.id] || c.decision : null);

// [{ type, label, tone, icon, cases, skippable, skipped }] en el orden de los tipos.
export function groupCases(cases, local = {}) {
  const by = new Map();
  for (const c of cases) {
    if (!by.has(c.type)) by.set(c.type, []);
    by.get(c.type).push(c);
  }
  const rank = (t) => (ORDER.includes(t) ? ORDER.indexOf(t) : ORDER.length);
  return [...by.keys()].sort((a, b) => rank(a) - rank(b)).map((type) => {
    const list = by.get(type);
    const info = CASE_INFO[type] || { label: type, tone: 'pend', icon: 'info' };
    return { type, ...info, cases: list, skippable: list.some((c) => c.skippable), skipped: list.filter((c) => decisionOf(c, local) === 'skip').length };
  });
}

// Decisiones elegidas a mano: { id: 'accept' | 'skip' } (solo casos que se pueden omitir).
export function setDecision(local, cases, id, value) {
  const c = cases.find((x) => x.id === id);
  if (!c || !c.skippable || (value !== 'accept' && value !== 'skip')) return local;
  return { ...local, [id]: value };
}
export function setGroupDecision(local, cases, type, value) {
  let out = local;
  for (const c of cases) if (c.type === type) out = setDecision(out, cases, c.id, value);
  return out;
}
export const decisionsOf = (local) => Object.fromEntries(Object.entries(local).sort(([a], [b]) => (a < b ? -1 : 1)));
export const sameDecisions = (a, b) => JSON.stringify(decisionsOf(a || {})) === JSON.stringify(decisionsOf(b || {}));

const TOTALS = [
  ['techsCreate', 'Técnicos nuevos'], ['techsAttach', 'Técnicos existentes'], ['toolsCreate', 'Herramientas nuevas'], ['toolsMatched', 'Herramientas que ya existían'],
  ['kitItems', 'Herramientas del kit base'], ['controls', 'Controles'], ['corrections', 'Controles de la misma semana (historial)'], ['entregas', 'Entregas'],
  ['ajustes', 'Entregas de ajuste'], ['reposiciones', 'Reposiciones'], ['devoluciones', 'Devoluciones'], ['bajas', 'Bajas'], ['novedades', 'Novedades'],
];
// [[etiqueta, cantidad]] sin los ceros.
export const totalsRows = (t = {}) => TOTALS.filter(([k]) => t[k]).map(([k, l]) => [l, t[k]]);

// null si el archivo se puede mandar; si no, el motivo.
export function checkFile(f) {
  if (!f || !/\.(xlsx|xlsm)$/i.test(f.name || '')) return 'Elegí el archivo de Excel (.xlsx o .xlsm).';
  if (f.size > MAX_EXCEL_BYTES) return `El archivo supera ${MAX_EXCEL_BYTES / 1024 / 1024} MB.`;
  if (!f.size) return 'El archivo está vacío.';
  return null;
}

// Bytes -> base64 (en partes, para no pasar millones de argumentos a fromCharCode).
export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
