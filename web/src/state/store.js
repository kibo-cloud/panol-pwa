// Estado en memoria alimentado por GET /api/state (reemplaza al `S` de 2.1). Las
// modificaciones van siempre por la API y después se recarga el estado.
import { api, setCsrf } from '../api/index.js';
import { deriveState } from './derive.js';

const COLS = ['techs', 'shiftChanges', 'categories', 'tools', 'units', 'assignments', 'controls', 'movements', 'alertRes', 'users', 'plantillas', 'plantillaHistory', 'lineas', 'cajas'];
// Listas (no objetos por id): plantillas activas con forma de turno 2.1, rotaciones, cambios de
// supervisor y la lista de turnos configurable.
const LISTS = ['shifts', 'plantillaRotations', 'plantillaSupervisors', 'shiftLabels'];
export const S = Object.fromEntries([...COLS.map((c) => [c, {}]), ...LISTS.map((c) => [c, []]), ['derived', null]]);
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
  for (const c of LISTS) S[c] = st[c] || [];
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
export const shiftName = (id) => { const s = derive().plantillaById[id]; return s ? s.name : 'Sin plantilla'; };
export const plantillaName = shiftName;
export const cajaName = (id) => (S.cajas[id] || {}).name || 'Caja eliminada';
// Nombre del poseedor de una asignación, control o movimiento (técnico o caja).
export const holderName = (o) => (o && o.cajaId ? cajaName(o.cajaId) : (S.techs[o && o.techId] || {}).name || '');
// Rota quien tiene plantilla_rotate o el supervisor de esa plantilla (como el servidor).
export const canRotate = (p) => !!p && (can('plantilla_rotate') || (myRole() === 'supervisor' && p.supervisorUserId === ME.id));
export const toolName = (id) => (S.tools[id] || {}).name || 'Herramienta eliminada';
export const catName = (id) => (S.categories[id] || {}).name || 'Sin categoría';
