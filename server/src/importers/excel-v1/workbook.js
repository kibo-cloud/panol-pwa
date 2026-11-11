// Lectura de un libro .xlsx / .xlsm como datos (puro, sin dependencias): nombres de las hojas y
// el valor de cada celda (número, texto o booleano). No se leen fórmulas (solo el último valor
// calculado que guardó Excel), estilos, macros (`vbaProject.bin`), vínculos ni objetos.
import { openZip, ZipError } from './zip.js';

export class WorkbookError extends Error {
  constructor(message, code = 'invalid_workbook') {
    super(message);
    this.name = 'WorkbookError';
    this.code = code;
  }
}

export const WB_LIMITS = Object.freeze({ sheets: 300, cells: 3_000_000, maxRow: 1_048_576, maxCol: 16_384, text: 32_767 });

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
// Entidades XML y los escapes `_xHHHH_` de OOXML.
export function xmlText(s) {
  return String(s)
    .replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (m, e) => {
      if (e[0] !== '#') return ENT[e];
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

// Atributos de una etiqueta (sin prefijo de espacio de nombres en la clave: `r:id` -> `id`
// queda también como `r:id`).
export function attrs(s) {
  const o = Object.create(null);
  for (const m of String(s).matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) o[m[1]] = xmlText(m[3] ?? m[4] ?? '');
  return o;
}

// "B12" -> { r: 11, c: 1 } (base 0).
export function decodeRef(ref) {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(String(ref).toUpperCase());
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}
export function encodeCol(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Texto de un <si> o <is>: todas las corridas <t>, sin las lecturas fonéticas (<rPh>).
function richText(xml) {
  const body = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of body.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += xmlText(m[1] ?? '');
  return out;
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => richText(m[1] ?? ''));
}

// Celdas de una hoja: Map "r,c" -> valor. Se guardan solo las que tienen valor.
function sheetCells(xml, sst, budget) {
  const cells = new Map();
  let maxR = -1;
  let maxC = -1;
  let rowIdx = -1;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]);
    rowIdx = ra.r ? Number(ra.r) - 1 : rowIdx + 1;
    if (!rm[2]) continue;
    let colIdx = -1;
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cm[1]);
      const ref = a.r ? decodeRef(a.r) : null;
      const r = ref ? ref.r : rowIdx;
      const c = ref ? ref.c : colIdx + 1;
      colIdx = c;
      if (!(r >= 0 && r < WB_LIMITS.maxRow && c >= 0 && c < WB_LIMITS.maxCol)) throw new WorkbookError('El libro tiene celdas fuera de los límites de Excel.');
      const inner = cm[2] || '';
      const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      const raw = vm ? xmlText(vm[1]) : null;
      let v = null;
      const t = a.t || 'n';
      if (t === 's') v = raw == null ? null : sst[Number(raw)] ?? null;
      else if (t === 'inlineStr') v = richText((/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner) || [])[1] ?? '');
      else if (t === 'str') v = raw;
      else if (t === 'b') v = raw == null ? null : raw.trim() === '1';
      else if (t === 'e') v = null;
      else if (raw != null && raw.trim() !== '') {
        const n = Number(raw);
        v = Number.isFinite(n) ? n : null;
      }
      if (typeof v === 'string' && v.length > WB_LIMITS.text) v = v.slice(0, WB_LIMITS.text);
      if (v === null || v === '') continue;
      if (++budget.n > WB_LIMITS.cells) throw new WorkbookError('El libro tiene demasiadas celdas para importarlo.');
      cells.set(`${r},${c}`, v);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
  }
  return { cells, maxR, maxC };
}

// Ruta de una relación del libro (relativa a `xl/` o absoluta desde la raíz).
const relPath = (target) => (target.startsWith('/') ? target.slice(1) : `xl/${target}`).replace(/\/\.\//g, '/');

// buf: el archivo. Devuelve { date1904, sheets: [{ name, cells, maxR, maxC, get(r, c) }] }.
export function readWorkbook(buf) {
  let zip;
  try {
    zip = openZip(buf);
  } catch (err) {
    if (err instanceof ZipError) throw new WorkbookError(err.message);
    throw err;
  }
  const text = (name) => {
    try {
      const b = zip.read(name);
      return b ? b.toString('utf8') : null;
    } catch (err) {
      if (err instanceof ZipError) throw new WorkbookError(err.message);
      throw err;
    }
  };
  const wbXml = text('xl/workbook.xml');
  if (!wbXml) throw new WorkbookError('El archivo no es un libro de Excel (.xlsx o .xlsm).');
  const relsXml = text('xl/_rels/workbook.xml.rels') || '';
  const rels = Object.create(null);
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) rels[a.Id] = { target: a.Target, type: a.Type || '' };
  }
  const prMatch = /<workbookPr\b([^>]*?)\/?>/.exec(wbXml);
  const pr = prMatch ? attrs(prMatch[1]) : {};
  const date1904 = pr.date1904 === '1' || pr.date1904 === 'true';
  const list = [...wbXml.matchAll(/<sheet\b([^>]*?)\/?>/g)].map((m) => attrs(m[1]));
  if (list.length > WB_LIMITS.sheets) throw new WorkbookError('El libro tiene demasiadas hojas para importarlo.');
  const sst = sharedStrings(text('xl/sharedStrings.xml'));
  const budget = { n: 0 };
  const sheets = [];
  for (const s of list) {
    const rel = rels[s['r:id']];
    // Solo hojas de cálculo (no gráficos ni hojas de macros).
    if (!rel || !/\/worksheet$/.test(rel.type)) continue;
    const xml = text(relPath(rel.target));
    if (xml == null) continue;
    const { cells, maxR, maxC } = sheetCells(xml, sst, budget);
    sheets.push({ name: String(s.name ?? ''), cells, maxR, maxC, get: (r, c) => cells.get(`${r},${c}`) ?? null });
  }
  return { date1904, sheets };
}
