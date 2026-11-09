// Orden personalizado de categorías y herramientas (etapa 3). Reordenar es un solo pedido con la
// lista completa de ids del alcance y la versión de ese alcance (If-Match): si otra persona
// reordenó (o agregó o sacó un elemento) mientras tanto, 409 con el orden vigente.
// Orden de los bloqueos: la versión del alcance (order_versions) antes que las filas que ordena.
import { DomainError, ConflictError } from '../domain/errors.js';
import { CATEGORY_SCOPE, toolScope, checkReorder } from '../domain/orden.js';
import { withTransaction, record } from './common.js';

const rule = (msg, code = 'invalid_input', status = 422) => new DomainError(msg, code, status);

// Bloquea la versión de un alcance (la crea en 1 si no existía) y la devuelve.
export async function lockScope(c, scope) {
  await c.query('INSERT INTO order_versions (scope) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  return (await c.query('SELECT version FROM order_versions WHERE scope = $1 FOR UPDATE', [scope])).rows[0].version;
}
// Bloquea varios alcances siempre en el mismo orden (evita bloqueos mutuos).
export async function lockScopes(c, scopes) {
  for (const s of [...new Set(scopes)].sort()) await lockScope(c, s);
}
export async function bumpScope(c, scope) {
  return (await c.query('UPDATE order_versions SET version = version + 1 WHERE scope = $1 RETURNING version', [scope])).rows[0].version;
}

export const categoryIds = async (c) => (await c.query('SELECT id FROM categories ORDER BY sort_order, name, id')).rows.map((r) => r.id);
export const toolIdsOf = async (c, categoryId) => (await c.query('SELECT id FROM tools WHERE category_id IS NOT DISTINCT FROM $1 ORDER BY sort_order, name, id', [categoryId ?? null])).rows.map((r) => r.id);

// Escribe el orden (1, 2, 3…) de las filas cuya posición cambió. Las filas se bloquean antes por
// id (el orden global, como entregar kit y los movimientos): escribirlas en el orden de la lista
// podía cruzarse con otra transacción y terminar en un bloqueo mutuo.
export async function writeOrder(c, table, ids) {
  await c.query(`SELECT id FROM ${table} WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
  const cur = new Map((await c.query(`SELECT id, sort_order FROM ${table} WHERE id = ANY($1)`, [ids])).rows.map((r) => [r.id, r.sort_order]));
  for (const [i, id] of ids.entries()) if (cur.get(id) !== i + 1) await c.query(`UPDATE ${table} SET sort_order = $2 WHERE id = $1`, [id, i + 1]);
}

async function reorder(db, actor, { scope, version, ids, current, table, audit }) {
  return withTransaction(db, async (c) => {
    const v = await lockScope(c, scope);
    const curIds = await current(c);
    if (v !== version) throw new ConflictError({ scope, ids: curIds, version: v }, 'Otra persona cambió el orden mientras lo editabas. Recargá para ver el orden actual.');
    try {
      checkReorder(curIds, ids);
    } catch (err) {
      if (err.code === 'order_changed') err.extra = { current: { scope, ids: curIds, version: v } };
      throw err;
    }
    await writeOrder(c, table, ids);
    const nv = await bumpScope(c, scope);
    await record(c, actor, { ...audit, version: nv });
    return { scope, ids, version: nv };
  });
}

export function reorderCategories(db, actor, ids, version) {
  return reorder(db, actor, {
    scope: CATEGORY_SCOPE, version, ids, current: categoryIds, table: 'categories',
    audit: { action: 'categories_reorder', entity: 'categories', id: CATEGORY_SCOPE, detail: `Nuevo orden de categorías (${ids.length})` },
  });
}

export async function reorderTools(db, actor, categoryId, ids, version) {
  let name = 'Sin categoría';
  if (categoryId) {
    const cat = (await db.query('SELECT name FROM categories WHERE id = $1', [categoryId])).rows[0];
    if (!cat) throw rule('Elegí una categoría válida.', 'invalid_category');
    name = cat.name;
  }
  return reorder(db, actor, {
    scope: toolScope(categoryId), version, ids, current: (c) => toolIdsOf(c, categoryId), table: 'tools',
    audit: { action: 'tools_reorder', entity: 'tools', id: toolScope(categoryId), detail: `Nuevo orden de herramientas en ${name} (${ids.length})` },
  });
}
