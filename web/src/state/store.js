// Estado en memoria alimentado por GET /api/state (reemplaza al `S` de 2.1). Las
// modificaciones van siempre por la API y después se recarga el estado.
import { api, setCsrf } from '../api/index.js';
import { deriveState } from './derive.js';

const COLS = ['techs', 'shiftChanges', 'categories', 'tools', 'units', 'assignments', 'controls', 'movements', 'alertRes', 'users'];
export const S = Object.fromEntries([...COLS.map((c) => [c, {}]), ['shifts', []], ['derived', null]]);
export const ME = { id: null, username: '', name: '', role: null, permissions: {}, mustChangePassword: false };
export const B = { mode: 'loading', loaded: false, installEvt: null };

let version = 0;
let D = null, Dver = -1;
const subs = new Set();
export const onStore = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const emit = (why) => { for (const fn of subs) { try { fn(why); } catch (e) { console.warn(e); } } };

export function setMe(r) {
  ME.id = r.user.id; ME.username = r.user.username; ME.name = r.user.name; ME.role = r.role;
  ME.permissions = r.permissions || {}; ME.mustChangePassword = !!r.mustChangePassword;
  setCsrf(r.csrfToken);
}
export function clearMe() {
  Object.assign(ME, { id: null, username: '', name: '', role: null, permissions: {}, mustChangePassword: false });
  setCsrf('');
}

export function setState(st) {
  for (const c of COLS) S[c] = st[c] || {};
  S.shifts = st.shifts || [];
  S.derived = st.derived || null;
  B.loaded = true;
  version++;
  emit('state');
}

// Recarga estado y sesión (los permisos pueden haber cambiado). Devuelve false si falló.
export async function refresh() {
  const [me, st] = await Promise.all([api.me(), api.state()]);
  setMe(me);
  setState(st);
  return true;
}

export function derive() {
  if (D && Dver === version) return D;
  D = deriveState(S); Dver = version; return D;
}

export const myRole = () => ME.role || 'consulta';
export function can(p) { if (myRole() === 'admin') return true; return !!(ME.permissions && ME.permissions[p]); }
export function who(id) { if (!id) return '—'; const u = S.users[id]; if (!u) return 'Usuario eliminado'; return id === ME.id ? u.name + ' (vos)' : u.name; }
export const shiftName = (id) => { const s = derive().shiftById[id]; return s ? s.name : 'Sin turno'; };
export const toolName = (id) => (S.tools[id] || {}).name || 'Herramienta eliminada';
export const catName = (id) => (S.categories[id] || {}).name || 'Sin categoría';
