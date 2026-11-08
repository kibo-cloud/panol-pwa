// Registro de vistas y estado de la interfaz (filtros, pestañas, formularios en curso).
// Lo que el usuario está escribiendo vive acá, así una recarga en vivo no lo pierde.
export const VIEWS = {};
export const freshMv = (o = {}) => ({ type: 'entrega_inicial', returned: true, oldDest: 'reparacion', cond: 'disponible', qty: 1, ...o });
export const UI = {
  ctlShift: 'all', techQ: '', techShift: 'all', techInactive: false, techTab: 'tools', techMonth: null,
  histMonth: null, histShift: 'all', invQ: '', invCat: 'all', mv: freshMv(), mvFilter: 'all', alertTab: 'open',
  rep: null, ck: null, pendingCk: null, adminTab: 'users', forceCk: false, turnoQ: '', turnoF: 'all',
};

let renderFn = () => {};
let queued = false;
export const setRender = (fn) => { renderFn = fn; };
export const render = () => renderFn();
export function scheduleRender() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; renderFn(); }); }
