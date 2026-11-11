// Etapa 8: existencia por técnico (la hoja RESUMEN del Excel). Herramientas en filas (orden
// personalizado), técnicos y cajas en columnas con legajo, especialidad, último control y días
// desde él; celda = unidades asignadas con las marcas C (recambio) y F (faltante) del último
// control. Filtro por plantilla, cajas y "solo con herramientas"; Excel e impresión (A4
// apaisado, en blanco y negro con letras además del color) con el permiso de exportar informes.
import vendor from 'virtual:panol-vendor';
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, CH } from '../../ui/actions.js';
import { act } from '../../ui/feedback.js';
import { kpi, pageHead, field, optList, emptyBox } from '../../ui/components.js';
import { saveFile, loadScript } from '../../ui/files.js';
import { gateUI } from '../tecnicos/view.js';
import { ME, derive, can, who, catName, shiftName, overdueDays } from '../../state/store.js';
import { mineFirst } from '../../state/plantillas.js';
import { fdt, nowISO } from '../../state/period.js';
import { buildExistencia, existenciaSheet, ageLabel, ageTone, localDay, holderLabel, cellCodes, EXI_LEGEND } from '../../state/existencia.js';

const filters = () => UI.exi || (UI.exi = { plantilla: 'all', cajas: true, withTools: false });
export function computeExistencia() {
  const f = filters();
  if (f.plantilla !== 'all' && !derive().shiftById[f.plantilla]) f.plantilla = 'all';
  return buildExistencia(derive(), f, { now: new Date(), threshold: overdueDays() });
}
const filterLabel = (f) => [f.plantilla === 'all' ? 'Todas las plantillas' : shiftName(f.plantilla), f.cajas ? 'con cajas compartidas' : 'sin cajas', f.withTools ? 'solo con herramientas' : ''].filter(Boolean).join(', ');

const TONE_TXT = { ok: 'Al día', bad: 'Vencido', pend: 'Sin controles', idle: 'Sin herramientas asignadas' };
function holderHead(h, thr) {
  const tone = ageTone(h, thr);
  const href = h.kind === 'caja' ? `#caja-${h.id}` : `#tecnico-${h.id}`;
  const days = h.days == null ? '—' : `${h.days} ${h.days === 1 ? 'día' : 'días'}`;
  return `<th scope="col" class="exi-h" data-h="${esc(h.key)}"><a class="exi-hn" href="${esc(href)}">${esc(h.name)}</a>`
    + `<span class="exi-hs">${h.kind === 'caja' ? 'Caja compartida' : `Leg. ${esc(h.legajo || '—')}`}</span>`
    + `<span class="exi-hs">${esc(h.kind === 'caja' ? '' : h.especialidad || 'Sin especialidad')}</span>`
    + `<span class="exi-hs">${h.never ? 'Sin controles' : 'Último: ' + esc(localDay(h.lastControlAt))}</span>`
    + `<span class="exi-age ${tone}" title="${esc(ageLabel(h))}">${icon(tone === 'ok' ? 'ok' : 'clock', 12)}${esc(days)}<span class="exi-sr"> ${TONE_TXT[tone]}</span></span></th>`;
}
const marks = (c) => `${c.cambio ? `<span class="mk c" title="${c.cambio} para recambio">C ${c.cambio}</span>` : ''}${c.faltante ? `<span class="mk f" title="${c.faltante} faltantes">F ${c.faltante}</span>` : ''}`;
const units = (c) => { const k = cellCodes(c); return k ? `<span class="exi-sr"> Unidades: ${esc(k)}</span>` : ''; };
const cell = (c) => (c && c.qty ? `<td class="n exi-c${c.faltante ? ' bad' : c.cambio ? ' warn' : ''}"${cellCodes(c) ? ` title="Unidades: ${esc(cellCodes(c))}"` : ''}><span class="q">${c.qty}</span>${marks(c)}${units(c)}</td>` : '<td class="n exi-c exi-0"><span class="exi-sr">0</span></td>');

function matrix(X, thr) {
  const head = `<tr><th scope="col" class="exi-t">Herramienta</th>${X.holders.map((h) => holderHead(h, thr)).join('')}<th scope="col" class="n exi-s">Total</th><th scope="col" class="n exi-s">Recambio</th><th scope="col" class="n exi-s">Faltante</th><th scope="col" class="n exi-s">Pañol</th></tr>`;
  const body = X.rows.map((r) => `<tr><th scope="row" class="exi-t"><span class="exi-num">${r.n}</span><a href="#herramienta-${esc(r.toolId)}">${esc(r.name)}</a>${r.inactive ? '<span class="exi-ina">(inactiva)</span>' : ''}</th>${X.holders.map((h) => cell(r.cells[h.key])).join('')}<td class="n exi-s">${r.total}</td><td class="n exi-s">${r.cambio ? `<span class="mk c">C ${r.cambio}</span>` : '0'}</td><td class="n exi-s">${r.faltante ? `<span class="mk f">F ${r.faltante}</span>` : '0'}</td><td class="n exi-s">${r.disponible}</td></tr>`).join('');
  const foot = `<tr><th scope="row" class="exi-t">Total</th>${X.holders.map((h) => cell({ qty: h.total, cambio: h.cambio, faltante: h.faltante })).join('')}<td class="n exi-s">${X.totals.total}</td><td class="n exi-s">${X.totals.cambio}</td><td class="n exi-s">${X.totals.faltante}</td><td class="n exi-s">${X.totals.disponible}</td></tr>`;
  return `<div class="exiwrap" id="exiwrap" role="region" aria-label="Existencia por técnico: herramientas en filas y técnicos o cajas en columnas" tabindex="0"><table class="tbl exi" id="exitbl"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>`;
}

VIEWS.existencia = () => {
  const d = derive(); const f = filters(); const X = computeExistencia(); const thr = overdueDays();
  // Vencidos = la regla de la alerta (solo poseedores con herramientas activas).
  const late = X.holders.filter((h) => h.overdue).length;
  const exp = can('reports_export');
  const acts = exp ? `<button class="btn" data-act="exiXlsx">${icon('dl', 18)}Excel</button><button class="btn" data-act="exiPrint">${icon('print', 18)}Imprimir</button>` : '';
  const pl = optList([['all', 'Todas las plantillas'], ...mineFirst(d.shifts, d.myPlantilla.plantillaIds).map((p) => [p.id, p.name])], f.plantilla);
  const chip = (a, on, l) => `<button class="fchip ${on ? 'on' : ''}" data-act="${a}" aria-pressed="${on}">${l}</button>`;
  const printHead = `<div class="exi-ph"><b>Villa D'agri · Mantenimiento</b><span>Existencia por técnico: ${esc(filterLabel(f))}</span><span>Emitido ${esc(fdt(nowISO()))} por ${esc(who(ME.id).replace(/ \(vos\)$/, ''))}</span></div>`;
  const legend = `<div class="exileg" id="exileg"><b>Referencias</b><ul>${EXI_LEGEND.map((l) => `<li>${esc(l)}</li>`).join('')}<li>${thr ? `Días: desde el último control efectivo (o desde la primera entrega si nunca se controló); vencido con más de ${thr} días.` : 'Días: desde el último control efectivo (o desde la primera entrega si nunca se controló). La alerta de días sin control está desactivada.'}</li></ul></div>`;
  return printHead + pageHead('Existencia por técnico', esc(filterLabel(f)), { acts }) +
  `<div class="card exi-f"><div class="formgrid c2">${field('Plantilla', `<select id="exi-pl" data-ch="exiPl">${pl}</select>`, 'exi-pl')}${field('Mostrar', `<div class="fchips">${chip('exiCajas', f.cajas, 'Incluir cajas')}${chip('exiWith', f.withTools, 'Solo con herramientas')}</div>`)}</div></div>
  <section class="kpis k3 exi-k">${kpi(X.holders.length, 'Técnicos y cajas')}${kpi(X.totals.total, 'Herramientas asignadas')}${kpi(X.totals.cambio, 'Para recambio', '', 'warn')}${kpi(X.totals.faltante, 'Faltantes', '', 'bad')}${kpi(X.totals.disponible, 'Disponibles en el pañol')}${kpi(late, thr ? `Sin control hace más de ${thr} días` : 'Sin control (alerta desactivada)', '', late ? 'bad' : '')}</section>
  ${X.holders.length && X.rows.length ? matrix(X, thr) : `<div class="list">${emptyBox(X.rows.length ? 'No hay técnicos ni cajas para mostrar' : 'No hay herramientas cargadas', X.rows.length ? 'Probá con otra plantilla o incluí las cajas.' : 'Cargá herramientas en Configuración de herramientas.')}</div>`}${legend}`;
};

CH.exiPl = (v) => { filters().plantilla = v || 'all'; render(); };
ACT.exiCajas = () => { const f = filters(); f.cajas = !f.cajas; render(); };
ACT.exiWith = () => { const f = filters(); f.withTools = !f.withTools; render(); };

const fileBase = () => { const f = filters(); return `existencia-${new Date().toISOString().slice(0, 10)}${f.plantilla !== 'all' ? '-' + String(shiftName(f.plantilla)).toLowerCase().replace(/[^a-z0-9ñáéíóú]+/g, '-').replace(/^-|-$/g, '') : ''}`; };

ACT.exiXlsx = async () => {
  if (!gateUI('reports_export')) return;
  await act(async () => {
    await loadScript(vendor.xlsx, () => window.XLSX); const XLSX = window.XLSX; const X = computeExistencia();
    const rows = existenciaSheet(X, { title: "Villa D'agri · Mantenimiento: existencia por técnico", subtitle: `${filterLabel(filters())}. Generado ${fdt(nowISO())}.`, catName: (id) => (id ? catName(id) : 'Sin categoría') });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 6 }, { wch: 28 }, { wch: 18 }, ...X.holders.map((h) => ({ wch: Math.max(12, Math.min(28, holderLabel(h).length + 2)) })), { wch: 14 }, { wch: 11 }, { wch: 11 }, { wch: 14 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Existencia');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }); await saveFile(fileBase() + '.xlsx', new Blob([buf]));
  });
};

// Imprimir: la hoja de estilos de impresión deja solo la matriz (encabezado repetido en cada
// página) con el encabezado de la empresa y las referencias al pie.
ACT.exiPrint = () => {
  if (!gateUI('reports_export')) return;
  document.body.classList.add('print-exi');
  const done = () => { document.body.classList.remove('print-exi'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
};

