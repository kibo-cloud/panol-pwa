// Ingreso con usuario y contraseña, bloqueo con tiempo restante (Retry-After), cambio de
// contraseña obligatorio, cambio voluntario y cierre de sesión.
import { $, esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, render } from '../../ui/registry.js';
import { ACT } from '../../ui/actions.js';
import { openModal, confirmBox } from '../../ui/modal.js';
import { toast, UErr } from '../../ui/feedback.js';
import { field } from '../../ui/components.js';
import { enterApp, logout } from '../../ui/app.js';
import { api } from '../../api/index.js';
import { B, ME, setMe } from '../../state/store.js';
import { PASSWORD_MIN } from '../../state/constants.js';

const pwField = (id, label, auto, extra = '') => field(label, `<div class="pinw"><input id="${esc(id)}" type="password" autocomplete="${esc(auto)}" maxlength="200" ${extra}><button type="button" class="icon-btn" data-act="pwShow" data-f="${esc(id)}" aria-label="Mostrar contraseña">${icon('eye', 18)}</button></div>`, id);
const brand = `<span class="logo">${icon('wrench', 28)}</span><div><h1>Pañol</h1><div class="s">Control de herramientas por técnico</div></div>`;
const installHint = () => (B.installEvt ? `<div class="hint">${icon('dl', 16)}<span><b>Instalá la app.</b> Abrila desde la pantalla de inicio, como cualquier aplicación. <button class="btn sm" data-act="install" data-css="margin-top:8px">Instalar Pañol</button></span></div>` : '');

VIEWS.login = () => `<div class="authw"><div class="authc">${brand}<form class="authf" id="loginf" novalidate>${field('Usuario', '<input id="a-user" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="200">', 'a-user')}${pwField('a-pass', 'Contraseña', 'current-password')}
  <label class="check"><input type="checkbox" id="a-keep" checked>Mantener la sesión en este dispositivo</label></form>
  <span class="aerr" id="a-err" role="alert"></span>
  <button class="btn pri lg block" id="a-go" data-act="authLogin">Ingresar</button>
  <p class="muted sm" data-css="margin:0">¿Olvidaste la contraseña? Pedile a un administrador que la restablezca.</p>${installHint()}</div></div>`;

VIEWS.changePassword = () => `<div class="authw"><div class="authc">${brand}<div><h2 class="si">Cambiá tu contraseña</h2><p class="s" data-css="margin:4px 0 0">${esc(ME.name || '')}, antes de seguir tenés que elegir una contraseña nueva. Si venís de Pañol 2.x, la actual es tu PIN.</p></div>
  <form class="authf" id="chpf" novalidate>${pwField('c-cur', 'Contraseña actual (o temporal)', 'current-password')}${pwField('c-new', `Contraseña nueva (al menos ${PASSWORD_MIN} caracteres)`, 'new-password')}${pwField('c-new2', 'Repetí la contraseña nueva', 'new-password')}</form>
  <span class="aerr" id="a-err" role="alert"></span>
  <button class="btn pri lg block" id="c-go" data-act="authChange">Guardar y entrar</button>
  <button class="btn lg block" data-act="authLeave">Salir</button></div></div>`;

const aErr = (m) => { const e = $('#a-err'); if (e) e.textContent = m; };
ACT.pwShow = (ds, el) => { const f = document.getElementById(ds.f); if (!f) return; const show = f.type === 'password'; f.type = show ? 'text' : 'password'; el.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña'); el.innerHTML = icon(show ? 'eyeoff' : 'eye', 18); };

// Bloqueo: cuenta regresiva con el tiempo que informa el servidor.
let lockTimer = null;
function lockCountdown(msg, seconds) {
  clearInterval(lockTimer);
  const until = Date.now() + seconds * 1000; const btn = $('#a-go');
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (!left) { clearInterval(lockTimer); lockTimer = null; aErr(''); if (btn) btn.disabled = false; return; }
    aErr(`${msg} Podés volver a intentar en ${left > 90 ? Math.ceil(left / 60) + ' min' : left + ' s'}.`);
    if (btn) btn.disabled = true;
  };
  tick(); lockTimer = setInterval(tick, 1000);
}

let busy = false;
ACT.authLogin = async () => {
  if (busy) return; busy = true; const btn = $('#a-go'); if (btn) btn.disabled = true;
  try {
    const username = ($('#a-user').value || '').trim(); const password = $('#a-pass').value || ''; const remember = $('#a-keep').checked;
    if (!username) { aErr('Ingresá tu usuario.'); return; }
    if (!password) { aErr('Ingresá tu contraseña.'); return; }
    let r;
    try { r = await api.login(username, password, remember); } catch (e) {
      $('#a-pass').value = ''; $('#a-pass').focus();
      if (e.kind === 'rate_limited' && e.retryAfter) { lockCountdown(e.message.replace(/\s*Esperá.*$/, '') || 'Demasiados intentos fallidos.', e.retryAfter); return; }
      aErr(e.message); return;
    }
    aErr(''); setMe(r);
    if (r.mustChangePassword) { B.mode = 'change'; $('#view').dataset.mounted = ''; render(); return; }
    toast(`Hola, ${(r.user.name || '').split(/\s+/)[0]}`);
    if (location.hash !== '#inicio') history.replaceState(null, '', '#inicio');
    await enterApp();
  } finally { busy = false; const b = $('#a-go'); if (b && !lockTimer) b.disabled = false; }
};

function checkNew(a, b) {
  if (a.length < PASSWORD_MIN) throw new UErr(`La contraseña nueva tiene que tener al menos ${PASSWORD_MIN} caracteres.`);
  if (!a.trim()) throw new UErr('La contraseña no puede ser solo espacios.');
  if (a !== b) throw new UErr('Las contraseñas nuevas no coinciden.');
}
ACT.authChange = async () => {
  if (busy) return; busy = true;
  try {
    const cur = $('#c-cur').value || ''; const a = $('#c-new').value || ''; const b = $('#c-new2').value || '';
    if (!cur) { aErr('Ingresá tu contraseña actual.'); return; }
    try { checkNew(a, b); } catch (e) { aErr(e.message); return; }
    let r;
    try { r = await api.changePassword(cur, a); } catch (e) {
      if (e.kind === 'unauthenticated') { aErr(e.message); B.mode = 'auth'; $('#view').dataset.mounted = ''; render(); return; }
      aErr(e.message); return;
    }
    setMe(r); toast('Contraseña actualizada');
    await enterApp();
  } finally { busy = false; }
};
ACT.authLeave = () => logout(true);
ACT.logout = async () => { if (await confirmBox('Cerrar sesión', 'Para volver a entrar vas a necesitar tu usuario y contraseña.', 'Cerrar sesión', 'dark')) logout(); };

// Enter en los formularios de ingreso.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target || !e.target.closest) return;
  if (e.target.closest('#loginf')) { e.preventDefault(); ACT.authLogin(); } else if (e.target.closest('#chpf')) { e.preventDefault(); ACT.authChange(); }
});

ACT.myPassword = () => {
  openModal({ title: 'Cambiar mi contraseña', render: (st) => `${field('Contraseña actual', `<input id="m-cur" type="password" autocomplete="current-password" maxlength="200" data-mi="cur" value="${esc(st.cur || '')}">`, 'm-cur')}${field(`Contraseña nueva (al menos ${PASSWORD_MIN} caracteres)`, `<input id="m-new" type="password" autocomplete="new-password" maxlength="200" data-mi="a" value="${esc(st.a || '')}">`, 'm-new')}${field('Repetí la contraseña nueva', `<input id="m-new2" type="password" autocomplete="new-password" maxlength="200" data-mi="b" value="${esc(st.b || '')}">`, 'm-new2')}<p class="muted sm">Al cambiarla se cierran tus otras sesiones.</p>`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar contraseña', kind: 'pri', run: async (st) => {
      if (!st.cur) throw new UErr('Ingresá tu contraseña actual.');
      checkNew(st.a || '', st.b || '');
      const r = await api.changePassword(st.cur, st.a); setMe(r); toast('Contraseña actualizada');
    } }] });
};
