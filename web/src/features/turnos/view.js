// Turnos: tarjetas por turno y detalle de un turno con sus técnicos (igual que 2.1).
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN } from '../../ui/actions.js';
import { kpi, pageHead, emptyBox, avatar, demoChip, ctlBadge, sbar, cnts, SHIFT_IC } from '../../ui/components.js';
import { shiftCard } from '../inicio/view.js';
import { derive, can } from '../../state/store.js';
import { plabel } from '../../state/period.js';

VIEWS.turnos = () => {
  const d = derive();
  return pageHead('Turnos', `${d.shifts.length} turnos, ${d.kpi.techs} técnicos activos`, { acts: can('shifts_edit') ? '<a class="btn" href="#admin" data-act="adminTab" data-v="shifts">Administrar turnos</a>' : '' }) +
    `<div class="g3">${d.shifts.map((s, i) => shiftCard(s, i)).join('')}</div>`;
};

function techCard(t) {
  const i = derive().techInfo[t.id];
  return `<div class="card tc"><a class="tc-h" href="#tecnico-${esc(t.id)}">${avatar(t.name, i.light, true)}<span class="grow"><span class="t">${esc(t.name)} ${demoChip(t)}</span><span class="s" data-css="display:block">Leg. ${esc(t.legajo)} · ${i.total} herramientas</span></span>${ctlBadge(i.curStatus)}</a><div class="tc-b">${sbar(i)}${cnts(i)}</div>${can('controls_do') && i.lines && i.curStatus !== 'done' ? `<a class="btn ${i.curStatus === 'draft' ? '' : 'pri'} block" href="#control-${esc(t.id)}">${icon('check', 16)}${i.curStatus === 'draft' ? 'Continuar control' : 'Controlar'}</a>` : ''}</div>`;
}

VIEWS.turno = (id) => {
  const d = derive(); const s = d.shiftById[id]; if (!s) return pageHead('Turno no encontrado', '', { back: '#turnos' });
  const idx = d.shifts.findIndex((x) => x.id === id); const i = d.shiftInfo[id]; let ts = d.activeTechs.filter((t) => t.shiftId === id);
  const den = i.sum.bueno + i.sum.cambio + i.sum.faltante; const q = (UI.turnoQ || '').trim().toLowerCase(); const f = UI.turnoF || 'all';
  if (q) ts = ts.filter((t) => t.name.toLowerCase().includes(q) || String(t.legajo).toLowerCase().includes(q));
  if (f === 'pend') ts = ts.filter((t) => d.techInfo[t.id].curStatus !== 'done');
  if (f === 'nov') ts = ts.filter((t) => d.techInfo[t.id].cambio || d.techInfo[t.id].faltante);
  return `<a class="backl" href="#turnos">${icon('back', 16)}Turnos</a><div class="ph"><div data-css="display:flex;align-items:center;gap:12px"><span class="tile">${icon(SHIFT_IC(idx), 20)}</span><div><h1>${esc(s.name)}</h1><div class="sub">${plabel(d.cur)}</div></div></div>${can('controls_do') && i.techs ? `<div class="acts"><a class="btn pri" href="#control" data-act="ctlShift" data-v="${esc(id)}">Controlar este turno</a></div>` : ''}</div>
  <section class="kpis k3" data-css="margin-bottom:12px">${kpi(`${i.done}<small> /${i.techs}</small>`, 'Controlados')}${kpi(i.tools, 'Herramientas')}${kpi(den ? Math.round(i.sum.bueno / den * 100) + '%' : '—', 'En condiciones', '', 'ok')}</section>
  <div class="toolbar"><div class="search">${icon('search', 18)}<input id="turq" type="search" placeholder="Buscar por nombre o legajo" value="${esc(UI.turnoQ || '')}" data-in="turnoQ" aria-label="Buscar técnico"></div></div>
  <div class="fchips" data-css="margin-bottom:12px">${[['all', 'Todos'], ['pend', 'Pendientes'], ['nov', 'Con novedades']].map(([k, l]) => `<button class="fchip ${f === k ? 'on' : ''}" data-act="turnoF" data-v="${esc(k)}" aria-pressed="${f === k}">${l}</button>`).join('')}</div>
  ${ts.length ? `<div class="gtech">${ts.map(techCard).join('')}</div>` : `<div class="list">${emptyBox(i.techs ? 'Ningún técnico coincide' : 'Este turno no tiene técnicos', i.techs ? 'Probá con otro filtro.' : 'Asigná técnicos desde la sección Técnicos.', !i.techs && can('techs_edit') ? '<button class="btn pri" data-act="techNew">Nuevo técnico</button>' : '')}</div>`}`;
};

ACT.turnoF = (ds) => { UI.turnoF = ds.v; render(); };
IN.turnoQ = (v) => { UI.turnoQ = v; render(); };
