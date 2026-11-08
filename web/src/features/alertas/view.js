// Alertas abiertas y resueltas (igual que 2.1). Resolver guarda quién y cuándo en el servidor.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT } from '../../ui/actions.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/feedback.js';
import { kpi, pageHead, emptyBox, alertList, field } from '../../ui/components.js';
import { gateUI } from '../tecnicos/view.js';
import { api } from '../../api/index.js';
import { S, derive, who, refresh } from '../../state/store.js';
import { fdt } from '../../state/period.js';

VIEWS.alertas = () => {
  const d = derive(); const tab = UI.alertTab;
  const res = Object.entries(S.alertRes).map(([k, r]) => ({ key: k, ...r })).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const byType = (t) => d.alertsOpen.filter((a) => a.type === t).length;
  return pageHead('Alertas', 'Situaciones que requieren atención') +
  `<section class="kpis" data-css="margin-bottom:14px">${kpi(byType('faltante'), 'Faltantes', '', 'bad')}${kpi(byType('cambio') + byType('consecutiva'), 'Para cambio', '', 'warn', byType('consecutiva') ? `${byType('consecutiva')} en controles seguidos` : '')}${kpi(byType('devolucion'), 'Devoluciones pendientes', '', 'bad')}${kpi(byType('pendiente'), 'Controles pendientes', '', 'pend')}</section>
  <div class="seg" role="tablist" data-css="margin-bottom:12px;max-width:420px"><button role="tab" aria-selected="${tab === 'open'}" class="${tab === 'open' ? 'on' : ''}" data-act="alertTab" data-v="open">Abiertas (${d.alertsOpen.length})</button><button role="tab" aria-selected="${tab === 'res'}" class="${tab === 'res' ? 'on' : ''}" data-act="alertTab" data-v="res">Resueltas (${res.length})</button></div>
  ${tab === 'open' ? alertList(d.alertsOpen, true) : res.length ? `<div class="list">${res.map((r) => `<div class="al"><span class="al-ic ok">${icon('ok', 16)}</span><div class="grow"><span class="t">${esc(r.title || 'Alerta')}</span><div class="s">${esc(r.text || '')}</div><div class="s" data-css="margin-top:4px">Resuelta por ${esc(who(r.by))} · ${fdt(r.at)}${r.note ? '. ' + esc(r.note) : ''}</div></div></div>`).join('')}</div>` : `<div class="list">${emptyBox('Todavía no se resolvieron alertas', '')}</div>`}`;
};

ACT.alertTab = (ds) => { UI.alertTab = ds.v; render(); };
ACT.resolveAlert = (ds) => {
  const a = derive().alertsOpen.find((x) => x.key === ds.k); if (!a || !gateUI('alerts_resolve')) return;
  openModal({ title: 'Resolver alerta', render: (st) => `<p data-css="margin-top:0"><b>${esc(a.title)}</b><br><span class="muted">${esc(a.text)}</span></p>${a.type === 'cambio' || a.type === 'consecutiva' || a.type === 'faltante' ? '<p class="hint">Si la herramienta se reemplazó, registrá la reposición: la alerta se cierra sola. Resolverla acá solo la marca como atendida.</p>' : ''}${field('Nota de resolución', `<input id="f-an" type="text" maxlength="2000" data-mi="note" value="${esc(st.note || '')}" placeholder="Qué se hizo">`, 'f-an')}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Marcar resuelta', kind: 'pri', run: async (st) => { await api.resolveAlert(a.key, (st.note || '').trim()); await refresh(); toast('Alerta resuelta'); } }] });
};
