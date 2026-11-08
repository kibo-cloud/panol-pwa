// Configuración de herramientas: categorías y herramientas (como 2.1) con su orden personalizado
// (etapa 3: arrastrar en la computadora, flechas en el celular, Alt+↑/↓ con el teclado, e
// insertar en posición al crear), kits (kit base y por especialidad) y especialidades.
// Cada orden se edita en el equipo y se guarda con un solo pedido (lista completa + versión del
// alcance): si otra persona lo cambió mientras tanto, se avisa en lugar de pisarlo.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN, CH } from '../../ui/actions.js';
import { openModal, modalRerender, MOD, confirmBox } from '../../ui/modal.js';
import { toast, act, UErr, tooLong, errMsg } from '../../ui/feedback.js';
import { pageHead, emptyBox, demoChip, field, optList } from '../../ui/components.js';
import { ordControls, registerScope } from '../../ui/sortable.js';
import { gateUI } from '../tecnicos/view.js';
import { api } from '../../api/index.js';
import { S, derive, can, refresh, espName, orderVersion } from '../../state/store.js';
import { CATEGORY_SCOPE, toolScope, sameOrder } from '../../state/orden.js';
import { LIM } from '../../state/constants.js';

// Ediciones en curso: orden por alcance, avisos de conflicto y kits.
Object.assign(UI, { cfgTab: UI.cfgTab || 'tools', ord: {}, ordConflict: {}, kitEd: {}, kitConflict: {}, kitNewEsp: '' });

// ------------------------------------------------------------------ orden (categorías y herramientas)
function serverIds(scope) {
  const d = derive();
  if (scope === CATEGORY_SCOPE) return d.cats.map((c) => c.id);
  const cat = scope.slice('tools:'.length);
  return d.tools.filter((t) => (t.categoryId && S.categories[t.categoryId] ? t.categoryId : '') === cat).map((t) => t.id);
}
// Lo que se ve: el orden editado (sin los que ya no existen, con los nuevos al final) o el del servidor.
function viewIds(scope) {
  const srv = serverIds(scope); const loc = UI.ord[scope];
  if (!loc) return srv;
  const set = new Set(srv);
  return [...loc.ids.filter((id) => set.has(id)), ...srv.filter((id) => !loc.ids.includes(id))];
}
function setOrder(scope, ids) {
  if (sameOrder(ids, serverIds(scope)) && !UI.ordConflict[scope]) { delete UI.ord[scope]; return; }
  UI.ord[scope] = { ids, version: UI.ord[scope] ? UI.ord[scope].version : orderVersion(scope) };
}
registerScope('categories', { ids: viewIds, set: setOrder });
registerScope('tools:', { ids: viewIds, set: setOrder });

function ordBar(scope) {
  if (UI.ordConflict[scope]) return `<div class="banner warn ordbar" role="alert"><div><b>Otra persona cambió el orden mientras lo editabas.</b><div class="sm">Recargá para ver el orden actual y volvé a ordenar.</div></div><div class="acts"><button class="btn sm" data-act="ordDiscard" data-scope="${esc(scope)}">Recargar</button></div></div>`;
  if (!UI.ord[scope]) return '';
  return `<div class="ordbar selbar" role="status"><span class="grow"><b>Orden sin guardar.</b></span><button class="btn sm" data-act="ordDiscard" data-scope="${esc(scope)}">Descartar</button><button class="btn sm pri" data-act="ordSave" data-scope="${esc(scope)}">Guardar orden</button></div>`;
}

// items: [{ id, label, body }] ya en orden. Sin permiso, una lista común.
function ordList(scope, items, editable) {
  if (!editable) return `<div class="list">${items.map((x) => `<div class="row">${x.body}</div>`).join('')}</div>`;
  return `<ol class="ordlist list" data-scope="${esc(scope)}" aria-label="Lista ordenable: usá Alt + flecha arriba o abajo, o los botones">${items.map((x, i) => `<li class="orditem row" data-id="${esc(x.id)}" tabindex="0">${ordControls(x.label, i, items.length)}${x.body}</li>`).join('')}</ol>${ordBar(scope)}`;
}

ACT.ordDiscard = (ds) => { delete UI.ord[ds.scope]; delete UI.ordConflict[ds.scope]; render(); };
ACT.ordSave = async (ds) => {
  const scope = ds.scope; const loc = UI.ord[scope]; if (!loc || !gateUI('tools_edit')) return;
  const ids = viewIds(scope);
  document.body.classList.add('busy');
  try {
    if (scope === CATEGORY_SCOPE) await api.reorderCategories(ids, loc.version);
    else await api.reorderTools(scope.slice('tools:'.length) || null, ids, loc.version);
    delete UI.ord[scope]; await refresh(); toast('Orden guardado');
  } catch (e) {
    console.warn(e);
    if (e && e.kind === 'conflict') UI.ordConflict[scope] = true;
    toast(errMsg(e), 'err'); render();
  } finally { document.body.classList.remove('busy'); }
};

// ------------------------------------------------------------------ pestaña Herramientas
function toolsTab(d, ce) {
  const catItems = viewIds(CATEGORY_SCOPE).map((id) => {
    const c = S.categories[id]; const n = d.tools.filter((t) => t.categoryId === id).length;
    return { id, label: c.name, body: `<div class="grow"><div class="t">${esc(c.name)} ${demoChip(c)}</div><div class="s">${n} ${n === 1 ? 'herramienta' : 'herramientas'}</div></div>${ce ? `<span class="r"><button class="btn sm" data-act="catEdit" data-c="${esc(id)}">Editar</button>${n ? '' : `<button class="btn sm danger" data-act="catDel" data-c="${esc(id)}">Eliminar</button>`}</span>` : ''}` };
  });
  const toolBody = (t) => { const p = d.pools[t.id]; return `<a class="grow" href="#herramienta-${esc(t.id)}"><div class="t ell">${esc(t.name)} ${t.active === false ? '<span class="chip">Inactiva</span>' : ''} ${demoChip(t)}</div><div class="s ell">${t.serialized ? 'por código' : 'por cantidad'}, ${p.asignado} asignadas, ${p.disponible} disponibles</div></a>${ce ? `<span class="r"><button class="btn sm" data-act="toolEdit" data-t="${esc(t.id)}">Editar</button><button class="btn sm" data-act="toolToggle" data-t="${esc(t.id)}">${t.active === false ? 'Activar' : 'Desactivar'}</button></span>` : ''}`; };
  const groups = [...viewIds(CATEGORY_SCOPE).map((id) => ({ id, name: S.categories[id].name })), { id: '', name: 'Sin categoría' }]
    .map((g) => ({ ...g, scope: toolScope(g.id), ids: viewIds(toolScope(g.id)) })).filter((g) => g.ids.length);
  return `${ce ? `<p class="hint">${icon('info', 16)}<span>Este orden se usa en el control, la ficha, el inventario, los reportes y el Excel. Arrastrá desde la manija, usá las flechas o Alt + ↑/↓, y después tocá Guardar orden.</span></p>` : ''}
  <h2 class="sec" data-css="margin-top:6px">Categorías</h2>${d.cats.length ? ordList(CATEGORY_SCOPE, catItems, ce) : `<div class="list">${emptyBox('Sin categorías', 'Agrupá las herramientas por tipo: eléctricas, medición, manuales.', ce ? '<button class="btn" data-act="catNew">Nueva categoría</button>' : '')}</div>`}
  <h2 class="sec">Herramientas</h2>${d.tools.length ? groups.map((g) => `<section class="grp tgroup" data-cat="${esc(g.id)}"><h2>${esc(g.name)}</h2>${ordList(g.scope, g.ids.map((id) => ({ id, label: S.tools[id].name, body: toolBody({ id, ...S.tools[id] }) })), ce)}</section>`).join('') : `<div class="list">${emptyBox('Sin herramientas', 'Creá la primera herramienta para empezar a asignarla.', ce ? '<button class="btn pri" data-act="toolNew">Nueva herramienta</button>' : '')}</div>`}`;
}

// ------------------------------------------------------------------ pestaña Kits
const kitOf = (id) => S.kits[id];
const kitItems = (id) => (UI.kitEd[id] ? UI.kitEd[id].items : (kitOf(id) || {}).items || []);
function editKit(id, items) {
  const k = kitOf(id); if (!k) return;
  const prev = UI.kitEd[id];
  UI.kitEd[id] = { items, version: prev ? prev.version : k.version, add: prev ? prev.add : {} };
}
registerScope('kit:', {
  ids: (scope) => kitItems(scope.slice(4)).map((it) => it.toolId),
  set: (scope, ids) => { const id = scope.slice(4); const by = Object.fromEntries(kitItems(id).map((it) => [it.toolId, it])); editKit(id, ids.map((t) => by[t])); },
});
const kitDirty = (id) => !!UI.kitEd[id] && JSON.stringify(UI.kitEd[id].items) !== JSON.stringify((kitOf(id) || {}).items || []);
const toolLabel = (id) => (S.tools[id] || {}).name || 'Herramienta eliminada';

function kitCard(k, ke) {
  const items = kitItems(k.id); const total = items.reduce((a, it) => a + it.qty, 0);
  const head = `<div class="srow"><div><h2 class="si">${esc(k.name)}</h2><div class="muted sm">${k.especialidadId ? 'Especialidad ' + esc(espName(k.especialidadId)) : 'Para todos los técnicos'} · ${items.length} ${items.length === 1 ? 'herramienta' : 'herramientas'}, ${total} en total</div></div>${ke && k.especialidadId ? `<button class="btn sm danger" data-act="kitDelete" data-k="${esc(k.id)}">Eliminar kit</button>` : ''}</div>`;
  if (!ke) return `<section class="card kitcard" data-kit="${esc(k.id)}">${head}${items.length ? `<div class="list">${items.map((it) => `<div class="row"><div class="grow t">${esc(toolLabel(it.toolId))}</div><span class="chip">×${it.qty}</span></div>`).join('')}</div>` : '<p class="muted sm">Todavía no tiene herramientas.</p>'}</section>`;
  const add = (UI.kitEd[k.id] || {}).add || {};
  const scope = 'kit:' + k.id;
  const list = items.length ? `<ol class="ordlist list" data-scope="${esc(scope)}" aria-label="Herramientas del kit: usá Alt + flecha arriba o abajo, o los botones">${items.map((it, i) => { const nm = toolLabel(it.toolId); return `<li class="orditem row" data-id="${esc(it.toolId)}" tabindex="0">${ordControls(nm, i, items.length)}<div class="grow t ell">${esc(nm)}</div><input class="kitqty" type="number" min="1" max="10000" inputmode="numeric" value="${esc(it.qty)}" data-in="kitQty" data-k="${esc(k.id)}" data-t="${esc(it.toolId)}" aria-label="Cantidad de ${esc(nm)}"><button type="button" class="icon-btn" data-act="kitRemove" data-k="${esc(k.id)}" data-t="${esc(it.toolId)}" aria-label="Quitar ${esc(nm)}">${icon('x', 18)}</button></li>`; }).join('')}</ol>` : '<p class="muted sm">Todavía no tiene herramientas. Agregalas abajo.</p>';
  const inKit = new Set(items.map((it) => it.toolId));
  const opts = derive().tools.filter((t) => t.active !== false && !inKit.has(t.id)).map((t) => [t.id, `${t.name}${t.serialized ? ' (por código)' : ''}`]);
  const addRow = `<div class="kitadd"><select id="ka-${esc(k.id)}" data-ch="kitAddTool" data-k="${esc(k.id)}" aria-label="Herramienta a agregar">${optList(opts, add.toolId || '', 'Agregar herramienta…')}</select><input type="number" min="1" max="10000" inputmode="numeric" value="${esc(add.qty || 1)}" data-in="kitAddQty" data-k="${esc(k.id)}" aria-label="Cantidad a agregar"><button class="btn" data-act="kitAdd" data-k="${esc(k.id)}">${icon('plus', 16)}Agregar</button></div>`;
  const bar = UI.kitConflict[k.id] ? `<div class="banner warn ordbar" role="alert"><div><b>Alguien modificó este kit mientras lo editabas.</b><div class="sm">Recargá para ver la lista actual.</div></div><div class="acts"><button class="btn sm" data-act="kitDiscard" data-k="${esc(k.id)}">Recargar</button></div></div>`
    : kitDirty(k.id) ? `<div class="ordbar selbar" role="status"><span class="grow"><b>Cambios sin guardar.</b></span><button class="btn sm" data-act="kitDiscard" data-k="${esc(k.id)}">Descartar</button><button class="btn sm pri" data-act="kitSave" data-k="${esc(k.id)}">Guardar kit</button></div>` : '';
  return `<section class="card kitcard" data-kit="${esc(k.id)}">${head}${list}${addRow}${bar}</section>`;
}

function kitsTab(d) {
  const ke = can('kits_edit');
  const free = d.especialidades.filter((e) => !e.archivedAt && !d.kits.some((k) => k.especialidadId === e.id));
  return `<p class="hint">${icon('info', 16)}<span>El kit base es la lista de herramientas que recibe cada técnico nuevo. Cada especialidad puede tener además su propio kit. Se entregan completos desde la ficha del técnico o de la caja, con Entregar kit.</span></p>
  ${ke && free.length ? `<div class="toolbar"><select id="kit-esp" data-ch="kitNewEsp" aria-label="Especialidad del kit nuevo">${optList(free.map((e) => [e.id, e.name]), UI.kitNewEsp || '', 'Kit para la especialidad…')}</select><button class="btn" data-act="kitNew">${icon('plus', 16)}Crear kit</button></div>` : ''}
  <div class="g1">${d.kits.map((k) => kitCard(k, ke)).join('')}</div>`;
}

// Escribir una cantidad no debe perder el foco del campo al volver a dibujar.
function renderKeepFocus(el) {
  const sel = `[data-in="${el.dataset.in}"][data-k="${CSS.escape(el.dataset.k)}"]${el.dataset.t ? `[data-t="${CSS.escape(el.dataset.t)}"]` : ''}`;
  render();
  const n = document.querySelector(sel); if (n) n.focus();
}
IN.kitQty = (v, el) => { const id = el.dataset.k; const q = parseInt(v, 10); if (!(q >= 1)) return; editKit(id, kitItems(id).map((it) => (it.toolId === el.dataset.t ? { ...it, qty: Math.min(q, 10000) } : it))); renderKeepFocus(el); };
CH.kitAddTool = (v, el) => { const id = el.dataset.k; editKit(id, kitItems(id)); UI.kitEd[id].add = { ...UI.kitEd[id].add, toolId: v }; };
IN.kitAddQty = (v, el) => { const id = el.dataset.k; editKit(id, kitItems(id)); UI.kitEd[id].add = { ...UI.kitEd[id].add, qty: v }; };
CH.kitNewEsp = (v) => { UI.kitNewEsp = v; };
ACT.kitAdd = (ds) => {
  const id = ds.k; const add = (UI.kitEd[id] || {}).add || {};
  if (!add.toolId || !S.tools[add.toolId]) { toast('Elegí una herramienta.', 'err'); return; }
  const q = parseInt(add.qty || 1, 10); if (!(q >= 1 && q <= 10000)) { toast('Indicá una cantidad válida.', 'err'); return; }
  editKit(id, [...kitItems(id), { toolId: add.toolId, qty: q }]); UI.kitEd[id].add = {}; render();
};
ACT.kitRemove = (ds) => { editKit(ds.k, kitItems(ds.k).filter((it) => it.toolId !== ds.t)); render(); };
ACT.kitDiscard = (ds) => { delete UI.kitEd[ds.k]; delete UI.kitConflict[ds.k]; render(); };
ACT.kitSave = async (ds) => {
  const ed = UI.kitEd[ds.k]; if (!ed || !gateUI('kits_edit')) return;
  document.body.classList.add('busy');
  try { await api.saveKit(ds.k, { items: ed.items }, ed.version); delete UI.kitEd[ds.k]; await refresh(); toast('Kit guardado'); }
  catch (e) { console.warn(e); if (e && e.kind === 'conflict') UI.kitConflict[ds.k] = true; toast(errMsg(e), 'err'); render(); }
  finally { document.body.classList.remove('busy'); }
};
ACT.kitNew = async () => {
  if (!gateUI('kits_edit')) return;
  const esp = UI.kitNewEsp; if (!esp) { toast('Elegí la especialidad del kit.', 'err'); return; }
  await act(async () => { await api.createKit({ especialidadId: esp }); UI.kitNewEsp = ''; await refresh(); }, 'Kit creado');
};
ACT.kitDelete = async (ds) => {
  const k = kitOf(ds.k); if (!k || !gateUI('kits_edit')) return;
  if (!await confirmBox('Eliminar kit', `Se elimina ${esc(k.name)}. Las entregas ya registradas no cambian.`, 'Eliminar', 'danger')) return;
  await act(async () => { await api.deleteKit(ds.k, k.version); delete UI.kitEd[ds.k]; await refresh(); }, 'Kit eliminado');
};

// ------------------------------------------------------------------ pestaña Especialidades
function espTab(d) {
  const te = can('techs_edit'); const live = d.especialidades.filter((e) => !e.archivedAt); const arch = d.especialidades.filter((e) => e.archivedAt);
  const n = (id) => d.activeTechs.filter((t) => t.especialidadId === id).length;
  return `<p class="hint">${icon('info', 16)}<span>La especialidad de cada técnico se elige al editarlo. Sirve para filtrar y aparece en los reportes.</span></p>
  ${te ? `<div class="toolbar"><button class="btn pri" data-act="espNew">${icon('plus', 16)}Nueva especialidad</button></div>` : ''}
  <div class="list">${live.map((e) => `<div class="row"><div class="grow"><div class="t">${esc(e.name)}</div><div class="s">${n(e.id)} ${n(e.id) === 1 ? 'técnico activo' : 'técnicos activos'}${d.kits.some((k) => k.especialidadId === e.id) ? ', con kit propio' : ''}</div></div>${te ? `<span class="r"><button class="btn sm" data-act="espEdit" data-e="${esc(e.id)}">Editar</button><button class="btn sm danger" data-act="espArchive" data-e="${esc(e.id)}">Archivar</button></span>` : ''}</div>`).join('') || emptyBox('Sin especialidades', '')}</div>
  ${arch.length ? `<p class="muted sm" data-css="margin-top:10px">Archivadas: ${arch.map((e) => esc(e.name)).join(', ')}.</p>` : ''}`;
}
const espForm = (st) => field('Nombre de la especialidad', `<input id="f-en" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}">`, 'f-en');
function validEsp(st, except) { const n = (st.name || '').trim(); if (n.length < 2) throw new UErr('Ingresá un nombre.'); tooLong(n, LIM.name, 'El nombre'); if (Object.entries(S.especialidades).some(([id, e]) => id !== except && !e.archivedAt && e.name.toLowerCase() === n.toLowerCase())) throw new UErr('Ya existe una especialidad con ese nombre.'); return n; }
ACT.espNew = () => { if (!gateUI('techs_edit')) return; openModal({ title: 'Nueva especialidad', render: espForm, actions: [{ label: 'Cancelar', close: true }, { label: 'Crear', kind: 'pri', run: async (st) => { await api.createEspecialidad({ name: validEsp(st) }); await refresh(); toast('Especialidad creada'); } }] }); };
ACT.espEdit = (ds) => {
  const e = S.especialidades[ds.e]; if (!e || !gateUI('techs_edit')) return;
  openModal({ title: 'Editar especialidad', render: espForm, rec: { get: () => S.especialidades[ds.e], version: e.version }, reload: (cur) => ({ name: cur.name }), actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar', kind: 'pri', run: async (st, m) => { await api.updateEspecialidad(ds.e, { name: validEsp(st, ds.e) }, m.rec.version); await refresh(); toast('Especialidad actualizada'); } }] });
  MOD.st = { name: e.name }; modalRerender();
};
ACT.espArchive = async (ds) => {
  const e = S.especialidades[ds.e]; if (!e || !gateUI('techs_edit')) return;
  if (!await confirmBox('Archivar especialidad', `${esc(e.name)} deja de ofrecerse para los técnicos. Solo se puede si ningún técnico activo la tiene y no tiene kit.`, 'Archivar', 'danger')) return;
  await act(async () => { await api.archiveEspecialidad(ds.e, e.version); await refresh(); }, 'Especialidad archivada');
};

// ------------------------------------------------------------------ vista
VIEWS.config = () => {
  const d = derive(); const ce = can('tools_edit'); const tab = UI.cfgTab;
  const acts = tab === 'tools' && ce ? `<button class="btn" data-act="catNew">Nueva categoría</button><button class="btn pri" data-act="toolNew">${icon('plus', 18)}Nueva herramienta</button>` : '';
  const ro = (tab === 'tools' && !ce) || (tab === 'kits' && !can('kits_edit')) || (tab === 'esp' && !can('techs_edit'));
  const body = tab === 'kits' ? kitsTab(d) : tab === 'esp' ? espTab(d) : toolsTab(d, ce);
  return pageHead('Configuración de herramientas', 'Categorías, herramientas y su orden, kits y especialidades', { acts }) +
  `<div class="tabs" role="tablist">${[['tools', 'Herramientas'], ['kits', 'Kits'], ['esp', 'Especialidades']].map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}" data-act="cfgTab" data-v="${esc(k)}">${l}</button>`).join('')}</div>
  ${ro ? '<p class="hint">Tu perfil puede consultar esta sección pero no modificarla.</p>' : ''}${body}`;
};
ACT.cfgTab = (ds) => { UI.cfgTab = ds.v; if (location.hash !== '#config') location.hash = '#config'; else render(); };

// ------------------------------------------------------------------ categorías
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

// ------------------------------------------------------------------ herramientas
// "Insertar en posición": antes de cada herramienta de la categoría elegida, o al final.
function positionOptions(categoryId, sel) {
  const ids = serverIds(toolScope(categoryId && S.categories[categoryId] ? categoryId : ''));
  return optList([['', 'Al final'], ...ids.map((id, i) => [String(i + 1), `${i + 1}. Antes de ${S.tools[id].name}`])], sel || '');
}
function toolForm(t) {
  const d = derive(); const hasMov = t && Object.values(S.movements).some((m) => m.toolId === t.id);
  return (st) => `${field('Nombre', `<input id="f-tn" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}" placeholder="Ej.: Taladro percutor">`, 'f-tn')}${field('Descripción', `<input id="f-td" type="text" maxlength="2000" data-mi="description" value="${esc(st.description || '')}" placeholder="Marca, modelo, medida">`, 'f-td')}${field('Categoría', `<select id="f-tc" data-mi="categoryId" ${t ? '' : 'data-mr'}>${optList(d.cats.map((c) => [c.id, c.name]), st.categoryId, 'Sin categoría')}</select>`, 'f-tc')}
  ${t ? '' : field('Insertar en posición', `<select id="f-tp" data-mi="position">${positionOptions(st.categoryId, st.position)}</select>`, 'f-tp')}
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
    const pos = parseInt(st.position, 10); if (pos >= 1) body.position = pos;
    if (ser && st.codes && st.codes.trim()) body.codes = st.codes.trim();
    if (!ser) { const q = parseInt(st.stock, 10); if (q > 0) body.stock = q; }
    await api.createTool(body); await refresh(); toast('Herramienta creada');
  } }] });
  MOD.st = { serialized: '0', categoryId: '' }; modalRerender();
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
