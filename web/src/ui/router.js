// Rutas por hash, como en 2.1 (#inicio, #tecnico-<id>, #control-<id>, #controlver-<id>…). Puro.
// Etapa 2: Plantillas reemplaza a Turnos (#turnos y #turno-<id> siguen funcionando como
// alias), Líneas y cajas (#lineas, #caja-<id>) y el control de una caja (#control-caja:<id>).
// Etapa 7: Gerencia (#compras) y el detalle de una solicitud (#compra-<id>).
// Etapa 8: Existencia por técnico (#existencia).
// Etapa 10: Imprimir para auditoría (#auditoria y #auditoria-<selección>), dentro de Reportes.
export const NAV = [['inicio', 'Panel', 'home'], ['plantillas', 'Plantillas', 'users'], ['tecnicos', 'Técnicos', 'users'], ['control', 'Control de herramientas', 'check'], ['entregas', 'Entregas y reposiciones', 'swap'], ['inventario', 'Inventario general', 'box'], ['lineas', 'Líneas y cajas', 'box'], ['controles', 'Historial de controles', 'hist'], ['reportes', 'Reportes', 'chart'], ['existencia', 'Existencia', 'grid'], ['alertas', 'Alertas', 'bell'], ['novedades', 'Novedades', 'note'], ['compras', 'Gerencia: compras', 'cart'], ['config', 'Configuración de herramientas', 'wrench'], ['admin', 'Administración', 'shield']];
export const NAV_PARENT = { plantilla: 'plantillas', tecnico: 'tecnicos', ck: 'control', ver: 'controles', herramienta: 'inventario', caja: 'lineas', compra: 'compras', auditoria: 'reportes' };
const DETAIL = { plantilla: 'plantilla', turno: 'plantilla', tecnico: 'tecnico', controlver: 'ver', herramienta: 'herramienta', caja: 'caja', compra: 'compra' };
const ALIAS = { turnos: 'plantillas' };

export function parseRoute(hash) {
  const h = String(hash || '#inicio').replace(/^#/, '') || 'inicio';
  const i = h.indexOf('-');
  const base = i < 0 ? h : h.slice(0, i);
  const id = i < 0 ? '' : h.slice(i + 1);
  if (id && base === 'control') return { name: 'ck', id };
  if (id && DETAIL[base]) return { name: DETAIL[base], id };
  if (h === 'mas') return { name: 'mas', id: '' };
  if (base === 'auditoria') return { name: 'auditoria', id };
  if (ALIAS[h]) return { name: ALIAS[h], id: '' };
  if (NAV.some((n) => n[0] === h)) return { name: h, id: '' };
  return { name: 'inicio', id: '' };
}

// Sección del menú que queda marcada para una ruta.
export const navKeyOf = (r) => NAV_PARENT[r.name] || r.name;
