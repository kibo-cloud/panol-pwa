// Etapa 10: datos inventados para el informe de auditoría, compartidos por la prueba del servidor
// (server/test/unit/auditoria.test.js) y la de la web (web/test/auditoria.test.js).
// Hoy (Buenos Aires): martes 17 de noviembre de 2026, 12:00. Meses del informe: octubre y noviembre.
export const NOW = new Date('2026-11-17T15:00:00.000Z');

const pk = (p) => ({ pkey: `${p.y}-${String(p.m).padStart(2, '0')}-${p.w}`, pnum: p.y * 1000 + p.m * 10 + p.w });
const it = (toolId, expected, good, change, missing, extra = {}) => ({ toolId, toolName: extra.toolName || toolId, state: missing ? 'faltante' : change ? 'cambio' : 'bueno', expected, qty: expected, good, change, missing, note: extra.note || '', unitCode: extra.unitCode || null });
const fin = (holder, period, finishedAt, items, extra = {}) => {
  const counts = { bueno: 0, cambio: 0, faltante: 0 };
  for (const x of Object.values(items)) { counts.bueno += x.good; counts.cambio += x.change; counts.faltante += x.missing; }
  return { ...holder, period, ...pk(period), status: 'finalizado', finishedAt, counts, items, cleaning: { status: 'limpio', note: '' }, by: 'u-resp', ...extra };
};
const tr = (toolId, qty, from, to) => ({ toolId, qty, from, to, unitId: null });

export function fixture() {
  return {
    shifts: [{ id: 'manana', name: 'Mañana', order: 1 }, { id: 'tarde', name: 'Tarde', order: 2 }],
    plantillas: { manana: { name: 'Mañana', order: 1 }, tarde: { name: 'Tarde', order: 2 } },
    plantillaHistory: {
      tA: [{ id: 'r1', techId: 'tA', plantillaId: 'tarde', validFrom: null, validTo: '2026-10-12' }, { id: 'r2', techId: 'tA', plantillaId: 'manana', validFrom: '2026-10-12', validTo: null, reason: 'Pase de turno', by: 'u-admin' }],
      tB: [{ id: 'r3', techId: 'tB', plantillaId: 'tarde', validFrom: null, validTo: null }],
      tX: [{ id: 'r4', techId: 'tX', plantillaId: 'manana', validFrom: null, validTo: null }],
    },
    plantillaRotations: [{ id: 'ro1', plantillaId: 'tarde', fromLabel: 'Tarde', label: 'Noche', from: '2026-11-02', by: 'u-admin' }],
    plantillaSupervisors: [{ id: 'su1', plantillaId: 'manana', fromUserId: null, supervisorUserId: 'u-resp', from: '2026-10-05', by: 'u-admin' }],
    especialidades: { e1: { name: 'Mecánico', order: 1 } },
    users: { 'u-admin': { name: 'Admin Uno' }, 'u-resp': { name: 'Rita Responsable' } },
    techs: {
      tA: { name: 'Ana', legajo: '10', shiftId: 'manana', plantillaId: 'manana', especialidadId: 'e1', active: true },
      tB: { name: 'Beto', legajo: '20', shiftId: 'tarde', plantillaId: 'tarde', active: true },
      tN: { name: 'Nadie', legajo: '30', shiftId: 'tarde', plantillaId: 'tarde', active: true },
      tX: { name: 'Xenia', legajo: '90', shiftId: 'manana', plantillaId: 'manana', active: false, archived: true, archivedAt: '2026-11-03T12:00:00.000Z' },
    },
    cajas: { k1: { name: 'Caja L1', lineaId: 'l1' } },
    lineas: { l1: { name: 'Línea 1', kind: 'linea', order: 1 } },
    categories: { cat: { name: 'Manuales', order: 1 } },
    tools: {
      llave: { name: 'Llave', categoryId: 'cat', order: 2, serialized: false },
      pinza: { name: 'Pinza', categoryId: 'cat', order: 1, serialized: false },
      taladro: { name: 'Taladro', categoryId: 'cat', order: 3, serialized: true },
    },
    units: { u1: { toolId: 'taladro', code: 'TAL-1' } },
    assignments: {
      a1: { techId: 'tA', toolId: 'llave', qty: 3, active: true, since: '2026-10-01T12:00:00.000Z' },
      a2: { techId: 'tA', toolId: 'taladro', unitId: 'u1', qty: 1, active: false, since: '2026-10-01T12:00:00.000Z' },
      a2b: { techId: 'tA', toolId: 'taladro', unitId: 'u1', qty: 1, active: true, since: '2026-10-20T12:00:00.000Z' },
      a3: { techId: 'tB', toolId: 'pinza', qty: 1, active: true, since: '2026-10-01T12:00:00.000Z' },
      a4: { cajaId: 'k1', toolId: 'llave', qty: 1, active: true, since: '2026-10-01T12:00:00.000Z' },
      a5: { techId: 'tX', toolId: 'pinza', qty: 1, active: false, since: '2026-09-01T12:00:00.000Z' },
    },
    controls: {
      // Ana, octubre semana 2: llave 2 bien + 1 faltante, taladro faltante (repuesto después).
      cA1: fin({ techId: 'tA', plantillaId: 'manana' }, { y: 2026, m: 10, w: 2 }, '2026-10-09T15:00:00.000Z', { a1: it('llave', 3, 2, 0, 1, { note: 'Se perdió una' }), a2: it('taladro', 1, 0, 0, 1, { unitCode: 'TAL-1', note: 'No está' }) }),
      // Ana, octubre semana 4: original y su corrección (la corrección es la vigente).
      cA2o: fin({ techId: 'tA', plantillaId: 'manana' }, { y: 2026, m: 10, w: 4 }, '2026-10-26T15:00:00.000Z', { a1: it('llave', 3, 3, 0, 0), a2b: it('taladro', 1, 1, 0, 0, { unitCode: 'TAL-1' }) }),
      cA2: fin({ techId: 'tA', plantillaId: 'manana' }, { y: 2026, m: 10, w: 4 }, '2026-10-27T15:00:00.000Z', { a1: it('llave', 3, 1, 1, 1), a2b: it('taladro', 1, 1, 0, 0, { unitCode: 'TAL-1' }) }, { supersedes: 'cA2o', correction: true, by: 'u-admin', cleaning: { status: 'requiere_limpieza', note: 'Grasa' } }),
      // Beto, noviembre semana 1: importado del Excel (limpieza sin dato) y la pinza sin contar ("sin dato").
      cB1: fin({ techId: 'tB', plantillaId: 'tarde' }, { y: 2026, m: 11, w: 1 }, '2026-11-03T15:00:00.000Z', {}, { importBatchId: 'b1', cleaning: { status: null, note: '' } }),
      // Xenia (eliminada), octubre semana 1.
      cX1: fin({ techId: 'tX', plantillaId: 'manana' }, { y: 2026, m: 10, w: 1 }, '2026-10-02T15:00:00.000Z', { a5: it('pinza', 1, 1, 0, 0) }),
      // Caja, septiembre (fuera del informe).
      cK0: fin({ cajaId: 'k1' }, { y: 2026, m: 9, w: 4 }, '2026-09-28T15:00:00.000Z', { a4: it('llave', 1, 1, 0, 0) }),
    },
    movements: {
      m1: { type: 'entrega_inicial', techId: 'tA', toolId: 'llave', qty: 3, at: '2026-10-01T12:00:00.000Z', by: 'u-resp', transfers: [tr('llave', 3, 'disponible', 'asignado')] },
      m2: { type: 'reposicion', techId: 'tA', toolId: 'taladro', qty: 1, oldAssignmentId: 'a2', newAssignmentId: 'a2b', newUnitId: 'u1', returned: true, at: '2026-10-20T12:00:00.000Z', by: 'u-resp', transfers: [tr('taladro', 1, 'asignado', 'baja'), tr('taladro', 1, 'disponible', 'asignado')] },
      m3: { type: 'entrega_inicial', techId: 'tB', toolId: 'pinza', qty: 1, at: '2026-10-01T12:00:00.000Z', by: 'u-resp', transfers: [tr('pinza', 1, 'disponible', 'asignado')] },
      m4: { type: 'adicional', techId: 'tB', toolId: 'pinza', qty: 1, at: '2026-11-05T12:00:00.000Z', by: 'u-resp', transfers: [tr('pinza', 1, 'disponible', 'asignado')] },
      m5: { type: 'anulacion', techId: 'tB', toolId: 'pinza', qty: 1, voidsMovementId: 'm4', at: '2026-11-06T12:00:00.000Z', by: 'u-admin', transfers: [tr('pinza', 1, 'asignado', 'disponible')] },
      m6: { type: 'ingreso', toolId: 'pinza', qty: 5, at: '2026-10-01T10:00:00.000Z', transfers: [tr('pinza', 5, 'externo', 'disponible')] },
    },
    alertRes: {},
  };
}

// Otras entradas del informe (como las arma la aplicación dentro de la misma instantánea).
export const purchases = () => [
  { id: 'p1', name: 'Compra 1', toolId: 'llave', toolName: 'Llave', techId: 'tA', holderName: 'Ana', reason: 'faltante', qty: 1, status: 'aprobada', decidedAt: '2026-10-10T15:00:00.000Z', decidedByName: 'Gerente', decisionComment: '', estimatedCost: 1500.5, supplier: 'Ferretería' },
  { id: 'p2', name: 'Compra 2', toolId: 'pinza', toolName: 'Pinza', techId: 'tB', holderName: 'Beto', reason: 'cambio', qty: 1, status: 'rechazada', decidedAt: '2026-11-04T15:00:00.000Z', decidedByName: 'Gerente', decisionComment: 'Hay en el pañol', estimatedCost: null, supplier: '' },
];
export const purchaseLinks = () => [{ requestId: 'p1', name: 'Compra 1', status: 'aprobada', reason: 'faltante', assignmentId: 'a1', controlId: 'cA1' }];
export const novedades = () => [
  { id: 'n1', name: 'Novedad 1', occurredAt: '2026-10-15T13:00:00.000Z', authorName: 'Rita Responsable', comment: 'Revisar llaves', techId: 'tA', techName: 'Ana', importBatchId: null },
  { id: 'n2', name: 'Novedad 2', occurredAt: '2026-09-15T13:00:00.000Z', authorName: 'Rita Responsable', comment: 'Fuera del período', techId: null },
];
export const ctxOf = (S, extra = {}) => ({
  S, now: NOW, actor: { id: 'u-admin', name: 'Admin Uno' }, perms: { purchasesView: true, novedadesView: true },
  empresa: { name: "Villa D'agri · Mantenimiento", logo: null }, purchases: purchases(), purchaseLinks: purchaseLinks(), novedades: novedades(), ...extra,
});
