// Hoja "Cambiar de plantilla" (desde la ficha del técnico) y "Mover seleccionados" (desde la
// vista de una plantilla), basadas en CambioTurno.dc.html: plantilla destino, fecha desde,
// motivo, cobertura temporal opcional con fecha hasta, "Se conserva todo" e historial.
// Un solo pedido por confirmación, con Idempotency-Key estable mientras no cambie el formulario.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { UI } from '../../ui/registry.js';
import { openModal, modalRerender, MOD } from '../../ui/modal.js';
import { toast, UErr } from '../../ui/feedback.js';
import { field, plIcon, turnoText } from '../../ui/components.js';
import { api, newIdempotencyKey } from '../../api/index.js';
import { S, derive, can, who, refresh, plantillaName } from '../../state/store.js';
import { fdate, fdt, todayISO } from '../../state/period.js';
import { validateMove, coverageOf, historyRows } from '../../state/plantillas.js';

const QUICK_REASONS = ['Rotación', 'Pedido del técnico', 'Cobertura', 'Reorganización'];
const plNames = () => Object.fromEntries(Object.values(derive().plantillaById).map((p) => [p.id, p.name]));

// Una línea del historial de plantillas de un técnico (ficha y hoja de cambio).
export function historyLine(h) {
  const title = h.temporary ? `Cobertura temporal en ${h.name}` : h.fromName ? `${h.fromName} → ${h.name}` : `En ${h.name}`;
  const span = h.from ? `desde el ${fdate(h.from)}${h.to ? ` hasta el ${fdate(h.to)}` : ''}` : h.to ? `hasta el ${fdate(h.to)}` : 'desde el alta';
  const back = h.temporary && h.returnTo ? `, vuelve a ${h.returnTo} el ${fdate(h.to)}` : '';
  const meta = [h.at ? fdt(h.at) : '', h.by ? who(h.by) : '', h.reason].filter(Boolean).join(' · ');
  return { title, sub: span + back, meta, temporary: h.temporary, current: !h.to };
}
export const techHistory = (techId) => historyRows((S.plantillaHistory || {})[techId] || [], plNames());

function destOpts(st, disabledId, counts) {
  const d = derive();
  return `<div class="opts" role="radiogroup" aria-label="Plantilla destino">${d.shifts.map((p) => {
    const cur = p.id === disabledId; const on = st.to === p.id;
    const sub = [turnoText(p.currentShiftLabel), `${counts[p.id] || 0} técnicos`].join(' · ');
    return `<button type="button" role="radio" aria-checked="${on}" class="opt plopt ${on ? 'on' : ''}" ${cur ? 'disabled aria-disabled="true"' : `data-act="mset" data-k="to" data-v="${esc(p.id)}"`}>${icon(plIcon(p), 16)}<span class="grow"><span class="t">${esc(p.name)}</span><span class="s">${esc(sub)}</span></span>${cur ? '<span class="chip">Actual</span>' : ''}</button>`;
  }).join('')}</div>`;
}

function formBody(st, { disabledId, counts, coverage, baseName }) {
  const covBox = `<label class="check"><input id="mv-cov" type="checkbox" data-mi="coverage" data-mr ${st.coverage ? 'checked' : ''}>Cobertura temporal: vuelve solo a su plantilla</label>`;
  const until = st.coverage ? field('Fecha hasta (vuelve ese día)', `<input id="mv-until" type="date" data-mi="until" value="${esc(st.until || '')}">`, 'mv-until') + (st.until ? `<p class="hint">${icon('info', 16)}<span>El ${esc(fdate(st.until))} vuelve solo a ${esc(baseName)}, sin hacer nada más.</span></p>` : '') : '';
  const covNote = coverage ? `<p class="hint warn">${icon('alert', 16)}<span>${coverage.started ? 'Está' : 'Va a estar'} en cobertura temporal en ${esc(plantillaName(coverage.plantillaId))} hasta el ${esc(fdate(coverage.until))} y después vuelve a ${esc(plantillaName(coverage.returnTo))}. Un cambio definitivo termina la cobertura y cancela esa vuelta; otra cobertura no se puede hasta que termine.</span></p>` : '';
  return `${covNote}${field('Plantilla destino', destOpts(st, disabledId, counts))}
  <div class="formgrid c2">${field('Desde', `<input id="mv-from" type="date" data-mi="from" value="${esc(st.from || '')}">`, 'mv-from')}${field('Motivo (obligatorio)', `<input id="mv-reason" type="text" maxlength="2000" data-mi="reason" value="${esc(st.reason || '')}" placeholder="Por qué cambia de plantilla">`, 'mv-reason')}</div>
  <div class="quick" data-css="margin:-6px 0 14px">${QUICK_REASONS.map((q) => `<button type="button" class="qchip" data-act="mset" data-k="reason" data-v="${esc(q)}">${esc(q)}</button>`).join('')}</div>
  ${covBox}${until}`;
}

const keptBox = (items) => `<section class="kept"><h3>Se conserva todo</h3>${items.map((k) => `<div class="kept-i"><span class="okd">${icon('ok', 14)}</span>${esc(k)}</div>`).join('')}</section>`;
const memberCounts = () => { const c = {}; for (const t of derive().activeTechs) c[t.shiftId] = (c[t.shiftId] || 0) + 1; return c; };

function idemFor(holder, body) {
  const sig = JSON.stringify(body);
  if (!holder.last || holder.last.sig !== sig) holder.last = { sig, key: newIdempotencyKey() };
  return holder.last.key;
}

// Cambiar de plantilla a un técnico (ficha).
export function openTechMove(techId) {
  const t = S.techs[techId]; if (!t) return;
  if (!can('shift_change')) { toast('Tu perfil no tiene permiso para esta acción.', 'err'); return; }
  const d = derive(); const today = todayISO();
  const ranges = (S.plantillaHistory || {})[techId] || [];
  const coverage = coverageOf(ranges, today);
  const nAsg = (d.asgByTech[techId] || []).length; const nCtl = d.ctls.filter((c) => c.techId === techId && c.status === 'finalizado').length;
  const idem = {};
  openModal({
    title: 'Cambiar de plantilla', rec: { get: () => S.techs[techId], version: t.version }, reload: (cur) => ({ ...MOD.st, cur: cur.shiftId }),
    render: (st) => {
      const curId = (S.techs[techId] || t).shiftId;
      const base = coverage ? plantillaName(coverage.returnTo) : plantillaName(curId);
      const hist = techHistory(techId).slice(0, 4).map(historyLine);
      return `<p class="muted" data-css="margin-top:0">${esc(t.name)} · Leg. ${esc(t.legajo)} · hoy en ${esc(plantillaName(curId))}</p>${formBody(st, { disabledId: coverage ? null : curId, counts: memberCounts(), coverage, baseName: base })}
      ${keptBox([`${nAsg} ${nAsg === 1 ? 'herramienta asignada' : 'herramientas asignadas'}`, `${nCtl} ${nCtl === 1 ? 'control anterior' : 'controles anteriores'}, cada uno con la plantilla de ese momento`, 'Entregas, reposiciones y novedades'])}
      ${hist.length ? `<div class="flabel" data-css="margin:14px 0 6px">Historial de plantillas</div><div class="list">${hist.map((h) => `<div class="row"><div class="grow"><div class="t">${esc(h.title)}</div><div class="s">${esc(h.sub)}</div>${h.meta ? `<div class="s">${esc(h.meta)}</div>` : ''}</div></div>`).join('')}</div>` : ''}`;
    },
    actions: [{ label: 'Cancelar', close: true }, { label: 'Confirmar cambio', kind: 'pri', run: async (st, m) => {
      const curId = (S.techs[techId] || t).shiftId;
      const v = validateMove({ plantillaId: st.to, from: st.from, reason: st.reason, coverage: !!st.coverage, until: st.until }, { currentId: curId, coverage });
      if (!v.ok) throw new UErr(v.error);
      const body = { plantillaId: st.to, ...v.body };
      await api.moveTech(techId, body, m.rec.version, { idempotencyKey: idemFor(idem, body) });
      await refresh();
      toast(body.until ? `${t.name} cubre en ${plantillaName(st.to)} hasta el ${fdate(body.until)}` : `${t.name} pasa a ${plantillaName(st.to)} desde el ${fdate(body.from)}`);
    } }],
  });
  MOD.st.from = today; modalRerender();
}

// Mover seleccionados: todos o ninguno, en un solo pedido.
export function openMoveSelected(sourceId, techIds) {
  if (!can('shift_change')) { toast('Tu perfil no tiene permiso para esta acción.', 'err'); return; }
  const ids = techIds.filter((id) => S.techs[id]);
  if (!ids.length) { toast('Elegí al menos un técnico.', 'err'); return; }
  const names = ids.map((id) => S.techs[id].name);
  const idem = {};
  const d = derive(); const nAsg = ids.reduce((a, id) => a + (d.asgByTech[id] || []).length, 0);
  openModal({
    title: 'Mover seleccionados',
    render: (st) => `<p class="muted" data-css="margin-top:0">${ids.length} ${ids.length === 1 ? 'técnico' : 'técnicos'} de ${esc(plantillaName(sourceId))}: ${esc(names.slice(0, 4).join(', '))}${names.length > 4 ? ` y ${names.length - 4} más` : ''}.</p>${formBody(st, { disabledId: sourceId, counts: memberCounts(), coverage: null, baseName: plantillaName(sourceId) })}
      ${keptBox([`${nAsg} herramientas asignadas siguen con cada técnico`, 'Los controles anteriores conservan la plantilla de ese momento', 'Se mueven todos o ninguno, en un solo paso'])}`,
    actions: [{ label: 'Cancelar', close: true }, { label: `Mover ${ids.length} ${ids.length === 1 ? 'técnico' : 'técnicos'}`, kind: 'pri', run: async (st) => {
      const v = validateMove({ plantillaId: st.to, from: st.from, reason: st.reason, coverage: !!st.coverage, until: st.until }, { currentId: sourceId });
      if (!v.ok) throw new UErr(v.error);
      const body = { techIds: ids, targetPlantillaId: st.to, ...v.body };
      const r = await api.moveSelected(sourceId, body, { idempotencyKey: idemFor(idem, body) });
      UI.plSel = [];
      await refresh();
      const n = (r && r.moved ? r.moved.length : ids.length);
      toast(`${n === 1 ? 'Se movió 1 técnico' : `Se movieron ${n} técnicos`} a ${plantillaName(st.to)}`);
    } }],
  });
  MOD.st.from = todayISO(); modalRerender();
}
