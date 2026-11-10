// SQL de los registros editables (técnicos, turnos, categorías, herramientas, unidades,
// cambios de turno y resoluciones de alertas). Cada tabla tiene un mapa campo de la API ->
// columna; nunca se arma SQL con nombres que no estén en estos mapas.
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

const COMMON = { version: 'version', createdAt: 'created_at', updatedAt: 'updated_at', by: 'created_by' };
// Etapa 5: baja lógica uniforme (quién, cuándo y por qué). Las respuestas agregan `archived`.
const ARCH = { archivedAt: 'archived_at', archivedBy: 'archived_by', archiveReason: 'archive_reason' };
export const TABLES = {
  // La plantilla de un técnico sale del historial (tech_plantilla_history), no de techs.shift_id.
  techs: { table: 'techs', key: 'id', cols: { name: 'name', legajo: 'legajo', active: 'active', alta: 'alta', especialidadId: 'especialidad_id', demo: 'demo', ...ARCH } },
  plantillas: {
    table: 'plantillas', key: 'id',
    cols: { name: 'name', supervisorUserId: 'supervisor_user_id', currentShiftLabel: 'current_shift_label', order: 'sort_order', ...ARCH },
  },
  shifts: { table: 'shifts', key: 'id', cols: { name: 'name', order: 'sort_order' } },
  // Etapa 3: orden personalizado (`order`), especialidades y kits (los ítems van aparte).
  categories: { table: 'categories', key: 'id', cols: { name: 'name', order: 'sort_order', demo: 'demo', ...ARCH } },
  tools: { table: 'tools', key: 'id', cols: { name: 'name', description: 'description', categoryId: 'category_id', serialized: 'serialized', active: 'active', order: 'sort_order', demo: 'demo', ...ARCH } },
  especialidades: { table: 'especialidades', key: 'id', cols: { name: 'name', order: 'sort_order', ...ARCH } },
  kits: { table: 'kits', key: 'id', cols: { name: 'name', especialidadId: 'especialidad_id', ...ARCH } },
  units: { table: 'units', key: 'id', cols: { toolId: 'tool_id', code: 'code', status: 'status', techId: 'tech_id', cajaId: 'caja_id', demo: 'demo', ...ARCH } },
  lineas: { table: 'lineas', key: 'id', cols: { name: 'name', kind: 'kind', order: 'sort_order', ...ARCH } },
  cajas: { table: 'cajas', key: 'id', cols: { name: 'name', lineaId: 'linea_id', referenteTechId: 'referente_tech_id', ...ARCH } },
  shiftChanges: {
    table: 'shift_changes', key: 'id',
    cols: { techId: 'tech_id', from: 'from_shift_id', to: 'to_shift_id', fromName: 'from_name', toName: 'to_name', effectiveFrom: 'effective_from', note: 'note', at: 'at', demo: 'demo' },
  },
  alertRes: { table: 'alert_resolutions', key: 'key', cols: { type: 'type', title: 'title', text: 'text', techId: 'tech_id', cajaId: 'caja_id', note: 'note', at: 'at', demo: 'demo' } },
  assignments: {
    table: 'assignments', key: 'id',
    cols: {
      techId: 'tech_id', cajaId: 'caja_id', toolId: 'tool_id', unitId: 'unit_id', qty: 'qty', active: 'active', since: 'since', until: 'until', movementId: 'movement_id',
      replaces: 'replaces', endReason: 'end_reason', replacedBy: 'replaced_by', endMovementId: 'end_movement_id', demo: 'demo',
    },
  },
};

function spec(name) {
  const s = TABLES[name];
  if (!s) throw new Error(`Tabla desconocida: ${name}`);
  return s;
}

// Fila de la base -> registro de la API (camelCase, fechas ISO).
export function toApi(name, row) {
  if (!row) return null;
  const s = spec(name);
  const out = { id: row[s.key] };
  for (const [k, c] of Object.entries({ ...s.cols, ...COMMON })) if (c in row) out[k] = row[c] instanceof Date ? iso(row[c]) : row[c];
  if ('archived_at' in row) out.archived = row.archived_at != null;
  return out;
}

function columns(s, values) {
  const keys = Object.keys(values);
  for (const k of keys) if (!s.cols[k] && k !== 'by') throw new Error(`Campo no permitido en ${s.table}: ${k}`);
  return keys.map((k) => ({ k, c: k === 'by' ? 'created_by' : s.cols[k], v: values[k] }));
}

export async function getRow(q, name, id, { lock = false } = {}) {
  const s = spec(name);
  const { rows } = await q.query(`SELECT * FROM ${s.table} WHERE ${s.key} = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  return toApi(name, rows[0]);
}

export async function listRows(q, name, where = '', params = []) {
  const s = spec(name);
  const { rows } = await q.query(`SELECT * FROM ${s.table} ${where}`, params);
  return rows.map((r) => toApi(name, r));
}

export async function insertRow(q, name, id, values) {
  const s = spec(name);
  const cs = columns(s, values);
  const sql = `INSERT INTO ${s.table} (${[s.key, ...cs.map((x) => x.c)].join(', ')}) VALUES (${[id, ...cs].map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
  const { rows } = await q.query(sql, [id, ...cs.map((x) => x.v)]);
  return toApi(name, rows[0]);
}

export async function updateRow(q, name, id, set) {
  const s = spec(name);
  const cs = columns(s, set);
  if (!cs.length) return getRow(q, name, id);
  const { rows } = await q.query(`UPDATE ${s.table} SET ${cs.map((x, i) => `${x.c} = $${i + 2}`).join(', ')} WHERE ${s.key} = $1 RETURNING *`, [id, ...cs.map((x) => x.v)]);
  return toApi(name, rows[0]);
}

export async function deleteRow(q, name, id) {
  const s = spec(name);
  const r = await q.query(`DELETE FROM ${s.table} WHERE ${s.key} = $1`, [id]);
  return r.rowCount > 0;
}

// Serializa chequeos de unicidad que la base no puede expresar (p. ej. sin distinguir
// mayúsculas en un campo con espacios): un lock por transacción y por nombre.
export const lockName = (q, name) => q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);
