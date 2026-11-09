// Orden personalizado de categorías y herramientas (etapa 3), por ejemplo el orden físico de la
// caja. Un solo orden global: las categorías entre sí y las herramientas dentro de cada
// categoría (las que no tienen categoría forman su propio grupo, al final). Cada alcance tiene
// su versión, así dos personas que reordenan a la vez no se pisan (409).
import { DomainError } from './errors.js';

export const CATEGORY_SCOPE = 'categories';
export const toolScope = (categoryId) => 'tools:' + (categoryId || '');

// La lista nueva tiene que tener exactamente los mismos ids que la actual, cada uno una vez.
// Si alguien agregó o sacó un elemento mientras se reordenaba, es un conflicto.
export function checkReorder(currentIds, ids) {
  if (new Set(ids).size !== ids.length) throw new DomainError('La lista tiene elementos repetidos.', 'invalid_order', 422);
  const cur = new Set(currentIds);
  if (ids.length !== cur.size || ids.some((id) => !cur.has(id))) {
    throw new DomainError('La lista cambió mientras la ordenabas. Recargá para ver el orden actual.', 'order_changed', 409);
  }
  return ids;
}

// Inserta `id` en la posición `position` (desde 1). Sin posición, o fuera de rango, va al final.
export function insertAt(ids, id, position) {
  const out = ids.filter((x) => x !== id);
  const p = Number.isInteger(position) ? Math.max(1, Math.min(position, out.length + 1)) : out.length + 1;
  out.splice(p - 1, 0, id);
  return out;
}

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name || '').localeCompare(b.name || '', 'es') || String(a.id).localeCompare(String(b.id));
export const sortByOrder = (list) => list.slice().sort(byOrder);

// Herramientas en el orden que se muestran: el de su categoría, después el propio.
export function orderTools(tools, categories) {
  const catPos = new Map(sortByOrder(categories).map((c, i) => [c.id, i]));
  const pos = (t) => (catPos.has(t.categoryId) ? catPos.get(t.categoryId) : catPos.size);
  return tools.slice().sort((a, b) => pos(a) - pos(b) || byOrder(a, b));
}

// Posición de cada herramienta en ese orden: { toolId: índice }.
export const toolRank = (tools, categories) => Object.fromEntries(orderTools(tools, categories).map((t, i) => [t.id, i]));
