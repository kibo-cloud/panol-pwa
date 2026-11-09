// Alertas abiertas y resueltas (como 2.1). Resolver guarda quién y cuándo en el servidor.
// Filtro por plantilla (y cajas compartidas); para un supervisor arranca en su plantilla.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, CH } from '../../ui/actions.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/feedback.js';
import { kpi, pageHead, emptyBox, alertList, field } from '../../ui/components.js';
import { gateUI, espSelect } from '../tecnicos/view.js';
import { api } from '../../api/index.js';
import { S, derive, who, refresh } from '../../state/store.js';
import { mineFirst } from '../../state/plantillas.js';

// Filtro elegido, o la plantilla propia del supervisor la primera vez.
function alertFilter(d) {
  if (UI.alertPl == null) UI.alertPl = d.myPlantilla.plantillaIds[0] || 'all';
  return UI.alertPl === 'all' || UI.alertPl === 'cajas' || d.shiftById[UI.alertPl] ? UI.alertPl : 'all';
}
import { fdt } from '../../state/period.js';

VIEWS.alertas = () => {
  const d = derive(); const tab = UI.alertTab; const pf = alertFilter(d);
  const espOk = (a) => !UI.alertEsp || UI.alertEsp === 'all' || (!a.cajaId && (UI.alertEsp === 'none' ? !(S.techs[a.techId] || {}).especialidadId : (S.techs[a.techId] || {}).especialidadId === UI.alertEsp));
  const open = (pf === 'all' ? d.alertsOpen : (d.alertsByPlantilla[pf] || [])).filter(espOk);
  const chips = [['all', 'Todas'], ...mineFirst(d.shifts, d.myPlantilla.plantillaIds).map((p) => [p.id, p.name + (d.myPlantilla.plantillaIds.includes(p.id) ? ' (mi plantilla)' : '')]), ...(d.cajas.length ? [['cajas', 'Cajas compartidas']] : [])];
  const res = Object.entries(S.alertRes).map(([k, r]) => ({ key: k, ...r })).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const byType = (t) => open.filter((a) => a.type === t).length;
  return pageHead('Alertas', 'Situaciones que requieren atención') +
  `<section class="kpis" data-css="margin-bottom:14px">${kpi(byType('faltante'), 'Faltantes', '', 'bad')}${kpi(byType('cambio') + byType('consecutiva'), 'Para cambio', '', 'warn', byType('consecutiva') ? `${byType('consecutiva')} en controles seguidos` : '')}${kpi(byType('devolucion'), 'Devoluciones pendientes', '', 'bad')}${kpi(byType('pendiente'), 'Controles pendientes', '', 'pend')}${kpi(byType('limpieza'), 'Limpieza', '', 'warn', 'dos controles seguidos')}</section>
  <div class="fchips" data-css="margin-bottom:12px" aria-label="Filtrar por plantilla">${chips.map(([k, l]) => `<button class="fchip ${pf === k ? 'on' : ''}" data-act="alertPl" data-v="${esc(k)}" aria-pressed="${pf === k}">${esc(l)}${k === 'all' ? '' : ` (${(k === 'all' ? d.alertsOpen : d.alertsByPlantilla[k] || []).length})`}</button>`).join('')}</div>
  <div class="toolbar">${espSelect('alert-esp', 'alertEsp', UI.alertEsp)}</div><div class="seg" role="tablist" data-css="margin-bottom:12px;max-width:420px"><button role="tab" aria-selected="${tab === 'open'}" class="${tab === 'open' ? 'on' : ''}" data-act="alertTab" data-v="open">Abiertas (${open.length})</button><button role="tab" aria-selected="${tab === 'res'}" class="${tab === 'res' ? 'on' : ''}" data-act="alertTab" data-v="res">Resueltas (${res.length})</button></div>
  ${tab === 'open' ? alertList(open, true) : res.length ? `<div class="list">${res.map((r) => `<div class="al"><span class="al-ic ok">${icon('ok', 16)}</span><div class="grow"><span class="t">${esc(r.title || 'Alerta')}</span><div class="s">${esc(r.text || '')}</div><div class="s" data-css="margin-top:4px">Resuelta por ${esc(who(r.by))} · ${fdt(r.at)}${r.note ? '. ' + esc(r.note) : ''}</div></div></div>`).join('')}</div>` : `<div class="list">${emptyBox('Todavía no se resolvieron alertas', '')}</div>`}`;
};

ACT.alertTab = (ds) => { UI.alertTab = ds.v; render(); };
CH.alertEsp = (v) => { UI.alertEsp = v; render(); };
ACT.alertPl = (ds) => { UI.alertPl = ds.v; render(); };
ACT.alertPlMine = () => { UI.alertPl = null; };
ACT.alertPlAll = () => { UI.alertPl = 'all'; };
ACT.resolveAlert = (ds) => {
  const a = derive().alertsOpen.find((x) => x.key === ds.k); if (!a || !gateUI('alerts_resolve')) return;
  openModal({ title: 'Resolver alerta', render: (st) => `<p data-css="margin-top:0"><b>${esc(a.title)}</b><br><span class="muted">${esc(a.text)}</span></p>${a.type === 'cambio' || a.type === 'consecutiva' || a.type === 'faltante' ? '<p class="hint">Si la herramienta se reemplazó, registrá la reposición: la alerta se cierra sola. Resolverla acá solo la marca como atendida.</p>' : ''}${field('Nota de resolución', `<input id="f-an" type="text" maxlength="2000" data-mi="note" value="${esc(st.note || '')}" placeholder="Qué se hizo">`, 'f-an')}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Marcar resuelta', kind: 'pri', run: async (st) => { await api.resolveAlert(a.key, (st.note || '').trim()); await refresh(); toast('Alerta resuelta'); } }] });
};
