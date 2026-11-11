// Lectura de un libro .xlsx / .xlsm como datos (puro, sin dependencias): nombres de las hojas y
// el valor de cada celda (número, texto o booleano). No se leen fórmulas (solo el último valor
// calculado que guardó Excel), estilos, macros (`vbaProject.bin`), vínculos ni objetos.
// El XML se recorre con un escáner lineal (indexOf, sin expresiones con retroceso): una etiqueta
// que no se cierra corta la lectura enseguida con un error claro (E9.V1).
import { openZip, ZipError } from './zip.js';

export class WorkbookError extends Error {
  constructor(message, code = 'invalid_workbook') {
    super(message);
    this.name = 'WorkbookError';
    this.code = code;
  }
}

export const WB_LIMITS = Object.freeze({ sheets: 300, cells: 3_000_000, maxRow: 1_048_576, maxCol: 16_384, text: 32_767 });

const damaged = (what) => new WorkbookError(`El archivo está dañado: ${what}.`);

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
// Entidades XML y los escapes `_xHHHH_` de OOXML (expresiones acotadas: lineales).
export function xmlText(s) {
  const str = String(s);
  if (str.indexOf('&') < 0 && str.indexOf('_x') < 0) return str;
  return str
    .replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (m, e) => {
      if (e[0] !== '#') return ENT[e];
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

const isSpace = (ch) => ch === 32 || ch === 9 || ch === 10 || ch === 13;
// Nombre sin prefijo de espacio de nombres (`x:row` -> `row`).
const local = (name) => { const i = name.indexOf(':'); return i < 0 ? name : name.slice(i + 1); };

// Atributos de una etiqueta, de s[from] a s[to] (lineal). Las claves quedan tal cual (`r:id`).
function parseAttrs(s, from, to) {
  const o = Object.create(null);
  let i = from;
  for (;;) {
    while (i < to && isSpace(s.charCodeAt(i))) i++;
    if (i >= to) return o;
    const k0 = i;
    while (i < to && !isSpace(s.charCodeAt(i)) && s.charCodeAt(i) !== 61) i++;
    const key = s.slice(k0, i);
    while (i < to && isSpace(s.charCodeAt(i))) i++;
    if (!key || s.charCodeAt(i) !== 61) throw damaged('una etiqueta está mal formada');
    i++;
    while (i < to && isSpace(s.charCodeAt(i))) i++;
    const q = s.charCodeAt(i);
    if (q !== 34 && q !== 39) throw damaged('una etiqueta está mal formada');
    const end = s.indexOf(q === 34 ? '"' : "'", i + 1);
    if (end < 0 || end >= to) throw damaged('una etiqueta está mal formada');
    o[key] = xmlText(s.slice(i + 1, end));
    i = end + 1;
  }
}

// Recorre el XML una sola vez: h.open(nombre, atributos, autocerrada), h.close(nombre) y
// h.text(texto) (entidades ya resueltas; CDATA tal cual). Los nombres van sin prefijo. Una
// etiqueta sin cerrar, mal cerrada o un DOCTYPE (no hay en OOXML) es un libro dañado.
export function scanXml(xml, h = {}) {
  const n = xml.length;
  const stack = [];
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i && h.text) h.text(xmlText(xml.slice(i, textEnd)));
    if (lt < 0) break;
    const c1 = xml.charCodeAt(lt + 1);
    if (c1 === 33) { // !
      if (xml.startsWith('<!--', lt)) {
        const e = xml.indexOf('-->', lt + 4);
        if (e < 0) throw damaged('un comentario no se cierra');
        i = e + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const e = xml.indexOf(']]>', lt + 9);
        if (e < 0) throw damaged('una etiqueta no se cierra');
        if (h.text) h.text(xml.slice(lt + 9, e));
        i = e + 3;
        continue;
      }
      throw damaged('tiene una declaración que no corresponde a un libro de Excel');
    }
    if (c1 === 63) { // ?
      const e = xml.indexOf('?>', lt + 2);
      if (e < 0) throw damaged('una etiqueta no se cierra');
      i = e + 2;
      continue;
    }
    // Fin de la etiqueta: el primer > fuera de comillas.
    let j = lt + 1;
    let q = 0;
    for (; j < n; j++) {
      const ch = xml.charCodeAt(j);
      if (q) { if (ch === q) q = 0; } else if (ch === 34 || ch === 39) q = ch;
      else if (ch === 62) break;
    }
    if (j >= n) throw damaged('una etiqueta no se cierra');
    if (c1 === 47) { // </nombre>
      let e = j;
      while (e > lt + 2 && isSpace(xml.charCodeAt(e - 1))) e--;
      const name = xml.slice(lt + 2, e);
      if (stack.pop() !== name) throw damaged('una etiqueta está mal cerrada');
      if (h.close) h.close(local(name));
    } else {
      const self = xml.charCodeAt(j - 1) === 47;
      const end = self ? j - 1 : j;
      let k = lt + 1;
      while (k < end && !isSpace(xml.charCodeAt(k))) k++;
      const name = xml.slice(lt + 1, k);
      if (!name) throw damaged('una etiqueta está mal formada');
      const ln = local(name);
      if (h.open) h.open(ln, h.attrs === false ? null : parseAttrs(xml, k, end), self);
      if (self) { if (h.close) h.close(ln); } else stack.push(name);
    }
    i = j + 1;
  }
  if (stack.length) throw damaged('una etiqueta no se cierra');
}

// "B12" -> { r: 11, c: 1 } (base 0).
export function decodeRef(ref) {
  const s = String(ref);
  if (s.length > 10) return null;
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(s.toUpperCase());
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

// Textos compartidos: el texto de cada <si> (todas las corridas <t>, sin las lecturas
// fonéticas <rPh>).
function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  let inSi = false;
  let rph = 0;
  let inT = false;
  let cur = '';
  scanXml(xml, {
    open(name, a, self) {
      if (name === 'si') { inSi = true; cur = ''; } else if (name === 'rPh') rph++;
      else if (name === 't' && inSi && !rph && !self) inT = true;
    },
    close(name) {
      if (name === 'si') { if (inSi) out.push(cur); inSi = false; } else if (name === 'rPh') rph--;
      else if (name === 't') inT = false;
    },
    text(s) { if (inT) cur += s; },
  });
  return out;
}

// Celdas de una hoja: Map "r,c" -> valor. Se guardan solo las que tienen valor.
function sheetCells(xml, sst, budget) {
  const cells = new Map();
  let maxR = -1;
  let maxC = -1;
  let rowIdx = -1;
  let colIdx = -1;
  let cell = null; // { r, c, t, v: texto de <v> | null, is: texto de <is> }
  let inV = false;
  let inIs = 0;
  let inT = false;
  let rph = 0;
  const finish = () => {
    const raw = cell.v;
    let v = null;
    const t = cell.t || 'n';
    if (t === 's') {
      if (raw != null && raw.trim() !== '') {
        const s = raw.trim();
        const k = /^\d{1,9}$/.test(s) ? Number(s) : -1;
        if (!(k >= 0 && k < sst.length)) throw damaged('una celda apunta a un texto que no existe');
        v = sst[k];
      }
    } else if (t === 'inlineStr') v = cell.is;
    else if (t === 'str') v = raw;
    else if (t === 'b') v = raw == null ? null : raw.trim() === '1';
    else if (t === 'e') v = null;
    else if (raw != null && raw.trim() !== '') {
      const num = Number(raw);
      v = Number.isFinite(num) ? num : null;
    }
    if (typeof v === 'string' && v.length > WB_LIMITS.text) v = v.slice(0, WB_LIMITS.text);
    if (v === null || v === '') return;
    if (++budget.n > WB_LIMITS.cells) throw new WorkbookError('El libro tiene demasiadas celdas para importarlo.');
    cells.set(`${cell.r},${cell.c}`, v);
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c > maxC) maxC = cell.c;
  };
  scanXml(xml, {
    open(name, a) {
      if (name === 'row') {
        rowIdx = a.r ? Number(a.r) - 1 : rowIdx + 1;
        colIdx = -1;
      } else if (name === 'c') {
        const ref = a.r ? decodeRef(a.r) : null;
        const r = ref ? ref.r : rowIdx;
        const c = ref ? ref.c : colIdx + 1;
        colIdx = c;
        if (!(r >= 0 && r < WB_LIMITS.maxRow && c >= 0 && c < WB_LIMITS.maxCol)) throw new WorkbookError('El libro tiene celdas fuera de los límites de Excel.');
        cell = { r, c, t: a.t, v: null, is: '' };
      } else if (cell) {
        if (name === 'v') { inV = true; cell.v = ''; } else if (name === 'is') inIs++;
        else if (name === 'rPh') rph++;
        else if (name === 't' && inIs && !rph) inT = true;
      }
    },
    close(name) {
      if (name === 'c') { if (cell) finish(); cell = null; inV = false; inIs = 0; inT = false; rph = 0; } else if (name === 'v') inV = false;
      else if (name === 'is') inIs--;
      else if (name === 'rPh') rph--;
      else if (name === 't') inT = false;
    },
    text(s) {
      if (!cell) return;
      if (inV) cell.v += s;
      else if (inT) cell.is += s;
    },
  });
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
  const rels = Object.create(null);
  scanXml(text('xl/_rels/workbook.xml.rels') || '', {
    open(name, a) { if (name === 'Relationship' && a.Id && a.Target) rels[a.Id] = { target: a.Target, type: a.Type || '' }; },
  });
  let date1904 = false;
  const list = [];
  scanXml(wbXml, {
    open(name, a) {
      if (name === 'workbookPr') date1904 = a.date1904 === '1' || a.date1904 === 'true';
      else if (name === 'sheet') {
        list.push(a);
        if (list.length > WB_LIMITS.sheets) throw new WorkbookError('El libro tiene demasiadas hojas para importarlo.');
      }
    },
  });
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
