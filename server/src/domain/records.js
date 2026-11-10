// Eliminar (baja lógica), restaurar y eliminación definitiva (etapa 5): reglas puras.
// Tipos de registro que se eliminan con el mismo modelo; el motivo es obligatorio; la
// eliminación definitiva pide escribir el nombre exacto; un técnico o una caja con herramientas
// asignadas se elimina resolviendo cada asignación en el mismo paso (devolución o retiro).
import { DomainError, tooLong } from './errors.js';
import { LIM } from './constants.js';

// key: clave del registro en las respuestas; audit: prefijo de las acciones de auditoría.
export const RECORD_TYPES = {
  techs: { key: 'tech', audit: 'tech', label: 'técnico', the: 'el técnico' },
  cajas: { key: 'caja', audit: 'caja', label: 'caja', the: 'la caja' },
  tools: { key: 'tool', audit: 'tool', label: 'herramienta', the: 'la herramienta' },
  categories: { key: 'category', audit: 'category', label: 'categoría', the: 'la categoría' },
  plantillas: { key: 'plantilla', audit: 'plantilla', label: 'plantilla', the: 'la plantilla' },
  lineas: { key: 'linea', audit: 'linea', label: 'línea o sector', the: 'la línea o sector' },
  especialidades: { key: 'especialidad', audit: 'especialidad', label: 'especialidad', the: 'la especialidad' },
  kits: { key: 'kit', audit: 'kit', label: 'kit', the: 'el kit' },
  users: { key: 'user', audit: 'user', label: 'usuario', the: 'el usuario' },
  // Etapa 6: una novedad no tiene historial operativo; su nombre es la etiqueta corta (Novedad N).
  novedades: { key: 'novedad', audit: 'novedad', label: 'novedad', the: 'la novedad' },
};
export const RECORD_TYPE_KEYS = Object.keys(RECORD_TYPES);

// Acciones de auditoría propias del registro: el alta, las bajas y las restauraciones.
export const ownActions = (type) => {
  const a = RECORD_TYPES[type].audit;
  return [`${a}_create`, `${a}_archive`, `${a}_restore`];
};

// E5.V1: solo las referencias operativas impiden la eliminación definitiva. En la auditoría del
// propio registro, una edición (renombrar, cambiar un campo, reordenar) no cuenta; una acción de
// ciclo de vida (desactivar, entregar un kit, rotar) sí. La auditoría nunca se borra.
const EDIT_ACTION = /_(edit|update|rename|reorder)$/;
export const isHistoryAction = (type, action) => !ownActions(type).includes(action) && !EDIT_ACTION.test(action);

export function cleanReason(v) {
  const r = String(v ?? '').trim();
  if (!r) throw new DomainError('Indicá el motivo.', 'reason_required', 422);
  tooLong(r, LIM.text, 'El motivo');
  return r;
}

// Doble confirmación de la eliminación definitiva: el nombre exacto (sin espacios de más).
export function checkConfirmName(name, typed) {
  if (String(typed ?? '').trim() !== String(name ?? '').trim()) {
    throw new DomainError(`Para eliminar definitivamente escribí el nombre exacto: ${name}.`, 'confirm_name', 422);
  }
}

export const RESOLUTION_ACTIONS = ['devolucion', 'retiro'];
export const RESOLUTION_COND = ['disponible', 'reparacion', 'baja'];

/**
 * Resolución de las asignaciones activas de un técnico o una caja que se elimina.
 * active: [{ id, toolName, qty, unitCode }]; resolutions: [{ assignmentId, action, cond? }].
 * Devuelve la lista de movimientos a registrar (uno por asignación) o un error 409 con las que
 * faltan resolver (`pending`).
 */
export function planResolutions(active, resolutions = []) {
  const byId = new Map(active.map((a) => [a.id, a]));
  const seen = new Set();
  const out = [];
  for (const r of resolutions || []) {
    if (!byId.has(r.assignmentId)) throw new DomainError('Una de las herramientas ya no está asignada. Recargá y revisá de nuevo.', 'invalid_resolution', 409);
    if (seen.has(r.assignmentId)) throw new DomainError('Hay una herramienta repetida en las resoluciones.', 'invalid_resolution', 422);
    seen.add(r.assignmentId);
    if (!RESOLUTION_ACTIONS.includes(r.action)) throw new DomainError('Elegí devolver o retirar cada herramienta.', 'invalid_resolution', 422);
    const cond = r.action === 'retiro' ? 'retirado' : r.cond || 'disponible';
    if (r.action === 'devolucion' && !RESOLUTION_COND.includes(cond)) throw new DomainError('Elegí en qué condición vuelve cada herramienta.', 'invalid_resolution', 422);
    const a = byId.get(r.assignmentId);
    out.push({ assignmentId: a.id, action: r.action, cond, qty: a.qty || 1 });
  }
  const pending = active.filter((a) => !seen.has(a.id));
  if (pending.length) {
    const err = new DomainError(`Tiene ${pending.length} ${pending.length === 1 ? 'herramienta asignada' : 'herramientas asignadas'}: indicá si cada una se devuelve o se retira.`, 'pending_assignments', 409);
    err.extra = { pending };
    throw err;
  }
  return out;
}
