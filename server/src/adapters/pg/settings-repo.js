// Ajustes de la empresa en `app_settings` (clave -> valor JSON con versión). Etapa 8: umbral de
// la alerta "Sin control hace N días". Sin fila vale el valor por defecto (versión 0).
import { DEFAULT_CONTROL_OVERDUE_DAYS } from '../../domain/existencia.js';

export const ALERT_SETTINGS_KEY = 'alerts.control_overdue_days';

export async function loadAlertSettings(q) {
  const { rows } = await q.query('SELECT value, version FROM app_settings WHERE key = $1', [ALERT_SETTINGS_KEY]);
  const v = rows[0] ? Number(rows[0].value) : NaN;
  return { controlOverdueDays: Number.isInteger(v) && v >= 0 ? v : DEFAULT_CONTROL_OVERDUE_DAYS, version: rows[0] ? rows[0].version : 0 };
}

export async function saveAlertSettings(q, days, actorId) {
  const { rows } = await q.query(
    `INSERT INTO app_settings (key, value, created_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING value, version`,
    [ALERT_SETTINGS_KEY, JSON.stringify(days), actorId],
  );
  return { controlOverdueDays: Number(rows[0].value), version: rows[0].version };
}
