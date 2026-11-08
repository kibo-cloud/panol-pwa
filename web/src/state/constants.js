// Constantes de la app (mismos textos que 2.1; roles y permisos como el servidor 3.0).
export const APP_VERSION = '3.0.0-dev';
export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const MSHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export const ST = { bueno: { label: 'Buen estado', cls: 'ok' }, cambio: { label: 'Para cambio', cls: 'warn' }, faltante: { label: 'Faltante', cls: 'bad' }, pendiente: { label: 'Pendiente de control', cls: 'pend' } };
export const MV = { entrega_inicial: 'Entrega inicial', reposicion: 'Reposición', adicional: 'Entrega adicional', devolucion: 'Devolución', retiro: 'Retiro', ingreso: 'Ingreso a inventario', reparado: 'Reparación terminada', baja: 'Baja', recupero: 'Recupero de retirada', recepcion: 'Devolución pendiente recibida' };
export const POOL = { disponible: 'Disponibles', asignado: 'Asignadas', reparacion: 'En reparación', retirado: 'Retiradas', pendiente: 'Pendientes de devolución', baja: 'Dadas de baja' };
export const UNIT_ST = { disponible: 'Disponible', asignado: 'Asignada', reparacion: 'En reparación', retirado: 'Retirada', pendiente: 'Pendiente de devolución', baja: 'De baja' };
export const POOL_CLS = { disponible: 'ok', asignado: 'pri', reparacion: 'warn', retirado: 'pend', pendiente: 'bad', baja: 'pend' };
export const QUICK = { cambio: ['No funciona', 'Cable deteriorado', 'Carcasa dañada', 'Desgaste por uso'], faltante: ['No está en el pañol', 'Extraviada en el trabajo', 'Entregada a otro sector', 'Pendiente de devolución'] };
export const REASONS = { entrega_inicial: ['Ingreso del técnico', 'Nueva asignación'], reposicion: ['Herramienta dañada', 'Herramienta faltante', 'Desgaste por uso'], adicional: ['Necesidad operativa', 'Trabajo especial'], devolucion: ['Ya no la necesita', 'Cambio de tareas', 'Baja del técnico'], retiro: ['Baja del técnico', 'Reasignación', 'Decisión de supervisión'] };
export const ROLES = { admin: 'Administrador', gerencia: 'Gerencia', supervisor: 'Supervisor', responsable: 'Responsable de control', consulta: 'Consulta' };
export const ROLE_KEYS = Object.keys(ROLES);
export const ROLE_SHORT = { admin: 'Admin', gerencia: 'Gerencia', supervisor: 'Supervisor', responsable: 'Control', consulta: 'Consulta' };
export const PERMS = [['controls_do', 'Realizar controles'], ['movements_do', 'Registrar entregas, devoluciones y reposiciones'], ['techs_edit', 'Crear, editar y desactivar técnicos'], ['shift_change', 'Mover técnicos de plantilla'], ['tools_edit', 'Crear y editar herramientas y categorías'], ['inventory_edit', 'Ajustar inventario: ingresos, reparaciones y bajas'], ['alerts_resolve', 'Marcar alertas como resueltas'], ['shifts_edit', 'Administrar turnos'], ['reports_export', 'Exportar informes'], ['demo_manage', 'Cargar o borrar datos de demostración'], ['plantillas_edit', 'Administrar plantillas: crear, renombrar, cambiar el supervisor y archivar'], ['plantilla_rotate', 'Cambiar el turno de cualquier plantilla (el supervisor siempre puede cambiar el de la suya)'], ['lineas_edit', 'Administrar líneas, sectores y cajas compartidas']];
// Permisos que quedan solo por compatibilidad (no se muestran en la matriz).
export const PERMS_HIDDEN = ['shifts_edit'];
export const LINEA_KIND = { linea: 'Línea', sector: 'Sector' };
export const LIM = { name: 120, legajo: 50, code: 60, text: 2000 };
export const PASSWORD_MIN = 10;
