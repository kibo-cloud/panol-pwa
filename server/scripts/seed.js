// Datos inventados para desarrollo (`npm run db:reset`). Nunca se cargan datos reales.
// Los movimientos pasan por el mismo planificador del dominio que usa la API, así el stock
// sembrado es coherente con el libro de movimientos.
import { withTransaction } from '../src/adapters/pg/pool.js';
import { loadInventoryContext, applyMovementPlan, saveControl } from '../src/adapters/pg/inventory-repo.js';
import { planMovement } from '../src/domain/movements.js';
import { buildControlDoc } from '../src/domain/controls.js';
import { periodOf, prevP, pkeyOf } from '../src/domain/period.js';
import { hashPassword } from '../src/application/passwords.js';
import { requireDevEnvironment } from '../src/config.js';

// Usuarios de desarrollo, uno o más por perfil. Contraseña de todos: DEV_PASSWORD (solo local).
export const DEV_PASSWORD = 'panol-dev-1234';
const USERS = [
  ['u-admin', 'admin', 'Admin Desarrollo', 'admin'],
  ['u-gerencia', 'gerencia', 'Gerencia Desarrollo', 'gerencia'],
  ['u-supervisor', 'supervisor', 'Supervisor Desarrollo', 'supervisor'],
  ['u-responsable', 'responsable', 'Responsable Desarrollo', 'responsable'],
  ['u-responsable2', 'responsable2', 'Responsable Dos', 'responsable'],
  ['u-consulta', 'consulta', 'Consulta Desarrollo', 'consulta'],
];

const TECHS = [
  ['t-ana', 'Ana Prueba', 'DEV-001', 'manana'],
  ['t-bruno', 'Bruno Ejemplo', 'DEV-002', 'tarde'],
  ['t-carla', 'Carla Demo', 'DEV-003', 'noche'],
  ['t-dario', 'Darío Inactivo', 'DEV-004', 'manana', false],
];
const CATEGORIES = [
  ['cat-manuales', 'Herramientas manuales'],
  ['cat-electricas', 'Herramientas eléctricas'],
  ['cat-medicion', 'Medición'],
];
const TOOLS = [
  ['tool-pinza', 'Pinza universal', 'cat-manuales', false],
  ['tool-destornillador', 'Destornillador plano', 'cat-manuales', false],
  ['tool-multimetro', 'Multímetro digital', 'cat-medicion', true],
  ['tool-taladro', 'Taladro percutor', 'cat-electricas', true],
];

export async function seed(pool, { now = new Date(), config } = {}) {
  // Datos y contraseñas de desarrollo: nunca en producción (ni con NODE_ENV sin definir).
  requireDevEnvironment(config ?? { nodeEnv: process.env.NODE_ENV || 'production' }, 'La semilla de desarrollo');
  let n = 0;
  const newId = (p) => `${p}seed${++n}`;
  const at = (daysAgo) => new Date(now.getTime() - daysAgo * 864e5).toISOString();
  const summary = { users: USERS.length, techs: TECHS.length, categories: CATEGORIES.length, tools: TOOLS.length, movements: 0, controls: 0 };

  const hash = await hashPassword(DEV_PASSWORD);
  await withTransaction(pool, async (c) => {
    for (const [id, username, name, role] of USERS) {
      await c.query('INSERT INTO users (id, username, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,false)', [id, username, name, role, hash]);
    }
    for (const [id, name, legajo, shift, active = true] of TECHS) {
      await c.query('INSERT INTO techs (id, name, legajo, shift_id, active, alta) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, legajo, shift, active, at(120).slice(0, 10)]);
    }
    for (const [id, name] of CATEGORIES) await c.query('INSERT INTO categories (id, name) VALUES ($1,$2)', [id, name]);
    for (const [id, name, cat, serialized] of TOOLS) {
      await c.query('INSERT INTO tools (id, name, category_id, serialized) VALUES ($1,$2,$3,$4)', [id, name, cat, serialized]);
    }

    const moves = [
      [40, { type: 'ingreso', toolId: 'tool-pinza', qty: 20, notes: 'Compra inicial (dato inventado)' }],
      [40, { type: 'ingreso', toolId: 'tool-destornillador', qty: 30 }],
      [40, { type: 'ingreso', toolId: 'tool-multimetro', codes: 'MUL-001\nMUL-002\nMUL-003' }],
      [40, { type: 'ingreso', toolId: 'tool-taladro', codes: 'TAL-001, TAL-002' }],
      [30, { type: 'entrega_inicial', techId: 't-ana', toolId: 'tool-pinza', qty: 2, reason: 'Ingreso del técnico' }],
      [30, { type: 'entrega_inicial', techId: 't-ana', toolId: 'tool-destornillador', qty: 1 }],
      [30, { type: 'entrega_inicial', techId: 't-ana', toolId: 'tool-taladro', unitId: 'TAL-001' }],
      [29, { type: 'entrega_inicial', techId: 't-bruno', toolId: 'tool-pinza', qty: 1 }],
      [29, { type: 'entrega_inicial', techId: 't-bruno', toolId: 'tool-multimetro', unitId: 'MUL-001' }],
      [28, { type: 'entrega_inicial', techId: 't-carla', toolId: 'tool-destornillador', qty: 2 }],
    ];
    for (const [daysAgo, m0] of moves) {
      const ctx = await loadInventoryContext(c);
      const m = { ...m0 };
      // En la lista de arriba la unidad se nombra por código; el plan usa su id.
      if (m.unitId) m.unitId = Object.entries(ctx.units).find(([, u]) => u.code === m.unitId)[0];
      const plan = planMovement(ctx, m, { at: at(daysAgo), newId });
      await applyMovementPlan(c, plan, { auditId: newId('l') });
      summary.movements++;
    }

    // Un control finalizado de la semana anterior (Ana) y un borrador de esta semana (Bruno).
    const ctx = await loadInventoryContext(c);
    const cats = Object.fromEntries(CATEGORIES.map(([id, name]) => [id, { name }]));
    const asgOf = (tid) => Object.entries(ctx.assignments).filter(([, a]) => a.techId === tid).map(([id, a]) => ({ id, ...a }));
    const cur = periodOf(now);
    const prev = prevP(cur);
    const anaAsg = asgOf('t-ana');
    const anaItems = Object.fromEntries(anaAsg.map((a, i) => [a.id, i === 0 ? { state: 'cambio', note: 'Mordaza gastada' } : { state: 'bueno' }]));
    const done = buildControlDoc({ tech: { id: 't-ana', name: 'Ana Prueba', shiftId: 'manana' }, period: prev, assignments: anaAsg, items: anaItems, tools: ctx.tools, units: ctx.units, categories: cats, status: 'finalizado' });
    await saveControl(c, `c-t-ana-${pkeyOf(prev)}`, done, { startedAt: at(8), finishedAt: at(7) });
    const brunoAsg = asgOf('t-bruno');
    const draft = buildControlDoc({ tech: { id: 't-bruno', name: 'Bruno Ejemplo', shiftId: 'tarde' }, period: cur, assignments: brunoAsg, items: { [brunoAsg[0].id]: { state: 'bueno' } }, tools: ctx.tools, units: ctx.units, categories: cats, status: 'borrador' });
    await saveControl(c, `c-t-bruno-${pkeyOf(cur)}`, draft, { startedAt: at(0) });
    summary.controls = 2;
  });
  return summary;
}
