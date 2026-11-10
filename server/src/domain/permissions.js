// Resolución de permisos. Admin puede todo; los demás roles usan el override configurado
// (tabla role_permissions) y, si no hay, el valor por defecto.
import { PERM_KEYS } from './constants.js';

const responsable = { controls_do: true, movements_do: true, alerts_resolve: true, reports_export: true, novedades_view: true, novedades_create: true };

export const DEFAULT_PERMS = Object.freeze({
  responsable: Object.freeze({ ...responsable }),
  consulta: Object.freeze({ reports_export: true }),
  // Supuesto a confirmar en el PR de la etapa 1: supervisor = responsable + cambiar de turno.
  supervisor: Object.freeze({ ...responsable, shift_change: true }),
  // Gerencia ve en modo consulta; el permiso de compras llega en la etapa 7.
  gerencia: Object.freeze({ reports_export: true }),
});

// overrides: { rol: { permiso: boolean } }
export function can(role, perm, overrides = {}) {
  if (!PERM_KEYS.includes(perm)) return false;
  if (role === 'admin') return true;
  if (!DEFAULT_PERMS[role]) return false;
  const cfg = overrides && overrides[role];
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, perm)) return !!cfg[perm];
  return !!DEFAULT_PERMS[role][perm];
}

export function effectivePermissions(role, overrides = {}) {
  return Object.fromEntries(PERM_KEYS.map((p) => [p, can(role, p, overrides)]));
}
