// Orden personalizado de categorías y herramientas (etapa 3), puro. Las mismas reglas que el
// servidor (server/src/domain/orden.js): categorías por su orden; herramientas por el orden de su
// categoría y después el propio; las que no tienen categoría, al final.
export const CATEGORY_SCOPE = 'categories';
export const toolScope = (categoryId) => 'tools:' + (categoryId || '');

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.name || '').localeCompare(b.name || '', 'es') || String(a.id).localeCompare(String(b.id));
export const sortByOrder = (list) => list.slice().sort(byOrder);

export function orderTools(tools, categories) {
  const catPos = new Map(sortByOrder(categories).map((c, i) => [c.id, i]));
  const pos = (t) => (catPos.has(t.categoryId) ? catPos.get(t.categoryId) : catPos.size);
  return tools.slice().sort((a, b) => pos(a) - pos(b) || byOrder(a, b));
}

// Mueve el elemento de la posición `from` a la posición `to` (índices desde 0).
export function moveTo(ids, from, to) {
  if (from < 0 || from >= ids.length) return ids.slice();
  const out = ids.slice();
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x);
  return out;
}

// Sube (delta -1) o baja (delta +1) un elemento; en los extremos no cambia nada.
export function moveBy(ids, id, delta) {
  const i = ids.indexOf(id);
  if (i < 0) return ids.slice();
  return moveTo(ids, i, i + delta);
}

// Posición (desde 1) donde queda un elemento nuevo; sin posición o fuera de rango, al final.
export function insertAt(ids, id, position) {
  const out = ids.filter((x) => x !== id);
  const p = Number.isInteger(position) ? Math.max(1, Math.min(position, out.length + 1)) : out.length + 1;
  out.splice(p - 1, 0, id);
  return out;
}

export const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
