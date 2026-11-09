// Etapa 5: Eliminar (baja lógica) con motivo, la resolución de las herramientas asignadas de un
// técnico o una caja en el mismo paso, Eliminar definitivamente (solo sin historial, escribiendo
// el nombre), Restaurar, Anular un movimiento y Administración › Registros eliminados.
// El servidor decide qué se puede: la hoja pide antes lo que impide eliminar y si tiene historial.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { UI, render } from '../../ui/registry.js';
import { ACT, IN, CH } from '../../ui/actions.js';
import { openModal, modalRerender, modalSet, MOD } from '../../ui/modal.js';
import { toast, act, UErr, tooLong, errMsg } from '../../ui/feedback.js';
import { field, emptyBox, optList, mvRow } from '../../ui/components.js';
import { hooks } from '../../ui/app.js';
import { api } from '../../api/index.js';
import { S, can, myRole, who, refresh } from '../../state/store.js';
import { LIM, mvLabel } from '../../state/constants.js';
import { fdt } from '../../state/period.js';
import { parseRoute } from '../../ui/router.js';

// Etiqueta, artículo y lista a la que se vuelve después de eliminar desde la ficha.
export const REC = {
  techs: { label: 'Técnico', the: 'el técnico', back: '#tecnicos' },
  cajas: { label: 'Caja', the: 'la caja', back: '#lineas' },
  tools: { label: 'Herramienta', the: 'la herramienta', back: '#config' },
  categories: { label: 'Categoría', the: 'la categoría' },
  plantillas: { label: 'Plantilla', the: 'la plantilla', back: '#plantillas' },
  lineas: { label: 'Línea o sector', the: 'la línea o sector' },
  especialidades: { label: 'Especialidad', the: 'la especialidad' },
  kits: { label: 'Kit', the: 'el kit' },
  users: { label: 'Usuario', the: 'el usuario' },
};
const QUICK = ['Cargado por error', 'Duplicado', 'Ya no se usa'];
const QUICK_TECH = ['Dejó la empresa', 'Cargado por error', 'Duplicado'];
const RES_OPTS = [['', 'Elegí qué hacer'], ['disponible', 'Devolver a disponibles'], ['reparacion', 'Devolver a reparación'], ['baja', 'Devolver y dar de baja'], ['retiro', 'Retirar']];

export const canDelete = (type) => can('records_delete') && (type !== 'users' || myRole() === 'admin');

// Botón "Eliminar" de una ficha o fila. back: adónde ir después (si se eliminó desde la ficha).
export function deleteBtn(type, id, { sm = false, back = '' } = {}) {
  if (!canDelete(type)) return '';
  return `<button class="btn ${sm ? 'sm ' : ''}danger" data-act="recDelete" data-type="${esc(type)}" data-id="${esc(id)}" data-back="${esc(back)}">${sm ? '' : icon('x', 16)}Eliminar</button>`;
}

const reasonField = (st, quick) => `${field('Motivo (obligatorio)', `<textarea id="rec-reason" rows="2" maxlength="${LIM.text}" data-mi="reason" placeholder="Por qué se elimina">${esc(st.reason || '')}</textarea>`, 'rec-reason')}<div class="qchips">${quick.map((q) => `<button type="button" class="qchip" data-act="recQuick" data-v="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
ACT.recQuick = (ds) => modalSet('reason', ds.v);
function cleanReasonUI(st) {
  const r = String(st.reason || '').trim();
  if (!r) throw new UErr('Indicá el motivo.');
  tooLong(r, LIM.text, 'El motivo');
  return r;
}
const resKey = (aid) => 'res:' + aid;

// ------------------------------------------------------------------ eliminar
ACT.recDelete = async (ds) => {
  const { type, id } = ds; if (!canDelete(type)) { toast('Tu perfil no tiene permiso para esta acción.', 'err'); return; }
  const chk = await act(() => api.deleteCheck(type, id)); if (!chk) return;
  const T = REC[type];
  const blocked = chk.blockers.length > 0;
  const asg = chk.assignments || [];
  openModal({
    title: `Eliminar ${T.label.toLowerCase()}`,
    render: (st) => {
      const head = `<p class="muted mt0">Vas a eliminar ${esc(T.the)} <b>${esc(chk.name)}</b>. Deja de aparecer en las listas y los selectores; su historial sigue en reportes, auditoría e impresiones, y se puede restaurar desde Administración › Registros eliminados.</p>`;
      if (blocked) return head + `<div class="banner warn" role="alert"><div><b>Todavía no se puede eliminar.</b>${chk.blockers.map((b) => `<div class="sm">${esc(b.message)}</div>`).join('')}</div></div>`;
      const pending = asg.filter((a) => !st[resKey(a.id)]).length;
      const res = asg.length ? `<div class="recres"><div class="srow"><h3 class="si">Herramientas asignadas (${asg.length})</h3><button type="button" class="btn sm" data-act="recAllDisp">Devolver todas a disponibles</button></div><p class="muted sm mt0">Indicá qué hacer con cada una: se registra en este mismo paso, junto con la eliminación.</p><div class="list">${asg.map((a) => `<div class="row recrow"><div class="grow"><div class="t">${esc(a.toolName)}${a.unitCode ? ' ' + esc(a.unitCode) : ''}${a.qty > 1 ? ` ×${a.qty}` : ''}</div></div><select class="recsel" data-mi="${esc(resKey(a.id))}" data-mr aria-label="Qué hacer con ${esc(a.toolName)}">${optList(RES_OPTS.slice(1), st[resKey(a.id)] || '', RES_OPTS[0][1])}</select></div>`).join('')}</div>${pending ? `<p class="hint warn">${icon('alert', 16)}<span>Falta elegir qué hacer con ${pending} ${pending === 1 ? 'herramienta' : 'herramientas'}.</span></p>` : ''}</div>` : '';
      const purge = chk.canPurge ? `<div class="card recpurge"><h3 class="si">Eliminar definitivamente</h3><p class="muted sm">No tiene historial: se puede borrar para siempre (la auditoría guarda el nombre y el motivo).</p><button type="button" class="btn sm danger" data-act="recPurgeOpen" data-type="${esc(type)}" data-id="${esc(id)}" data-back="${esc(ds.back || '')}">Eliminar definitivamente</button></div>` : `<p class="muted sm">${chk.hasHistory ? 'Tiene historial: solo se puede eliminar (queda archivado y se puede restaurar).' : ''}</p>`;
      return head + res + reasonField(st, type === 'techs' ? QUICK_TECH : QUICK) + purge;
    },
    actions: blocked ? [{ label: 'Cerrar', close: true }] : [{ label: 'Cancelar', close: true }, { label: 'Eliminar', kind: 'danger', run: async (st) => {
      const reason = cleanReasonUI(st);
      const missing = asg.filter((a) => !st[resKey(a.id)]).length;
      if (missing) throw new UErr(`Elegí qué hacer con ${missing} ${missing === 1 ? 'herramienta' : 'herramientas'}.`);
      const resolutions = asg.map((a) => { const v = st[resKey(a.id)]; return v === 'retiro' ? { assignmentId: a.id, action: 'retiro' } : { assignmentId: a.id, action: 'devolucion', cond: v }; });
      await api.archiveRecord(type, id, { reason, ...(resolutions.length ? { resolutions } : {}) }, chk.version);
      await refresh(); toast(`${T.label} eliminado`); afterChange(ds.back);
    } }],
  });
};
ACT.recAllDisp = () => {
  if (!MOD) return;
  for (const el of document.querySelectorAll('#mbody .recsel')) MOD.st[el.dataset.mi] = MOD.st[el.dataset.mi] || 'disponible';
  modalRerender();
};
function afterChange(back) {
  if (back && location.hash !== back) location.hash = back; else render();
}

// ------------------------------------------------------------------ eliminar definitivamente
ACT.recPurgeOpen = async (ds) => {
  const { type, id } = ds; if (!canDelete(type)) return;
  const chk = await act(() => api.deleteCheck(type, id)); if (!chk) return;
  const T = REC[type];
  if (!chk.canPurge) { toast(chk.hasHistory ? 'Tiene historial: solo se puede eliminar.' : chk.blockers.map((b) => b.message).join(' '), 'err'); return; }
  openModal({
    title: 'Eliminar definitivamente',
    render: (st) => `<div class="banner warn" role="alert"><div><b>Se borra para siempre.</b><div class="sm">${esc(T.label)} ${esc(chk.name)} no tiene historial. No se puede deshacer; la auditoría guarda el nombre y el motivo.</div></div></div>${field(`Escribí el nombre exacto para confirmar: <b>${esc(chk.name)}</b>`, `<input id="rec-confirm" type="text" maxlength="500" autocomplete="off" data-mi="confirm" value="${esc(st.confirm || '')}">`, 'rec-confirm')}${reasonField(st, QUICK)}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Eliminar definitivamente', kind: 'danger', run: async (st) => {
      if (String(st.confirm || '').trim() !== String(chk.name).trim()) throw new UErr('El nombre no coincide. Escribilo exactamente como aparece.');
      const reason = cleanReasonUI(st);
      await api.purgeRecord(type, id, { reason, confirmName: String(st.confirm).trim() }, chk.version);
      await refresh(); toast(`${T.label} eliminado definitivamente`); afterChange(ds.back || T.back || '');
    } }],
  });
};

// ------------------------------------------------------------------ restaurar
ACT.recRestore = (ds) => {
  const r = (DEL.list || []).find((x) => x.type === ds.type && x.id === ds.id); if (!r || !canDelete(r.type)) return;
  const T = REC[r.type];
  openModal({
    title: `Restaurar ${T.label.toLowerCase()}`,
    render: (st) => `<p class="muted mt0">${esc(T.label)} <b>${esc(r.name)}</b> vuelve a aparecer en las listas y los selectores, con todo su historial.${r.type === 'users' ? ' Queda desactivado: reactivalo en Usuarios para que pueda ingresar.' : ''}</p>${field('Motivo (obligatorio)', `<textarea id="rec-reason" rows="2" maxlength="${LIM.text}" data-mi="reason">${esc(st.reason || '')}</textarea>`, 'rec-reason')}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Restaurar', kind: 'pri', run: async (st) => {
      const reason = cleanReasonUI(st);
      await api.restoreRecord(r.type, r.id, { reason }, r.version);
      await refresh(); toast(`${T.label} restaurado`); await loadDeleted(true);
    } }],
  });
};

// ------------------------------------------------------------------ anular movimientos
export const canVoid = () => can('movements_void');
ACT.mvVoid = async (ds) => {
  const m = S.movements[ds.m]; if (!m || !canVoid()) return;
  const chk = await act(() => api.voidCheck(ds.m)); if (!chk) return;
  const row = mvRow({ id: ds.m, ...m }, { plain: true });
  openModal({
    title: 'Anular movimiento',
    render: (st) => `<div class="list">${row}</div>${chk.ok ? `<p class="muted">Se registra una anulación que revierte el inventario, con las mismas herramientas, unidades y poseedor. El original no se borra: los dos quedan en el historial (Anulado y Anulación).</p>${reasonField(st, ['Cargado por error', 'Herramienta equivocada', 'Técnico equivocado'])}` : `<div class="banner warn" role="alert"><div><b>No se puede anular.</b><div class="sm">${esc(chk.reason)}</div></div></div>`}`,
    actions: chk.ok ? [{ label: 'Cancelar', close: true }, { label: 'Anular movimiento', kind: 'danger', run: async (st) => {
      const reason = cleanReasonUI(st);
      await api.voidMovement(ds.m, { reason });
      await refresh(); toast('Movimiento anulado');
    } }] : [{ label: 'Cerrar', close: true }],
  });
};
// Texto de la anulación: qué movimiento anula.
export const voidOfText = (m) => { const o = S.movements[m.voidsMovementId]; return o ? `Anula: ${mvLabel(o.type)} del ${fdt(o.at)}` : 'Anula un movimiento'; };

// ------------------------------------------------------------------ registros eliminados
const DEL = { list: null, loading: false };
async function loadDeleted(force) {
  if (DEL.loading || (!force && DEL.list)) return;
  DEL.loading = true;
  try { DEL.list = (await api.archived()).records; } catch (e) { toast(errMsg(e), 'err'); } finally { DEL.loading = false; render(); }
}
hooks.afterState.push(() => { if (parseRoute(location.hash).name === 'admin' && UI.adminTab === 'deleted' && can('records_delete')) loadDeleted(true); });

export function deletedTab() {
  if (!can('records_delete')) return '<p class="hint">Tu perfil no puede ver los registros eliminados.</p>';
  loadDeleted();
  if (!DEL.list) return '<div class="loading"><div class="spin"></div>Cargando…</div>';
  const q = String(UI.delQ || '').trim().toLowerCase(); const ty = UI.delType || 'all';
  const types = Object.keys(REC).filter((t) => t !== 'users' || myRole() === 'admin');
  const list = DEL.list.filter((r) => (ty === 'all' || r.type === ty) && (!q || [r.name, r.legajo, r.username, r.reason].filter(Boolean).join(' ').toLowerCase().includes(q)));
  const filters = `<div class="toolbar"><div class="search">${icon('search', 18)}<input id="delq" type="search" placeholder="Buscar por nombre o motivo" value="${esc(UI.delQ || '')}" data-in="delQ" aria-label="Buscar registros eliminados"></div><select id="deltype" data-ch="delType" aria-label="Tipo de registro">${optList([['all', 'Todos los tipos'], ...types.map((t) => [t, REC[t].label])], ty)}</select></div>`;
  const rows = list.map((r) => `<div class="row recdel" data-rec="${esc(r.type + ':' + r.id)}"><div class="grow"><div class="t">${esc(r.name)} <span class="chip pend">${esc(REC[r.type].label)}</span></div><div class="s">Eliminado el ${fdt(r.archivedAt)} por ${esc(r.archivedByName || who(r.archivedBy))}</div><div class="s">Motivo: ${esc(r.reason || '—')}</div></div><span class="r"><button class="btn sm" data-act="recRestore" data-type="${esc(r.type)}" data-id="${esc(r.id)}">Restaurar</button>${r.hasHistory ? '' : `<button class="btn sm danger" data-act="recPurgeOpen" data-type="${esc(r.type)}" data-id="${esc(r.id)}">Eliminar definitivamente</button>`}</span></div>`).join('');
  return `<p class="hint">${icon('info', 16)}<span>Lo eliminado queda archivado: no aparece en listas ni selectores, pero su historial sigue en reportes, auditoría e impresiones. Restaurar lo vuelve a mostrar.</span></p>${filters}${list.length ? `<div class="list">${rows}</div>` : `<div class="list">${emptyBox(DEL.list.length ? 'Ningún registro coincide' : 'No hay registros eliminados', '')}</div>`}`;
}
IN.delQ = (v) => { UI.delQ = v; render(); };
CH.delType = (v) => { UI.delType = v; render(); };

// Para las vistas: nombre del artículo eliminado en un aviso de la ficha.
export const archivedBanner = (r, type) => `<div class="banner warn" role="status"><div><b>${esc(REC[type].label)} eliminado.</b><div class="sm">El ${fdt(r.archivedAt)}, ${esc(who(r.archivedBy))}. Motivo: ${esc(r.archiveReason || '—')}. Se conserva su historial; se restaura desde Administración › Registros eliminados.</div></div></div>`;
