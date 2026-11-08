// Hoja inferior (bottom sheet) de 2.1, con aviso de conflicto: si el registro que se edita
// cambió en el servidor (otro usuario, o un 409), se avisa y se elige recargar o mantener.
import { $, esc, setHTML } from './dom.js';
import { icon } from './icons.js';
import { ACT, setModalFieldHandler } from './actions.js';
import { errMsg } from './feedback.js';

export let MOD = null;

export const CONFLICT_HTML = (reloadAct, keepAct) => `<div class="banner warn" role="alert"><div><b>Alguien modificó este registro mientras lo editabas.</b><div class="sm">Recargá para ver los datos nuevos, o mantené tus cambios y guardalos encima.</div></div><div class="acts"><button class="btn sm" data-act="${esc(reloadAct)}">Recargar</button><button class="btn sm" data-act="${esc(keepAct)}">Mantener mis cambios</button></div></div>`;

// o.rec = { get: () => registro actual o null, version } para detectar ediciones ajenas.
// o.reload(rec) = estado nuevo del formulario a partir del registro actual.
export function openModal(o) {
  MOD = { st: {}, conflict: false, ...o };
  const root = $('#modal-root');
  setHTML(root, `<div class="scrim" data-act="modalClose"></div><div class="sheet" role="dialog" aria-modal="true" ${o.noHead ? 'aria-label="Resultado"' : 'aria-labelledby="mtitle"'}><span class="handle" aria-hidden="true"></span>${o.noHead ? '' : `<div class="sheet-h"><h2 id="mtitle">${esc(o.title)}</h2><button class="icon-btn" data-act="modalClose" aria-label="Cerrar">${icon('x')}</button></div>`}<div id="mconf"></div><div class="sheet-b" id="mbody"></div><div class="merr" id="merr" role="alert"></div>${(o.actions || []).length ? `<div class="sheet-f">${o.actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-act="modalAction" data-i="${esc(i)}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div>`);
  setHTML($('#mbody'), o.render(MOD.st));
  root.hidden = false; document.body.classList.add('noscroll');
  if (matchMedia('(min-width:1024px)').matches) setTimeout(() => { const f = root.querySelector('.sheet-b input:not([type=file]),.sheet-b select,.sheet-b textarea'); if (f) f.focus(); }, 60);
  return MOD;
}
export function closeModal() { MOD = null; const r = $('#modal-root'); r.innerHTML = ''; r.hidden = true; document.body.classList.remove('noscroll'); }
export function modalRerender() {
  if (!MOD) return;
  const ae = document.activeElement; const key = ae && ae.dataset && ae.dataset.mi;
  setHTML($('#mbody'), MOD.render(MOD.st));
  if (key) { const el = $(`#mbody [data-mi="${CSS.escape(key)}"]`); if (el && el.tagName !== 'SELECT') el.focus(); }
}
export function modalSet(k, v) { if (MOD) { MOD.st[k] = v; modalRerender(); } }
export function confirmBox(title, text, label = 'Confirmar', kind = 'pri') {
  return new Promise((res) => { openModal({ title, render: () => `<p data-css="margin:4px 0 12px">${text}</p>`, actions: [{ label: 'Cancelar', close: true, run: () => res(false) }, { label, kind, run: () => { res(true); } }], onClose: () => res(false) }); });
}

function showConflict() {
  if (!MOD || MOD.conflict) return;
  MOD.conflict = true;
  setHTML($('#mconf'), `<div data-css="padding:0 20px">${CONFLICT_HTML('conflictReload', 'conflictKeep')}</div>`);
}
// Llamado después de cada recarga del estado: compara la versión que se está editando.
export function checkModalConflict() {
  if (!MOD || !MOD.rec || MOD.conflict) return;
  const cur = MOD.rec.get();
  if (cur && cur.version != null && MOD.rec.version != null && cur.version !== MOD.rec.version) showConflict();
}

setModalFieldHandler((el) => {
  if (!(el.dataset && el.dataset.mi !== undefined && MOD)) return false;
  MOD.st[el.dataset.mi] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
  if (el.dataset.mr !== undefined) modalRerender();
  return true;
});

ACT.modalClose = () => { const m = MOD; closeModal(); if (m && m.onClose) m.onClose(); };
ACT.mset = (ds) => modalSet(ds.k, ds.v);
ACT.modalAction = async (ds) => {
  if (!MOD) return; const m = MOD; const a = m.actions[+ds.i];
  if (a.close) { closeModal(); if (a.run) a.run(); return; }
  const err = $('#merr'); err.textContent = ''; document.body.classList.add('busy');
  try { const r = await a.run(m.st, m); if (r !== false && MOD === m) closeModal(); }
  catch (e) {
    console.warn(e);
    if (MOD === m) {
      err.textContent = errMsg(e);
      // 409: el servidor manda el registro actual; nunca se pisa en silencio.
      if (e && e.kind === 'conflict' && m.rec) { m.conflictCurrent = e.current; showConflict(); }
    }
  } finally { document.body.classList.remove('busy'); }
};
// El registro más nuevo entre el estado recargado y el que mandó el 409.
const latest = () => [MOD.rec && MOD.rec.get(), MOD.conflictCurrent].filter(Boolean).sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null;
ACT.conflictReload = () => {
  if (!MOD) return; const cur = latest();
  if (cur && MOD.reload) { MOD.st = MOD.reload(cur); MOD.rec.version = cur.version; }
  MOD.conflict = false; setHTML($('#mconf'), ''); $('#merr').textContent = ''; modalRerender();
};
ACT.conflictKeep = () => {
  if (!MOD) return; const cur = latest();
  if (cur && cur.version != null) MOD.rec.version = cur.version;
  MOD.conflict = false; setHTML($('#mconf'), ''); $('#merr').textContent = '';
};
