// Control semanal: selector de técnicos y checklist (igual que 2.1). El borrador se guarda
// primero en el equipo (IndexedDB) y después en el servidor; sin conexión queda local y se
// reenvía al volver, con la misma Idempotency-Key. Si otra persona cambió el control, se avisa.
// Etapa 2: una caja compartida se controla igual que un técnico (poseedor `caja:<id>`).
import { $, esc, setHTML, fromHTML } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN, CH } from '../../ui/actions.js';
import { openModal } from '../../ui/modal.js';
import { CONFLICT_HTML } from '../../ui/modal.js';
import { toast, errMsg } from '../../ui/feedback.js';
import { pageHead, emptyBox, avatar, demoChip, ctlBadge, periodStatus } from '../../ui/components.js';
import { hooks } from '../../ui/app.js';
import { gateUI } from '../tecnicos/view.js';
import { api, newIdempotencyKey } from '../../api/index.js';
import { net } from '../../api/net.js';
import { S, ME, derive, can, who, refresh, shiftName, catName } from '../../state/store.js';
import { holderBody, holderKey } from '../../state/plantillas.js';
import { ST, QUICK } from '../../state/constants.js';
import { pkeyOf, parsePkey, plabel, pshort, prevP, fdt, fhm, nowISO } from '../../state/period.js';
import { draftKey, nextDraft, requestFor, flushDrafts, idbStore, memoryStore } from '../../state/drafts.js';

let store = null;
const drafts = () => store || (store = typeof indexedDB !== 'undefined' ? idbStore() : memoryStore());

// Poseedor de un control: técnico o caja compartida, con lo que muestra el checklist.
export function holderOf(hk) {
  if (String(hk).startsWith('caja:')) {
    const id = hk.slice(5); const k = S.cajas[id]; if (!k) return null;
    const l = S.lineas[k.lineaId]; const ref = k.referenteTechId && S.techs[k.referenteTechId];
    return { kind: 'caja', hk, id, name: k.name, sub: [l ? l.name : '', ref ? 'Referente ' + ref.name : 'Sin referente'].filter(Boolean).join(' · '), back: '#caja-' + id, active: !k.archivedAt, demo: null, shiftId: null };
  }
  const t = S.techs[hk]; if (!t) return null;
  return { kind: 'tech', hk, id: hk, name: t.name, sub: `Leg. ${t.legajo} · ${shiftName(t.shiftId)}`, back: t.shiftId ? '#plantilla-' + t.shiftId : '#control', active: t.active !== false, demo: t, shiftId: t.shiftId };
}

VIEWS.control = () => {
  const d = derive(); const sh = UI.ctlShift;
  let ts = d.activeTechs.filter((t) => sh === 'all' || t.shiftId === sh);
  const ord = { pend: 0, draft: 1, done: 2 }; ts = ts.slice().sort((a, b) => ord[d.techInfo[a.id].curStatus] - ord[d.techInfo[b.id].curStatus] || a.name.localeCompare(b.name, 'es'));
  const done = ts.filter((t) => d.techInfo[t.id].curStatus === 'done').length;
  const cajas = d.activeCajas.filter((k) => d.cajaInfo[k.id].lines).slice().sort((a, b) => ord[d.cajaInfo[a.id].curStatus] - ord[d.cajaInfo[b.id].curStatus] || a.name.localeCompare(b.name, 'es'));
  return pageHead('Control de herramientas', `${plabel(d.cur)}. ${done} de ${ts.length} técnicos controlados.`) +
  `<div class="fchips" data-css="margin-bottom:12px"><button class="fchip ${sh === 'all' ? 'on' : ''}" data-act="ctlShift" data-v="all">Todas las plantillas</button>${d.shifts.map((s) => `<button class="fchip ${sh === s.id ? 'on' : ''}" data-act="ctlShift" data-v="${esc(s.id)}">${esc(s.name)}</button>`).join('')}</div>
  ${ts.length ? `<div class="list">${ts.map((t) => { const i = d.techInfo[t.id]; return `<a class="row" href="#control-${esc(t.id)}">${avatar(t.name, i.light)}<div class="grow"><div class="t ell">${esc(t.name)} ${demoChip(t)}</div><div class="s ell">${esc(shiftName(t.shiftId))} · ${i.lines} ${i.lines === 1 ? 'ítem' : 'ítems'} a controlar</div></div>${ctlBadge(i.curStatus)}${icon('right', 18)}</a>`; }).join('')}</div>` : `<div class="list">${emptyBox('No hay técnicos activos en esta plantilla', '')}</div>`}
  ${sh === 'all' && cajas.length ? `<h2 class="sec">Cajas compartidas</h2><div class="list">${cajas.map((k) => { const i = d.cajaInfo[k.id]; const h = holderOf('caja:' + k.id); return `<a class="row" href="#control-caja:${esc(k.id)}"><span class="tile sm">${icon('box', 18)}</span><div class="grow"><div class="t ell">${esc(k.name)}</div><div class="s ell">${esc(h.sub)} · ${i.lines} ${i.lines === 1 ? 'ítem' : 'ítems'} a controlar</div></div>${ctlBadge(i.curStatus)}${icon('right', 18)}</a>`; }).join('')}</div>` : ''}`;
};

// ------------------------------------------------------------------ estado del checklist
const serverDraftOf = (techId, pk, correctionOf) => derive().ctls.find((c) => c.status === 'borrador' && (correctionOf ? c.correction && c.supersedes === correctionOf : c.hk === techId && c.pkey === pk && !c.correction));
const itemsOf = (src) => { const o = {}; for (const [k, v] of Object.entries(src || {})) if (v && v.state) o[k] = { state: v.state, note: v.note || '' }; return o; };

function initCheck(techId, period, opts = {}) {
  const d = derive(); const pk = pkeyOf(period); const correctionOf = opts.correctionOf || null;
  const ex = serverDraftOf(techId, pk, correctionOf);
  const items = itemsOf(ex ? ex.items : correctionOf ? (S.controls[correctionOf] || {}).items : null);
  const effC = d.eff[techId + '|' + pk];
  UI.ck = { techId, period, pk, key: draftKey(techId, period, correctionOf), controlId: ex ? ex.id : null, version: ex ? ex.version : null, items, correctionOf, locked: !correctionOf && !!effC, effId: effC ? effC.id : null, dirty: false, local: false, conflict: null, startedAt: (ex && ex.startedAt) || null, savedAt: ex ? ex.updatedAt : null };
  restoreLocal(UI.ck);
}
// Un borrador guardado en este equipo (p. ej. sin conexión) se recupera al abrir el control.
async function restoreLocal(ck) {
  let rec = null; try { rec = await drafts().get(ck.key); } catch (e) { console.warn(e); }
  if (!rec || UI.ck !== ck || ck.locked) return;
  ck.items = { ...ck.items, ...rec.items }; ck.local = true; ck.savedAt = rec.savedAt;
  if (rec.controlId && !ck.controlId) { ck.controlId = rec.controlId; ck.version = rec.version; }
  if (rec.conflict) ck.conflict = { current: S.controls[ck.controlId] || null };
  UI.forceCk = true; render();
  if (!net.offline && !rec.conflict) sendLocal();
}

VIEWS.ck = (techId) => {
  const d = derive(); const t = holderOf(techId); if (!t) return pageHead(String(techId).startsWith('caja:') ? 'Caja no encontrada' : 'Técnico no encontrado', '', { back: '#control' });
  if (UI.pendingCk && UI.pendingCk.techId === techId) { const p = UI.pendingCk; UI.pendingCk = null; initCheck(techId, p.period, { correctionOf: p.correctionOf }); } else if (!UI.ck || UI.ck.techId !== techId) initCheck(techId, d.cur);
  const ck = UI.ck; const list = d.asgByTech[techId] || [];
  const periods = []; let p = d.cur; for (let i = 0; i < 8; i++) { periods.push(p); p = prevP(p); }
  if (!periods.some((x) => pkeyOf(x) === ck.pk)) periods.push(ck.period);
  const per = ck.correctionOf ? `<span class="pchip">${icon('cal', 14)}${pshort(ck.period)}</span>` : `<label class="pchip">${icon('cal', 14)}<span id="ckpl">${pshort(ck.period)}</span>${icon('down', 14)}<select id="ckper" data-ch="ckPeriod" aria-label="Período del control">${periods.map((x) => `<option value="${esc(pkeyOf(x))}" ${pkeyOf(x) === ck.pk ? 'selected' : ''}>${plabel(x)}${pkeyOf(x) === d.curKey ? ' (actual)' : ''}</option>`).join('')}</select></label>`;
  const editing = can('controls_do') && !ck.locked && list.length;
  const prog = editing ? `<div class="ck-prog"><div class="rowb"><span class="pt" id="ckcount"></span><span class="s" id="cksaved"></span></div><div class="segs" id="cksegs" role="progressbar" aria-label="Progreso del control" aria-valuemin="0" aria-valuemax="${list.length}" aria-valuenow="0">${list.map((a) => `<span id="sg-${esc(a.id)}"></span>`).join('')}</div><div class="legend-dots" id="cklegend"></div></div>` : '';
  const head = `<div class="ckhead"><div class="ck-top"><a class="icon-btn" href="${esc(t.back)}" aria-label="Volver">${icon('back', 22)}</a><div class="grow"><h1 class="ell">${esc(t.name)}</h1><div class="s">${esc(t.sub)} ${demoChip(t.demo)}</div></div>${per}</div>${prog}</div>`;
  const corr = ck.correctionOf ? `<div class="banner warn"><div><b>Corrección del control de ${plabel(ck.period).toLowerCase()}</b><div class="sm">Se guarda como un registro nuevo de auditoría. El control original no se borra.</div></div><div class="acts"><button class="btn sm" data-act="ckCancelCorr">Cancelar corrección</button></div></div>` : '';
  if (!can('controls_do')) return head + `<div class="hint">${icon('info', 16)}Tu perfil es de consulta: podés ver los controles pero no registrarlos.</div>` + (ck.effId ? `<a class="btn pri" href="#controlver-${esc(ck.effId)}">Ver control de esta semana</a>` : '');
  if (ck.locked) {
    const c = S.controls[ck.effId] || {};
    return head + `<div class="banner"><div><b>Ya hay un control finalizado para ${plabel(ck.period).toLowerCase()}.</b><div class="sm">Finalizado ${fdt(c.finishedAt)} por ${esc(who(c.by))}. Para cambiarlo, registrá una corrección: el original queda guardado.</div></div><div class="acts"><a class="btn sm" href="#controlver-${esc(ck.effId)}">Ver control</a><button class="btn sm pri" data-act="correct" data-c="${esc(ck.effId)}">Registrar corrección</button></div></div>`;
  }
  if (!list.length) return head + corr + `<div class="list">${emptyBox(t.kind === 'caja' ? 'Esta caja no tiene herramientas asignadas' : 'Este técnico no tiene herramientas asignadas', 'Asigná herramientas para poder controlarlo.', can('movements_do') ? `<button class="btn pri" data-act="asgNew" data-h="${esc(techId)}">Asignar herramienta</button>` : '')}</div>`;
  return head + corr + `<div id="ckconf"></div><button class="allok" id="ckallok" data-act="ckAllOk">${icon('ok', 18)}<span id="ckallokt">Marcar pendientes como Buen estado</span></button>
  <div class="items" id="ckitems">${list.map(ckItemHTML).join('')}</div><div class="ckpad"></div>
  <div class="ckfoot"><span class="why" id="ckwhy" aria-live="polite"></span><div class="bt"><button class="btn" data-act="ckSave">Guardar borrador</button><button class="btn pri" id="ckfin" data-act="ckFinish">FINALIZAR CONTROL</button></div></div>`;
};

function ckItemHTML(a) {
  const d = derive(); const it = UI.ck.items[a.id] || {}; const tool = S.tools[a.toolId] || {}; const u = a.unitId && S.units[a.unitId]; const prev = d.stateOf[a.id];
  const meta = [u ? u.code : '', catName(tool.categoryId), a.qty > 1 ? a.qty + ' unidades' : ''].filter(Boolean).map(esc).join(' · ');
  const st = it.state; const cls = st ? ST[st].cls : ''; const noteEmpty = st === 'faltante' && !(it.note || '').trim();
  const opts = [['bueno', 'Bueno', 'ok'], ['cambio', 'Cambio', 'wrench'], ['faltante', 'Faltante', 'x']];
  return `<article class="item ${cls}" id="it-${esc(a.id)}"><div class="item-h"><div data-css="min-width:0"><h2 class="item-name">${esc(tool.name || 'Herramienta')}</h2><div class="s">${meta}</div></div><span class="prev">Anterior<b data-css="color:${prev ? `var(--${ST[prev.state].cls}-ink)` : 'var(--ink2)'}">${prev ? ST[prev.state].label : 'Sin control'}</b></span></div>
  <div class="pick" role="radiogroup" aria-label="Estado de ${esc(tool.name || 'herramienta')}">${opts.map(([s, l, ic]) => `<button type="button" role="radio" class="${ST[s].cls}" aria-checked="${st === s}" data-act="ckSet" data-aid="${esc(a.id)}" data-s="${esc(s)}">${icon(ic, 16)}${l}</button>`).join('')}</div>
  ${st === 'cambio' || st === 'faltante' ? `<div class="note ${cls}"><label for="nt-${esc(a.id)}">${st === 'faltante' ? 'Motivo del faltante (obligatorio)' : 'Observación (opcional)'}</label><div class="quick" data-css="margin:0">${QUICK[st].map((q) => `<button type="button" class="qchip" data-act="ckQuick" data-aid="${esc(a.id)}" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div><textarea id="nt-${esc(a.id)}" class="${noteEmpty ? 'empty' : ''}" data-in="ckNote" data-aid="${esc(a.id)}" rows="2" maxlength="2000" placeholder="${st === 'faltante' ? 'Contá qué pasó con la herramienta' : 'Describí el problema'}">${esc(it.note || '')}</textarea>${st === 'faltante' ? `<span class="nerr" role="alert" id="ne-${esc(a.id)}" ${noteEmpty ? '' : 'hidden'}>La nota es obligatoria para registrar un faltante.</span>` : ''}</div>` : ''}</article>`;
}
function ckStats() { const list = derive().asgByTech[UI.ck.techId] || []; const c = { bueno: 0, cambio: 0, faltante: 0, pendiente: 0, noNote: 0, n: list.length, list }; for (const a of list) { const it = UI.ck.items[a.id]; const s = it && it.state; if (!s) c.pendiente++; else { c[s]++; if (s === 'faltante' && !(it.note || '').trim()) c.noNote++; } } return c; }
function savedText(ck) {
  if (ck.dirty) return 'Cambios sin guardar';
  if (ck.local) return 'Borrador guardado en este equipo' + (net.offline ? ' (sin conexión)' : '');
  return ck.savedAt ? 'Borrador guardado ' + fhm(ck.savedAt) : '';
}
function ckUpdateProgress() {
  if (!UI.ck || !$('#ckcount')) return; const c = ckStats(); const done = c.n - c.pendiente;
  $('#ckcount').textContent = `${done} de ${c.n} controladas`;
  const sv = $('#cksaved'); if (sv) sv.textContent = savedText(UI.ck);
  for (const a of c.list) { const el = document.getElementById('sg-' + a.id); if (el) { const it = UI.ck.items[a.id]; el.className = it && it.state ? ST[it.state].cls : ''; } }
  const sg = $('#cksegs'); if (sg) sg.setAttribute('aria-valuenow', done);
  const lg = $('#cklegend'); if (lg) setHTML(lg, `<span class="ld"><i data-css="background:var(--ok)"></i>${c.bueno} bueno</span><span class="ld"><i data-css="background:var(--warn)"></i>${c.cambio} cambio</span><span class="ld"><i data-css="background:var(--bad)"></i>${c.faltante} faltante</span><span class="ld"><i data-css="background:var(--pend)"></i>${c.pendiente} pendiente</span>`);
  const ao = $('#ckallok'); if (ao) { ao.hidden = !c.pendiente; $('#ckallokt').textContent = `Marcar ${c.pendiente} ${c.pendiente === 1 ? 'pendiente' : 'pendientes'} como Buen estado`; }
  const why = c.pendiente ? `Falta${c.pendiente === 1 ? '' : 'n'} ${c.pendiente} ${c.pendiente === 1 ? 'herramienta' : 'herramientas'} por controlar` : c.noNote ? `Completá el motivo de ${c.noNote === 1 ? '1 faltante' : c.noNote + ' faltantes'}` : net.offline ? 'Sin conexión: el control se finaliza cuando vuelva la conexión' : '';
  const w = $('#ckwhy'); if (w) w.textContent = why; const fb = $('#ckfin'); if (fb) fb.disabled = !!why;
  const cf = $('#ckconf'); if (cf) setHTML(cf, UI.ck.conflict ? CONFLICT_HTML('ckConflictReload', 'ckConflictKeep') : '');
}
VIEWS.ckRefresh = ckUpdateProgress;

// ------------------------------------------------------------------ guardado del borrador
let draftTimer = null;
function ckTouch() { UI.ck.dirty = true; ckUpdateProgress(); clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraft(true), 2500); }

async function sendRequest(req) {
  const o = { idempotencyKey: req.idempotencyKey, allowOffline: true };
  const r = req.kind === 'create' ? await api.createControl(req.body, o) : await api.saveControl(req.id, req.items, req.version, o);
  return r.control;
}
function adopt(ck, control) { ck.controlId = control.id; ck.version = control.version; ck.startedAt = control.startedAt; ck.savedAt = control.updatedAt; }

// Guarda en el equipo y, si hay conexión, en el servidor.
async function saveDraft(silent) {
  const ck = UI.ck; if (!ck || ck.locked || !can('controls_do')) return; clearTimeout(draftTimer);
  if (!ck.dirty && silent) return;
  ck.dirty = false;
  let prev = null; try { prev = await drafts().get(ck.key); } catch { prev = null; }
  const rec = nextDraft(prev, { techId: ck.techId, period: ck.period, correctionOf: ck.correctionOf, controlId: ck.controlId, version: ck.version, items: { ...ck.items } }, newIdempotencyKey());
  try { await drafts().put(rec); ck.local = true; } catch (e) { console.warn(e); }
  if (ck.conflict) { if (!silent) toast('Resolvé el aviso de cambios antes de guardar.', 'err'); if (UI.ck === ck) ckUpdateProgress(); return; }
  if (net.offline) { if (!silent) toast('Sin conexión: el borrador quedó guardado en este equipo y se envía al volver la conexión.'); if (UI.ck === ck) ckUpdateProgress(); return; }
  await sendLocal(silent, ck);
}
// Recibe el control a enviar: al salir del checklist UI.ck ya se limpió y el borrador igual se envía.
async function sendLocal(silent = true, ck = UI.ck) {
  if (!ck) return;
  let rec = null; try { rec = await drafts().get(ck.key); } catch { rec = null; }
  if (!rec || rec.conflict) return;
  ck.saving = true;
  try {
    const control = await sendRequest(requestFor(rec));
    adopt(ck, control); ck.local = false;
    try { const cur = await drafts().get(ck.key); if (cur && cur.idemKey === rec.idemKey) await drafts().del(ck.key); else if (cur) { await drafts().put({ ...cur, controlId: control.id, version: control.version }); ck.local = true; } } catch (e) { console.warn(e); }
    if (!silent) toast('Borrador guardado');
    refresh().catch(() => {});
  } catch (e) {
    if (e.kind === 'network' || e.kind === 'offline') { if (!silent) toast('Sin conexión: el borrador quedó guardado en este equipo y se envía al volver la conexión.'); }
    else if (e.kind === 'conflict') { ck.conflict = { current: e.current }; await drafts().put({ ...rec, conflict: true }).catch(() => {}); }
    else { ck.dirty = true; toast(errMsg(e), 'err'); }
  } finally { ck.saving = false; }
  if (UI.ck === ck) ckUpdateProgress();
}

// Al volver la conexión: se envían todos los borradores guardados en el equipo.
hooks.online.push(async () => {
  const out = await flushDrafts(drafts(), sendRequest);
  for (const { rec, control } of out.sent) if (UI.ck && UI.ck.key === rec.key) { adopt(UI.ck, control); UI.ck.local = false; }
  for (const rec of out.conflicts) if (UI.ck && UI.ck.key === rec.key && !UI.ck.conflict) UI.ck.conflict = { current: S.controls[rec.controlId] || null };
  if (out.sent.length) { toast(out.sent.length === 1 ? 'Se envió el borrador guardado sin conexión.' : `Se enviaron ${out.sent.length} borradores guardados sin conexión.`); refresh().catch(() => {}); }
  for (const f of out.failed) toast(errMsg(f.error), 'err');
  if (UI.ck) ckUpdateProgress();
});

// Después de cada recarga: si el control que se está editando cambió en el servidor, aviso.
hooks.afterState.push(() => {
  const ck = UI.ck; if (!ck || ck.locked || ck.conflict || ck.saving) return;
  const cur = ck.controlId ? S.controls[ck.controlId] : serverDraftOf(ck.techId, ck.pk, ck.correctionOf);
  if (!cur) return;
  const touched = ck.dirty || ck.local || Object.keys(ck.items).length;
  if (ck.controlId ? cur.version !== ck.version : touched) { ck.conflict = { current: cur }; ckUpdateProgress(); }
});
hooks.beforeRoute.push((r) => { if (UI.ck && UI.ck.dirty && !UI.ck.locked) saveDraft(true); if (r.name !== 'ck') UI.ck = null; });

ACT.ckConflictReload = async () => {
  const ck = UI.ck; if (!ck) return;
  try { await drafts().del(ck.key); } catch (e) { console.warn(e); }
  const { techId, period, correctionOf } = ck; UI.ck = null; initCheck(techId, period, { correctionOf }); UI.forceCk = true; render();
};
ACT.ckConflictKeep = async () => {
  const ck = UI.ck; if (!ck || !ck.conflict) return;
  const cur = ck.conflict.current || (ck.controlId ? S.controls[ck.controlId] : serverDraftOf(ck.techId, ck.pk, ck.correctionOf));
  if (cur && cur.status === 'finalizado') { toast('Ese control ya fue finalizado por otra persona. Registrá una corrección.', 'err'); return ACT.ckConflictReload(); }
  if (cur) { ck.controlId = cur.id; ck.version = cur.version; }
  ck.conflict = null; ck.dirty = true;
  try { const rec = await drafts().get(ck.key); if (rec) await drafts().put({ ...rec, conflict: false }); } catch (e) { console.warn(e); }
  await saveDraft(false);
};

// ------------------------------------------------------------------ acciones del checklist
function ckReplaceItem(aid) { const a = S.assignments[aid]; const el = document.getElementById('it-' + aid); if (el && a) el.replaceWith(fromHTML(ckItemHTML({ id: aid, ...a }))); }
ACT.ckSet = (ds) => {
  const ck = UI.ck; if (!ck) return; const cur = ck.items[ds.aid] || {};
  ck.items[ds.aid] = { state: ds.s, note: cur.note || '' }; ckReplaceItem(ds.aid);
  if (ds.s === 'faltante' && !(cur.note || '').trim()) { const ta = document.getElementById('nt-' + ds.aid); if (ta && matchMedia('(min-width:1024px)').matches) ta.focus(); }
  const it = document.getElementById('it-' + ds.aid); const b = it && it.querySelector(`[data-s="${CSS.escape(ds.s)}"]`); if (b) b.focus({ preventScroll: true });
  ckTouch();
};
function ckNoteState(aid) { const it = UI.ck && UI.ck.items[aid]; const ta = document.getElementById('nt-' + aid); const er = document.getElementById('ne-' + aid); const empty = it && it.state === 'faltante' && !(it.note || '').trim(); if (ta) ta.classList.toggle('empty', !!empty); if (er) er.hidden = !empty; }
ACT.ckQuick = (ds) => { const it = UI.ck && UI.ck.items[ds.aid]; if (!it) return; it.note = ds.q; const ta = document.getElementById('nt-' + ds.aid); if (ta) ta.value = ds.q; ckNoteState(ds.aid); ckTouch(); };
IN.ckNote = (v, el) => { const it = UI.ck && UI.ck.items[el.dataset.aid]; if (!it) return; it.note = v; ckNoteState(el.dataset.aid); ckTouch(); };
ACT.ckAllOk = () => { const ck = UI.ck; if (!ck) return; let n = 0; for (const a of (derive().asgByTech[ck.techId] || [])) { if (!ck.items[a.id] || !ck.items[a.id].state) { ck.items[a.id] = { state: 'bueno', note: '' }; n++; ckReplaceItem(a.id); } } if (n) { ckTouch(); toast(`${n} marcadas en buen estado`); } else toast('No quedan herramientas pendientes'); };
ACT.ckSave = () => { if (UI.ck) { UI.ck.dirty = true; saveDraft(false); } };
CH.ckPeriod = (v) => { if (UI.ck && UI.ck.dirty) saveDraft(true); initCheck(UI.ck.techId, parsePkey(v)); UI.forceCk = true; render(); };
ACT.ckCancelCorr = () => { const ck = UI.ck; if (!ck) return; const p = ck.period, t = ck.techId; UI.ck = null; initCheck(t, p); UI.forceCk = true; render(); };
ACT.correct = (ds) => { const c = S.controls[ds.c]; if (!c || !gateUI('controls_do')) return; const hk = holderKey(c); UI.ck = null; UI.pendingCk = { techId: hk, period: c.period, correctionOf: ds.c }; if (location.hash === '#control-' + hk) { UI.forceCk = true; render(); } else location.hash = '#control-' + hk; };
ACT.resumeCorr = (ds) => { if (ds.c) { const c = Object.values(S.controls).find((x) => x.supersedes === ds.c && x.status === 'borrador'); if (c) { UI.ck = null; UI.pendingCk = { techId: holderKey(c), period: c.period, correctionOf: ds.c }; } } };
ACT.ctlShift = (ds) => { UI.ctlShift = ds.v; if (location.hash === '#control') render(); };
ACT.openPeriod = (ds) => {
  const p = parsePkey(ds.p); const st = periodStatus(ds.t, p); const d = derive();
  if (st === 'fut') { toast('Esa semana todavía no empezó'); return; }
  if (st === 'done') { location.hash = '#controlver-' + d.eff[ds.t + '|' + ds.p].id; return; }
  if (!can('controls_do')) { toast('Control pendiente. Tu perfil no puede registrarlo.'); return; }
  UI.ck = null; UI.pendingCk = { techId: ds.t, period: p }; if (location.hash === '#control-' + ds.t) { UI.forceCk = true; render(); } else location.hash = '#control-' + ds.t;
};

ACT.ckFinish = async () => {
  const ck = UI.ck; if (!ck || !gateUI('controls_do')) return; const d = derive();
  const c = ckStats();
  if (c.pendiente || c.noNote) { ckUpdateProgress(); const first = c.list.find((a) => { const it = ck.items[a.id]; return !it || !it.state || (it.state === 'faltante' && !(it.note || '').trim()); }); if (first) document.getElementById('it-' + first.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (net.offline) { toast('Sin conexión: el control se finaliza cuando vuelva la conexión. El borrador queda guardado en este equipo.', 'err'); saveDraft(true); return; }
  if (ck.conflict) { toast('Resolvé el aviso de cambios antes de finalizar.', 'err'); return; }
  const t = holderOf(ck.techId);
  if (!ck.correctionOf && d.eff[ck.techId + '|' + ck.pk]) { toast('Ya existe un control finalizado para ese período. Registrá una corrección.', 'err'); UI.ck = null; UI.forceCk = true; render(); return; }
  const counts = { bueno: 0, cambio: 0, faltante: 0 }; for (const a of c.list) counts[ck.items[a.id].state] += a.qty || 1;
  const nAl = c.list.filter((a) => ck.items[a.id].state !== 'bueno').length;
  openModal({ title: '¿Finalizar el control?', render: () => `<p class="muted" data-css="margin:0 0 14px">${esc(t.name)} · ${plabel(ck.period)}${ck.correctionOf ? ' (corrección)' : ''}. El registro no podrá editarse; las correcciones se hacen con un nuevo registro de auditoría.</p><div class="tiles3"><div class="tile3 ok"><b>${counts.bueno}</b><span>Buen estado</span></div><div class="tile3 warn"><b>${counts.cambio}</b><span>Para cambio</span></div><div class="tile3 bad"><b>${counts.faltante}</b><span>Faltante</span></div></div><dl class="meta"><dt>Responsable</dt><dd>${esc(who(ME.id))}</dd><dt>Fecha y hora</dt><dd>${fdt(nowISO())}</dd><dt>Alertas</dt><dd>${nAl ? `Se generarán ${nAl} ${nAl === 1 ? 'alerta automática' : 'alertas automáticas'}` : 'No se generan alertas'}</dd></dl>`,
    actions: [{ label: 'Revisar', close: true }, { label: 'Confirmar y guardar', kind: 'pri', run: async () => {
      clearTimeout(draftTimer); ck.saving = true;
      try {
      // Primero queda guardado el borrador con todos los ítems; después se finaliza.
      const items = { ...ck.items };
      const saved = ck.controlId ? await api.saveControl(ck.controlId, items, ck.version) : await api.createControl(ck.correctionOf ? { correctionOf: ck.correctionOf, items } : { ...holderBody(ck.techId), period: ck.period, items });
      adopt(ck, saved.control);
      const fin = (await api.finalizeControl(ck.controlId, ck.version)).control;
      try { await drafts().del(ck.key); } catch (e) { console.warn(e); }
      UI.ck = null; if (t.shiftId) UI.ctlShift = t.shiftId;
      await refresh();
      const dd = derive();
      const next = t.kind === 'caja' ? (dd.activeCajas.filter((k) => 'caja:' + k.id !== t.hk && dd.cajaInfo[k.id].lines && dd.cajaInfo[k.id].curStatus !== 'done').map((k) => ({ id: 'caja:' + k.id, name: k.name }))[0] || null) : dd.activeTechs.find((x) => x.id !== t.id && x.shiftId === t.shiftId && dd.techInfo[x.id].lines && dd.techInfo[x.id].curStatus !== 'done');
      const ficha = t.kind === 'caja' ? `#caja-${t.id}` : `#tecnico-${t.id}`;
      openModal({ noHead: true, onClose: () => { location.hash = '#control'; }, render: () => `<div class="success"><span class="okc">${icon('ok', 32)}</span><div><h2>Control guardado</h2><div class="s">${plabel(fin.period)} · ${fdt(fin.finishedAt)} · ${esc(who(ME.id))}</div></div>${next ? `<a class="btn pri lg block" href="#control-${esc(next.id)}">Siguiente: ${esc(next.name)}${icon('right', 18)}</a>` : `<a class="btn pri lg block" href="#control">Volver a la lista${icon('right', 18)}</a>`}<a class="lnk" href="${esc(ficha)}" data-css="min-height:44px;display:flex;align-items:center">Ver ficha de ${esc(t.name)}</a></div>` });
      return false;
      } finally { ck.saving = false; }
    } }] });
};
