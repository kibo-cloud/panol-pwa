// Avisos (toasts), errores de usuario y ejecución de acciones con aviso de error.
import { $ } from './dom.js';

export class UErr extends Error {}
export const tooLong = (v, n, what) => { if (String(v || '').length > n) throw new UErr(`${what} admite hasta ${n} caracteres.`); };

// Una sesión vencida o un cambio de contraseña obligatorio los resuelve la app (pantalla de ingreso).
let authHandler = () => {};
export const setAuthHandler = (fn) => { authHandler = fn; };

export function errMsg(e) {
  if (e instanceof UErr) return e.message;
  if (e && e.name === 'ApiError') {
    if (e.kind === 'unauthenticated' || e.kind === 'password_change_required') authHandler(e);
    return e.message;
  }
  return (e && e.message) || 'Ocurrió un error inesperado.';
}

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5200 : 2800);
}

export async function act(fn, okMsg) {
  document.body.classList.add('busy');
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { console.warn(e); toast(errMsg(e), 'err'); return false; }
  finally { document.body.classList.remove('busy'); }
}
