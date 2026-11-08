// Técnicos: lista, ficha (herramientas, controles, novedades, movimientos, turnos), alta,
// edición, activación y cambio de turno. Las escrituras van por la API con If-Match.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN } from '../../ui/actions.js';
import { openModal, modalRerender, MOD, closeModal, confirmBox } from '../../ui/modal.js';
import { toast, act, UErr, tooLong } from '../../ui/feedback.js';
import { kpi, pageHead, emptyBox, avatar, demoChip, ctlBadge, stChip, mvList, field, optList, weekCells, monthNav, SHIFT_IC } from '../../ui/components.js';
import { api } from '../../api/index.js';
import { S, derive, can, who, refresh, shiftName, toolName, catName } from '../../state/store.js';
import { ST, LIM } from '../../state/constants.js';
import { fdate, fdt, plabel, parsePkey, prevMonth, nextMonth, todayISO } from '../../state/period.js';

export function gateUI(p) { if (can(p)) return true; toast('Tu perfil no tiene permiso para esta acción.', 'err'); return false; }

VIEWS.tecnicos = () => {
  const d = derive(); const q = UI.techQ.trim().toLowerCase();
  let list = d.techs.filter((t) => (UI.techInactive ? t.active === false : t.active !== false));
  if (UI.techShift !== 'all') list = list.filter((t) => t.shiftId === UI.techShift);
  if (q) list = list.filter((t) => (t.name || '').toLowerCase().includes(q) || String(t.legajo || '').toLowerCase().includes(q));
  return pageHead('Técnicos', `${d.activeTechs.length} activos, ${d.techs.length - d.activeTechs.length} inactivos`, { acts: can('techs_edit') ? `<button class="btn pri" data-act="techNew">${icon('plus', 16)}Nuevo técnico</button>` : '' }) +
  `<div class="toolbar"><div class="search">${icon('search', 18)}<input id="techq" type="search" placeholder="Buscar por nombre o legajo" value="${esc(UI.techQ)}" data-in="techQ" aria-label="Buscar técnico"></div></div>
  <div class="fchips" data-css="margin-bottom:12px"><button class="fchip ${UI.techShift === 'all' ? 'on' : ''}" data-act="techShift" data-v="all">Todos</button>${d.shifts.map((s) => `<button class="fchip ${UI.techShift === s.id ? 'on' : ''}" data-act="techShift" data-v="${esc(s.id)}">${esc(s.name)}</button>`).join('')}<button class="fchip ${UI.techInactive ? 'on' : ''}" data-act="techInactive">Inactivos</button></div>
  ${list.length ? `<div class="list">${list.map((t) => { const i = d.techInfo[t.id]; return `<a class="row" href="#tecnico-${esc(t.id)}">${avatar(t.name, t.active === false ? null : i.light)}<div class="grow"><div class="t ell">${esc(t.name)} ${demoChip(t)}</div><div class="s ell">Leg. ${esc(t.legajo)} · ${esc(shiftName(t.shiftId))} · ${i.total} herr.</div></div><div class="r">${t.active === false ? '<span class="chip">Inactivo</span>' : ctlBadge(i.curStatus)}</div></a>`; }).join('')}</div>` : `<div class="list">${emptyBox(q ? 'Ningún técnico coincide con la búsqueda' : 'No hay técnicos para mostrar', q ? 'Probá con otro nombre o legajo.' : '', !q && can('techs_edit') && !UI.techInactive ? '<button class="btn pri" data-act="techNew">Nuevo técnico</button>' : '')}</div>`}`;
};

VIEWS.tecnico = (id) => {
  const d = derive(); const t = S.techs[id]; if (!t) return pageHead('Técnico no encontrado', '', { back: '#tecnicos' });
  const i = d.techInfo[id]; const list = d.asgByTech[id] || [];
  if (!UI.techMonth) UI.techMonth = { y: d.cur.y, m: d.cur.m };
  const acts = [can('controls_do') && list.length && t.active !== false ? `<a class="btn pri" href="#control-${esc(id)}">${icon('check', 18)}Controlar</a>` : '', can('movements_do') && t.active !== false ? `<button class="btn" data-act="goEntrega" data-t="${esc(id)}">Entregar herramienta</button>` : '', can('techs_edit') ? `<button class="btn" data-act="techEdit" data-t="${esc(id)}">Editar</button>` : ''].join('');
  const tab = UI.techTab;
  let body = '';
  if (tab === 'tools') {
    body = list.length ? `<div class="list">${list.map((a) => { const s = d.stateOf[a.id]; const st = s ? s.state : 'pendiente'; const u = a.unitId && S.units[a.unitId]; return `<a class="row" href="#herramienta-${esc(a.toolId)}"><span class="light ${ST[st].cls}"></span><div class="grow"><div class="t ell">${esc(toolName(a.toolId))}${a.qty > 1 ? ` ×${a.qty}` : ''}</div><div class="s ell">${[catName((S.tools[a.toolId] || {}).categoryId), u ? 'Código ' + u.code : '', 'desde ' + fdate(a.since)].filter(Boolean).map(esc).join(', ')}</div>${s && s.note ? `<div class="s">${esc(s.note)}</div>` : ''}</div>${stChip(st)}</a>`; }).join('')}</div>` : `<div class="list">${emptyBox('Sin herramientas asignadas', 'Registrá una entrega inicial para asignarle herramientas.', can('movements_do') && t.active !== false ? `<button class="btn pri" data-act="goEntrega" data-t="${esc(id)}">Entregar herramienta</button>` : '')}</div>`;
  } else if (tab === 'ctl') {
    const cl = d.ctls.filter((c) => c.techId === id).sort((a, b) => (b.finishedAt || b.updatedAt || '').localeCompare(a.finishedAt || a.updatedAt || ''));
    body = `<div class="card" data-css="margin-bottom:12px"><div class="srow"><h2 class="si">Calendario de controles</h2>${monthNav(UI.techMonth.y, UI.techMonth.m, 'techMonth')}</div>${weekCells(id, UI.techMonth.y, UI.techMonth.m)}</div>` +
    (cl.length ? `<div class="list">${cl.map((c) => `<a class="row" href="#controlver-${esc(c.id)}"><span class="light ${c.status === 'finalizado' ? 'ok' : 'warn'}"></span><div class="grow"><div class="t">${plabel(c.period)}${c.correction ? ' (corrección)' : ''}</div><div class="s">${c.status === 'finalizado' ? 'Finalizado ' + fdt(c.finishedAt) : 'Borrador, guardado ' + fdt(c.updatedAt)}, ${esc(who(c.by))}${d.supersededBy[c.id] ? ', reemplazado por una corrección' : ''}</div></div>${c.counts ? `<div class="r">${c.counts.cambio ? `<span class="chip warn">${esc(c.counts.cambio)}</span>` : ''}${c.counts.faltante ? `<span class="chip bad">${esc(c.counts.faltante)}</span>` : ''}</div>` : ''}</a>`).join('')}</div>` : `<div class="list">${emptyBox('Todavía no tiene controles', '')}</div>`);
  } else if (tab === 'nov') {
    const tr = d.transitions.filter((x) => x.techId === id).map((x) => { let txt, cls; if (x.to === 'faltante') { txt = 'Nuevo faltante'; cls = 'bad'; } else if (x.from === 'faltante') { txt = 'Herramienta recuperada'; cls = 'ok'; } else if (x.to === 'cambio') { txt = 'Pasó a para cambio'; cls = 'warn'; } else if (x.from === 'cambio' && x.to === 'bueno') { txt = 'Volvió a buen estado'; cls = 'ok'; } else { txt = 'Cambio de estado'; cls = 'pend'; } return { at: x.at, cls, title: `${txt}: ${x.toolName || toolName(x.toolId)}${x.unitCode ? ' (' + x.unitCode + ')' : ''}`, sub: `${plabel(parsePkey(x.pkey))}${x.note ? '. ' + x.note : ''}` }; });
    const rp = d.movs.filter((m) => m.techId === id && m.type === 'reposicion').map((m) => ({ at: m.at, cls: 'pri', title: `Herramienta reemplazada: ${toolName(m.toolId)}`, sub: `${fdt(m.at)}. Estado anterior: ${(ST[m.oldState] || {}).label || '—'}. ${m.returned ? 'Devolvió la anterior.' : 'No devolvió la anterior.'}` }));
    const sc = Object.values(S.shiftChanges).filter((x) => x.techId === id).map((x) => ({ at: x.at, cls: 'pri', title: `Cambio de turno: ${x.fromName || shiftName(x.from)} a ${x.toName || shiftName(x.to)}`, sub: `${fdt(x.at)}, ${who(x.by)}` }));
    const all = [...tr, ...rp, ...sc].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    body = all.length ? `<div class="card"><div class="tl">${all.map((x) => `<div class="tl-i"><span class="tl-dot ${x.cls}"></span><div><div data-css="font-weight:620">${esc(x.title)}</div><div class="muted sm">${esc(x.sub)}</div></div></div>`).join('')}</div></div>` : `<div class="list">${emptyBox('Sin novedades', 'Los cambios de estado entre controles, reemplazos y cambios de turno aparecen acá.')}</div>`;
  } else if (tab === 'mov') { body = mvList(d.movs.filter((m) => m.techId === id)); } else if (tab === 'shift') {
    const sc = Object.values(S.shiftChanges).filter((x) => x.techId === id).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    body = sc.length ? `<div class="list">${sc.map((x) => `<div class="row"><div class="grow"><div class="t">${esc(x.fromName || shiftName(x.from))} a ${esc(x.toName || shiftName(x.to))}</div><div class="s">${fdt(x.at)}, ${esc(who(x.by))}${x.note ? '. ' + esc(x.note) : ''}</div></div></div>`).join('')}</div>` : `<div class="list">${emptyBox('Sin cambios de turno', `Está en ${esc(shiftName(t.shiftId))} desde el alta.`)}</div>`;
  }
  return `<a class="backl" href="#tecnicos">${icon('back', 16)}Técnicos</a><div class="card" data-css="margin-bottom:12px"><div class="prof">${avatar(t.name, t.active === false ? null : i.light, true)}<div class="grow"><h1>${esc(t.name)} ${demoChip(t)}</h1><div class="s">Leg. ${esc(t.legajo)} · Alta ${fdate(t.alta || t.createdAt)}</div></div><span class="chip ${t.active === false ? 'pend' : 'ok'}">${t.active === false ? 'Inactivo' : 'Activo'}</span></div><div class="shiftnow"><span class="tile">${icon(SHIFT_IC(d.shifts.findIndex((s) => s.id === t.shiftId)), 20)}</span><div class="grow"><div class="s">Turno actual</div><div class="t">${esc(shiftName(t.shiftId))}</div></div>${can('shift_change') && t.active !== false ? `<button class="btn sm" data-act="shiftChange" data-t="${esc(id)}">Cambiar turno</button>` : ''}</div>${acts ? `<div class="toolbar" data-css="margin:0">${acts}</div>` : ''}</div>` +
  `<section class="kpis">${kpi(i.total, 'Herramientas asignadas')}${kpi(i.bueno, 'En buen estado', '', 'ok')}${kpi(i.cambio, 'Para cambio', '', 'warn')}${kpi(i.faltante, 'Faltantes', '', 'bad')}</section>
  <div class="tabs" role="tablist">${[['tools', 'Herramientas'], ['ctl', 'Controles'], ['nov', 'Novedades'], ['mov', 'Entregas y reposiciones'], ['shift', 'Turnos']].map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}" data-act="techTab" data-v="${esc(k)}">${l}</button>`).join('')}</div>${body}`;
};

ACT.techShift = (ds) => { UI.techShift = ds.v; render(); };
ACT.techInactive = () => { UI.techInactive = !UI.techInactive; render(); };
IN.techQ = (v) => { UI.techQ = v; render(); };
ACT.techTab = (ds) => { UI.techTab = ds.v; render(); };
ACT.techMonth = (ds) => { UI.techMonth = +ds.d < 0 ? prevMonth(UI.techMonth.y, UI.techMonth.m) : nextMonth(UI.techMonth.y, UI.techMonth.m); render(); };

function techForm(t) {
  const d = derive();
  return (st) => `${field('Nombre y apellido', `<input id="f-name" type="text" maxlength="120" data-mi="name" value="${esc(st.name)}" autocomplete="off">`, 'f-name')}${field('Legajo o identificador', `<input id="f-leg" type="text" maxlength="50" data-mi="legajo" value="${esc(st.legajo)}" autocomplete="off">`, 'f-leg')}${t ? '' : field('Turno', `<select id="f-shift" data-mi="shiftId">${optList(d.shifts.map((s) => [s.id, s.name]), st.shiftId)}</select>`, 'f-shift')}${field('Fecha de alta', `<input id="f-alta" type="date" data-mi="alta" value="${esc(st.alta)}">`, 'f-alta')}${t ? '<p class="muted sm">Para cambiar el turno usá Cambiar turno, así queda registrado en el historial.</p>' : ''}`;
}
function validTech(st, exceptId) {
  const name = (st.name || '').trim(), leg = (st.legajo || '').trim();
  if (name.length < 3) throw new UErr('Ingresá nombre y apellido.'); if (!leg) throw new UErr('Ingresá el legajo.'); tooLong(name, LIM.name, 'El nombre'); tooLong(leg, LIM.legajo, 'El legajo');
  const dup = Object.entries(S.techs).find(([id, t]) => id !== exceptId && String(t.legajo).trim().toLowerCase() === leg.toLowerCase());
  if (dup) throw new UErr(`El legajo ${leg} ya pertenece a ${dup[1].name}.`);
  return { name, leg };
}
const techSt = (t) => ({ name: t.name, legajo: t.legajo, alta: t.alta || (t.createdAt || '').slice(0, 10) });

ACT.techNew = () => {
  if (!gateUI('techs_edit')) return;
  openModal({ title: 'Nuevo técnico', render: techForm(null), actions: [{ label: 'Cancelar', close: true }, { label: 'Crear técnico', kind: 'pri', run: async (st) => {
    const { name, leg } = validTech(st);
    const r = await api.createTech({ name, legajo: leg, shiftId: st.shiftId || derive().shifts[0].id, alta: st.alta || todayISO() });
    await refresh(); toast('Técnico creado'); location.hash = '#tecnico-' + r.tech.id;
  } }] });
  if (MOD) { MOD.st.shiftId = UI.techShift !== 'all' ? UI.techShift : (derive().shifts[0] || {}).id; MOD.st.alta = todayISO(); modalRerender(); }
};
ACT.techEdit = (ds) => {
  const t = S.techs[ds.t]; if (!t || !gateUI('techs_edit')) return;
  openModal({ title: 'Editar técnico', rec: { get: () => S.techs[ds.t], version: t.version }, reload: techSt,
    render: (st) => techForm(t)(st) + `<div class="field"><label>Estado</label>${t.active === false ? `<button class="btn" data-act="techActive" data-t="${esc(ds.t)}" data-v="1">Reactivar técnico</button>` : `<button class="btn danger" data-act="techActive" data-t="${esc(ds.t)}" data-v="0">Desactivar técnico</button>`}</div>`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar cambios', kind: 'pri', run: async (st, m) => {
      const { name, leg } = validTech(st, ds.t);
      await api.updateTech(ds.t, { name, legajo: leg, alta: st.alta || null }, m.rec.version); await refresh(); toast('Cambios guardados');
    } }] });
  MOD.st = techSt(t); modalRerender();
};
ACT.techActive = async (ds) => {
  const t = S.techs[ds.t]; const n = (derive().asgByTech[ds.t] || []).length; closeModal(); const on = ds.v === '1';
  if (!on && !await confirmBox('Desactivar técnico', `${esc(t.name)} dejará de aparecer en turnos y controles. Su historial se conserva.${n ? `<br><br><b>Tiene ${n} herramientas asignadas.</b> Te conviene registrar su devolución o retiro.` : ''}`, 'Desactivar', 'danger')) return;
  await act(async () => { await api.updateTech(ds.t, { active: on }, S.techs[ds.t].version); await refresh(); }, on ? 'Técnico reactivado' : 'Técnico desactivado');
};
ACT.shiftChange = (ds) => {
  const t = S.techs[ds.t]; if (!t || !gateUI('shift_change')) return; const d = derive();
  const hist = Object.values(S.shiftChanges).filter((x) => x.techId === ds.t).sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 3);
  openModal({ title: 'Cambio de turno', rec: { get: () => S.techs[ds.t], version: t.version }, reload: (cur) => ({ ...MOD.st, cur: cur.shiftId }),
    render: (st) => `<p class="muted" data-css="margin-top:0">${esc(t.name)} · Leg. ${esc(t.legajo)}</p>${field('Nuevo turno', `<div class="opts">${d.shifts.map((s, i) => { const cur = s.id === (S.techs[ds.t] || t).shiftId; return `<button type="button" class="opt ${st.to === s.id ? 'on' : ''}" ${cur ? 'disabled aria-disabled="true" data-css="opacity:.55"' : `data-act="mset" data-k="to" data-v="${esc(s.id)}"`}>${icon(SHIFT_IC(i), 16)}${esc(s.name)}${cur ? ' (actual)' : ''}</button>`; }).join('')}</div>`)}${field('Desde', `<input id="f-nd" type="date" data-mi="from" value="${esc(st.from || '')}">`, 'f-nd')}${field('Motivo', `<input id="f-nn" type="text" maxlength="2000" data-mi="note" value="${esc(st.note || '')}" placeholder="Opcional">`, 'f-nn')}<div class="hint ok">${icon('ok', 16)}<span><b>Se conserva todo.</b> Las herramientas asignadas, los controles anteriores y el historial siguen con el técnico. Queda registrado el turno anterior, el nuevo, la fecha y el responsable.</span></div>${hist.length ? `<div class="flabel" data-css="margin-bottom:6px">Historial de turnos</div><div class="list" data-css="margin-bottom:8px">${hist.map((x) => `<div class="row"><div class="grow"><div class="t">${esc(x.fromName || shiftName(x.from))} → ${esc(x.toName || shiftName(x.to))}</div><div class="s">${fdt(x.at)} · ${esc(who(x.by))}</div></div></div>`).join('')}</div>` : ''}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Confirmar cambio', kind: 'pri', run: async (st, m) => {
      if (!st.to) throw new UErr('Elegí el turno nuevo.');
      await api.shiftChange(ds.t, { to: st.to, effectiveFrom: st.from || null, note: (st.note || '').trim() }, m.rec.version); await refresh(); toast('Turno actualizado');
    } }] });
  MOD.st.from = todayISO(); modalRerender();
};
