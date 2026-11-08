// Configuración de herramientas: categorías y herramientas (igual que 2.1), por la API.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS } from '../../ui/registry.js';
import { ACT } from '../../ui/actions.js';
import { openModal, modalRerender, MOD, confirmBox } from '../../ui/modal.js';
import { toast, act, UErr, tooLong } from '../../ui/feedback.js';
import { pageHead, emptyBox, demoChip, field, optList } from '../../ui/components.js';
import { gateUI } from '../tecnicos/view.js';
import { api } from '../../api/index.js';
import { S, derive, can, refresh, catName } from '../../state/store.js';
import { LIM } from '../../state/constants.js';

VIEWS.config = () => {
  const d = derive(); const ce = can('tools_edit');
  return pageHead('Configuración de herramientas', 'Categorías y herramientas que usa la empresa', { acts: ce ? `<button class="btn" data-act="catNew">Nueva categoría</button><button class="btn pri" data-act="toolNew">${icon('plus', 18)}Nueva herramienta</button>` : '' }) +
  `${!ce ? '<p class="hint">Tu perfil puede consultar esta sección pero no modificarla.</p>' : ''}
  <h2 class="sec" data-css="margin-top:6px">Categorías</h2>${d.cats.length ? `<div class="list">${d.cats.map((c) => { const n = d.tools.filter((t) => t.categoryId === c.id).length; return `<div class="row"><div class="grow"><div class="t">${esc(c.name)} ${demoChip(c)}</div><div class="s">${n} ${n === 1 ? 'herramienta' : 'herramientas'}</div></div>${ce ? `<button class="btn sm" data-act="catEdit" data-c="${esc(c.id)}">Editar</button>${n ? '' : `<button class="btn sm danger" data-act="catDel" data-c="${esc(c.id)}">Eliminar</button>`}` : ''}</div>`; }).join('')}</div>` : `<div class="list">${emptyBox('Sin categorías', 'Agrupá las herramientas por tipo: eléctricas, medición, manuales.', ce ? '<button class="btn" data-act="catNew">Nueva categoría</button>' : '')}</div>`}
  <h2 class="sec">Herramientas</h2>${d.tools.length ? `<div class="list">${d.tools.map((t) => { const p = d.pools[t.id]; return `<div class="row"><a class="grow" href="#herramienta-${esc(t.id)}"><div class="t ell">${esc(t.name)} ${t.active === false ? '<span class="chip">Inactiva</span>' : ''} ${demoChip(t)}</div><div class="s ell">${esc(catName(t.categoryId))}, ${t.serialized ? 'por código' : 'por cantidad'}, ${p.asignado} asignadas, ${p.disponible} disponibles</div></a>${ce ? `<button class="btn sm" data-act="toolEdit" data-t="${esc(t.id)}">Editar</button><button class="btn sm" data-act="toolToggle" data-t="${esc(t.id)}">${t.active === false ? 'Activar' : 'Desactivar'}</button>` : ''}</div>`; }).join('')}</div>` : `<div class="list">${emptyBox('Sin herramientas', 'Creá la primera herramienta para empezar a asignarla.', ce ? '<button class="btn pri" data-act="toolNew">Nueva herramienta</button>' : '')}</div>`}`;
};

function catForm(st) { return field('Nombre de la categoría', `<input id="f-cn" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}">`, 'f-cn'); }
function validCat(st, except) { const n = (st.name || '').trim(); if (n.length < 2) throw new UErr('Ingresá un nombre.'); tooLong(n, LIM.name, 'El nombre'); if (Object.entries(S.categories).some(([id, c]) => id !== except && c.name.toLowerCase() === n.toLowerCase())) throw new UErr('Ya existe esa categoría.'); return n; }
ACT.catNew = () => { if (!gateUI('tools_edit')) return; openModal({ title: 'Nueva categoría', render: catForm, actions: [{ label: 'Cancelar', close: true }, { label: 'Crear', kind: 'pri', run: async (st) => { await api.createCategory({ name: validCat(st) }); await refresh(); toast('Categoría creada'); } }] }); };
ACT.catEdit = (ds) => {
  const c = S.categories[ds.c]; if (!c || !gateUI('tools_edit')) return;
  openModal({ title: 'Editar categoría', render: catForm, rec: { get: () => S.categories[ds.c], version: c.version }, reload: (cur) => ({ name: cur.name }), actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar', kind: 'pri', run: async (st, m) => { await api.updateCategory(ds.c, { name: validCat(st, ds.c) }, m.rec.version); await refresh(); toast('Categoría actualizada'); } }] });
  MOD.st = { name: c.name }; modalRerender();
};
ACT.catDel = async (ds) => {
  const c = S.categories[ds.c]; if (!c || !gateUI('tools_edit')) return;
  if (Object.values(S.tools).some((t) => t.categoryId === ds.c)) { toast('La categoría tiene herramientas.', 'err'); return; }
  if (!await confirmBox('Eliminar categoría', `Se elimina ${esc(c.name)}.`, 'Eliminar', 'danger')) return;
  await act(async () => { await api.deleteCategory(ds.c, c.version); await refresh(); }, 'Categoría eliminada');
};

function toolForm(t) {
  const d = derive(); const hasMov = t && Object.values(S.movements).some((m) => m.toolId === t.id);
  return (st) => `${field('Nombre', `<input id="f-tn" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}" placeholder="Ej.: Taladro percutor">`, 'f-tn')}${field('Descripción', `<input id="f-td" type="text" maxlength="2000" data-mi="description" value="${esc(st.description || '')}" placeholder="Marca, modelo, medida">`, 'f-td')}${field('Categoría', `<select id="f-tc" data-mi="categoryId">${optList(d.cats.map((c) => [c.id, c.name]), st.categoryId, 'Sin categoría')}</select>`, 'f-tc')}
  ${field('Seguimiento', hasMov ? `<p class="muted" data-css="margin:0">${t.serialized ? 'Por código individual' : 'Por cantidad'}. No se puede cambiar porque ya tiene movimientos.</p>` : `<div class="opts">${[['1', 'Por código individual: cada unidad tiene su código'], ['0', 'Por cantidad: se controla el total, sin código']].map(([v, l]) => `<button type="button" class="opt ${st.serialized === v ? 'on' : ''}" data-act="mset" data-k="serialized" data-v="${esc(v)}">${l}</button>`).join('')}</div>`)}
  ${t ? '' : st.serialized === '1' ? field('Códigos iniciales (uno por línea, opcional)', `<textarea id="f-tk" data-mi="codes" rows="3" placeholder="TAL-001&#10;TAL-002">${esc(st.codes || '')}</textarea>`, 'f-tk') : field('Stock inicial disponible (opcional)', `<input id="f-ts" type="number" min="0" inputmode="numeric" data-mi="stock" value="${esc(st.stock || '')}">`, 'f-ts')}`;
}
function validTool(st, except) { const n = (st.name || '').trim(); if (n.length < 2) throw new UErr('Ingresá el nombre.'); tooLong(n, LIM.name, 'El nombre'); tooLong(st.description, LIM.text, 'La descripción'); if (Object.entries(S.tools).some(([id, t]) => id !== except && t.name.toLowerCase() === n.toLowerCase())) throw new UErr('Ya existe una herramienta con ese nombre.'); return n; }
const toolSt = (t) => ({ name: t.name, description: t.description || '', categoryId: t.categoryId || '', serialized: t.serialized ? '1' : '0' });

ACT.toolNew = () => {
  if (!gateUI('tools_edit')) return;
  openModal({ title: 'Nueva herramienta', render: toolForm(null), actions: [{ label: 'Cancelar', close: true }, { label: 'Crear herramienta', kind: 'pri', run: async (st) => {
    const n = validTool(st); const ser = st.serialized === '1';
    const body = { name: n, description: (st.description || '').trim(), categoryId: st.categoryId || null, serialized: ser };
    if (ser && st.codes && st.codes.trim()) body.codes = st.codes.trim();
    if (!ser) { const q = parseInt(st.stock, 10); if (q > 0) body.stock = q; }
    await api.createTool(body); await refresh(); toast('Herramienta creada');
  } }] });
  MOD.st = { serialized: '0' }; modalRerender();
};
ACT.toolEdit = (ds) => {
  const t = S.tools[ds.t]; if (!t || !gateUI('tools_edit')) return; const hasMov = Object.values(S.movements).some((m) => m.toolId === ds.t);
  openModal({ title: 'Editar herramienta', render: toolForm({ id: ds.t, ...t }), rec: { get: () => S.tools[ds.t], version: t.version }, reload: toolSt, actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar cambios', kind: 'pri', run: async (st, m) => {
    const n = validTool(st, ds.t);
    await api.updateTool(ds.t, { name: n, description: (st.description || '').trim(), categoryId: st.categoryId || null, ...(hasMov ? {} : { serialized: st.serialized === '1' }) }, m.rec.version);
    await refresh(); toast('Cambios guardados');
  } }] });
  MOD.st = toolSt(t); modalRerender();
};
ACT.toolToggle = async (ds) => {
  const t = S.tools[ds.t]; if (!t || !gateUI('tools_edit')) return; const on = t.active === false;
  await act(async () => { await api.updateTool(ds.t, { active: on }, t.version); await refresh(); }, on ? 'Herramienta activada' : 'Herramienta desactivada');
};
