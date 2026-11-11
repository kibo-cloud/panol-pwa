// Etapa 10: impresión para auditoría, puro. La selección (meses, plantillas, técnicos, cajas,
// secciones y "Formato planilla") se guarda en la dirección (#auditoria-<selección>) para poder
// volver a imprimir el mismo informe; el informe lo arma el servidor (GET /api/audit-report) y
// acá se arma también el Excel: una hoja por sección y una por poseedor en formato planilla.
import { MONTHS } from './constants.js';

export const SECTIONS = [
  ['resumen', 'Resumen'], ['poseedores', 'Por técnico o caja'], ['faltantes', 'Faltantes y su resolución'], ['movimientos', 'Entregas, reposiciones, devoluciones y retiros'],
  ['compras', 'Compras aprobadas y rechazadas'], ['novedades', 'Novedades'], ['plantillas', 'Cambios de plantilla'], ['firmas', 'Espacio de firmas'],
];
const KEYS = SECTIONS.map(([k]) => k);
export const MAX_MONTHS = 24;
const pad = (n) => String(n).padStart(2, '0');
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const mnum = (k) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
const mkey = (n) => `${Math.floor(n / 12)}-${pad((n % 12) + 1)}`;
export const monthText = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;

// Últimos n meses desde el actual (para los selectores), del más nuevo al más viejo.
export function monthOptions(cur, n = MAX_MONTHS) {
  const out = [];
  const c = cur.y * 12 + cur.m - 1;
  for (let i = 0; i < n; i++) out.push({ key: mkey(c - i), label: monthText(mkey(c - i)) });
  return out;
}

export function defaultSel(cur) {
  const k = `${cur.y}-${pad(cur.m)}`;
  return { mode: 'range', from: k, to: k, months: [k], plantillas: 'all', techs: 'all', cajas: 'all', sections: KEYS.slice(), planilla: false };
}

// Meses de la selección, en orden (el rango se expande).
export function selMonths(sel) {
  if (sel.mode === 'range') {
    const a = mnum(sel.from); const b = mnum(sel.to);
    const out = [];
    for (let n = Math.min(a, b); n <= Math.max(a, b) && out.length <= 240; n++) out.push(mkey(n));
    return out;
  }
  return [...new Set(sel.months)].sort();
}

const list = (v) => (v === 'all' || v === 'none' ? v : v.join(','));
const unlist = (v, none) => {
  if (!v || v === 'all') return 'all';
  if (v === 'none' && none) return 'none';
  return v.split(',').filter(Boolean);
};

export function encodeSel(sel) {
  const p = new URLSearchParams();
  p.set('mode', sel.mode);
  p.set('d', sel.from); p.set('h', sel.to); p.set('m', sel.months.join(','));
  p.set('pl', list(sel.plantillas)); p.set('t', list(sel.techs)); p.set('c', list(sel.cajas));
  p.set('s', sel.sections.join(','));
  if (sel.planilla) p.set('f', 'planilla');
  return p.toString();
}

export function decodeSel(str) {
  if (!str) return null;
  let p;
  try { p = new URLSearchParams(str); } catch { return null; }
  const mode = p.get('mode');
  if (mode !== 'range' && mode !== 'list') return null;
  const from = p.get('d') || ''; const to = p.get('h') || '';
  const months = (p.get('m') || '').split(',').filter((x) => MONTH_RE.test(x));
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to)) return null;
  const sections = (p.get('s') || '').split(',').filter((k) => KEYS.includes(k));
  return {
    mode, from, to, months, plantillas: unlist(p.get('pl'), false), techs: unlist(p.get('t'), true), cajas: unlist(p.get('c'), true),
    sections: sections.length ? KEYS.filter((k) => sections.includes(k)) : KEYS.slice(), planilla: p.get('f') === 'planilla',
  };
}

// Consulta para GET /api/audit-report.
export function selQuery(sel) {
  const p = new URLSearchParams();
  p.set('months', selMonths(sel).join(','));
  for (const [k, v] of [['plantillas', sel.plantillas], ['techs', sel.techs], ['cajas', sel.cajas]]) if (v !== 'all') p.set(k, list(v));
  if (sel.sections.length !== KEYS.length) p.set('sections', sel.sections.join(','));
  return p.toString();
}

export const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
// 0,5 con coma decimal (como el Excel anterior); vacío sin dato.
export const half = (v) => (v == null || v === '' ? '' : String(v).replace('.', ','));
// Fecha local AAAA-MM-DD -> d/m/aaaa.
export const dmy = (day) => (day ? `${Number(day.slice(8, 10))}/${Number(day.slice(5, 7))}/${day.slice(0, 4)}` : '');
export const periodShort = (p) => (p ? `S${p.w} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}` : '');
export const CLEANING_TXT = { limpio: 'Limpio', requiere_limpieza: 'Requiere limpieza' };
export const cleaningText = (c) => (c && c.status ? CLEANING_TXT[c.status] + (c.note ? `: ${c.note}` : '') : 'Sin dato');
export const RESOLUTION_TONE = { reposicion: 'ok', devolucion: 'ok', retiro: 'ok', recuperada: 'ok', compra: 'warn', parcial: 'warn', sin_resolver: 'bad' };

// Nombre de hoja de Excel: sin / \ : * ? [ ], hasta 31 caracteres y sin repetir.
export function sheetName(name, used) {
  const base = String(name || 'Hoja').replace(/[/\\:*?[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Hoja';
  let n = base; let i = 2;
  while (used.has(n.toLowerCase())) { const suf = ` (${i++})`; n = base.slice(0, 31 - suf.length) + suf; }
  used.add(n.toLowerCase());
  return n;
}

const head = (R, title) => [[`${R.header.company}: ${title}`], [`Período: ${R.header.period}. ${R.header.filters}.`], [`Emitido el ${dmy(R.header.issuedDay)} por ${R.header.issuer}.`], []];
const pctTxt = (v) => (v == null ? '—' : `${v} %`);

// Planilla de un poseedor como el Excel anterior: bloques fechados ENTREGA / DEVOLUCIÓN / CONTEO y
// el SALDO de la fila (último conteo − (entregas − devoluciones) de los bloques mostrados).
export function planillaRows(h) {
  const bl = h.planilla.blocks;
  const dates = ['', '', ...bl.flatMap((b) => [b.controlId ? `${dmy(b.day)}${b.correction ? ' (corrección)' : ''}${b.imported ? ' (importado)' : ''}` : 'Sin control', '', '']), ''];
  const cols = ['N°', 'Herramienta', ...bl.flatMap(() => ['ENTREGA', 'DEVOLUCIÓN', 'CONTEO']), 'SALDO'];
  const rows = h.planilla.rows.map((r) => [r.n ?? '', r.name, ...r.cells.flatMap((c) => [c.entrega ?? '', c.devolucion ?? '', c.conteo ?? '']), r.saldo ?? '']);
  return [dates, cols, ...rows];
}

export function auditWorkbook(R) {
  const has = (k) => R.sections.includes(k);
  const used = new Set();
  const out = [];
  const add = (name, rows, cols) => out.push({ name: sheetName(name, used), rows, cols });
  const s = R.summary;
  if (has('resumen')) {
    add('Resumen', [...head(R, 'resumen para auditoría'),
      ['Técnicos', s.techs], ['Cajas compartidas', s.cajas], ['Herramientas distintas asignadas', s.tools], ['Unidades asignadas', s.units],
      ['Controles realizados', s.done], ['Controles esperados', s.expected], ['Cumplimiento', pctTxt(s.pctDone)],
      ['En buen estado (último control)', s.bueno], ['Para recambio', s.cambio], ['Faltantes', s.faltante], ['% en condiciones', pctTxt(s.pctCond)],
      ['Faltantes registrados', s.faltantesEpisodios], ['Faltantes sin resolver', s.sinResolver], ['Reposiciones', s.reposiciones],
      ['Controles limpios', s.limpio], ['Requieren limpieza', s.sucio], ['Sin dato de limpieza', s.sinDatoLimpieza], ['% limpio', pctTxt(s.pctLimpio)],
      ['Correcciones', s.corrections], ['Importados del Excel', s.imported], [],
      ['Mes', 'Controles', 'Esperados', '% en condiciones', 'Faltantes', '% limpio'], ...s.perMonth.map((m) => [m.label, m.done, m.expected, pctTxt(m.pctCond), m.faltantes, pctTxt(m.pctLimpio)]),
    ], [{ wch: 34 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 10 }]);
  }
  if (has('faltantes')) {
    add('Faltantes', [...head(R, 'faltantes y su resolución'), ['Poseedor', 'N°', 'Herramienta', 'Unidad', 'Faltan', 'De', 'Desde', 'Motivo', 'Resolución', 'Fecha', 'Compra'],
      ...R.faltantes.map((f) => [f.holderName, f.n ?? '', f.toolName, f.unitCode || '', f.missing, f.expected, dmy(f.firstDay), f.note, f.resolution.label, dmy(f.resolution.day), f.purchase ? `${f.purchase.name} (${f.purchase.statusLabel})` : ''])],
    [{ wch: 22 }, { wch: 5 }, { wch: 24 }, { wch: 10 }, { wch: 7 }, { wch: 5 }, { wch: 11 }, { wch: 28 }, { wch: 26 }, { wch: 11 }, { wch: 20 }]);
  }
  if (has('movimientos')) {
    add('Movimientos', [...head(R, 'entregas, reposiciones, devoluciones y retiros'), ['Fecha', 'Tipo', 'Poseedor', 'Herramienta', 'Unidad', 'Cantidad', 'Motivo', 'Registró', 'Marca'],
      ...R.movements.map((m) => [dmy(m.day), m.typeLabel, m.holderName, m.toolName, m.unitCode || '', m.qty, m.reason || m.notes, m.byName, [m.voided ? 'Anulado' : '', m.voids ? `Anula: ${m.voids.typeLabel} del ${dmy(m.voids.at ? m.voids.at.slice(0, 10) : '')}` : '', m.imported ? 'Importado del Excel' : ''].filter(Boolean).join('. ')])],
    [{ wch: 11 }, { wch: 18 }, { wch: 22 }, { wch: 24 }, { wch: 10 }, { wch: 9 }, { wch: 26 }, { wch: 18 }, { wch: 30 }]);
  }
  if (has('compras')) {
    const cost = R.costsShown;
    add('Compras', [...head(R, 'compras aprobadas y rechazadas'), ['Solicitud', 'Estado', 'Decisión', 'Decidió', 'Herramienta', 'Poseedor', 'Motivo', 'Cantidad', 'Comentario o motivo del rechazo', ...(cost ? ['Costo estimado', 'Proveedor'] : [])],
      ...R.purchases.map((p) => [p.name, p.statusLabel, dmy(p.decidedDay), p.decidedByName || '', p.toolName, p.holderName, p.reason === 'faltante' ? 'Extraviada' : 'Dañada', p.qty, p.decisionComment || '', ...(cost ? [p.estimatedCost ?? 'Sin costo', p.supplier || ''] : [])])],
    [{ wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 18 }, { wch: 24 }, { wch: 20 }, { wch: 11 }, { wch: 9 }, { wch: 32 }, { wch: 14 }, { wch: 18 }]);
  }
  if (has('novedades') && R.novedades) {
    add('Novedades', [...head(R, 'novedades'), ['Fecha', 'Autor', 'Técnico', 'Plantilla', 'Línea', 'Comentario', 'Marca'],
      ...R.novedades.map((n) => [dmy(n.day), n.authorName, n.techName, n.plantillaName, n.lineaName, n.comment, n.imported ? 'Importada del Excel' : ''])],
    [{ wch: 11 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 60 }, { wch: 18 }]);
  }
  if (has('plantillas')) {
    const P = R.plantillas;
    add('Plantillas', [...head(R, 'cambios de plantilla'), ['Fecha', 'Cambio', 'Quién o qué', 'Antes', 'Después', 'Motivo', 'Registró'],
      ...P.moves.map((m) => [dmy(m.day), 'Cambio de plantilla', m.techName, m.fromName, m.toName, m.note, m.byName]),
      ...P.supervisors.map((x) => [dmy(x.day), 'Cambio de supervisor', x.plantillaName, x.fromName, x.toName, '', x.byName]),
      ...P.rotations.map((x) => [dmy(x.day), 'Rotación de turno', x.plantillaName, x.fromLabel, x.label, '', x.byName]),
    ], [{ wch: 11 }, { wch: 20 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 26 }, { wch: 18 }]);
  }
  if (has('poseedores')) {
    for (const h of R.holders) {
      const info = [h.kind === 'caja' ? `Caja compartida${h.linea ? ' · ' + h.linea : ''}` : `Legajo ${h.legajo || '—'}${h.especialidad ? ' · ' + h.especialidad : ''}${h.plantillas.length ? ' · ' + h.plantillas.join(', ') : ''}`];
      const rows = [[`${R.header.company}: ${h.name}`], info, [`Período: ${R.header.period}. Controles: ${h.done} de ${h.expected}.`], [], ...planillaRows(h), [], ['Referencias: CONTEO 1 = buen estado, 0,5 = requiere recambio (también suma 0,5 en DEVOLUCIÓN en el primer control del recambio), 0 = falta. Vacío = sin dato. SALDO = último conteo − (entregas − devoluciones); ENTREGA y DEVOLUCIÓN cubren solo el período elegido.']];
      add(h.name, rows, [{ wch: 5 }, { wch: 28 }, ...h.planilla.blocks.flatMap(() => [{ wch: 10 }, { wch: 12 }, { wch: 9 }]), { wch: 8 }]);
    }
  }
  return out;
}
