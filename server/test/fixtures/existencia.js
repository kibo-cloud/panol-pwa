// Etapa 8: datos inventados de existencia por técnico, compartidos por las pruebas del servidor
// (server/test/unit/existencia.test.js) y por la de paridad de la web (web/test/existencia.test.js):
// los dos constructores de la matriz tienen que dar lo mismo con el mismo estado.

// Hoy (hora de Buenos Aires): miércoles 18 de marzo de 2026, 12:00.
export const NOW = new Date('2026-03-18T15:00:00.000Z');

const tr = (toolId, qty, from, to, unitId = null) => ({ toolId, qty, from, to, unitId });
const pk = (p) => ({ pkey: `${p.y}-${String(p.m).padStart(2, '0')}-${p.w}`, pnum: p.y * 1000 + p.m * 10 + p.w });
const fin = (id, holder, period, finishedAt, items) => ({ ...holder, period, ...pk(period), status: 'finalizado', finishedAt, counts: { bueno: 0, cambio: 0, faltante: 0 }, items });
export const it = (toolId, expected, good, change, missing) => ({ toolId, state: missing ? 'faltante' : change ? 'cambio' : 'bueno', expected, qty: expected, good, change, missing });

export function fixture() {
  return {
    shifts: [{ id: 'manana', name: 'Mañana', order: 1 }, { id: 'tarde', name: 'Tarde', order: 2 }],
    plantillas: { manana: { name: 'Mañana', order: 1 }, tarde: { name: 'Tarde', order: 2 } },
    especialidades: { e1: { name: 'Mecánico', order: 1 } },
    techs: {
      tA: { name: 'Ana', legajo: '10', shiftId: 'manana', plantillaId: 'manana', especialidadId: 'e1', active: true },
      tB: { name: 'Beto', legajo: '20', shiftId: 'tarde', plantillaId: 'tarde', active: true },
      tC: { name: 'Ciro', legajo: '30', shiftId: 'manana', plantillaId: 'manana', active: true },
      tX: { name: 'Xenia', legajo: '90', shiftId: 'manana', plantillaId: 'manana', active: false, archivedAt: '2026-03-01T12:00:00.000Z' },
    },
    cajas: { k1: { name: 'Caja L1', lineaId: 'l1' }, k9: { name: 'Caja vieja', archivedAt: '2026-02-01T12:00:00.000Z' } },
    categories: { cat: { name: 'Manuales', order: 1 } },
    tools: {
      llave: { name: 'Llave', categoryId: 'cat', order: 2, serialized: false },
      pinza: { name: 'Pinza', categoryId: 'cat', order: 1, serialized: false },
      taladro: { name: 'Taladro', categoryId: 'cat', order: 3, serialized: true },
      vieja: { name: 'Vieja', categoryId: 'cat', order: 4, active: false, archivedAt: '2026-02-01T12:00:00.000Z' },
    },
    units: { u1: { toolId: 'taladro', code: 'TAL-1' }, u2: { toolId: 'taladro', code: 'TAL-2' } },
    assignments: {
      a1: { techId: 'tA', toolId: 'llave', qty: 5, active: true, since: '2026-02-01T12:00:00.000Z' },
      a2: { techId: 'tA', toolId: 'taladro', unitId: 'u1', qty: 1, active: true, since: '2026-02-01T12:00:00.000Z' },
      a3: { techId: 'tA', toolId: 'taladro', unitId: 'u2', qty: 1, active: true, since: '2026-02-01T12:00:00.000Z' },
      a4: { techId: 'tB', toolId: 'pinza', qty: 2, active: true, since: '2026-02-20T12:00:00.000Z' },
      a5: { cajaId: 'k1', toolId: 'llave', qty: 1, active: true, since: '2026-03-01T12:00:00.000Z' },
      a6: { techId: 'tX', toolId: 'pinza', qty: 1, active: true, since: '2026-01-01T12:00:00.000Z' },
      a7: { techId: 'tA', toolId: 'vieja', qty: 1, active: true, since: '2026-01-01T12:00:00.000Z' },
      a8: { techId: 'tA', toolId: 'pinza', qty: 3, active: false, since: '2026-01-01T12:00:00.000Z' },
      // Entregada después del último control de Ana: suma en la celda, sin marcas.
      a9: { techId: 'tA', toolId: 'pinza', qty: 1, active: true, since: '2026-03-12T12:00:00.000Z' },
    },
    controls: {
      // Corregido por c2 (mismo período): no es el vigente.
      c1: fin('c1', { techId: 'tA' }, { y: 2026, m: 3, w: 2 }, '2026-03-09T15:00:00.000Z', { a1: it('llave', 5, 0, 0, 5), a2: it('taladro', 1, 1, 0, 0), a3: it('taladro', 1, 1, 0, 0) }),
      // Finalizado el 9 de marzo a las 23:30 de Buenos Aires (10 de marzo en UTC).
      c2: { ...fin('c2', { techId: 'tA' }, { y: 2026, m: 3, w: 2 }, '2026-03-10T02:30:00.000Z', { a1: it('llave', 5, 2, 2, 1), a2: it('taladro', 1, 0, 1, 0), a3: it('taladro', 1, 0, 0, 1), a7: it('vieja', 1, 0, 0, 1) }), supersedes: 'c1', correction: true },
      c3: fin('c3', { techId: 'tA' }, { y: 2026, m: 2, w: 4 }, '2026-02-25T15:00:00.000Z', { a1: it('llave', 5, 5, 0, 0) }),
      d1: { techId: 'tC', period: { y: 2026, m: 3, w: 3 }, ...pk({ y: 2026, m: 3, w: 3 }), status: 'borrador', items: {} },
    },
    movements: {
      m1: { type: 'ingreso', toolId: 'llave', at: '2026-01-01T12:00:00.000Z', transfers: [tr('llave', 10, 'externo', 'disponible'), tr('llave', 6, 'disponible', 'asignado')] },
      m2: { type: 'ingreso', toolId: 'pinza', at: '2026-01-01T12:00:00.000Z', transfers: [tr('pinza', 7, 'externo', 'disponible'), tr('pinza', 4, 'disponible', 'asignado')] },
    },
    alertRes: {},
  };
}

// Revisión de la etapa 8 (E8.V1): los casos que tienen que coincidir entre servidor y web.
// - Dora: un control viejo y ninguna herramienta activa (nunca "vencida", sin alerta).
// - "Inactiva": desactivada pero no eliminada, todavía asignada a Beto (cuenta y se marca).
// - La caja tiene un control finalizado sin `finishedAt` (fecha = inicio de su semana).
export function reviewFixture() {
  const S = fixture();
  S.techs.tD = { name: 'Dora', legajo: '40', shiftId: 'manana', plantillaId: 'manana', active: true };
  S.tools.inact = { name: 'Inactiva', categoryId: 'cat', order: 5, active: false };
  S.assignments.a10 = { techId: 'tB', toolId: 'inact', qty: 1, active: true, since: '2026-02-20T12:00:00.000Z' };
  S.controls.c5 = fin('c5', { techId: 'tD' }, { y: 2026, m: 2, w: 1 }, '2026-02-02T15:00:00.000Z', {});
  const c6 = fin('c6', { cajaId: 'k1' }, { y: 2026, m: 3, w: 1 }, null, { a5: it('llave', 1, 0, 1, 0) });
  delete c6.finishedAt;
  S.controls.c6 = c6;
  return S;
}
