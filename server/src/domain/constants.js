// Constantes del dominio, tomadas tal cual de Pañol 2.1 (index.html) y ampliadas para la 3.0.

export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export const DEFAULT_SHIFTS = [
  { id: 'manana', name: 'Turno mañana', order: 1 },
  { id: 'tarde', name: 'Turno tarde', order: 2 },
  { id: 'noche', name: 'Turno noche', order: 3 },
];

// Estados de una herramienta en un control.
export const ST = {
  bueno: 'Buen estado',
  cambio: 'Para cambio',
  faltante: 'Faltante',
  pendiente: 'Pendiente de control',
};
export const ITEM_STATES = ['bueno', 'cambio', 'faltante'];

// Tipos de movimiento del libro de inventario.
export const MV = {
  entrega_inicial: 'Entrega inicial',
  reposicion: 'Reposición',
  adicional: 'Entrega adicional',
  devolucion: 'Devolución',
  retiro: 'Retiro',
  ingreso: 'Ingreso a inventario',
  reparado: 'Reparación terminada',
  baja: 'Baja',
  recupero: 'Recupero de retirada',
  recepcion: 'Devolución pendiente recibida',
};
export const MV_TYPES = Object.keys(MV);

// Lugares (pools) entre los que se mueve el stock.
export const POOL_K = ['disponible', 'asignado', 'reparacion', 'retirado', 'pendiente', 'baja', 'externo'];
export const POOL = {
  disponible: 'Disponibles',
  asignado: 'Asignadas',
  reparacion: 'En reparación',
  retirado: 'Retiradas',
  pendiente: 'Pendientes de devolución',
  baja: 'Dadas de baja',
  externo: 'Externo',
};

export const ROLES = {
  admin: 'Administrador',
  gerencia: 'Gerencia',
  supervisor: 'Supervisor',
  responsable: 'Responsable de control',
  consulta: 'Consulta',
};
export const ROLE_KEYS = Object.keys(ROLES);

export const PERMS = [
  ['controls_do', 'Realizar controles'],
  ['movements_do', 'Registrar entregas, devoluciones y reposiciones'],
  ['techs_edit', 'Crear, editar y desactivar técnicos'],
  ['shift_change', 'Mover técnicos de plantilla'],
  ['tools_edit', 'Crear y editar herramientas y categorías'],
  ['inventory_edit', 'Ajustar inventario: ingresos, reparaciones y bajas'],
  ['alerts_resolve', 'Marcar alertas como resueltas'],
  ['shifts_edit', 'Administrar turnos'],
  ['reports_export', 'Exportar informes'],
  ['demo_manage', 'Cargar o borrar datos de demostración'],
  // Etapa 2: plantillas por supervisor, rotación y líneas/cajas (admin por defecto).
  ['plantillas_edit', 'Administrar plantillas: crear, renombrar, supervisor y archivar'],
  ['plantilla_rotate', 'Rotar cualquier plantilla (el supervisor siempre rota la suya)'],
  ['lineas_edit', 'Administrar líneas, sectores y cajas compartidas'],
  // Etapa 3: kits (kit base y por especialidad), solo admin por defecto.
  ['kits_edit', 'Administrar kits: kit base y kits por especialidad'],
];
export const PERM_KEYS = PERMS.map(([k]) => k);

// Límites de carga desde la interfaz (LIM de 2.1).
export const LIM = { name: 120, legajo: 50, code: 60, text: 2000 };
// Límites del esquema de datos de 2.1 (lo que acepta un .txt); la base usa estos.
export const SCHEMA_LIM = { name: 500, legajo: 200, code: 200, text: 20000 };

// Ids de 2.1: caracteres seguros, sin nombres especiales.
export const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const validId = (id) => typeof id === 'string' && ID_RE.test(id) && id !== '.' && id !== '..' && !BAD_KEYS.has(id);
