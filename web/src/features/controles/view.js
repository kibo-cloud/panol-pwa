// Historial de controles (matriz técnicos × semanas) y detalle de un control (como 2.1).
// Cada control muestra la plantilla que tenía el técnico al hacerse (foto del servidor) y el
// filtro por plantilla usa esa foto; una caja compartida no tiene plantilla.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT } from '../../ui/actions.js';
import { kpi, pageHead, emptyBox, stChip, weekCells, monthNav, periodStatus } from '../../ui/components.js';
import { S, derive, can, who, shiftName, toolName, holderName } from '../../state/store.js';
import { holderKey, mineFirst } from '../../state/plantillas.js';

const ctlPlantilla = (c) => (c.cajaId ? null : c.plantillaId || c.shiftId || null);
const ctlPlantillaName = (c) => (c.cajaId ? 'Caja compartida (sin plantilla)' : shiftName(ctlPlantilla(c)));
import { fdt, plabel, prevMonth, nextMonth } from '../../state/period.js';

VIEWS.ver = (id) => {
  const d = derive(); const c = S.controls[id]; if (!c) return pageHead('Control no encontrado', '', { back: '#controles' });
  const t = (c.cajaId ? S.cajas[c.cajaId] : S.techs[c.techId]) || { name: c.techName || (c.cajaId ? 'Caja' : 'Técnico') }; const sup = d.supersededBy[id];
  const hk = holderKey(c); const back = c.cajaId ? `#caja-${c.cajaId}` : `#tecnico-${c.techId}`;
  const items = Object.entries(c.items || {}).sort((a, b) => (a[1].toolName || '').localeCompare(b[1].toolName || '', 'es'));
  const cn = c.counts || { bueno: 0, cambio: 0, faltante: 0 };
  return pageHead(`Control de ${esc(t.name)}`, `${plabel(c.period)}, ${esc(ctlPlantillaName(c))}`, { back, acts: c.status === 'finalizado' && can('controls_do') ? `<button class="btn" data-act="correct" data-c="${esc(id)}">Registrar corrección</button>` : c.status === 'borrador' && can('controls_do') ? `<a class="btn pri" href="#control-${esc(hk)}" data-act="${esc(c.correction ? 'resumeCorr' : '')}" data-c="${esc(c.supersedes || '')}">Continuar control</a>` : '' }) +
  `${sup ? `<div class="banner warn"><div><b>Este control fue corregido.</b><div class="sm">La versión vigente es la corrección. Este registro se conserva como historial.</div></div><div class="acts"><a class="btn sm" href="#controlver-${esc(sup)}">Ver corrección</a></div></div>` : ''}
  ${c.correction && c.supersedes ? `<div class="banner"><div><b>Corrección de auditoría.</b><div class="sm">Reemplaza al control registrado antes para el mismo período.</div></div><div class="acts"><a class="btn sm" href="#controlver-${esc(c.supersedes)}">Ver original</a></div></div>` : ''}
  <div class="card" data-css="margin-bottom:12px"><div class="formgrid c2"><div><div class="flabel">Estado</div><div>${c.status === 'finalizado' ? 'Finalizado' : 'Borrador sin finalizar'}</div></div><div><div class="flabel">Fecha y hora</div><div>${fdt(c.finishedAt || c.updatedAt)}</div></div><div data-css="margin-top:10px"><div class="flabel">Responsable</div><div>${esc(who(c.by))}</div></div><div data-css="margin-top:10px"><div class="flabel">Plantilla al momento del control</div><div>${esc(ctlPlantillaName(c))}</div></div></div></div>
  <section class="kpis" data-css="margin-bottom:12px">${kpi(cn.bueno, 'Buen estado', '', 'ok')}${kpi(cn.cambio, 'Para cambio', '', 'warn')}${kpi(cn.faltante, 'Faltantes', '', 'bad')}${kpi(items.length, 'Ítems controlados')}</section>
  <div class="twrap"><table class="tbl cards"><thead><tr><th>Herramienta</th><th>Código</th><th class="n">Cant.</th><th>Estado</th><th>Observación</th></tr></thead><tbody>${items.map(([, it]) => `<tr><td class="lead" data-l="Herramienta">${esc(it.toolName || toolName(it.toolId))}</td><td data-l="Código">${esc(it.unitCode || '—')}</td><td class="n" data-l="Cantidad">${esc(it.qty || 1)}</td><td data-l="Estado">${stChip(it.state)}</td><td data-l="Observación">${esc(it.note || '—')}</td></tr>`).join('') || '<tr><td colspan="5">Sin ítems</td></tr>'}</tbody></table></div>`;
};

VIEWS.controles = () => {
  const d = derive(); if (!UI.histMonth) UI.histMonth = { y: d.cur.y, m: d.cur.m }; const { y, m } = UI.histMonth;
  const ts = d.activeTechs.filter((t) => UI.histShift === 'all' || t.shiftId === UI.histShift);
  const inMonth = d.ctls.filter((c) => c.period && c.period.y === y && c.period.m === m && (UI.histShift === 'all' || ctlPlantilla(c) === UI.histShift)).sort((a, b) => b.pnum - a.pnum || (b.finishedAt || b.updatedAt || '').localeCompare(a.finishedAt || a.updatedAt || ''));
  let done = 0, draft = 0, pend = 0; for (const t of ts) for (const w of [1, 2, 3, 4]) { const s = periodStatus(t.id, { y, m, w }); if (s === 'done') done++; else if (s === 'draft') draft++; else if (s === 'pend') pend++; }
  return pageHead('Historial de controles', 'Cuatro controles por técnico y por mes') +
  `<div class="toolbar">${monthNav(y, m, 'histMonth')}</div>
  <div class="fchips" data-css="margin-bottom:12px"><button class="fchip ${UI.histShift === 'all' ? 'on' : ''}" data-act="histShift" data-v="all">Todos</button>${mineFirst(d.shifts, d.myPlantilla.plantillaIds).map((s) => `<button class="fchip ${UI.histShift === s.id ? 'on' : ''}" data-act="histShift" data-v="${esc(s.id)}">${esc(s.name)}</button>`).join('')}</div>
  <section class="kpis" data-css="margin-bottom:12px">${kpi(done, 'Realizados', '', 'ok')}${kpi(draft, 'Incompletos', '', 'warn')}${kpi(pend, 'Pendientes', '', 'pend')}${kpi(inMonth.filter((c) => c.correction).length, 'Correcciones')}</section>
  <div class="card">${ts.length ? `<div class="cal">${ts.map((t) => `<div class="cal-row"><a href="#tecnico-${esc(t.id)}"><div data-css="font-weight:620" class="ell">${esc(t.name)}</div><div class="muted xs">${esc(shiftName(t.shiftId))}</div></a>${weekCells(t.id, y, m)}</div>`).join('')}${UI.histShift === 'all' ? d.activeCajas.filter((k) => d.cajaInfo[k.id].lines).map((k) => `<div class="cal-row"><a href="#caja-${esc(k.id)}"><div data-css="font-weight:620" class="ell">${esc(k.name)}</div><div class="muted xs">Caja compartida</div></a>${weekCells('caja:' + k.id, y, m)}</div>`).join('') : ''}</div>` : emptyBox('No hay técnicos activos', '')}</div>
  <h2 class="sec">Registros del mes</h2>${inMonth.length ? `<div class="list">${inMonth.map((c) => `<a class="row" href="#controlver-${esc(c.id)}"><span class="light ${c.status === 'finalizado' ? (d.supersededBy[c.id] ? 'pend' : 'ok') : 'warn'}"></span><div class="grow"><div class="t ell">${esc(holderName(c) || c.techName)}, semana ${c.period.w}${c.correction ? ' (corrección)' : ''}</div><div class="s">${c.status === 'finalizado' ? 'Finalizado ' + fdt(c.finishedAt) : 'Borrador ' + fdt(c.updatedAt)}, ${esc(who(c.by))}</div></div>${icon('right', 18)}</a>`).join('')}</div>` : `<div class="list">${emptyBox('Sin controles en este mes', '')}</div>`}`;
};

ACT.histMonth = (ds) => { UI.histMonth = +ds.d < 0 ? prevMonth(UI.histMonth.y, UI.histMonth.m) : nextMonth(UI.histMonth.y, UI.histMonth.m); render(); };
ACT.histShift = (ds) => { UI.histShift = ds.v; render(); };
