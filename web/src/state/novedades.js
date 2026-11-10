// Novedades (etapa 6): piezas puras de la pantalla (se prueban con node --test).

// Filtros vacíos de la lista (los mismos nombres que GET /api/novedades).
export const NOV_EMPTY = Object.freeze({ from: '', to: '', techId: '', plantillaId: '', lineaId: '', authorId: '', q: '', linked: '', archived: false });
const KEYS = ['from', 'to', 'techId', 'plantillaId', 'lineaId', 'authorId', 'q', 'linked'];

// Cantidad de filtros cargados (para el botón "Limpiar filtros").
export const activeFilters = (f) => KEYS.filter((k) => String(f[k] || '').trim()).length + (f.archived ? 1 : 0);

// Query string de la lista: solo los filtros cargados; page = { limit, before }.
export function novQuery(f, page = {}) {
  const parts = [];
  const add = (k, v) => parts.push(`${k}=${encodeURIComponent(v)}`);
  for (const k of KEYS) { const v = String(f[k] || '').trim(); if (v) add(k, v); }
  if (f.archived) add('archived', 'include');
  if (page.limit) add('limit', page.limit);
  if (page.before) add('before', page.before);
  return parts.join('&');
}

// El autor edita la suya si puede cargar novedades; novedades_edit edita cualquiera.
export const canEditNov = (n, meId, can) => !!n && !n.archived && (can('novedades_edit') || (can('novedades_create') && n.authorId === meId));

// Movimientos a los que se vincula una novedad (como el servidor).
export const LINKABLE = ['entrega_inicial', 'adicional', 'reposicion'];
export const linkableMv = (m, voidedBy) => !!m && LINKABLE.includes(m.type) && !voidedBy;

const mark = (name, archived) => (archived ? `${name} (eliminado)` : name);
// Temas de una novedad con su enlace y la marca "(eliminado)".
export function novSubjects(n) {
  const out = [];
  if (n.techId) out.push({ kind: 'tech', id: n.techId, label: mark(n.techName || 'Técnico', n.techArchived), href: `#tecnico-${n.techId}` });
  if (n.plantillaId) out.push({ kind: 'plantilla', id: n.plantillaId, label: mark(n.plantillaName || 'Plantilla', n.plantillaArchived), href: `#plantilla-${n.plantillaId}` });
  if (n.lineaId) out.push({ kind: 'linea', id: n.lineaId, label: mark(n.lineaName || 'Línea', n.lineaArchived), href: '#lineas' });
  return out;
}
