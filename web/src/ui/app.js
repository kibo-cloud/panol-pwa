// Ciclo de la app: arranque con la sesión del servidor, dibujo de la vista según la ruta,
// menú lateral/superior/inferior, cambios en vivo (SSE) y aviso sin conexión.
import { $, esc, setHTML } from './dom.js';
import { icon } from './icons.js';
import { avatar } from './components.js';
import { NAV, parseRoute, navKeyOf } from './router.js';
import { VIEWS, UI, setRender, scheduleRender, freshMv } from './registry.js';
import { installDelegation, ACT } from './actions.js';
import { closeModal, checkModalConflict } from './modal.js';
import { toast, setAuthHandler, errMsg } from './feedback.js';
import { api } from '../api/index.js';
import { net, watchBrowser } from '../api/net.js';
import { connectEvents } from '../api/events.js';
import { S, B, ME, derive, refresh, setMe, clearMe, onStore, who, myRole } from '../state/store.js';
import { ROLES, DOW, MSHORT } from '../state/constants.js';

// Ganchos de las funcionalidades: antes de cambiar de ruta, después de cada recarga del
// estado y al volver la conexión.
export const hooks = { beforeRoute: [], afterState: [], online: [] };
const runHooks = (list, ...a) => { for (const fn of list) { try { const r = fn(...a); if (r && r.catch) r.catch((e) => console.warn(e)); } catch (e) { console.warn(e); } } };

let events = null;
let lastRouteKey = '';

function renderChrome(r) {
  const d = derive(); const navKey = navKeyOf(r); const nAl = d.alertsOpen.length; const nPend = d.kpi.pendCtl;
  document.body.classList.toggle('ckmode', r.name === 'ck');
  const meName = who(ME.id).replace(/ \(vos\)$/, '');
  setHTML($('#side'), `<div class="brandrow"><span class="logo">${icon('wrench', 18)}</span><span><b>Pañol</b><span>Control de herramientas</span></span></div><nav aria-label="Secciones">${NAV.map(([k, l]) => { const b = k === 'control' ? nPend : k === 'alertas' ? nAl : 0; return `<a href="#${esc(k)}" class="${navKey === k ? 'on' : ''}" ${navKey === k ? 'aria-current="page"' : ''}><span class="nd"></span>${l}${b ? `<span class="nb">${b}</span>` : ''}</a>`; }).join('')}</nav><div class="ucard">${avatar(meName)}<span class="grow"><span class="t ell" data-css="display:block">${esc(meName)}</span><span class="s" data-css="display:block">${ROLES[myRole()] || ''}</span></span></div>`);
  const now = new Date(); const first = (ME.name || '').trim().split(/\s+/)[0];
  setHTML($('#top'), `<span class="logo">${icon('wrench', 20)}</span><div class="greet"><span class="d">${DOW[now.getDay()]} ${now.getDate()} ${MSHORT[now.getMonth()]} · Semana ${d.cur.w}</span><span class="h">${first ? 'Hola, ' + esc(first) : 'Pañol'}</span></div><a class="bellbtn" href="#alertas" aria-label="Alertas, ${nAl} abiertas">${icon('bell', 20)}${nAl ? '<span class="bdot"></span>' : ''}</a>`);
  const masOn = ['tecnicos', 'inventario', 'controles', 'reportes', 'alertas', 'config', 'admin', 'mas'].includes(navKey);
  const it = (k, l, ic, on) => `<a href="#${esc(k)}" class="${on ? 'on' : ''}" ${on ? 'aria-current="page"' : ''}>${icon(ic, 22)}${l}</a>`;
  setHTML($('#bottom'), it('inicio', 'Inicio', 'home', navKey === 'inicio') + it('turnos', 'Turnos', 'users', navKey === 'turnos') + `<a href="#control" class="cta" ${navKey === 'control' ? 'aria-current="page"' : ''}><span class="fab">${icon('check', 24)}</span>Controlar</a>` + it('entregas', 'Entregas', 'swap', navKey === 'entregas') + it('mas', 'Más', 'menu', masOn));
}

function render() {
  const view = $('#view');
  if (B.mode === 'loading') {
    setHTML(view, B.bootOffline ? `<div class="loading"><b>No se pudo conectar con el servidor todavía.</b><br>Revisá tu conexión: la app sigue intentando y va a mostrar los datos apenas responda.</div>` : `<div class="loading"><div class="spin"></div>Cargando datos…</div>`);
    return;
  }
  if (B.mode === 'auth' || B.mode === 'change') {
    document.body.classList.add('auth'); document.body.classList.remove('ckmode');
    const key = B.mode;
    if (view.dataset.mounted !== key) { setHTML(view, (B.mode === 'auth' ? VIEWS.login : VIEWS.changePassword)()); view.dataset.mounted = key; }
    return;
  }
  document.body.classList.remove('auth');
  const r = parseRoute(location.hash); const rk = r.name + '-' + r.id;
  renderChrome(r);
  if (r.name === 'ck' && UI.ck && UI.ck.techId === r.id && view.dataset.mounted === rk && !UI.forceCk) { VIEWS.ckRefresh && VIEWS.ckRefresh(); return; }
  UI.forceCk = false;
  const ae = document.activeElement; const fid = ae && ae.id && view.contains(ae) ? ae.id : null; const sel = fid && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;
  const fn = VIEWS[r.name] || VIEWS.inicio;
  setHTML(view, fn(r.id)); view.dataset.mounted = rk;
  if (r.name === 'ck' && VIEWS.ckRefresh) VIEWS.ckRefresh();
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* sin selección */ } } }
  if (rk !== lastRouteKey) { window.scrollTo(0, 0); lastRouteKey = rk; }
}

function renderNetbar() {
  const el = $('#netbar'); if (!el) return;
  el.hidden = !net.offline || B.mode === 'auth';
  if (!el.hidden) setHTML(el, `<div class="banner warn" role="status"><div><b>Sin conexión con el servidor.</b><div class="sm">Podés seguir con el control en curso: el borrador se guarda en este equipo y se envía al volver la conexión. Las demás acciones quedan en pausa.</div></div></div>`);
}

async function softRefresh() {
  try { await refresh(); } catch (e) { if (e.kind !== 'network') errMsg(e); }
}

function startEvents() {
  if (events) return;
  events = connectEvents(() => { if (B.mode === 'app') softRefresh(); });
}
function stopEvents() { if (events) events.close(); events = null; }

export async function enterApp() {
  await refresh();
  B.mode = 'app'; B.bootOffline = false;
  if (!location.hash) history.replaceState(null, '', '#inicio');
  startEvents();
  runHooks(hooks.online);
  render();
}

function toAuth(mode) {
  stopEvents(); closeModal();
  B.mode = mode; UI.ck = null; UI.mv = freshMv();
  $('#view').dataset.mounted = '';
  renderNetbar(); render();
}

export function logout(silent) {
  api.logout().catch(() => {});
  clearMe();
  if (location.hash && location.hash !== '#inicio') history.replaceState(null, '', '#inicio');
  toAuth('auth');
  if (!silent) toast('Sesión cerrada');
}

async function start() {
  try {
    const me = await api.me();
    setMe(me);
    if (me.mustChangePassword) { toAuth('change'); return; }
    await enterApp();
  } catch (e) {
    if (e.kind === 'unauthenticated') { toAuth('auth'); return; }
    if (e.kind === 'password_change_required') { toAuth('change'); return; }
    B.mode = 'loading'; B.bootOffline = true; render();
    setTimeout(start, 5000);
  }
}

export function boot() {
  installDelegation();
  setRender(render);
  watchBrowser();
  onStore(() => { scheduleRender(); checkModalConflict(); runHooks(hooks.afterState); });
  net.on((offline) => { renderNetbar(); if (!offline && B.mode === 'app') { softRefresh(); runHooks(hooks.online); } });
  setAuthHandler((e) => {
    if (B.mode !== 'app' && B.mode !== 'change') return;
    if (e.kind === 'unauthenticated') { clearMe(); toAuth('auth'); toast('Tu sesión terminó. Ingresá de nuevo.', 'err'); }
    else if (e.kind === 'password_change_required') toAuth('change');
  });
  window.addEventListener('hashchange', () => { runHooks(hooks.beforeRoute, parseRoute(location.hash)); closeModal(); render(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal-root') && !$('#modal-root').hidden) ACT.modalClose(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); B.installEvt = e; scheduleRender(); });
  window.addEventListener('appinstalled', () => { B.installEvt = null; toast('Pañol quedó instalada'); scheduleRender(); });
  if ('serviceWorker' in navigator && import.meta.env && import.meta.env.PROD) {
    const registerSw = () => { navigator.serviceWorker.register('/sw.js').catch((e) => console.warn(e)); };
    // Si `load` ya ocurrió, el listener nunca se dispararía: se registra en el momento.
    if (document.readyState === 'complete') registerSw(); else window.addEventListener('load', registerSw);
  }
  render();
  start();
}

export { S };
