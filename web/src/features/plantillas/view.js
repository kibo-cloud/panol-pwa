// Plantillas por supervisor (reemplazan a Turnos): lista, vista de una plantilla basada en
// Turno.dc.html (miembros con estado, selección múltiple y "Mover seleccionados"), cambio de
// turno de la plantilla (rotación), cambio de supervisor con sus historiales, y alta,
// renombre y archivo (plantillas_edit). "Mi plantilla" va primero para el supervisor.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN, CH } from '../../ui/actions.js';
import { openModal, modalRerender, MOD, confirmBox } from '../../ui/modal.js';
import { toast, act, UErr } from '../../ui/feedback.js';
import { kpi, pageHead, emptyBox, avatar, demoChip, ctlBadge, sbar, cnts, plIcon, field, turnoText } from '../../ui/components.js';
import { api } from '../../api/index.js';
import { S, derive, can, who, refresh, canRotate, plantillaName } from '../../state/store.js';
import { plabel, fdate, todayISO } from '../../state/period.js';
import { toggleId, pruneSelection, allSelected, coverageOf, daysBetween, mineFirst } from '../../state/plantillas.js';
import { LIM } from '../../state/constants.js';
import { openMoveSelected } from './move.js';

const supName = (p) => (p.supervisorUserId ? who(p.supervisorUserId) : 'Sin supervisor');
const lastCtlText = (lastAt) => { const n = daysBetween(lastAt, todayISO()); return n == null ? 'Sin controles todavía' : n === 0 ? 'Último control hoy' : n === 1 ? 'Último control ayer' : `Último control hace ${n} días`; };

// Tarjeta de una plantilla (lista y panel de inicio).
export function plantillaCard(p) {
  const d = derive(); const i = d.shiftInfo[p.id] || { techs: 0, done: 0, alerts: 0, lastAt: null }; const pct = i.techs ? Math.round(i.done / i.techs * 100) : 0;
  const mine = d.myPlantilla.plantillaIds.includes(p.id);
  return `<a class="scard plcard" href="#plantilla-${esc(p.id)}"><span class="tile">${icon(plIcon(p), 20)}</span><span class="grow col6"><span class="rowb"><span class="t">${esc(p.name)}${mine ? ' <span class="chip pri">Mi plantilla</span>' : ''}</span><span class="s">${i.done}/${i.techs}</span></span><span class="s">${esc(supName(p))} · ${esc(turnoText(p.currentShiftLabel))} · ${i.techs} ${i.techs === 1 ? 'técnico' : 'técnicos'}</span><span class="pbar" role="img" aria-label="${i.done} de ${i.techs} técnicos controlados"><i data-css="width:${pct}%"></i></span><span class="plmeta">${i.alerts ? `<span class="chip bad">${icon('alert', 12)}${i.alerts} ${i.alerts === 1 ? 'alerta' : 'alertas'}</span>` : `<span class="chip ok">${icon('ok', 12)}Sin alertas</span>`}<span class="s">${lastCtlText(i.lastAt)}</span></span></span>${icon('right', 18)}</a>`;
}

VIEWS.plantillas = () => {
  const d = derive(); const list = mineFirst(d.shifts, d.myPlantilla.plantillaIds);
  const mine = list.filter((p) => d.myPlantilla.plantillaIds.includes(p.id)); const rest = list.filter((p) => !mine.includes(p));
  const acts = can('plantillas_edit') ? `<button class="btn pri" data-act="plNew">${icon('plus', 16)}Nueva plantilla</button>` : '';
  return pageHead('Plantillas', `${d.shifts.length} ${d.shifts.length === 1 ? 'plantilla' : 'plantillas'}, ${d.kpi.techs} técnicos activos`, { acts }) +
    (mine.length ? `<h2 class="sec" data-css="margin-top:0">Mi plantilla</h2><div class="g3">${mine.map(plantillaCard).join('')}</div><h2 class="sec">Otras plantillas</h2>` : '') +
    (rest.length ? `<div class="g3">${rest.map(plantillaCard).join('')}</div>` : mine.length ? '' : `<div class="list">${emptyBox('No hay plantillas', 'Creá la primera plantilla para agrupar a los técnicos.')}</div>`) +
    (d.archivedPlantillas.length ? `<h2 class="sec">Archivadas</h2><div class="list">${d.archivedPlantillas.map((p) => `<div class="row"><div class="grow"><div class="t">${esc(p.name)}</div><div class="s">Archivada el ${fdate(p.archivedAt)}</div></div></div>`).join('')}</div>` : '');
};

function memberCard(t, sel, selectable) {
  const d = derive(); const i = d.techInfo[t.id]; const on = sel.includes(t.id);
  const cov = coverageOf((S.plantillaHistory || {})[t.id] || [], todayISO());
  const covChip = cov && cov.started ? `<span class="chip warn">${icon('clock', 12)}Cobertura hasta el ${esc(fdate(cov.until))}</span>` : '';
  const box = selectable ? `<label class="selbox"><input id="sel-${esc(t.id)}" type="checkbox" data-ch="plSel" value="${esc(t.id)}" ${on ? 'checked' : ''} aria-label="Seleccionar a ${esc(t.name)}"></label>` : '';
  return `<div class="card tc ${on ? 'sel' : ''}"><div class="tc-row">${box}<a class="tc-h grow" href="#tecnico-${esc(t.id)}">${avatar(t.name, i.light, true)}<span class="grow"><span class="t">${esc(t.name)} ${demoChip(t)}</span><span class="s" data-css="display:block">Leg. ${esc(t.legajo)} · ${i.total} herramientas</span></span>${ctlBadge(i.curStatus)}</a></div>${covChip ? `<div>${covChip}</div>` : ''}<div class="tc-b">${sbar(i)}${cnts(i)}</div>${can('controls_do') && i.lines && i.curStatus !== 'done' ? `<a class="btn ${i.curStatus === 'draft' ? '' : 'pri'} block" href="#control-${esc(t.id)}">${icon('check', 16)}${i.curStatus === 'draft' ? 'Continuar control' : 'Controlar'}</a>` : ''}</div>`;
}

function historyCard(title, rows, empty) {
  return `<section class="card" data-css="margin-top:12px"><h2 class="si">${title}</h2>${rows.length ? `<div class="tl" data-css="margin-top:6px">${rows.map((r) => `<div class="tl-i"><span class="tl-dot pri"></span><div><div data-css="font-weight:620">${esc(r.change)}</div><div class="muted sm">${esc(r.meta)}</div></div></div>`).join('')}</div>` : `<p class="muted sm" data-css="margin:6px 0 0">${empty}</p>`}</section>`;
}

VIEWS.plantilla = (id) => {
  const d = derive(); const p = d.plantillaById[id]; if (!p) return pageHead('Plantilla no encontrada', '', { back: '#plantillas' });
  const archived = !!p.archivedAt; const i = d.shiftInfo[id] || { techs: 0, done: 0, tools: 0, sum: { bueno: 0, cambio: 0, faltante: 0 } };
  const members = d.activeTechs.filter((t) => t.shiftId === id);
  // La selección es de esta plantilla y solo de sus miembros actuales.
  if (UI.plSelFor !== id) { UI.plSel = []; UI.plSelFor = id; }
  UI.plSel = pruneSelection(UI.plSel || [], members.map((t) => t.id));
  const sel = UI.plSel;
  let ts = members; const q = (UI.turnoQ || '').trim().toLowerCase(); const f = UI.turnoF || 'all';
  if (q) ts = ts.filter((t) => t.name.toLowerCase().includes(q) || String(t.legajo).toLowerCase().includes(q));
  if (f === 'pend') ts = ts.filter((t) => d.techInfo[t.id].curStatus !== 'done');
  if (f === 'nov') ts = ts.filter((t) => d.techInfo[t.id].cambio || d.techInfo[t.id].faltante);
  const den = i.sum.bueno + i.sum.cambio + i.sum.faltante;
  const mv = can('shift_change') && !archived; const edit = can('plantillas_edit') && !archived;
  const acts = [
    can('controls_do') && i.techs ? `<a class="btn pri" href="#control" data-act="ctlShift" data-v="${esc(id)}">Controlar esta plantilla</a>` : '',
    canRotate(p) && !archived ? `<button class="btn" data-act="plRotate" data-p="${esc(id)}">${icon('clock', 16)}Cambiar turno de la plantilla</button>` : '',
    edit ? `<button class="btn" data-act="plSupervisor" data-p="${esc(id)}">Cambiar supervisor</button><button class="btn" data-act="plRename" data-p="${esc(id)}">${icon('pencil', 16)}Renombrar</button>` : '',
  ].join('');
  const selBar = mv && members.length ? `<div class="selbar" role="region" aria-label="Técnicos seleccionados"><span class="grow"><b>${sel.length ? `${sel.length} ${sel.length === 1 ? 'seleccionado' : 'seleccionados'}` : 'Ninguno seleccionado'}</b><span class="s" data-css="display:block">${sel.length ? 'Se mueven todos juntos, en un solo paso.' : 'Tildá a los técnicos que querés mover.'}</span></span><button class="btn sm" data-act="plSelAll">${allSelected(sel, members.map((t) => t.id)) ? 'Quitar todos' : 'Seleccionar todos'}</button><button class="btn sm pri" data-act="plMoveSel" data-p="${esc(id)}" ${sel.length ? '' : 'disabled aria-disabled="true"'}>${icon('swap', 16)}Mover seleccionados</button></div>` : '';
  const rot = (S.plantillaRotations || []).filter((r) => r.plantillaId === id).slice().reverse().map((r) => ({ change: `${r.fromLabel || 'Sin turno'} → ${r.label}`, meta: `Desde el ${fdate(r.from)} · ${who(r.by)}` }));
  const sups = (S.plantillaSupervisors || []).filter((r) => r.plantillaId === id).slice().reverse().map((r) => ({ change: r.fromUserId ? `${who(r.fromUserId)} → ${r.supervisorUserId ? who(r.supervisorUserId) : 'Sin supervisor'}` : `Supervisor: ${r.supervisorUserId ? who(r.supervisorUserId) : 'sin supervisor'}`, meta: `Desde el ${fdate(r.from)} · ${who(r.by)}` }));
  const archiveBox = edit ? `<section class="card" data-css="margin-top:12px"><h2 class="si">Archivar plantilla</h2>${members.length ? `<p class="muted sm" data-css="margin:6px 0 10px">Para archivarla, mové antes a sus ${members.length} ${members.length === 1 ? 'técnico' : 'técnicos'} a otra plantilla.</p><button class="btn danger" disabled aria-disabled="true">Archivar</button>` : `<p class="muted sm" data-css="margin:6px 0 10px">No tiene técnicos. Queda en el historial y en los informes anteriores.</p><button class="btn danger" data-act="plArchive" data-p="${esc(id)}">Archivar</button>`}</section>` : '';
  return `<a class="backl" href="#plantillas">${icon('back', 16)}Plantillas</a><div class="ph"><div data-css="display:flex;align-items:center;gap:12px"><span class="tile">${icon(plIcon(p), 20)}</span><div><h1>${esc(p.name)}${archived ? ' <span class="chip">Archivada</span>' : ''}</h1><div class="sub">${esc(supName(p))} · ${p.currentShiftLabel ? 'Turno actual: ' + esc(p.currentShiftLabel) : 'Sin turno actual'} · ${plabel(d.cur)}</div></div></div>${acts ? `<div class="acts">${acts}</div>` : ''}</div>
  <section class="kpis k3" data-css="margin-bottom:12px">${kpi(`${i.done}<small> /${i.techs}</small>`, 'Controlados')}${kpi(i.tools, 'Herramientas')}${kpi(den ? Math.round(i.sum.bueno / den * 100) + '%' : '—', 'En condiciones', '', 'ok')}</section>
  <div class="toolbar"><div class="search">${icon('search', 18)}<input id="turq" type="search" placeholder="Buscar por nombre o legajo" value="${esc(UI.turnoQ || '')}" data-in="turnoQ" aria-label="Buscar técnico"></div></div>
  <div class="fchips" data-css="margin-bottom:12px">${[['all', 'Todos'], ['pend', 'Pendientes'], ['nov', 'Con novedades']].map(([k, l]) => `<button class="fchip ${f === k ? 'on' : ''}" data-act="turnoF" data-v="${esc(k)}" aria-pressed="${f === k}">${l}</button>`).join('')}</div>
  ${selBar}
  ${ts.length ? `<div class="gtech">${ts.map((t) => memberCard(t, sel, mv)).join('')}</div>` : `<div class="list">${emptyBox(i.techs ? 'Ningún técnico coincide' : 'Esta plantilla no tiene técnicos', i.techs ? 'Probá con otro filtro.' : 'Mové técnicos desde otra plantilla o desde la ficha de cada técnico.', !i.techs && can('techs_edit') && !archived ? '<button class="btn pri" data-act="techNew">Nuevo técnico</button>' : '')}</div>`}
  <div class="two">${historyCard('Historial de turnos', rot, 'Todavía no se cambió el turno de esta plantilla.')}${historyCard('Historial de supervisores', sups, 'Sin cambios de supervisor registrados.')}</div>${archiveBox}`;
};

ACT.turnoF = (ds) => { UI.turnoF = ds.v; render(); };
IN.turnoQ = (v) => { UI.turnoQ = v; render(); };
CH.plSel = (v, el) => { UI.plSel = toggleId(UI.plSel || [], v, el.checked); render(); };
ACT.plSelAll = () => {
  const d = derive(); const id = UI.plSelFor; const ids = d.activeTechs.filter((t) => t.shiftId === id).map((t) => t.id);
  UI.plSel = allSelected(UI.plSel || [], ids) ? [] : ids; render();
};
ACT.plMoveSel = (ds) => openMoveSelected(ds.p, UI.plSel || []);

// ------------------------------------------------------------------ rotación y supervisor
ACT.plRotate = (ds) => {
  const p = derive().plantillaById[ds.p]; if (!p) return;
  if (!canRotate(p)) { toast('Solo el supervisor de la plantilla o quien tenga el permiso puede cambiar su turno.', 'err'); return; }
  const labels = S.shiftLabels && S.shiftLabels.length ? S.shiftLabels : ['Mañana', 'Tarde', 'Noche'];
  const hist = (S.plantillaRotations || []).filter((r) => r.plantillaId === ds.p).slice(-3).reverse();
  openModal({ title: 'Cambiar turno de la plantilla', rec: { get: () => S.plantillas[ds.p], version: p.version }, reload: () => ({ ...MOD.st }),
    render: (st) => `<p class="muted" data-css="margin-top:0">${esc(p.name)}: cambia una vez para toda la plantilla y queda en el historial, para saber qué plantilla estaba de turno en cada fecha.</p>${field('Turno nuevo', `<div class="opts" role="radiogroup" aria-label="Turno nuevo">${labels.map((l) => { const cur = l === (S.plantillas[ds.p] || p).currentShiftLabel; return `<button type="button" role="radio" aria-checked="${st.label === l}" class="opt ${st.label === l ? 'on' : ''}" ${cur ? 'disabled aria-disabled="true"' : `data-act="mset" data-k="label" data-v="${esc(l)}"`}>${esc(l)}${cur ? ' <span class="chip">Actual</span>' : ''}</button>`; }).join('')}</div>`)}${field('Desde', `<input id="rt-from" type="date" data-mi="from" max="${esc(todayISO())}" value="${esc(st.from || '')}">`, 'rt-from')}${hist.length ? `<div class="flabel" data-css="margin-bottom:6px">Últimos cambios</div><div class="list">${hist.map((r) => `<div class="row"><div class="grow"><div class="t">${esc(r.fromLabel || 'Sin turno')} → ${esc(r.label)}</div><div class="s">Desde el ${fdate(r.from)} · ${esc(who(r.by))}</div></div></div>`).join('')}</div>` : ''}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Confirmar cambio de turno', kind: 'pri', run: async (st, m) => {
      if (!st.label) throw new UErr('Elegí el turno nuevo.');
      if (!st.from) throw new UErr('Ingresá la fecha del cambio.');
      if (st.from > todayISO()) throw new UErr('La fecha del cambio no puede ser futura.');
      await api.rotatePlantilla(ds.p, { label: st.label, from: st.from }, m.rec.version); await refresh(); toast(`${p.name} pasa al turno ${st.label}`);
    } }] });
  MOD.st.from = todayISO(); modalRerender();
};

const supervisors = () => Object.entries(S.users || {}).filter(([, u]) => u.role === 'supervisor' && u.active !== false).map(([id, u]) => ({ id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
const supOpts = (st, k, cur) => `<div class="opts" role="radiogroup" aria-label="Supervisor">${[{ id: '', name: 'Sin supervisor' }, ...supervisors()].map((u) => { const isCur = cur !== undefined && (cur || '') === u.id; const on = (st[k] || '') === u.id && st[k] !== undefined; return `<button type="button" role="radio" aria-checked="${on}" class="opt ${on ? 'on' : ''}" ${isCur ? 'disabled aria-disabled="true"' : `data-act="mset" data-k="${esc(k)}" data-v="${esc(u.id)}"`}>${esc(u.name)}${isCur ? ' <span class="chip">Actual</span>' : ''}</button>`; }).join('')}</div>`;

ACT.plSupervisor = (ds) => {
  const p = derive().plantillaById[ds.p]; if (!p || !can('plantillas_edit')) return;
  openModal({ title: 'Cambiar supervisor', rec: { get: () => S.plantillas[ds.p], version: p.version }, reload: () => ({ ...MOD.st }),
    render: (st) => `<p class="muted" data-css="margin-top:0">${esc(p.name)}. El cambio queda registrado con la fecha y quién lo hizo.</p>${supervisors().length ? '' : `<p class="hint warn">${icon('alert', 16)}<span>No hay usuarios activos con perfil Supervisor. Crealos en Administración.</span></p>`}${field('Supervisor nuevo', supOpts(st, 'sup', (S.plantillas[ds.p] || p).supervisorUserId || ''))}${field('Desde', `<input id="sp-from" type="date" data-mi="from" max="${esc(todayISO())}" value="${esc(st.from || '')}">`, 'sp-from')}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Confirmar supervisor', kind: 'pri', run: async (st, m) => {
      if (st.sup === undefined) throw new UErr('Elegí el supervisor nuevo.');
      await api.setSupervisor(ds.p, { supervisorUserId: st.sup || null, from: st.from || null }, m.rec.version); await refresh(); toast('Supervisor actualizado');
    } }] });
  MOD.st.from = todayISO(); modalRerender();
};

// ------------------------------------------------------------------ alta, renombre y archivo
ACT.plNew = () => {
  if (!can('plantillas_edit')) { toast('Tu perfil no tiene permiso para esta acción.', 'err'); return; }
  const labels = S.shiftLabels && S.shiftLabels.length ? S.shiftLabels : [];
  openModal({ title: 'Nueva plantilla',
    render: (st) => { const sup = supervisors().find((u) => u.id === st.sup); return `${field('Supervisor', supOpts(st, 'sup'))}${field('Nombre', `<input id="pl-name" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}" placeholder="${esc(sup ? 'Plantilla de ' + sup.name : 'Ej.: Plantilla de mantenimiento')}">`, 'pl-name')}<p class="muted sm" data-css="margin-top:-8px">Si lo dejás vacío, se llama "Plantilla de" y el nombre del supervisor.</p>${labels.length ? field('Turno actual (informativo)', `<div class="opts">${labels.map((l) => `<button type="button" class="opt ${st.label === l ? 'on' : ''}" data-act="mset" data-k="label" data-v="${esc(l)}">${esc(l)}</button>`).join('')}</div>`) : ''}`; },
    actions: [{ label: 'Cancelar', close: true }, { label: 'Crear plantilla', kind: 'pri', run: async (st) => {
      const name = (st.name || '').trim();
      if (!name && !st.sup) throw new UErr('Ingresá un nombre o elegí un supervisor.');
      if (name && name.length < 2) throw new UErr('El nombre necesita al menos 2 letras.');
      if (name.length > LIM.name) throw new UErr(`El nombre admite hasta ${LIM.name} caracteres.`);
      const body = {}; if (name) body.name = name; if (st.sup) body.supervisorUserId = st.sup; if (st.label) body.shiftLabel = st.label;
      const r = await api.createPlantilla(body); await refresh(); toast('Plantilla creada'); location.hash = '#plantilla-' + r.plantilla.id;
    } }] });
};
ACT.plRename = (ds) => {
  const p = derive().plantillaById[ds.p]; if (!p || !can('plantillas_edit')) return;
  openModal({ title: 'Renombrar plantilla', rec: { get: () => S.plantillas[ds.p], version: p.version }, reload: (cur) => ({ name: cur.name }),
    render: (st) => field('Nombre', `<input id="pl-rn" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}">`, 'pl-rn'),
    actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar', kind: 'pri', run: async (st, m) => {
      const n = (st.name || '').trim(); if (n.length < 2) throw new UErr('Ingresá un nombre.');
      if (derive().shifts.some((x) => x.id !== ds.p && x.name.toLowerCase() === n.toLowerCase())) throw new UErr('Ya existe una plantilla con ese nombre.');
      await api.updatePlantilla(ds.p, { name: n }, m.rec.version); await refresh(); toast('Plantilla renombrada');
    } }] });
  MOD.st = { name: p.name }; modalRerender();
};
ACT.plArchive = async (ds) => {
  const p = derive().plantillaById[ds.p]; if (!p || !can('plantillas_edit')) return;
  if (!await confirmBox('Archivar plantilla', `${esc(p.name)} deja de aparecer en las listas. Su historial y los controles anteriores se conservan.`, 'Archivar', 'danger')) return;
  const ok = await act(async () => { await api.archivePlantilla(ds.p, p.version); await refresh(); return true; }, 'Plantilla archivada');
  if (ok) location.hash = '#plantillas';
};

export { plantillaName };
