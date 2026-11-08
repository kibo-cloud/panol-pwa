// Rutas por hash, como en 2.1 (#inicio, #tecnico-<id>, #control-<id>, #controlver-<id>…). Puro.
export const NAV = [['inicio', 'Panel', 'home'], ['turnos', 'Turnos', 'shift'], ['tecnicos', 'Técnicos', 'users'], ['control', 'Control de herramientas', 'check'], ['entregas', 'Entregas y reposiciones', 'swap'], ['inventario', 'Inventario general', 'box'], ['controles', 'Historial de controles', 'hist'], ['reportes', 'Reportes', 'chart'], ['alertas', 'Alertas', 'bell'], ['config', 'Configuración de herramientas', 'wrench'], ['admin', 'Administración', 'shield']];
export const NAV_PARENT = { turno: 'turnos', tecnico: 'tecnicos', ck: 'control', ver: 'controles', herramienta: 'inventario' };
const DETAIL = { turno: 'turno', tecnico: 'tecnico', controlver: 'ver', herramienta: 'herramienta' };

export function parseRoute(hash) {
  const h = String(hash || '#inicio').replace(/^#/, '') || 'inicio';
  const i = h.indexOf('-');
  const base = i < 0 ? h : h.slice(0, i);
  const id = i < 0 ? '' : h.slice(i + 1);
  if (id && base === 'control') return { name: 'ck', id };
  if (id && DETAIL[base]) return { name: DETAIL[base], id };
  if (h === 'mas') return { name: 'mas', id: '' };
  if (NAV.some((n) => n[0] === h)) return { name: h, id: '' };
  return { name: 'inicio', id: '' };
}

// Sección del menú que queda marcada para una ruta.
export const navKeyOf = (r) => NAV_PARENT[r.name] || r.name;
