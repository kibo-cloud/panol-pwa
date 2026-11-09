// Control semanal: selector de técnicos y checklist (igual que 2.1). El borrador se guarda
// primero en el equipo (IndexedDB) y después en el servidor; sin conexión queda local y se
// reenvía al volver, con la misma Idempotency-Key. Si otra persona cambió el control, se avisa.
// Etapa 2: una caja compartida se controla igual que un técnico (poseedor `caja:<id>`).
// Etapa 4: conteo por cantidad (con 1 unidad, los tres botones; con más, cuántas están en buen
// estado y cuántas requieren recambio, y las que faltan piden motivo), línea opcional en
// faltantes y recambios, y la limpieza de herramientas y caja (obligatoria para finalizar).
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
import { CLEAN, CLEAN_QUICK, itemQty, itemState, ckSummary, ckWhy, checklistItem, apiItem, apiItems, cleaningRequiredFor } from '../../state/conteo.js';
import { pkeyOf, parsePkey, plabel, pshort, prevP, fdt, fhm, nowISO } from '../../state/period.js';
import { draftKey, nextDraft, requestFor, flushDrafts, needsReview, reviewOf, idbStore, memoryStore } from '../../state/drafts.js';

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
const qtyOfAsg = (aid) => ((S.assignments[aid] || {}).qty || 1);
// Ítems guardados -> ítems del checklist (con cantidades si la asignación tiene más de 1).
const itemsOf = (src) => { const o = {}; for (const [k, v] of Object.entries(src || {})) { const it = checklistItem(v, qtyOfAsg(k)); if (it) o[k] = it; } return o; };
const cleaningOf = (c) => ({ status: (c && c.cleaning && c.cleaning.status) || null, note: (c && c.cleaning && c.cleaning.note) || '' });
const ckList = (ck) => derive().asgByTech[ck.techId] || [];

function initCheck(techId, period, opts = {}) {
  const d = derive(); const pk = pkeyOf(period); const correctionOf = opts.correctionOf || null;
  const ex = serverDraftOf(techId, pk, correctionOf);
  const src = ex || (correctionOf ? S.controls[correctionOf] : null);
  const items = itemsOf(src ? src.items : null);
  const effC = d.eff[techId + '|' + pk];
  // Limpieza: obligatoria salvo en la corrección de un control sin dato (puede seguir sin dato).
  const cleaningRequired = cleaningRequiredFor(correctionOf ? S.controls[correctionOf] : null);
  UI.ck = { techId, period, pk, key: draftKey(techId, period, correctionOf), controlId: ex ? ex.id : null, version: ex ? ex.version : null, items, cleaning: cleaningOf(src), cleaningRequired, correctionOf, locked: !correctionOf && !!effC, effId: effC ? effC.id : null, dirty: false, local: false, conflict: null, review: null, startedAt: (ex && ex.startedAt) || null, savedAt: ex ? ex.updatedAt : null };
  restoreLocal(UI.ck);
}
// Un borrador guardado en este equipo (p. ej. sin conexión) se recupera al abrir el control.
async function restoreLocal(ck) {
  let rec = null; try { rec = await drafts().get(ck.key); } catch (e) { console.warn(e); }
  if (!rec || UI.ck !== ck || ck.locked) return;
  ck.items = { ...ck.items, ...rec.items }; ck.local = true; ck.savedAt = rec.savedAt;
  if (rec.cleaning !== undefined) ck.cleaning = cleaningOf({ cleaning: rec.cleaning });
  if (rec.controlId && !ck.controlId) { ck.controlId = rec.controlId; ck.version = rec.version; }
  if (rec.conflict) ck.conflict = { current: S.controls[ck.controlId] || null };
  if (rec.review) ck.review = rec.review;
  UI.forceCk = true; render();
  if (!net.offline && !rec.conflict && !rec.review) sendLocal();
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
  return head + corr + `<div id="ckconf"></div><div id="ckreview"></div><button class="allok" id="ckallok" data-act="ckAllOk">${icon('ok', 18)}<span id="ckallokt">Marcar pendientes como Buen estado</span></button>
  <div class="items" id="ckitems">${list.map(ckItemHTML).join('')}</div>${ckCleanHTML()}<div class="ckpad"></div>
  <div class="ckfoot"><span class="why" id="ckwhy" aria-live="polite"></span><div class="bt"><button class="btn" data-act="ckSave">Guardar borrador</button><button class="btn pri" id="ckfin" data-act="ckFinish">FINALIZAR CONTROL</button></div></div>`;
};

// Selector de línea o sector (opcional) en ítems con faltantes o recambios: las líneas activas
// y, si el ítem ya tenía una que se archivó, esa también.
function lineaSelect(a, it) {
  const d = derive(); const opts = d.lineas.filter((l) => !l.archivedAt || l.id === it.lineaId);
  if (!opts.length) return '';
  const id = 'ln-' + a.id;
  return `<div class="field ckline"><label for="${esc(id)}">Línea o sector donde se trabajaba (opcional)</label><select id="${esc(id)}" data-ch="ckLinea" data-aid="${esc(a.id)}"><option value="">Sin indicar</option>${opts.map((l) => `<option value="${esc(l.id)}" ${l.id === it.lineaId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`;
}

// Bloque de nota: motivo obligatorio si falta alguna unidad; observación opcional si solo hay recambios.
function noteHTML(a, it, q) {
  const kind = q.missing > 0 ? 'faltante' : 'cambio'; const cls = ST[kind].cls; const noteEmpty = kind === 'faltante' && !(it.note || '').trim();
  return `<div class="note ${cls}"><label for="nt-${esc(a.id)}">${kind === 'faltante' ? 'Motivo del faltante (obligatorio)' : 'Observación (opcional)'}</label><div class="quick" data-css="margin:0">${QUICK[kind].map((x) => `<button type="button" class="qchip" data-act="ckQuick" data-aid="${esc(a.id)}" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div><textarea id="nt-${esc(a.id)}" class="${noteEmpty ? 'empty' : ''}" data-in="ckNote" data-aid="${esc(a.id)}" rows="2" maxlength="2000" placeholder="${kind === 'faltante' ? 'Contá qué pasó con la herramienta' : 'Describí el problema'}">${esc(it.note || '')}</textarea>${kind === 'faltante' ? `<span class="nerr" role="alert" id="ne-${esc(a.id)}" ${noteEmpty ? '' : 'hidden'}>La nota es obligatoria para registrar un faltante.</span>` : ''}${lineaSelect(a, it)}</div>`;
}

// Con más de 1 unidad: cuántas en buen estado y cuántas requieren recambio (las que faltan son el resto).
function qtyHTML(a, name, q, exp) {
  const row = (k, label, v, max) => { const lid = `ql-${k}-${a.id}`; return `<div class="qrow"><span class="ql" id="${esc(lid)}">${label}</span><div class="stepper"><button type="button" data-act="ckStep" data-aid="${esc(a.id)}" data-k="${k}" data-d="-1" aria-label="Restar una: ${esc(label.toLowerCase())}" ${!q || !v ? 'disabled' : ''}>${icon('minus', 18)}</button><input type="number" inputmode="numeric" min="0" max="${max}" id="q${k}-${esc(a.id)}" data-ch="ckQty" data-aid="${esc(a.id)}" data-k="${k}" value="${q ? v : ''}" placeholder="—" aria-labelledby="${esc(lid)}"><button type="button" data-act="ckStep" data-aid="${esc(a.id)}" data-k="${k}" data-d="1" aria-label="Sumar una: ${esc(label.toLowerCase())}" ${q && q.good + q.change >= exp ? 'disabled' : ''}>${icon('plus', 18)}</button></div></div>`; };
  const miss = !q ? `${exp} unidades sin contar` : q.missing ? `Faltan ${q.missing}` : 'Están todas';
  return `<div class="qty" role="group" aria-label="Conteo de ${esc(name)}: ${exp} unidades">${row('good', 'En buen estado', q ? q.good : 0, exp - (q ? q.change : 0))}${row('change', 'Requieren recambio', q ? q.change : 0, exp - (q ? q.good : 0))}<div class="qfoot"><span class="qmiss ${!q ? '' : q.missing ? 'bad' : 'ok'}" id="qm-${esc(a.id)}">${icon(!q ? 'clock' : q.missing ? 'x' : 'ok', 16)}${miss}</span>${!q || q.good !== exp ? `<button type="button" class="qchip" data-act="ckAllGood" data-aid="${esc(a.id)}">Todas en buen estado</button>` : ''}</div></div>`;
}

function ckItemHTML(a) {
  const d = derive(); const exp = a.qty || 1; const it = UI.ck.items[a.id] || {}; const tool = S.tools[a.toolId] || {}; const u = a.unitId && S.units[a.unitId]; const prev = d.stateOf[a.id];
  const meta = [u ? u.code : '', catName(tool.categoryId), exp > 1 ? exp + ' unidades' : ''].filter(Boolean).map(esc).join(' · ');
  const q = itemQty(UI.ck.items[a.id], exp); const st = q ? itemState(q) : null; const cls = st ? ST[st].cls : '';
  const opts = [['bueno', 'Bueno', 'ok'], ['cambio', 'Cambio', 'wrench'], ['faltante', 'Faltante', 'x']];
  const name = tool.name || 'herramienta';
  const pick = exp > 1 ? qtyHTML(a, name, q, exp) : `<div class="pick" role="radiogroup" aria-label="Estado de ${esc(name)}">${opts.map(([s, l, ic]) => `<button type="button" role="radio" class="${ST[s].cls}" aria-checked="${st === s}" data-act="ckSet" data-aid="${esc(a.id)}" data-s="${esc(s)}">${icon(ic, 16)}${l}</button>`).join('')}</div>`;
  return `<article class="item ${cls}" id="it-${esc(a.id)}"><div class="item-h"><div data-css="min-width:0"><h2 class="item-name">${esc(tool.name || 'Herramienta')}</h2><div class="s">${meta}</div></div><span class="prev">Anterior<b data-css="color:${prev ? `var(--${ST[prev.state].cls}-ink)` : 'var(--ink2)'}">${prev ? ST[prev.state].label : 'Sin control'}</b></span></div>
  ${pick}${q && (q.missing > 0 || q.change > 0) ? noteHTML(a, it, q) : ''}</article>`;
}

// Limpieza de herramientas y caja (una por control): Limpio o Requiere limpieza (con nota).
function ckCleanHTML() {
  const d = derive(); const cl = UI.ck.cleaning || {}; const st = CLEAN[cl.status] ? cl.status : null;
  const effs = d.effByTech[UI.ck.techId] || []; const last = effs.filter((c) => c.pkey !== UI.ck.pk).pop(); const prev = last && last.cleaning && CLEAN[last.cleaning.status];
  const empty = st === 'requiere_limpieza' && !(cl.note || '').trim();
  const sub = UI.ck.cleaningRequired === false ? 'Opcional: el control que corregís no tiene dato de limpieza' : 'Obligatorio para finalizar el control';
  return `<article class="item ckclean ${st ? CLEAN[st].cls : ''}" id="it-clean"><div class="item-h"><div data-css="min-width:0"><h2 class="item-name">Limpieza de herramientas y caja</h2><div class="s">${sub}</div></div><span class="prev">Anterior<b data-css="color:${prev ? `var(--${prev.cls}-ink)` : 'var(--ink2)'}">${prev ? prev.label : 'Sin dato'}</b></span></div>
  <div class="pick two" role="radiogroup" aria-label="Limpieza de herramientas y caja">${[['limpio', 'ok'], ['requiere_limpieza', 'clean']].map(([s, ic]) => `<button type="button" role="radio" class="${CLEAN[s].cls}" aria-checked="${st === s}" data-act="ckClean" data-s="${s}">${icon(ic, 16)}${CLEAN[s].label}</button>`).join('')}</div>
  ${st === 'requiere_limpieza' ? `<div class="note warn"><label for="nt-clean">Nota de limpieza (obligatoria)</label><div class="quick" data-css="margin:0">${CLEAN_QUICK.map((x) => `<button type="button" class="qchip" data-act="ckCleanQuick" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div><textarea id="nt-clean" class="${empty ? 'empty' : ''}" data-in="ckCleanNote" rows="2" maxlength="2000" placeholder="Contá qué hay que limpiar">${esc(cl.note || '')}</textarea><span class="nerr" role="alert" id="ne-clean" ${empty ? '' : 'hidden'}>La nota es obligatoria si requiere limpieza.</span></div>` : ''}</article>`;
}

const ckStats = () => { const list = ckList(UI.ck); return { ...ckSummary(list, UI.ck.items, UI.ck.cleaning, { cleaningRequired: UI.ck.cleaningRequired !== false }), list }; };
// Aviso de un borrador que el servidor rechazó: queda en el equipo hasta corregirlo o descartarlo.
const reviewHTML = (rv) => `<div class="banner warn" role="alert"><div><b>Este borrador necesita revisión</b><div class="sm">El servidor no lo aceptó: ${esc(rv.message)} Quedó guardado en este equipo; corregilo y guardalo de nuevo, o descartalo.</div></div><div class="acts"><button class="btn sm" data-act="ckDiscardLocal">Descartar borrador</button><button class="btn sm pri" data-act="ckSave">Guardar de nuevo</button></div></div>`;
function savedText(ck) {
  if (ck.dirty) return 'Cambios sin guardar';
  if (ck.local) return 'Borrador guardado en este equipo' + (net.offline ? ' (sin conexión)' : '');
  return ck.savedAt ? 'Borrador guardado ' + fhm(ck.savedAt) : '';
}
function ckUpdateProgress() {
  if (!UI.ck || !$('#ckcount')) return; const c = ckStats(); const done = c.n - c.pendiente;
  $('#ckcount').textContent = `${done} de ${c.n} controladas`;
  const sv = $('#cksaved'); if (sv) sv.textContent = savedText(UI.ck);
  for (const a of c.list) { const el = document.getElementById('sg-' + a.id); if (el) { const q = itemQty(UI.ck.items[a.id], a.qty || 1); el.className = q ? ST[itemState(q)].cls : ''; } }
  const sg = $('#cksegs'); if (sg) sg.setAttribute('aria-valuenow', done);
  const lg = $('#cklegend'); if (lg) setHTML(lg, `<span class="ld"><i data-css="background:var(--ok)"></i>${c.bueno} bueno</span><span class="ld"><i data-css="background:var(--warn)"></i>${c.cambio} cambio</span><span class="ld"><i data-css="background:var(--bad)"></i>${c.faltante} faltante</span><span class="ld"><i data-css="background:var(--pend)"></i>${c.pendUnits} pendiente</span>`);
  const ao = $('#ckallok'); if (ao) { ao.hidden = !c.pendiente; $('#ckallokt').textContent = `Marcar ${c.pendiente} ${c.pendiente === 1 ? 'pendiente' : 'pendientes'} como Buen estado`; }
  const why = ckWhy(c, net.offline);
  const w = $('#ckwhy'); if (w) w.textContent = why; const fb = $('#ckfin'); if (fb) fb.disabled = !!why;
  const cf = $('#ckconf'); if (cf) setHTML(cf, UI.ck.conflict ? CONFLICT_HTML('ckConflictReload', 'ckConflictKeep') : '');
  const rv = $('#ckreview'); if (rv) setHTML(rv, UI.ck.review ? reviewHTML(UI.ck.review) : '');
}
VIEWS.ckRefresh = ckUpdateProgress;

// ------------------------------------------------------------------ guardado del borrador
let draftTimer = null;
function ckTouch() { UI.ck.dirty = true; ckUpdateProgress(); clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraft(true), 2500); }

async function sendRequest(req) {
  const o = { idempotencyKey: req.idempotencyKey, allowOffline: true };
  const r = req.kind === 'create' ? await api.createControl(req.body, o) : await api.saveControl(req.id, { items: req.items, ...(req.cleaning !== undefined ? { cleaning: req.cleaning } : {}) }, req.version, o);
  droppedLineas(r.control, r.warnings);
  return r.control;
}
// El servidor guardó sin línea los ítems cuya línea ya no está activa (p. ej. la archivaron
// mientras el borrador esperaba sin conexión): se avisa y el checklist abierto la quita también.
function droppedLineas(control, warnings) {
  const ws = (warnings || []).filter((w) => w && w.code === 'linea_dropped'); if (!ws.length || !control) return;
  const ck = UI.ck;
  if (ck && ck.key === draftKey(holderKey(control), control.period, control.supersedes || null)) for (const w of ws) { const it = ck.items[w.assignmentId]; if (it) { it.lineaId = null; ckReplaceItem(w.assignmentId); } }
  toast(ws.length === 1 ? 'La línea elegida en una herramienta ya no está activa: se guardó sin línea. Elegí otra si hace falta.' : `La línea elegida en ${ws.length} herramientas ya no está activa: se guardaron sin línea. Elegí otra si hace falta.`);
}
function adopt(ck, control) { ck.controlId = control.id; ck.version = control.version; ck.startedAt = control.startedAt; ck.savedAt = control.updatedAt; }

// Guarda en el equipo y, si hay conexión, en el servidor.
async function saveDraft(silent) {
  const ck = UI.ck; if (!ck || ck.locked || !can('controls_do')) return; clearTimeout(draftTimer);
  if (!ck.dirty && silent) return;
  ck.dirty = false;
  let prev = null; try { prev = await drafts().get(ck.key); } catch { prev = null; }
  const rec = nextDraft(prev, { techId: ck.techId, period: ck.period, correctionOf: ck.correctionOf, controlId: ck.controlId, version: ck.version, items: apiItems(ck.items, qtyOfAsg), cleaning: { ...ck.cleaning } }, newIdempotencyKey());
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
    adopt(ck, control); ck.local = false; ck.review = null;
    try { const cur = await drafts().get(ck.key); if (cur && cur.idemKey === rec.idemKey) await drafts().del(ck.key); else if (cur) { await drafts().put({ ...cur, controlId: control.id, version: control.version }); ck.local = true; } } catch (e) { console.warn(e); }
    if (!silent) toast('Borrador guardado');
    refresh().catch(() => {});
  } catch (e) {
    if (e.kind === 'network' || e.kind === 'offline') { if (!silent) toast('Sin conexión: el borrador quedó guardado en este equipo y se envía al volver la conexión.'); }
    else if (e.kind === 'conflict') { ck.conflict = { current: e.current }; await drafts().put({ ...rec, conflict: true }).catch(() => {}); }
    else if (needsReview(e)) { ck.review = reviewOf(e); await drafts().put({ ...rec, review: ck.review }).catch(() => {}); toast(errMsg(e), 'err'); }
    else { ck.dirty = true; toast(errMsg(e), 'err'); }
  } finally { ck.saving = false; }
  if (UI.ck === ck) ckUpdateProgress();
}

// Al volver la conexión: se envían todos los borradores guardados en el equipo.
hooks.online.push(async () => {
  const out = await flushDrafts(drafts(), sendRequest);
  for (const { rec, control } of out.sent) if (UI.ck && UI.ck.key === rec.key) { adopt(UI.ck, control); UI.ck.local = false; }
  for (const rec of out.conflicts) if (UI.ck && UI.ck.key === rec.key && !UI.ck.conflict) UI.ck.conflict = { current: S.controls[rec.controlId] || null };
  // Rechazados: siguen en el equipo, marcados para revisar (con el aviso en el control).
  for (const rec of out.review) if (UI.ck && UI.ck.key === rec.key) UI.ck.review = rec.review;
  const nRev = out.review.length;
  if (nRev) toast(nRev === 1 ? `Un borrador guardado sin conexión necesita revisión: ${out.review[0].review.message}` : `${nRev} borradores guardados sin conexión necesitan revisión. Abrí cada control para corregirlo.`, 'err');
  if (out.sent.length) { toast(out.sent.length === 1 ? 'Se envió el borrador guardado sin conexión.' : `Se enviaron ${out.sent.length} borradores guardados sin conexión.`); refresh().catch(() => {}); }
  for (const f of out.failed) toast(errMsg(f.error), 'err');
  if (UI.ck) ckUpdateProgress();
});

// Después de cada recarga: si el control que se está editando cambió en el servidor, aviso.
hooks.afterState.push(() => {
  const ck = UI.ck; if (!ck || ck.locked || ck.conflict || ck.saving) return;
  const cur = ck.controlId ? S.controls[ck.controlId] : serverDraftOf(ck.techId, ck.pk, ck.correctionOf);
  if (!cur) return;
  const touched = ck.dirty || ck.local || Object.keys(ck.items).length || (ck.cleaning && ck.cleaning.status);
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
// Reemplaza la tarjeta y devuelve el foco al mismo control (botón, campo o selector).
function focusKey(el) { if (!el) return null; if (el.id) return '#' + CSS.escape(el.id); const ds = el.dataset || {}; return ds.act ? `[data-act="${CSS.escape(ds.act)}"]${ds.k ? `[data-k="${CSS.escape(ds.k)}"]` : ''}${ds.d ? `[data-d="${CSS.escape(ds.d)}"]` : ''}${ds.s ? `[data-s="${CSS.escape(ds.s)}"]` : ''}` : null; }
function swapCard(id, html) {
  const el = document.getElementById(id); if (!el) return;
  const act = document.activeElement; const key = el.contains(act) ? focusKey(act) : null;
  const next = fromHTML(html); el.replaceWith(next);
  if (key) { const f = next.querySelector(key); if (f && !f.disabled) f.focus({ preventScroll: true }); }
}
function ckReplaceItem(aid) { const a = S.assignments[aid]; if (a) swapCard('it-' + aid, ckItemHTML({ id: aid, ...a })); }
const keepNote = (cur) => ({ note: (cur && cur.note) || '', lineaId: (cur && cur.lineaId) || null });
// Guarda el ítem en la forma del pedido (apiItem): si quedó sin faltantes ni recambios, sin línea.
const setItem = (aid, it) => { UI.ck.items[aid] = apiItem(it, qtyOfAsg(aid)); };

ACT.ckSet = (ds) => {
  const ck = UI.ck; if (!ck) return; const cur = ck.items[ds.aid] || {};
  setItem(ds.aid, { state: ds.s, expected: qtyOfAsg(ds.aid), ...keepNote(cur) }); ckReplaceItem(ds.aid);
  if (ds.s === 'faltante' && !(cur.note || '').trim()) { const ta = document.getElementById('nt-' + ds.aid); if (ta && matchMedia('(min-width:1024px)').matches) ta.focus(); }
  const it = document.getElementById('it-' + ds.aid); const b = it && it.querySelector(`[data-s="${CSS.escape(ds.s)}"]`); if (b && !it.contains(document.activeElement)) b.focus({ preventScroll: true });
  ckTouch();
};
// Cantidades (más de 1 unidad): nunca más que las asignadas entre buen estado y recambio.
function setQty(aid, k, value) {
  const ck = UI.ck; if (!ck) return; const exp = qtyOfAsg(aid); const cur = ck.items[aid]; const q = itemQty(cur, exp);
  let good = q ? q.good : 0; let change = q ? q.change : 0;
  const v = Math.max(0, Math.floor(Number(value) || 0));
  if (k === 'good') good = Math.min(v, exp - change); else change = Math.min(v, exp - good);
  setItem(aid, { good, change, expected: exp, ...keepNote(cur) }); ckReplaceItem(aid); ckTouch();
}
ACT.ckStep = (ds) => { const q = itemQty(UI.ck && UI.ck.items[ds.aid], qtyOfAsg(ds.aid)); setQty(ds.aid, ds.k, (q ? q[ds.k] : 0) + Number(ds.d)); };
CH.ckQty = (v, el) => setQty(el.dataset.aid, el.dataset.k, v);
ACT.ckAllGood = (ds) => { const exp = qtyOfAsg(ds.aid); const cur = UI.ck && UI.ck.items[ds.aid]; if (!UI.ck) return; setItem(ds.aid, { good: exp, change: 0, expected: exp, ...keepNote(cur) }); ckReplaceItem(ds.aid); ckTouch(); };
CH.ckLinea = (v, el) => { const it = UI.ck && UI.ck.items[el.dataset.aid]; if (!it) return; it.lineaId = v || null; ckTouch(); };
function ckNoteState(aid) { const it = UI.ck && UI.ck.items[aid]; const ta = document.getElementById('nt-' + aid); const er = document.getElementById('ne-' + aid); const q = itemQty(it, qtyOfAsg(aid)); const empty = q && q.missing > 0 && !(it.note || '').trim(); if (ta) ta.classList.toggle('empty', !!empty); if (er) er.hidden = !empty; }
ACT.ckQuick = (ds) => { const it = UI.ck && UI.ck.items[ds.aid]; if (!it) return; it.note = ds.q; const ta = document.getElementById('nt-' + ds.aid); if (ta) ta.value = ds.q; ckNoteState(ds.aid); ckTouch(); };
IN.ckNote = (v, el) => { const it = UI.ck && UI.ck.items[el.dataset.aid]; if (!it) return; it.note = v; ckNoteState(el.dataset.aid); ckTouch(); };
ACT.ckAllOk = () => {
  const ck = UI.ck; if (!ck) return; let n = 0;
  for (const a of ckList(ck)) { const exp = a.qty || 1; if (!itemQty(ck.items[a.id], exp)) { const cur = ck.items[a.id]; setItem(a.id, exp > 1 ? { good: exp, change: 0, expected: exp, ...keepNote(cur) } : { state: 'bueno', expected: 1, ...keepNote(cur) }); n++; ckReplaceItem(a.id); } }
  if (n) { ckTouch(); toast(`${n} marcadas en buen estado`); } else toast('No quedan herramientas pendientes');
};
// Limpieza.
function ckCleanState() { const cl = UI.ck && UI.ck.cleaning; const ta = document.getElementById('nt-clean'); const er = document.getElementById('ne-clean'); const empty = cl && cl.status === 'requiere_limpieza' && !(cl.note || '').trim(); if (ta) ta.classList.toggle('empty', !!empty); if (er) er.hidden = !empty; }
ACT.ckClean = (ds) => { const ck = UI.ck; if (!ck) return; ck.cleaning = { status: ds.s, note: (ck.cleaning && ck.cleaning.note) || '' }; swapCard('it-clean', ckCleanHTML()); const b = document.querySelector(`#it-clean [data-s="${CSS.escape(ds.s)}"]`); if (b) b.focus({ preventScroll: true }); ckTouch(); };
ACT.ckCleanQuick = (ds) => { const cl = UI.ck && UI.ck.cleaning; if (!cl) return; cl.note = ds.q; const ta = document.getElementById('nt-clean'); if (ta) ta.value = ds.q; ckCleanState(); ckTouch(); };
IN.ckCleanNote = (v) => { const cl = UI.ck && UI.ck.cleaning; if (!cl) return; cl.note = v; ckCleanState(); ckTouch(); };
ACT.ckSave = () => { if (UI.ck) { UI.ck.dirty = true; saveDraft(false); } };
// Descarta el borrador guardado en este equipo (decisión explícita) y vuelve a lo del servidor.
ACT.ckDiscardLocal = async () => {
  const ck = UI.ck; if (!ck) return;
  try { await drafts().del(ck.key); } catch (e) { console.warn(e); }
  const { techId, period, correctionOf } = ck; UI.ck = null; initCheck(techId, period, { correctionOf }); UI.forceCk = true; render();
  toast('Se descartó el borrador guardado en este equipo.');
};
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
  if (ckWhy(c)) { ckUpdateProgress(); const el = document.getElementById(c.first ? 'it-' + c.first : 'it-clean'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (net.offline) { toast('Sin conexión: el control se finaliza cuando vuelva la conexión. El borrador queda guardado en este equipo.', 'err'); saveDraft(true); return; }
  if (ck.conflict) { toast('Resolvé el aviso de cambios antes de finalizar.', 'err'); return; }
  const t = holderOf(ck.techId);
  if (!ck.correctionOf && d.eff[ck.techId + '|' + ck.pk]) { toast('Ya existe un control finalizado para ese período. Registrá una corrección.', 'err'); UI.ck = null; UI.forceCk = true; render(); return; }
  // Alertas: una por ítem con faltantes, otra por ítem con recambios y la de limpieza si el control
  // efectivo anterior también requería limpieza.
  const prevEff = (d.effByTech[ck.techId] || []).filter((x) => x.pkey !== ck.pk).pop();
  const cleanAlert = ck.cleaning.status === 'requiere_limpieza' && prevEff && prevEff.cleaning && prevEff.cleaning.status === 'requiere_limpieza';
  const nAl = c.alerts + (cleanAlert ? 1 : 0);
  const cl = CLEAN[ck.cleaning.status];
  openModal({ title: '¿Finalizar el control?', render: () => `<p class="muted" data-css="margin:0 0 14px">${esc(t.name)} · ${plabel(ck.period)}${ck.correctionOf ? ' (corrección)' : ''}. El registro no podrá editarse; las correcciones se hacen con un nuevo registro de auditoría.</p><div class="tiles3"><div class="tile3 ok"><b>${c.bueno}</b><span>Buen estado</span></div><div class="tile3 warn"><b>${c.cambio}</b><span>Para cambio</span></div><div class="tile3 bad"><b>${c.faltante}</b><span>Faltante</span></div></div><p class="muted xs" data-css="margin:8px 0 0">En unidades. Las que requieren recambio no cuentan como faltantes.</p><dl class="meta"><dt>Responsable</dt><dd>${esc(who(ME.id))}</dd><dt>Fecha y hora</dt><dd>${fdt(nowISO())}</dd><dt>Limpieza</dt><dd>${esc(cl ? cl.label : 'Sin dato')}${ck.cleaning.status === 'requiere_limpieza' ? '. ' + esc(ck.cleaning.note.trim()) : ''}</dd><dt>Alertas</dt><dd>${nAl ? `Se generarán ${nAl} ${nAl === 1 ? 'alerta automática' : 'alertas automáticas'}` : 'No se generan alertas'}</dd></dl>`,
    actions: [{ label: 'Revisar', close: true }, { label: 'Confirmar y guardar', kind: 'pri', run: async () => {
      clearTimeout(draftTimer); ck.saving = true;
      try {
      // Primero queda guardado el borrador con todos los ítems y la limpieza; después se finaliza.
      const items = apiItems(ck.items, qtyOfAsg); const cleaning = { ...ck.cleaning };
      const saved = ck.controlId ? await api.saveControl(ck.controlId, { items, cleaning }, ck.version) : await api.createControl(ck.correctionOf ? { correctionOf: ck.correctionOf, items, cleaning } : { ...holderBody(ck.techId), period: ck.period, items, cleaning });
      droppedLineas(saved.control, saved.warnings);
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
