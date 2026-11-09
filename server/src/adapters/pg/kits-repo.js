// Lectura de kits (con sus ítems en orden) y de las versiones del orden personalizado (etapa 3).
import { listRows } from './catalog-repo.js';
import { CATEGORY_SCOPE, toolScope } from '../../domain/orden.js';

// [{ id, name, especialidadId, version, items: [{ toolId, qty }] }]; el kit base primero.
// lock: 'UPDATE' o 'SHARE' (solo con id).
export async function loadKits(q, { id = null, lock = null } = {}) {
  const kits = await listRows(q, 'kits', `${id ? 'WHERE id = $1' : ''} ORDER BY (especialidad_id IS NOT NULL), name, id${id && lock ? ' FOR ' + (lock === 'SHARE' ? 'SHARE' : 'UPDATE') : ''}`, id ? [id] : []);
  const items = (await q.query(`SELECT kit_id, tool_id, qty FROM kit_items ${id ? 'WHERE kit_id = $1' : ''} ORDER BY kit_id, sort_order, tool_id`, id ? [id] : [])).rows;
  const by = {};
  for (const it of items) (by[it.kit_id] ||= []).push({ toolId: it.tool_id, qty: it.qty });
  return kits.map((k) => ({ ...k, items: by[k.id] || [] }));
}

// Versión de cada alcance: { categories, 'tools:<id>', 'tools:' } (1 si nunca se reordenó).
export async function loadOrderVersions(q) {
  const out = { [CATEGORY_SCOPE]: 1, [toolScope(null)]: 1 };
  for (const r of (await q.query('SELECT id FROM categories')).rows) out[toolScope(r.id)] = 1;
  for (const r of (await q.query('SELECT scope, version FROM order_versions')).rows) if (r.scope in out) out[r.scope] = r.version;
  return out;
}
