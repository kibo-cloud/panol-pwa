// SQL de plantillas: historial de pertenencia de los técnicos (rangos sin superposición),
// rotaciones, cambios de supervisor y la lista de turnos configurable.
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

export const RANGE = (r) => ({
  id: r.id, techId: r.tech_id, plantillaId: r.plantilla_id, validFrom: r.valid_from, validTo: r.valid_to, temporary: r.temporary,
  reason: r.reason || '', demo: r.demo, createdAt: iso(r.created_at), by: r.created_by,
});
const ROTATION = (r) => ({ id: r.id, plantillaId: r.plantilla_id, fromLabel: r.from_label, label: r.shift_label, from: r.effective_from, createdAt: iso(r.created_at), by: r.created_by });
const SUPERVISOR = (r) => ({
  id: r.id, plantillaId: r.plantilla_id, fromUserId: r.from_user_id, supervisorUserId: r.supervisor_user_id, from: r.effective_from, createdAt: iso(r.created_at), by: r.created_by,
});

// Historial (todos los técnicos, o los indicados), ordenado por técnico y fecha desde.
export async function loadHistory(q, { techIds, plantillaId } = {}) {
  const conds = [];
  const params = [];
  if (techIds) conds.push(`tech_id = ANY($${params.push(techIds)})`);
  if (plantillaId) conds.push(`plantilla_id = $${params.push(plantillaId)}`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await q.query(`SELECT * FROM tech_plantilla_history ${where} ORDER BY tech_id, valid_from NULLS FIRST, created_at, id`, params);
  return rows.map(RANGE);
}

export const groupByTech = (ranges) => {
  const o = {};
  for (const r of ranges) (o[r.techId] ||= []).push(r);
  return o;
};

// Plantilla de cada técnico hoy (fecha local de la base): { techId: plantillaId }.
export async function currentMembership(q, techIds = null) {
  const { rows } = await q.query(
    `SELECT tech_id, plantilla_id FROM tech_plantilla_history
      WHERE daterange(valid_from, valid_to, '[)') @> current_date ${techIds ? 'AND tech_id = ANY($1)' : ''}`,
    techIds ? [techIds] : [],
  );
  return Object.fromEntries(rows.map((r) => [r.tech_id, r.plantilla_id]));
}

export async function plantillaOn(q, techId, day) {
  const { rows } = await q.query('SELECT plantilla_on($1, $2::date) AS p', [techId, day]);
  return rows[0]?.p ?? null;
}

export async function insertRange(q, r, { actorId = null, demo = false, createdAt = null } = {}) {
  const { rows } = await q.query(
    `INSERT INTO tech_plantilla_history (id, tech_id, plantilla_id, valid_from, valid_to, temporary, reason, demo, created_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz, now()),$10) RETURNING *`,
    [r.id, r.techId, r.plantillaId, r.validFrom, r.validTo, !!r.temporary, r.reason || null, demo, createdAt, actorId],
  );
  return RANGE(rows[0]);
}

// Cierra un rango abierto (lo único que el trigger permite modificar).
export async function closeRange(q, id, validTo) {
  const { rows } = await q.query('UPDATE tech_plantilla_history SET valid_to = $2 WHERE id = $1 AND valid_to IS NULL RETURNING *', [id, validTo]);
  return rows[0] ? RANGE(rows[0]) : null;
}

// Acorta una cobertura temporal (migración 007): termina antes por un cambio definitivo.
export async function shortenCoverage(q, id, validTo) {
  const { rows } = await q.query('UPDATE tech_plantilla_history SET valid_to = $2 WHERE id = $1 AND temporary AND valid_to > $2 RETURNING *', [id, validTo]);
  if (!rows[0]) throw new Error(`No se pudo acortar la cobertura ${id}`);
  return RANGE(rows[0]);
}

// Aplica un plan de planMove() (dominio) en el orden que pide el historial: primero se acorta
// la cobertura y se anula la vuelta (o se cierra el rango abierto); después entran los rangos
// nuevos. Lo usan mover técnicos y la importación del .txt. Devuelve los rangos insertados.
export async function applyMovePlan(q, plan, { actorId = null, demo = false } = {}) {
  if (plan.shorten) await shortenCoverage(q, plan.shorten.id, plan.shorten.validTo);
  if (plan.close) await closeRange(q, plan.close.id, plan.close.validTo);
  const inserted = [];
  for (const r of plan.inserts) inserted.push(await insertRange(q, r, { actorId, demo }));
  return inserted;
}

// Id de un rango que viene de afuera (el .txt): si ya existe en el historial (por ejemplo, un
// rango que no se exporta), se usa uno nuevo para no chocar con la clave primaria.
export async function freeRangeId(q, id, newId) {
  if (!id) return newId('ph');
  const { rows } = await q.query('SELECT 1 FROM tech_plantilla_history WHERE id = $1', [id]);
  return rows[0] ? newId('ph') : id;
}

// Rangos calculados por la función de la migración 005 a partir de cambios de turno de 2.1.
export async function rangesFromChanges(q, currentPlantillaId, changes) {
  const { rows } = await q.query('SELECT * FROM plantilla_ranges_from_changes($1, $2::jsonb)', [currentPlantillaId, JSON.stringify(changes)]);
  return rows.map((r) => ({ srcId: r.src_id, plantillaId: r.plantilla_id, validFrom: r.valid_from, validTo: r.valid_to, reason: r.reason, createdAt: iso(r.created_at), by: r.created_by }));
}

export async function loadRotations(q, plantillaId = null) {
  const { rows } = await q.query(`SELECT * FROM plantilla_rotations ${plantillaId ? 'WHERE plantilla_id = $1' : ''} ORDER BY effective_from, created_at, id`, plantillaId ? [plantillaId] : []);
  return rows.map(ROTATION);
}

export async function insertRotation(q, r, actorId) {
  const { rows } = await q.query(
    'INSERT INTO plantilla_rotations (id, plantilla_id, from_label, shift_label, effective_from, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [r.id, r.plantillaId, r.fromLabel, r.label, r.from, actorId],
  );
  return ROTATION(rows[0]);
}

export async function loadSupervisorHistory(q, plantillaId = null) {
  const { rows } = await q.query(`SELECT * FROM plantilla_supervisor_history ${plantillaId ? 'WHERE plantilla_id = $1' : ''} ORDER BY effective_from, created_at, id`, plantillaId ? [plantillaId] : []);
  return rows.map(SUPERVISOR);
}

export async function insertSupervisorChange(q, r, actorId) {
  const { rows } = await q.query(
    'INSERT INTO plantilla_supervisor_history (id, plantilla_id, from_user_id, supervisor_user_id, effective_from, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [r.id, r.plantillaId, r.fromUserId, r.supervisorUserId, r.from, actorId],
  );
  return SUPERVISOR(rows[0]);
}

export const SHIFT_LABELS_KEY = 'plantillas.shift_labels';
export const DEFAULT_SHIFT_LABELS = ['Mañana', 'Tarde', 'Noche'];

export async function loadShiftLabels(q) {
  const { rows } = await q.query('SELECT value, version FROM app_settings WHERE key = $1', [SHIFT_LABELS_KEY]);
  return rows[0] ? { labels: rows[0].value, version: rows[0].version } : { labels: DEFAULT_SHIFT_LABELS, version: 0 };
}

export async function saveShiftLabels(q, labels, actorId) {
  const { rows } = await q.query(
    `INSERT INTO app_settings (key, value, created_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING value, version`,
    [SHIFT_LABELS_KEY, JSON.stringify(labels), actorId],
  );
  return { labels: rows[0].value, version: rows[0].version };
}

// Fecha local de hoy según la base (zona horaria de la empresa).
export async function today(q) {
  return (await q.query('SELECT current_date::text AS d')).rows[0].d;
}
