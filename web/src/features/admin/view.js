// Administración: usuarios y permisos (solo admin, en el servidor), configuración (lista de
// turnos de las plantillas), datos e integridad, y auditoría paginada.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN } from '../../ui/actions.js';
import { openModal, modalRerender, MOD, confirmBox } from '../../ui/modal.js';
import { toast, act, UErr, tooLong, errMsg } from '../../ui/feedback.js';
import { pageHead, emptyBox, avatar, field } from '../../ui/components.js';
import { hooks } from '../../ui/app.js';
import { gateUI } from '../tecnicos/view.js';
import { api } from '../../api/index.js';
import { S, ME, derive, can, who, myRole, refresh, toolName } from '../../state/store.js';
import { ROLES, ROLE_KEYS, PERMS, PERMS_HIDDEN, POOL, LIM } from '../../state/constants.js';
import { validateShiftLabels } from '../../state/plantillas.js';
import { fdate, fdt } from '../../state/period.js';
import { parseRoute } from '../../ui/router.js';
import { deleteBtn, deletedTab } from '../records/view.js';

// Datos que solo ve un administrador: se piden al abrir la pestaña.
const AD = { users: null, perms: null, pending: {}, audit: null, labels: null, loading: {} };
const isAdm = () => myRole() === 'admin';

async function load(what, force) {
  if (AD.loading[what] || (!force && AD[what])) return;
  AD.loading[what] = true;
  try {
    if (what === 'users') AD.users = (await api.users()).users;
    if (what === 'perms') AD.perms = await api.permissions();
    if (what === 'audit') AD.audit = await api.audit();
    if (what === 'labels') { const r = await api.shiftLabels(); AD.labels = r; if (!UI.cfgLabels || !UI.cfgLabels.dirty) UI.cfgLabels = { list: r.labels.slice(), version: r.version, dirty: false }; }
  } catch (e) { toast(errMsg(e), 'err'); } finally { AD.loading[what] = false; render(); }
}
// Si otro administrador cambia algo mientras la pestaña está abierta, se vuelve a pedir.
hooks.afterState.push(() => {
  if (parseRoute(location.hash).name !== 'admin' || !isAdm()) return;
  if (UI.adminTab === 'users') { load('users', true); load('perms', true); }
  if (UI.adminTab === 'config') load('labels', true);
});
const loading = '<div class="loading"><div class="spin"></div>Cargando…</div>';

function usersTab() {
  const mine = `<div class="card" data-css="margin-bottom:12px"><h2 class="si">Tu acceso</h2><p data-css="margin:8px 0 0">${esc(who(ME.id))} (${esc(ME.username)}): <b>${ROLES[myRole()] || ''}</b></p><p class="muted sm" data-css="margin:6px 0 0">Los usuarios, perfiles y contraseñas se administran en el servidor. Si alguien olvida su contraseña, un administrador la restablece y se cambia en el siguiente ingreso.</p></div>`;
  if (!isAdm()) return mine + '<p class="hint">Solo un administrador puede ver y administrar los usuarios y los permisos.</p>';
  load('users'); load('perms');
  const users = (AD.users || []).slice().sort((a, b) => (a.active === false) - (b.active === false) || (a.name || '').localeCompare(b.name || '', 'es'));
  const list = !AD.users ? loading : `<div class="list">${users.map((u) => `<div class="row" data-css="flex-wrap:wrap">${avatar(u.name)}<div class="grow"><div class="t">${esc(u.name)}${u.id === ME.id ? ' (vos)' : ''}</div><div class="s">${esc(u.username)} · ${ROLES[u.role] || ''}${u.active === false ? ' · inactivo' : ''}${u.mustChangePassword ? ' · debe cambiar la contraseña' : ''} · alta ${fdate(u.createdAt)}</div></div><div class="r"><button class="btn sm" data-act="userEdit" data-u="${esc(u.id)}">Editar</button><button class="btn sm" data-act="userReset" data-u="${esc(u.id)}">Restablecer contraseña</button>${u.id === ME.id ? '' : `<button class="btn sm ${u.active === false ? '' : 'danger'}" data-act="userToggle" data-u="${esc(u.id)}">${u.active === false ? 'Reactivar' : 'Desactivar'}</button>${deleteBtn('users', u.id, { sm: true })}`}</div></div>`).join('')}</div>`;
  return mine + `<div class="srow" data-css="margin-top:22px"><h2 class="si">Usuarios</h2><button class="btn sm pri" data-act="userNew">${icon('plus', 16)}Nuevo usuario</button></div>${list}
  <h2 class="sec">Permisos por perfil</h2><p class="muted sm" data-css="margin-top:-4px">El perfil Administrador tiene acceso total.</p>${permMatrix()}`;
}

function permValue(r, k) { if (r === 'admin') return true; const p = AD.pending[r] && k in AD.pending[r] ? AD.pending[r][k] : null; if (p !== null) return p; return !!(AD.perms.effective[r] || {})[k]; }
const pendingCount = () => Object.values(AD.pending).reduce((a, o) => a + Object.keys(o).length, 0);
function permMatrix() {
  if (!AD.perms) return loading;
  const n = pendingCount();
  return `<div class="twrap"><table class="tbl matrix"><thead><tr><th>Permiso</th>${ROLE_KEYS.map((r) => `<th>${ROLES[r]}</th>`).join('')}</tr></thead><tbody>${PERMS.filter(([k]) => !PERMS_HIDDEN.includes(k)).map(([k, l]) => `<tr><td>${l}</td>${ROLE_KEYS.map((r) => { const v = permValue(r, k); return `<td><button class="sw ${v ? 'on' : ''}" ${r === 'admin' ? 'disabled' : ''} data-act="permToggle" data-r="${esc(r)}" data-k="${esc(k)}" role="switch" aria-checked="${v}" aria-label="${l} para ${ROLES[r]}"></button></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
  <div class="toolbar" data-css="margin-top:12px"><span class="s">${n ? `${n} ${n === 1 ? 'cambio sin guardar' : 'cambios sin guardar'}` : 'Sin cambios sin guardar'}</span><button class="btn sm" data-act="permDiscard" ${n ? '' : 'disabled'}>Descartar</button><button class="btn sm pri" data-act="permSave" ${n ? '' : 'disabled'}>Guardar cambios</button></div>`;
}

// Configuración: lista de turnos (rótulos informativos) para cambiar el turno de las plantillas.
function configTab() {
  const ed = can('plantillas_edit');
  load('labels');
  const L = UI.cfgLabels;
  if (!L) return loading;
  const n = L.list.length;
  return `<div class="card"><h2 class="si">Turnos de las plantillas</h2><p class="muted sm" data-css="margin:6px 0 12px">El turno actual de cada plantilla es un dato informativo. Al cambiarlo se elige de esta lista y queda en el historial. Las plantillas se administran en Plantillas.</p>
  ${ed ? `<div class="labels">${L.list.map((l, i) => `<div class="lblrow"><input id="lbl-${i}" type="text" maxlength="120" data-in="cfgLabel" data-i="${i}" value="${esc(l)}" aria-label="Turno ${i + 1}"><button class="icon-btn" data-act="cfgLabelDel" data-i="${i}" aria-label="Quitar ${esc(l || 'turno')}" ${n <= 1 ? 'disabled' : ''}>${icon('x', 18)}</button></div>`).join('')}</div>
  <div class="toolbar" data-css="margin-top:12px"><button class="btn sm" data-act="cfgLabelAdd" ${n >= 20 ? 'disabled' : ''}>${icon('plus', 16)}Agregar turno</button><span class="s grow">${L.dirty ? 'Cambios sin guardar' : 'Sin cambios sin guardar'}</span><button class="btn sm" data-act="cfgLabelReset" ${L.dirty ? '' : 'disabled'}>Descartar</button><button class="btn sm pri" data-act="cfgLabelSave" ${L.dirty ? '' : 'disabled'}>Guardar cambios</button></div>` : `<div class="list">${L.list.map((l) => `<div class="row"><div class="grow"><div class="t">${esc(l)}</div></div></div>`).join('')}</div><p class="muted sm">Tu perfil puede ver la lista pero no modificarla.</p>`}</div>`;
}

export function integrity() {
  const d = derive(); const out = []; const codes = {};
  for (const t of d.tools) {
    const p = d.pools[t.id]; const asg = d.activeAsg.filter((a) => a.toolId === t.id).reduce((s, a) => s + (a.qty || 1), 0);
    if (p.asignado !== asg) out.push({ sev: 'bad', t: `${t.name}: asignaciones no coinciden`, s: `Inventario indica ${p.asignado} asignadas y las fichas de técnicos suman ${asg}.` });
    for (const k of ['disponible', 'asignado', 'reparacion', 'retirado', 'pendiente', 'baja']) if (p[k] < 0) out.push({ sev: 'bad', t: `${t.name}: saldo negativo`, s: `${POOL[k]}: ${p[k]}` });
    if (t.serialized) { for (const k of ['disponible', 'asignado', 'reparacion', 'retirado', 'pendiente', 'baja']) { const n = (d.unitsByTool[t.id] || []).filter((u) => u.status === k).length; if (n !== p[k]) out.push({ sev: 'warn', t: `${t.name}: unidades y movimientos difieren`, s: `${POOL[k]}: ${n} unidades contra ${p[k]} según movimientos.` }); } }
  }
  for (const u of d.units) { const c = (u.code || '').toLowerCase(); if (codes[c]) out.push({ sev: 'bad', t: 'Código duplicado', s: u.code }); codes[c] = 1; }
  for (const a of d.activeAsg) { if (a.cajaId) { const k = S.cajas[a.cajaId]; if (!k) out.push({ sev: 'bad', t: 'Asignación sin caja', s: toolName(a.toolId) }); else if (k.archivedAt) out.push({ sev: 'warn', t: `${k.name} está archivada y tiene herramientas`, s: toolName(a.toolId) }); continue; } const t = S.techs[a.techId]; if (!t) out.push({ sev: 'bad', t: 'Asignación sin técnico', s: toolName(a.toolId) }); else if (t.active === false) out.push({ sev: 'warn', t: `${t.name} está inactivo y tiene herramientas`, s: `${toolName(a.toolId)}: registrá la devolución o el retiro.` }); }
  return out;
}
function dataTab() {
  const d = derive(); const issues = integrity();
  return `<div class="card" data-css="margin-bottom:12px"><h2 class="si">Datos de demostración</h2><p class="muted sm">${d.hasDemo ? 'Hay datos de demostración cargados y marcados como Demo.' : 'No hay datos de demostración cargados.'} Sirven para probar el sistema y se pueden borrar sin tocar los datos reales.</p><div class="toolbar">${can('demo_manage') ? (d.hasDemo ? '<button class="btn danger" data-act="clearDemo">Borrar datos de demostración</button>' : '<button class="btn" data-act="loadDemo">Cargar datos de demostración</button>') : ''}</div></div>
  <div class="card" data-css="margin-bottom:12px"><h2 class="si">Copia de seguridad (.txt)</h2><p class="muted sm">El servidor hace la copia principal todos los días. Acá podés descargar una copia manual o importar el archivo de Pañol 2.x.</p><button class="btn" data-act="backup">${icon('db', 16)}Importar o descargar .txt</button></div>
  <div class="card"><h2 class="si">Verificación de integridad</h2><p class="muted sm">Compara asignaciones, unidades e inventario.</p>${issues.length ? `<div class="list">${issues.map((x) => `<div class="row"><span class="light ${x.sev}"></span><div class="grow"><div class="t">${esc(x.t)}</div><div class="s">${esc(x.s)}</div></div></div>`).join('')}</div>` : '<p data-css="margin:0"><span class="chip ok">Sin inconsistencias</span></p>'}</div>`;
}

function auditTab() {
  if (!isAdm()) return '<p class="hint">Solo un administrador puede ver la auditoría.</p>';
  load('audit');
  if (!AD.audit) return loading;
  const list = AD.audit.items;
  return (list.length ? `<div class="list">${list.map((a) => `<div class="row"><div class="grow"><div class="t">${esc(a.detail || a.action)}</div><div class="s">${fdt(a.at)}, ${esc(who(a.by))}${a.ip ? ' · ' + esc(a.ip) : ''}</div></div></div>`).join('')}</div>` : `<div class="list">${emptyBox('Sin registros de auditoría', '')}</div>`) +
    `<div class="toolbar" data-css="margin-top:12px"><button class="btn sm" data-act="auditReload">Actualizar</button>${AD.audit.next ? '<button class="btn sm" data-act="auditMore">Ver más</button>' : ''}</div>`;
}

VIEWS.admin = () => {
  const tab = UI.adminTab;
  const tabs = [['users', 'Usuarios y permisos'], ['config', 'Configuración'], ['data', 'Datos e integridad'], ...(can('records_delete') ? [['deleted', 'Registros eliminados']] : []), ['audit', 'Auditoría']];
  const body = tab === 'users' ? usersTab() : tab === 'deleted' ? deletedTab() : tab === 'config' || tab === 'shifts' ? configTab() : tab === 'data' ? dataTab() : auditTab();
  return pageHead('Administración', 'Usuarios, permisos, configuración y registros del sistema') + `<div class="tabs">${tabs.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-act="adminTab" data-v="${esc(k)}">${l}</button>`).join('')}</div>${body}`;
};
ACT.adminTab = (ds) => { UI.adminTab = ds.v; if (location.hash !== '#admin') location.hash = '#admin'; else render(); };

// ------------------------------------------------------------------ usuarios
const roleOpts = (st) => `<div class="opts">${ROLE_KEYS.map((r) => `<button type="button" class="opt ${st.role === r ? 'on' : ''}" data-act="mset" data-k="role" data-v="${esc(r)}">${ROLES[r]}</button>`).join('')}</div>`;
function showTempPassword(u, pw, created) {
  openModal({ title: created ? 'Usuario creado' : 'Contraseña restablecida', render: () => `<p data-css="margin-top:0">${esc(u.name)} entra con el usuario <b>${esc(u.username)}</b> y esta contraseña temporal. La va a tener que cambiar en el primer ingreso.</p><div class="hint ok">${icon('info', 16)}<span>Contraseña temporal: <b class="num" id="tmppw">${esc(pw)}</b></span></div><p class="muted sm">Anotala ahora: no se vuelve a mostrar.</p>`, actions: [{ label: 'Listo', kind: 'pri', run: () => true }] });
}
const findUser = (id) => (AD.users || []).find((u) => u.id === id) || null;
ACT.userNew = () => {
  if (!isAdm()) return;
  openModal({ title: 'Nuevo usuario', render: (st) => `${field('Usuario (para ingresar)', `<input id="u-user" type="text" maxlength="60" autocomplete="off" autocapitalize="none" data-mi="username" value="${esc(st.username || '')}" placeholder="Ej.: lgomez">`, 'u-user')}${field('Nombre y apellido', `<input id="u-name" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}">`, 'u-name')}${field('Perfil', roleOpts(st))}<p class="muted sm">Se genera una contraseña temporal que se muestra una sola vez.</p>`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Crear usuario', kind: 'pri', run: async (st) => {
      const username = (st.username || '').trim().toLowerCase(); const name = (st.name || '').trim();
      if (!/^[a-z0-9._-]{3,60}$/.test(username)) throw new UErr('El usuario tiene que tener entre 3 y 60 letras, números, punto, guion o guion bajo.');
      if (name.length < 3) throw new UErr('Ingresá nombre y apellido.'); tooLong(name, LIM.name, 'El nombre');
      const r = await api.createUser({ username, name, role: st.role || 'responsable' });
      await load('users', true); await refresh().catch(() => {});
      setTimeout(() => showTempPassword(r.user, r.temporaryPassword, true), 0);
    } }] });
  MOD.st.role = 'responsable'; modalRerender();
};
ACT.userEdit = (ds) => {
  const u = findUser(ds.u); if (!u || !isAdm()) return;
  openModal({ title: `Editar ${u.name}`, rec: { get: () => findUser(ds.u), version: u.version }, reload: (cur) => ({ name: cur.name, role: cur.role }),
    render: (st) => `${field('Nombre y apellido', `<input id="u-name" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}">`, 'u-name')}${u.id === ME.id ? '<p class="muted sm">No podés cambiar tu propio perfil.</p>' : field('Perfil', roleOpts(st))}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar cambios', kind: 'pri', run: async (st, m) => {
      const name = (st.name || '').trim(); if (name.length < 3) throw new UErr('Ingresá nombre y apellido.'); tooLong(name, LIM.name, 'El nombre');
      const body = { name }; if (u.id !== ME.id && st.role !== u.role) body.role = st.role;
      await api.updateUser(ds.u, body, m.rec.version); await load('users', true); await refresh().catch(() => {}); toast('Usuario actualizado');
    } }] });
  MOD.st = { name: u.name, role: u.role }; modalRerender();
};
ACT.userToggle = async (ds) => {
  const u = findUser(ds.u); if (!u || !isAdm()) return; if (ds.u === ME.id) { toast('No podés desactivar tu propio usuario.', 'err'); return; }
  const on = u.active === false;
  if (!on && !await confirmBox('Desactivar usuario', `${esc(u.name)} no va a poder ingresar y se cierran sus sesiones. Su historial se conserva.`, 'Desactivar', 'danger')) return;
  await act(async () => { await api.setUserActive(ds.u, on, u.version); await load('users', true); }, on ? 'Usuario reactivado' : 'Usuario desactivado');
};
ACT.userReset = async (ds) => {
  const u = findUser(ds.u); if (!u || !isAdm()) return;
  if (!await confirmBox('Restablecer contraseña', `Se genera una contraseña temporal para ${esc(u.name)}. Sus sesiones abiertas se cierran y tiene que cambiarla al ingresar.`, 'Restablecer', 'dark')) return;
  const r = await act(() => api.resetPassword(ds.u, u.version));
  if (r) { await load('users', true); showTempPassword(r.user, r.temporaryPassword, false); }
};

// ------------------------------------------------------------------ permisos
ACT.permToggle = (ds) => {
  if (!isAdm() || !AD.perms || ds.r === 'admin') return;
  const cur = permValue(ds.r, ds.k); const base = !!(AD.perms.effective[ds.r] || {})[ds.k];
  const p = AD.pending[ds.r] || (AD.pending[ds.r] = {});
  if (!cur === base) delete p[ds.k]; else p[ds.k] = !cur;
  render();
};
ACT.permDiscard = () => { AD.pending = {}; render(); };
ACT.permSave = async () => {
  if (!isAdm() || !AD.perms) return;
  const overrides = {};
  for (const r of ROLE_KEYS.filter((x) => x !== 'admin')) { overrides[r] = { ...(AD.perms.overrides[r] || {}) }; for (const [k, v] of Object.entries(AD.pending[r] || {})) overrides[r][k] = v; }
  const r = await act(() => api.setPermissions(overrides), 'Permisos guardados');
  if (r) { AD.perms = r; AD.pending = {}; await refresh().catch(() => {}); render(); }
};

// ------------------------------------------------------------------ turnos de las plantillas
const L = () => UI.cfgLabels;
IN.cfgLabel = (v, el) => { const x = L(); if (!x) return; x.list[+el.dataset.i] = v; x.dirty = true; render(); };
ACT.cfgLabelAdd = () => { const x = L(); if (!x || x.list.length >= 20) return; x.list.push(''); x.dirty = true; render(); setTimeout(() => { const el = document.getElementById('lbl-' + (x.list.length - 1)); if (el) el.focus(); }, 0); };
ACT.cfgLabelDel = (ds) => { const x = L(); if (!x || x.list.length <= 1) return; x.list.splice(+ds.i, 1); x.dirty = true; render(); };
ACT.cfgLabelReset = () => { if (AD.labels) UI.cfgLabels = { list: AD.labels.labels.slice(), version: AD.labels.version, dirty: false }; render(); };
ACT.cfgLabelSave = async () => {
  const x = L(); if (!x || !gateUI('plantillas_edit')) return;
  const v = validateShiftLabels(x.list); if (!v.ok) { toast(v.error, 'err'); return; }
  const r = await act(() => api.setShiftLabels(v.labels, x.version), 'Turnos guardados');
  if (r) { AD.labels = r; UI.cfgLabels = { list: r.labels.slice(), version: r.version, dirty: false }; await refresh().catch(() => {}); render(); }
};

// ------------------------------------------------------------------ auditoría
ACT.auditReload = () => load('audit', true);
ACT.auditMore = async () => {
  if (!AD.audit || !AD.audit.next) return;
  const r = await act(() => api.audit(AD.audit.next));
  if (r) { AD.audit = { items: [...AD.audit.items, ...r.items], next: r.next }; render(); }
};

// ------------------------------------------------------------------ demostración
ACT.loadDemo = async () => {
  if (!gateUI('demo_manage')) return;
  if (!await confirmBox('Cargar datos de demostración', 'Se crean técnicos, herramientas, entregas y controles de ejemplo, marcados como Demo. Los podés borrar después desde Administración.', 'Cargar datos')) return;
  await act(async () => { await api.loadDemo(); await refresh(); }, 'Datos de demostración cargados');
};
ACT.clearDemo = async () => {
  if (!gateUI('demo_manage')) return;
  if (!await confirmBox('Borrar datos de demostración', 'Se borran todos los registros marcados como Demo y los que dependan de ellos. Los datos reales no se tocan.', 'Borrar', 'danger')) return;
  await act(async () => { await api.clearDemo(); await refresh(); }, 'Datos de demostración borrados');
};
