// Ajustes de la empresa en `app_settings` (clave -> valor JSON con versión). Etapa 8: umbral de
// la alerta "Sin control hace N días". Sin fila vale el valor por defecto (versión 0).
import { DEFAULT_CONTROL_OVERDUE_DAYS } from '../../domain/existencia.js';
import { DEFAULT_COMPANY_NAME } from '../../domain/empresa.js';

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

// Etapa 10: empresa (nombre y hash del logo) en 'empresa.profile'; el logo en company_logo.
export const EMPRESA_KEY = 'empresa.profile';

export async function loadEmpresa(q) {
  const { rows } = await q.query('SELECT value, version FROM app_settings WHERE key = $1', [EMPRESA_KEY]);
  const v = rows[0] ? rows[0].value || {} : {};
  const name = typeof v.name === 'string' && v.name.trim() ? v.name : DEFAULT_COMPANY_NAME;
  const logo = v.logo && /^[0-9a-f]{64}$/.test(v.logo.sha256 || '') ? { sha256: v.logo.sha256, contentType: v.logo.contentType, size: v.logo.size } : null;
  return { name, logo, version: rows[0] ? rows[0].version : 0 };
}

export async function saveEmpresa(q, { name, logo }, actorId) {
  const { rows } = await q.query(
    `INSERT INTO app_settings (key, value, created_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING version`,
    [EMPRESA_KEY, JSON.stringify({ name, logo: logo || null }), actorId],
  );
  return rows[0].version;
}

export async function loadLogo(q) {
  const { rows } = await q.query('SELECT content_type, data, sha256 FROM company_logo WHERE id = 1');
  return rows[0] ? { contentType: rows[0].content_type, data: rows[0].data, sha256: rows[0].sha256 } : null;
}

export async function writeLogo(q, { contentType, data, sha256 }, actorId) {
  await q.query(
    `INSERT INTO company_logo (id, content_type, data, sha256, created_by) VALUES (1, $1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, sha256 = EXCLUDED.sha256, created_by = EXCLUDED.created_by, created_at = now()`,
    [contentType, data, sha256, actorId],
  );
}

export const deleteLogo = (q) => q.query('DELETE FROM company_logo WHERE id = 1');
