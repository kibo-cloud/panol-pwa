// Aviso de cambios entre instancias: cada escritura hace NOTIFY dentro de su transacción, así
// PostgreSQL lo entrega solo si se confirma (y a todas las instancias que escuchan).
export const EVENTS_CHANNEL = 'panol_events';

export function notifyChange(q, { entity, id = null, version = null, action }) {
  return q.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, JSON.stringify({ entity, id, version, action })]);
}
