// Plan de importación del Excel anterior (puro, sin I/O): a partir de la estructura del libro
// (layout.js) y de lo que hay en el servidor, arma la lista de casos (cada supuesto, con su id
// estable y, cuando tiene sentido, aceptar u omitir) y las operaciones a aplicar en orden.
// No escribe nada: la aplicación las aplica en una sola transacción (application/excel-import.js).
//
// Reglas (PEDIDO §2.12, decisiones de la etapa 9; ver odd/tasks/v3-servidor.md):
// - Técnicos y referentes desde RESUMEN (legajo, nombre, especialidad), sin plantilla. Un legajo
//   con historial operativo en el servidor (o eliminado o inactivo) es un conflicto: no se importa
//   nada de su hoja. Uno existente sin historial recibe los datos importados.
// - Herramientas por cantidad, en el orden del Excel (BLANCO, después las que solo están en
//   alguna hoja); se buscan por nombre normalizado, si no existen se crean. Una herramienta por
//   unidad (con código) o inactiva no se puede importar.
// - BLANCO pasa a ser el kit base (1 de cada herramienta).
// - Cada bloque fechado, en orden de fecha: primero las devoluciones, después las entregas
//   (entrega inicial si el técnico no la tenía; reposición si sigue a un faltante o recambio de
//   esa herramienta y repone lo asignado; si no, adicional) y después el conteo, que es un
//   control finalizado en esa fecha: 1 = bueno, 0,5 = recambio (x,5 = x - 0,5 buenas y 1 para
//   recambio), menos que lo asignado = faltante con nota "Conteo 0 en Excel"; vacío = 0.
//   Cada bloque se aplica entero y en orden (devoluciones, entregas, control), en su propia
//   ventana de tiempo de ese día; ninguna fecha queda después de "ahora".
// - Conteo vacío probable (E9.V1): un conteo menor que lo asignado (sin recambio) que un bloque
//   posterior de la hoja supera sin una ENTREGA de esa herramienta en el medio: por defecto queda
//   "sin dato" (el ítem no entra en ese control, como uno no contado); se puede importar como
//   faltante. Los demás conteos menores son faltantes.
// - Conteo mayor que lo asignado (saldo positivo): entrega de ajuste marcada (un caso por
//   técnico y herramienta; si se omite, el conteo se recorta a lo asignado).
// - DEVOLUCIÓN 0,5 junto a un conteo x,5: se ignora. Igual al conteo previo: devolución a
//   disponible; si el conteo previo era x,5, la unidad de recambio va a baja y las x − 0,5 buenas
//   a disponible. Otro valor entero: caso dudoso, omitido salvo que se acepte (a disponible).
// - Dos bloques en la misma semana (período de control): el último queda vigente como
//   corrección del anterior, que queda como historial.
// - NOVEDADES: fecha y hora de la hoja, técnico por legajo, autor = quien importa.
import { norm, clean, legajoOf } from './layout.js';
import { zonedDate, periodOf, pkeyOf, pad } from '../../domain/period.js';
import { WorkbookError } from './workbook.js';

export const PLAN_VERSION = 2;
// Trabajo máximo del plan (operaciones + ítems de control), contra libros armados para crecer.
export const PLAN_LIMITS = Object.freeze({ work: 2_000_000 });
const MAX_NAME = 120;
const MAX_LEGAJO = 50;
const MAX_COMMENT = 2000;
export const MISSING_NOTE = 'Conteo 0 en Excel';
export const NOTES = {
  entrega: 'Importado del Excel',
  ajuste: 'Entrega de ajuste: el Excel tenía conteo sin entrega (importado)',
  reposicion: 'Reposición importada del Excel',
  devolucion: 'Devolución importada del Excel',
  baja: 'Baja importada del Excel (devolución de una herramienta para recambio)',
  ingreso: 'Stock para la importación del Excel',
};

// Grupos de casos (el orden es el de la vista previa).
export const CASE_TYPES = [
  'conflicto', 'tecnico_nuevo', 'tecnico_existente', 'legajo_sin_resumen', 'legajo_repetido', 'legajo_invalido', 'especialidad_desconocida',
  'herramienta_nueva', 'herramienta_no_importable', 'kit_base',
  'ajuste', 'faltante', 'conteo_vacio_probable', 'recambio', 'devolucion', 'devolucion_dudosa', 'devolucion_05', 'reposicion', 'semana_duplicada',
  'bloque_sin_fecha', 'fecha_invalida', 'bloque_vacio', 'hoja_sin_bloques', 'hoja_sin_formato', 'hoja_ignorada', 'valor_invalido',
  'novedad_sin_tecnico', 'novedad_invalida', 'novedad_recortada',
];

// ---------------------------------------------------------------- valores
const frac = (x) => x - Math.floor(x);
// Número de una celda: números tal cual, textos con coma o punto decimal ("0,5"). null = vacía.
// undefined = no es un número.
export function numOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return undefined;
  const s = String(v).trim();
  if (!s || s === '-') return null;
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return undefined;
  return Number(s.replace(',', '.'));
}
const isCount = (x) => x >= 0 && x <= 10000 && Number.isInteger(x * 2);
const isWhole = (x) => x >= 0 && x <= 10000 && Number.isInteger(x);

const validYmd = (y, m, d) => {
  if (!(y >= 1900 && y <= 9999 && m >= 1 && m <= 12 && d >= 1)) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const ymdIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// Fecha de una celda: número de serie de Excel (sistema 1900 o 1904) o texto dd/mm/aaaa o
// aaaa-mm-dd. Devuelve 'AAAA-MM-DD' o null.
export function dateOf(v, date1904 = false) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const days = Math.floor(v) + (date1904 ? 1462 : 0);
    if (days < 1) return null;
    const dt = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
    return ymdIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m && validYmd(+m[1], +m[2], +m[3])) return ymdIso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (validYmd(y, +m[2], +m[1])) return ymdIso(y, +m[2], +m[1]);
  }
  return null;
}

// Hora de una celda: fracción del día (o número de serie con fecha) o texto HH:MM[:SS].
export function timeOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    const mins = Math.round(frac(v) * 1440) % 1440;
    return { h: Math.floor(mins / 60), mi: mins % 60 };
  }
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v ?? '').trim());
  if (m && +m[1] < 24 && +m[2] < 60) return { h: +m[1], mi: +m[2] };
  return null;
}

// Instante ISO de una hora local (Buenos Aires) de un día.
const localIso = (ymd, h, mi = 0, s = 0) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return zonedDate(y, m, d, h, mi, s).toISOString();
};
const fmtDay = (ymd) => { const [y, m, d] = ymd.split('-'); return `${Number(d)}/${Number(m)}/${y}`; };
const units = (n) => `${n} ${n === 1 ? 'unidad' : 'unidades'}`;

// ---------------------------------------------------------------- plan
// book: parseBook(). server: { techs: [{ id, legajo, name, active, archived, hasHistory }],
//   tools: [{ id, name, serialized, active, archived }], especialidades: [{ id, name, archived }],
//   baseKit: { id, items: [{ toolId, qty }] } | null }.
// opts: { decisions: { [caseId]: 'accept' | 'skip' }, today: 'AAAA-MM-DD' (fecha local),
//   now: instante (ms) que ninguna fecha importada supera }.
export function planExcelImport(book, server, { decisions = {}, today, now = Date.now() }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const cases = [];
  const errors = [];
  const caseIds = new Set();
  const decided = new Set();
  // Un caso con aceptar/omitir toma la decisión pedida o la de por defecto.
  const addCase = (c) => {
    if (caseIds.has(c.id)) return c;
    caseIds.add(c.id);
    const def = c.skippable ? c.defaultDecision || 'accept' : null;
    const want = c.skippable ? decisions[c.id] : undefined;
    if (want === 'accept' || want === 'skip') decided.add(c.id);
    const out = { ...c, skippable: !!c.skippable, defaultDecision: def, decision: c.skippable ? (want === 'accept' || want === 'skip' ? want : def) : null };
    cases.push(out);
    return out;
  };
  const accepted = (id, def = 'accept') => {
    const want = decisions[id];
    return (want === 'accept' || want === 'skip' ? want : def) === 'accept';
  };

  const res = book.resumen;
  if (!res && !book.legajoSheets.length) {
    errors.push({ code: 'not_panol_excel', message: 'El libro no tiene la hoja RESUMEN ni hojas de legajos: no parece el Excel de herramientas.' });
    return { version: PLAN_VERSION, cases, ops: [], totals: {}, errors, effectiveDecisions: {}, staleDecisions: [] };
  }

  // ------------------------------------------------ herramientas
  const toolList = [];
  const toolByKey = new Map();
  const addTool = (name, from) => {
    const nm = clean(name).slice(0, MAX_NAME);
    const key = norm(nm);
    if (!key) return null;
    if (toolByKey.has(key)) return toolByKey.get(key);
    const t = { idx: toolList.length, key, name: nm, from, used: from === 'blanco', usable: false, serverId: null, create: false };
    toolList.push(t);
    toolByKey.set(key, t);
    return t;
  };
  for (const n of (book.blanco ? book.blanco.tools : res ? res.tools : [])) addTool(n, 'blanco');
  for (const s of book.legajoSheets) for (const t of (s.layout ? s.layout.tools : [])) addTool(t.name, s.name);

  const serverTools = new Map();
  for (const t of server.tools || []) if (!t.archived && !serverTools.has(norm(t.name))) serverTools.set(norm(t.name), t);

  // ------------------------------------------------ legajos
  const serverTechs = new Map((server.techs || []).filter((t) => t.legajo).map((t) => [String(t.legajo).trim().toLowerCase(), t]));
  const esps = new Map((server.especialidades || []).filter((e) => !e.archived).map((e) => [norm(e.name), e]));
  const legajos = [];
  const byLegajo = new Map();
  const sheetOf = new Map(book.legajoSheets.map((s) => [norm(s.legajo), s]));
  const addLegajo = (legajo, info) => {
    const key = norm(legajo);
    if (byLegajo.has(key)) return null;
    const L = { n: legajos.length, ref: `l${legajos.length}`, legajo, key, ...info, sheet: sheetOf.get(key) || null, include: false, techId: null, create: false };
    legajos.push(L);
    byLegajo.set(key, L);
    return L;
  };
  for (const t of res ? res.techs : []) {
    const lg = legajoOf(t.legajo);
    if (!lg || lg.length > MAX_LEGAJO) {
      addCase({ id: `leginv:c${t.col}`, type: 'legajo_invalido', message: `Una columna de RESUMEN tiene un legajo vacío o demasiado largo: no se importa.` });
      continue;
    }
    if (byLegajo.has(norm(lg))) {
      addCase({ id: `legrep:c${t.col}`, type: 'legajo_repetido', legajo: lg, message: `El legajo ${lg} aparece más de una vez en RESUMEN: se usa la primera columna.` });
      continue;
    }
    addLegajo(lg, { name: t.name, especialidad: t.especialidad, inResumen: true });
  }
  for (const s of book.legajoSheets) if (!byLegajo.has(norm(s.legajo)) && s.legajo.length <= MAX_LEGAJO) addLegajo(s.legajo, { name: '', especialidad: '', inResumen: false });
  for (const n of book.ignoredSheets || []) addCase({ id: `hojaign:${norm(n).slice(0, 60)}`, type: 'hoja_ignorada', message: `La hoja ${n} no es de un legajo: no se importa.` });

  for (const L of legajos) {
    const name = (L.name || '').slice(0, MAX_NAME) || `Legajo ${L.legajo}`;
    L.displayName = name;
    const st = serverTechs.get(L.legajo.trim().toLowerCase());
    const noSheet = !L.sheet ? ' No tiene hoja: queda sin herramientas.' : '';
    if (st) {
      const why = st.archived ? 'está eliminado en el servidor' : st.hasHistory ? 'ya tiene historial en el servidor (no se mezclan historiales)' : st.active === false ? 'está inactivo en el servidor' : null;
      L.displayName = st.name;
      if (why) {
        addCase({ id: `tec:${L.ref}`, type: 'conflicto', legajo: L.legajo, tech: st.name, message: `Legajo ${L.legajo} (${st.name}) ${why}: no se importa nada de su hoja.` });
        continue;
      }
      const c = addCase({ id: `tec:${L.ref}`, type: 'tecnico_existente', skippable: true, legajo: L.legajo, tech: st.name, message: `Legajo ${L.legajo}: ${st.name} ya existe sin historial; recibe los datos importados.${noSheet}` });
      if (c.decision === 'accept') { L.include = true; L.techId = st.id; }
      continue;
    }
    if (!L.inResumen) {
      const c = addCase({ id: `tec:${L.ref}`, type: 'legajo_sin_resumen', skippable: true, defaultDecision: 'skip', legajo: L.legajo, tech: name, message: `La hoja ${L.legajo} no está en RESUMEN: si la aceptás, se crea el técnico "${name}" (sin nombre ni especialidad).` });
      if (c.decision === 'accept') { L.include = true; L.create = true; }
      continue;
    }
    let especialidadId = null;
    if (L.especialidad) {
      const e = esps.get(norm(L.especialidad));
      if (e) especialidadId = e.id;
      else addCase({ id: `esp:${L.ref}`, type: 'especialidad_desconocida', legajo: L.legajo, tech: name, message: `Legajo ${L.legajo}: la especialidad "${L.especialidad}" no existe; queda sin especialidad.` });
    }
    L.especialidadId = especialidadId;
    const c = addCase({ id: `tec:${L.ref}`, type: 'tecnico_nuevo', skippable: true, legajo: L.legajo, tech: name, message: `Legajo ${L.legajo}: se crea ${name}, sin plantilla.${noSheet}` });
    if (c.decision === 'accept') { L.include = true; L.create = true; }
  }

  // Herramientas usadas por alguna hoja incluida (o en BLANCO): coincidencias y altas.
  for (const L of legajos) {
    if (!L.include || !L.sheet || !L.sheet.layout) continue;
    for (const b of L.sheet.layout.blocks) for (const r of L.sheet.layout.tools) {
      const v = b.rows[r.row];
      if ([v.e, v.d, v.c].some((x) => { const n = numOf(x); return n !== null && n !== 0; })) toolByKey.get(norm(r.name.slice(0, MAX_NAME))).used = true;
    }
  }
  for (const t of toolList) {
    if (!t.used) continue;
    const s = serverTools.get(t.key);
    if (s) {
      if (s.serialized || s.active === false) {
        addCase({ id: `herr:t${t.idx}`, type: 'herramienta_no_importable', tool: s.name, message: `${s.name} ${s.serialized ? 'se controla por unidad (con código) en el servidor' : 'está inactiva en el servidor'}: sus valores del Excel no se importan.` });
        continue;
      }
      t.usable = true;
      t.serverId = s.id;
      t.name = s.name;
      continue;
    }
    const c = addCase({ id: `herr:t${t.idx}`, type: 'herramienta_nueva', skippable: true, tool: t.name, message: `Se crea la herramienta ${t.name} (por cantidad, sin categoría)${t.from === 'blanco' ? '' : `; solo figura en la hoja ${t.from}`}.` });
    if (c.decision === 'accept') { t.usable = true; t.create = true; }
  }

  // ------------------------------------------------ operaciones
  const ops = [];
  for (const t of toolList) if (t.usable && t.create) ops.push({ kind: 'tool', tool: t.idx, name: t.name });
  for (const L of legajos) {
    if (!L.include) continue;
    if (L.create) ops.push({ kind: 'tech', legajo: L.ref, legajoText: L.legajo, name: L.displayName, especialidadId: L.especialidadId || null, alta: null });
    else ops.push({ kind: 'attach', legajo: L.ref, techId: L.techId });
  }

  // Kit base = BLANCO (si el servidor no tiene kit base, se crea).
  if (book.blanco) {
    const items = [];
    for (const n of book.blanco.tools) { const t = toolByKey.get(norm(clean(n).slice(0, MAX_NAME))); if (t && t.usable && !items.some((x) => x.tool === t.idx)) items.push({ tool: t.idx, qty: 1 }); }
    if (items.length) {
      const had = server.baseKit && server.baseKit.items ? server.baseKit.items.length : 0;
      const message = !server.baseKit ? `Se crea el kit base con las ${items.length} herramientas de BLANCO (1 de cada una).`
        : had ? `El kit base del servidor ya tiene ${had} herramientas: aceptá para reemplazarlo por las ${items.length} de BLANCO (1 de cada una).`
          : `El kit base queda con las ${items.length} herramientas de BLANCO (1 de cada una).`;
      const c = addCase({ id: 'kit', type: 'kit_base', skippable: true, defaultDecision: had ? 'skip' : 'accept', message });
      if (c.decision === 'accept') ops.push({ kind: 'kit', kitId: server.baseKit ? server.baseKit.id : null, items });
    }
  }

  // Línea de tiempo de cada hoja incluida, en el orden del plan: bloque por bloque, primero las
  // devoluciones, después las entregas y al final el control de ese bloque. Cada bloque tiene su
  // propia ventana de tiempo dentro del día (de 8 a 20 h repartidas entre los bloques de ese
  // día; hoy, hasta "ahora"), así que nunca se mezcla con otro bloque ni queda en el futuro.
  const sheetOps = [];
  const firstDay = new Map();
  const windows = new Map();
  const dayWindow = (day) => {
    if (!windows.has(day)) {
      let ws = Date.parse(localIso(day, 8));
      let we = Date.parse(localIso(day, 20));
      if (we > nowMs) {
        we = nowMs;
        if (we <= ws) ws = Date.parse(localIso(day, 0));
      }
      windows.set(day, [ws, we]);
    }
    return windows.get(day);
  };
  let work = 0;
  const spend = (n) => {
    work += n;
    if (work > PLAN_LIMITS.work) throw new WorkbookError('El libro genera demasiados movimientos y controles para importarlo de una vez. Dividilo en partes.', 'too_complex');
  };
  for (const L of legajos) {
    if (!L.include || !L.sheet) continue;
    const lay = L.sheet.layout;
    if (!lay) {
      addCase({ id: `hoja:${L.ref}`, type: 'hoja_sin_formato', legajo: L.legajo, tech: L.displayName, message: `La hoja ${L.sheet.name} no tiene el formato de bloques ENTREGA / DEVOLUCIÓN / CONTEO: el técnico queda sin herramientas.` });
      continue;
    }
    const blocks = [];
    for (const b of lay.blocks) {
      const bk = `c${b.col}`;
      const nonzero = lay.tools.some((r) => [b.rows[r.row].e, b.rows[r.row].d, b.rows[r.row].c].some((x) => { const n = numOf(x); return n !== null && n !== 0; }));
      if (b.date === null || clean(b.date) === '') {
        if (nonzero) addCase({ id: `bsf:${L.ref}:${bk}`, type: 'bloque_sin_fecha', legajo: L.legajo, tech: L.displayName, message: `Hoja ${L.sheet.name}: un bloque con datos no tiene fecha; no se importa.` });
        continue;
      }
      const day = dateOf(b.date, book.date1904);
      if (!day || day < '2000-01-01' || day > today) {
        addCase({ id: `fecha:${L.ref}:${bk}`, type: 'fecha_invalida', legajo: L.legajo, tech: L.displayName, message: `Hoja ${L.sheet.name}: la fecha de un bloque (${day ? fmtDay(day) : 'ilegible'}) ${day && day > today ? 'es futura' : 'no es válida'}; no se importa.` });
        continue;
      }
      if (!nonzero) {
        addCase({ id: `bvac:${L.ref}:${bk}`, type: 'bloque_vacio', legajo: L.legajo, tech: L.displayName, date: day, message: `Hoja ${L.sheet.name}: el bloque del ${fmtDay(day)} está vacío; no se importa.` });
        continue;
      }
      blocks.push({ ...b, day, bk });
    }
    // En orden de fecha; el mismo día, el de más a la izquierda es el más nuevo (el + de Excel).
    blocks.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : b.col - a.col));
    if (!blocks.length) {
      addCase({ id: `hsb:${L.ref}`, type: 'hoja_sin_bloques', legajo: L.legajo, tech: L.displayName, message: `Hoja ${L.sheet.name}: no tiene bloques fechados con datos; el técnico queda sin herramientas.` });
      continue;
    }
    firstDay.set(L.ref, blocks[0].day);
    const perDay = new Map();
    for (const b of blocks) perDay.set(b.day, (perDay.get(b.day) || 0) + 1);

    // Valores de cada bloque y herramienta importable (un valor inválido es un caso y vale vacío).
    const rowsT = [];
    for (const r of lay.tools) {
      const t = toolByKey.get(norm(r.name.slice(0, MAX_NAME)));
      if (t && t.usable) rowsT.push(t);
    }
    spend(blocks.length * rowsT.length);
    const values = [];
    for (const b of blocks) {
      const row = [];
      for (const r of lay.tools) {
        const t = toolByKey.get(norm(r.name.slice(0, MAX_NAME)));
        if (!t || !t.usable) continue;
        const v = b.rows[r.row];
        const bad = (what) => addCase({ id: `val:${L.ref}:${b.bk}:t${t.idx}:${norm(what).slice(0, 3).toLowerCase()}`, type: 'valor_invalido', legajo: L.legajo, tech: L.displayName, tool: t.name, date: b.day, message: `Hoja ${L.sheet.name}, ${fmtDay(b.day)}, ${t.name}: el valor de ${what} no es válido; se toma como vacío.` });
        let e = numOf(v.e);
        let d = numOf(v.d);
        let c = numOf(v.c);
        if (e === undefined || (e !== null && !isWhole(e))) { bad('ENTREGA'); e = null; }
        if (c === undefined || (c !== null && !isCount(c))) { bad('CONTEO'); c = null; }
        if (d === undefined || (d !== null && !isCount(d))) { bad('DEVOLUCIÓN'); d = null; }
        row.push({ e, d, c });
      }
      values.push(row);
    }
    // Un conteo es "vacío probable" si un bloque posterior cuenta más unidades de esa fila sin una
    // ENTREGA en el medio (incluida la del bloque que cuenta más). De atrás para adelante: lineal.
    const rises = values.map(() => new Array(rowsT.length).fill(false));
    for (let k = 0; k < rowsT.length; k++) {
      let max = -1;
      for (let bi = blocks.length - 1; bi >= 0; bi--) {
        const x = values[bi][k];
        const u = Math.ceil(x.c ?? 0);
        rises[bi][k] = max > u;
        if (x.e) max = -1;
        else if (u > max) max = u;
      }
    }

    const state = new Map(); // tool idx -> { slots: [{ id, qty }], prev, loss, nslot }
    const stOf = (t) => {
      if (!state.has(t.idx)) state.set(t.idx, { slots: [], prev: null, loss: false, nslot: 0 });
      return state.get(t.idx);
    };
    const adjust = new Map(); // tool idx -> { units, dates }
    const periods = new Map(); // pkey -> ref del último control de ese período
    const sameDay = new Map();
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const nDay = sameDay.get(b.day) || 0;
      sameDay.set(b.day, nDay + 1);
      const devs = [];
      const ents = [];
      const items = [];
      for (let k = 0; k < rowsT.length; k++) {
        const t = rowsT[k];
        const { e, d, c } = values[bi][k];
        const st = stOf(t);
        const A = () => st.slots.reduce((a, s) => a + s.qty, 0);
        const cHalf = c !== null && frac(c) === 0.5;
        const caseBase = { legajo: L.legajo, tech: L.displayName, tool: t.name, date: b.day };
        const who = `${L.displayName}, ${t.name}, ${fmtDay(b.day)}`;

        // 1) Devolución: [[unidades, destino]] de las asignaciones más nuevas.
        if (d) {
          let back = [];
          if (d === 0.5 && cHalf) {
            addCase({ id: `d05:${L.ref}:${b.bk}:t${t.idx}`, type: 'devolucion_05', ...caseBase, message: `${who}: el 0,5 en DEVOLUCIÓN acompaña al recambio; se ignora.` });
          } else if (st.prev && d === st.prev) {
            const qty = Math.min(Math.ceil(st.prev), A());
            if (!A()) addCase({ id: `dev:${L.ref}:${b.bk}:t${t.idx}`, type: 'devolucion_dudosa', ...caseBase, message: `${who}: devolución de ${units(Math.ceil(st.prev))} sin herramienta asignada; se ignora.` });
            else {
              // x,5: la unidad de recambio va a baja; las x − 0,5 buenas, a disponible.
              const baja = frac(st.prev) === 0.5 ? 1 : 0;
              const disp = qty - baja;
              const what = baja ? `baja de ${units(baja)} (la de recambio)${disp ? ` y devolución a disponible de ${units(disp)}` : ''}` : `devolución a disponible de ${units(disp)}`;
              const cs = addCase({ id: `dev:${L.ref}:${b.bk}:t${t.idx}`, type: 'devolucion', skippable: true, ...caseBase, message: `${who}: DEVOLUCIÓN igual al conteo previo; ${what}.` });
              if (cs.decision === 'accept') back = [[baja, 'baja'], [disp, 'disponible']];
            }
          } else if (Number.isInteger(d) && A()) {
            const cs = addCase({ id: `dev:${L.ref}:${b.bk}:t${t.idx}`, type: 'devolucion_dudosa', skippable: true, defaultDecision: 'skip', ...caseBase, message: `${who}: DEVOLUCIÓN ${d} no coincide con el conteo previo; si la aceptás, es una devolución a disponible de ${units(Math.min(d, A()))}.` });
            if (cs.decision === 'accept') back = [[d, 'disponible']];
          } else {
            addCase({ id: `dev:${L.ref}:${b.bk}:t${t.idx}`, type: 'devolucion_dudosa', ...caseBase, message: `${who}: DEVOLUCIÓN ${String(d).replace('.', ',')} no se puede interpretar${A() ? '' : ' (sin herramienta asignada)'}; se ignora.` });
          }
          for (const [q0, cond] of back) {
            let qty = Math.min(q0, A());
            while (qty > 0) {
              const s = st.slots[st.slots.length - 1];
              const take = Math.min(qty, s.qty);
              devs.push({ kind: 'devolucion', legajo: L.ref, tool: t.idx, slot: s.id, qty: take, cond });
              s.qty -= take;
              qty -= take;
              if (!s.qty) st.slots.pop();
            }
          }
        }

        // 2) Entrega.
        if (e) {
          if (!A()) {
            const id = `s${st.nslot++}`;
            ents.push({ kind: 'entrega', type: 'entrega_inicial', legajo: L.ref, tool: t.idx, slot: id, qty: e });
            st.slots.push({ id, qty: e });
          } else if (st.loss && st.slots.length === 1 && st.slots[0].qty === e) {
            const id = `s${st.nslot++}`;
            ents.push({ kind: 'reposicion', legajo: L.ref, tool: t.idx, slot: st.slots[0].id, newSlot: id, qty: e });
            addCase({ id: `rep:${L.ref}:${b.bk}:t${t.idx}`, type: 'reposicion', ...caseBase, message: `${who}: la entrega sigue a un faltante o recambio; se registra como reposición (la anterior va a baja).` });
            st.slots = [{ id, qty: e }];
          } else {
            const id = `s${st.nslot++}`;
            ents.push({ kind: 'entrega', type: 'adicional', legajo: L.ref, tool: t.idx, slot: id, qty: e });
            st.slots.push({ id, qty: e });
          }
        }

        // 3) Conteo.
        const cv = c ?? 0;
        const n = Math.ceil(cv);
        let change = cHalf ? 1 : 0;
        let good = n - change;
        if (n > A()) {
          const id = `aj:${L.ref}:t${t.idx}`;
          const a = adjust.get(t.idx) || { units: 0, dates: [] };
          a.units += n - A();
          a.dates.push(b.day);
          adjust.set(t.idx, a);
          if (accepted(id)) {
            const sid = `s${st.nslot++}`;
            ents.push({ kind: 'entrega', type: A() ? 'adicional' : 'entrega_inicial', adjust: true, legajo: L.ref, tool: t.idx, slot: sid, qty: n - A() });
            st.slots.push({ id: sid, qty: n - A() });
          } else {
            change = Math.min(change, A());
            good = Math.min(good, A() - change);
          }
        }
        const total = A();
        const missing = total - good - change;
        let asMissing = false;
        if (total && missing > 0 && change === 0 && rises[bi][k]) {
          const cs = addCase({ id: `vac:${L.ref}:${b.bk}:t${t.idx}`, type: 'conteo_vacio_probable', skippable: true, defaultDecision: 'skip', ...caseBase, message: `${who}: conteo ${String(cv).replace('.', ',')} de ${total}, pero un bloque posterior cuenta más sin una ENTREGA en el medio (probablemente la celda quedó sin llenar). Omitido: queda sin dato en este control. Si lo importás, faltan ${missing} (nota "${MISSING_NOTE}").` });
          // Sin dato: el ítem no entra en este control (como uno no contado); sigue valiendo el
          // estado anterior y el conteo no cuenta como previo para las devoluciones.
          if (cs.decision !== 'accept') continue;
          asMissing = true;
        }
        st.prev = cv;
        if (!total) { st.loss = false; continue; }
        if (missing > 0 && !asMissing) addCase({ id: `fal:${L.ref}:${b.bk}:t${t.idx}`, type: 'faltante', ...caseBase, message: `${who}: faltan ${missing} de ${total} (nota "${MISSING_NOTE}").` });
        if (change > 0) addCase({ id: `rec:${L.ref}:${b.bk}:t${t.idx}`, type: 'recambio', ...caseBase, message: `${who}: ${change} para recambio${cv === 0.5 ? ' (conteo 0,5)' : ` (conteo ${String(cv).replace('.', ',')})`}.` });
        st.loss = missing + change > 0;
        // Reparto por asignación: primero las buenas, después las de recambio, el resto falta.
        let g = good;
        let ch = change;
        for (const s of st.slots) {
          const sg = Math.min(g, s.qty);
          const sc = Math.min(ch, s.qty - sg);
          g -= sg;
          ch -= sc;
          items.push({ tool: t.idx, slot: s.id, expected: s.qty, good: sg, change: sc, missing: s.qty - sg - sc });
        }
      }
      const blockOps = [...devs, ...ents];
      if (items.length) {
        const period = periodOf(new Date(localIso(b.day, 12)));
        const pk = pkeyOf(period);
        const ref = `${L.ref}:${b.bk}`;
        const prev = periods.get(pk) || null;
        if (prev) addCase({ id: `sem:${ref}`, type: 'semana_duplicada', legajo: L.legajo, tech: L.displayName, date: b.day, message: `${L.displayName}: el bloque del ${fmtDay(b.day)} cae en la misma semana que el anterior; queda vigente y el anterior como historial.` });
        periods.set(pk, ref);
        blockOps.push({ kind: 'control', legajo: L.ref, ref, day: b.day, at: null, period, correctionOf: prev, items });
      }
      if (!blockOps.length) continue;
      spend(blockOps.length + items.length);
      // Ventana del bloque: su parte del día, con un paso de hasta 1 s entre operaciones.
      const [ws, we] = dayWindow(b.day);
      const span = Math.floor((we - ws) / perDay.get(b.day));
      const step = Math.min(1000, Math.floor(span / (blockOps.length + 1)));
      if (step < 1) throw new WorkbookError(`La hoja ${L.sheet.name} tiene demasiados movimientos el ${fmtDay(b.day)} para importarlos.`, 'too_complex');
      const start = ws + nDay * span;
      blockOps.forEach((op, i) => { op.at = new Date(start + i * step).toISOString(); });
      for (const op of blockOps) sheetOps.push(op);
    }
    for (const [idx, a] of adjust) {
      const t = toolList[idx];
      addCase({ id: `aj:${L.ref}:t${idx}`, type: 'ajuste', skippable: true, legajo: L.legajo, tech: L.displayName, tool: t.name, date: a.dates[0], message: `${L.displayName}, ${t.name}: el conteo supera lo entregado (${a.dates.map(fmtDay).join(', ')}); entrega de ajuste de ${units(a.units)} marcada como importada. Si la omitís, el conteo se recorta a lo entregado.` });
    }
  }
  for (const op of ops) if (op.kind === 'tech') op.alta = firstDay.get(op.legajo) || null;

  // Stock: un ingreso por herramienta con todo lo que se entrega (entregas, ajustes y
  // reposiciones), una hora antes de su primera entrega. Las existencias del servidor no se tocan.
  const need = new Map();
  for (const op of sheetOps) {
    if (op.kind !== 'entrega' && op.kind !== 'reposicion') continue;
    const x = need.get(op.tool) || { qty: 0, at: op.at };
    x.qty += op.qty;
    if (op.at < x.at) x.at = op.at;
    need.set(op.tool, x);
  }
  for (const [tool, x] of need) ops.push({ kind: 'ingreso', tool, qty: x.qty, at: new Date(new Date(x.at).getTime() - 3600_000).toISOString() });
  for (const op of sheetOps) ops.push(op);

  // ------------------------------------------------ novedades
  const nov = book.novedades;
  if (nov) {
    for (const r of nov.rows) {
      const id = `r${r.row + 1}`;
      const comment0 = clean(r.comentario);
      const day = dateOf(r.fecha, book.date1904);
      if (!comment0 || !day || day < '2000-01-01' || day > today) {
        addCase({ id: `novinv:${id}`, type: 'novedad_invalida', message: `NOVEDADES fila ${r.row + 1}: ${!comment0 ? 'sin comentario' : 'la fecha no es válida'}; no se importa.` });
        continue;
      }
      const tm = timeOf(r.hora) || { h: 0, mi: 0 };
      const lg = r.legajo === null ? '' : legajoOf(r.legajo);
      const L = lg ? byLegajo.get(norm(lg)) : null;
      let comment = comment0;
      let legajo = null;
      if (L && L.include) legajo = L.ref;
      else if (lg) {
        comment = `[Legajo ${lg}] ${comment0}`;
        addCase({ id: `novst:${id}`, type: 'novedad_sin_tecnico', legajo: lg, message: `NOVEDADES fila ${r.row + 1}: el legajo ${lg} no se importa${L ? '' : ' (no existe)'}; la novedad queda sin técnico y el legajo va al comienzo del comentario.` });
      }
      if (comment.length > MAX_COMMENT) {
        comment = comment.slice(0, MAX_COMMENT - 1) + '…';
        addCase({ id: `novrec:${id}`, type: 'novedad_recortada', message: `NOVEDADES fila ${r.row + 1}: el comentario supera ${MAX_COMMENT} caracteres y se recorta.` });
      }
      // Nunca después de "ahora" (una novedad de hoy con una hora que todavía no llegó).
      const at = new Date(Math.min(Date.parse(localIso(day, tm.h, tm.mi)), nowMs)).toISOString();
      ops.push({ kind: 'novedad', legajo, comment, at, day });
    }
  }

  // ------------------------------------------------ totales
  const totals = { techsCreate: 0, techsAttach: 0, toolsCreate: 0, toolsMatched: 0, kitItems: 0, controls: 0, corrections: 0, entregas: 0, ajustes: 0, reposiciones: 0, devoluciones: 0, bajas: 0, ingresos: 0, novedades: 0 };
  for (const op of ops) {
    if (op.kind === 'tech') totals.techsCreate++;
    else if (op.kind === 'attach') totals.techsAttach++;
    else if (op.kind === 'tool') totals.toolsCreate++;
    else if (op.kind === 'kit') totals.kitItems = op.items.length;
    else if (op.kind === 'control') { totals.controls++; if (op.correctionOf) totals.corrections++; }
    else if (op.kind === 'entrega') { if (op.adjust) totals.ajustes++; else totals.entregas++; }
    else if (op.kind === 'reposicion') totals.reposiciones++;
    else if (op.kind === 'devolucion') { if (op.cond === 'baja') totals.bajas++; else totals.devoluciones++; }
    else if (op.kind === 'ingreso') totals.ingresos++;
    else if (op.kind === 'novedad') totals.novedades++;
  }
  totals.toolsMatched = toolList.filter((t) => t.usable && !t.create).length;

  const effectiveDecisions = {};
  for (const c of cases) if (c.skippable && decided.has(c.id)) effectiveDecisions[c.id] = c.decision;
  const skippableIds = new Set(cases.filter((c) => c.skippable).map((c) => c.id));
  const staleDecisions = Object.keys(decisions).filter((id) => !skippableIds.has(id)).sort();
  cases.sort((a, b) => CASE_TYPES.indexOf(a.type) - CASE_TYPES.indexOf(b.type));
  const tools = toolList.filter((t) => t.usable).map((t) => ({ idx: t.idx, name: t.name, serverId: t.serverId, create: t.create }));
  const techs = legajos.filter((L) => L.include).map((L) => ({ ref: L.ref, legajo: L.legajo, name: L.displayName, techId: L.techId, create: L.create }));
  return { version: PLAN_VERSION, cases, ops, totals, errors, tools, techs, effectiveDecisions, staleDecisions };
}

// Resumen de casos por tipo: { tipo: n }.
export function caseCounts(cases) {
  const out = {};
  for (const c of cases) out[c.type] = (out[c.type] || 0) + 1;
  return out;
}
