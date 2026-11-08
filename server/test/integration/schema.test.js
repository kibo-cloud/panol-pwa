import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupApp } from './harness.js';
import { runMigrations, listMigrations } from '../../src/adapters/pg/migrate.js';
import { withTransaction } from '../../src/adapters/pg/pool.js';
import { loadInventoryContext, loadControls, applyMovementPlan } from '../../src/adapters/pg/inventory-repo.js';
import { planMovement } from '../../src/domain/movements.js';
import { seed } from '../../scripts/seed.js';

let ctx;
let q;
before(async () => {
  ctx = await setupApp({ migrate: false });
  q = (sql, params) => ctx.pool.query(sql, params);
});
after(async () => {
  await ctx?.close();
});

const restricted = { code: '23001' }; // restrict_violation

test('las migraciones se aplican desde una base vacía y una segunda corrida no hace nada', async () => {
  const all = (await listMigrations()).map((m) => m.name);
  assert.deepEqual(await runMigrations(ctx.pool), all);
  assert.deepEqual(await runMigrations(ctx.pool), []);
  const { rows } = await q("SELECT count(*)::int AS n FROM shifts");
  assert.equal(rows[0].n, 3);
});

test('la semilla inventada carga stock coherente con el libro', async () => {
  const s = await seed(ctx.pool, { now: new Date('2026-03-18T12:00:00-03:00') });
  assert.equal(s.controls, 2);
  const inv = await loadInventoryContext(ctx.pool);
  assert.equal(inv.pools['tool-pinza'].disponible, 17);
  assert.equal(inv.pools['tool-pinza'].asignado, 3);
  assert.equal(inv.pools['tool-multimetro'].disponible, 2);
  const units = Object.values(inv.units).filter((u) => u.status === 'asignado').map((u) => u.code).sort();
  assert.deepEqual(units, ['MUL-001', 'TAL-001']);
  const ctls = await loadControls(ctx.pool);
  assert.deepEqual(ctls.map((c) => c.status).sort(), ['borrador', 'finalizado']);
  const finItems = Object.keys(ctls.find((c) => c.status === 'finalizado').items);
  assert.deepEqual(finItems.map((a) => inv.stateOf[a].state).sort(), ['bueno', 'bueno', 'cambio']);
});

test('el libro de movimientos es de solo agregar', async () => {
  const { rows } = await q('SELECT id FROM movements LIMIT 1');
  const id = rows[0].id;
  await assert.rejects(q("UPDATE movements SET notes = 'x' WHERE id = $1", [id]), restricted);
  await assert.rejects(q('DELETE FROM movements WHERE id = $1', [id]), restricted);
  await assert.rejects(q('UPDATE movement_transfers SET qty = 99 WHERE movement_id = $1', [id]), restricted);
  await assert.rejects(q('DELETE FROM movement_transfers WHERE movement_id = $1', [id]), restricted);
  await assert.rejects(q('TRUNCATE movement_transfers'), restricted);
});

test('la auditoría es de solo agregar', async () => {
  await q("INSERT INTO audit_log (id, action, detail) VALUES ('l-test', 'test', 'x')");
  await assert.rejects(q("UPDATE audit_log SET detail = 'y' WHERE id = 'l-test'"), restricted);
  await assert.rejects(q("DELETE FROM audit_log WHERE id = 'l-test'"), restricted);
});

test('un control finalizado y sus ítems no se modifican ni se borran', async () => {
  const { rows } = await q("SELECT id FROM controls WHERE status = 'finalizado'");
  const id = rows[0].id;
  await assert.rejects(q("UPDATE controls SET count_bueno = 99 WHERE id = $1", [id]), restricted);
  await assert.rejects(q("UPDATE controls SET status = 'borrador' WHERE id = $1", [id]), restricted);
  await assert.rejects(q('DELETE FROM controls WHERE id = $1', [id]), restricted);
  await assert.rejects(q("UPDATE control_items SET state = 'bueno' WHERE control_id = $1", [id]), restricted);
  await assert.rejects(q('DELETE FROM control_items WHERE control_id = $1', [id]), restricted);
  await assert.rejects(q("INSERT INTO control_items (control_id, assignment_id, state) VALUES ($1, 'a-nuevo', 'bueno')", [id]), restricted);
});

test('un borrador se edita y sube su versión', async () => {
  const { rows } = await q("SELECT id, version FROM controls WHERE status = 'borrador'");
  const { id, version } = rows[0];
  await q("UPDATE control_items SET note = 'ok' WHERE control_id = $1", [id]);
  const r = await q('UPDATE controls SET count_bueno = count_bueno WHERE id = $1 RETURNING version', [id]);
  assert.equal(r.rows[0].version, version + 1);
});

test('un solo control original por técnico y período; las correcciones no cuentan', async () => {
  const { rows } = await q("SELECT id, tech_id, period_y, period_m, period_w FROM controls WHERE status = 'finalizado'");
  const c = rows[0];
  await assert.rejects(
    q("INSERT INTO controls (id, tech_id, period_y, period_m, period_w, status) VALUES ('c-dup', $1, $2, $3, $4, 'borrador')", [c.tech_id, c.period_y, c.period_m, c.period_w]),
    { code: '23505' },
  );
  await q("INSERT INTO controls (id, tech_id, period_y, period_m, period_w, status, correction, supersedes_id) VALUES ('k-1', $1, $2, $3, $4, 'borrador', true, $5)", [c.tech_id, c.period_y, c.period_m, c.period_w, c.id]);
  await q("INSERT INTO controls (id, tech_id, period_y, period_m, period_w, status, correction, supersedes_id) VALUES ('k-2', $1, $2, $3, $4, 'borrador', true, $5)", [c.tech_id, c.period_y, c.period_m, c.period_w, c.id]);
  // Corrección sin control corregido: no.
  await assert.rejects(q("INSERT INTO controls (id, tech_id, period_y, period_m, period_w, status, correction) VALUES ('k-3', $1, 2026, 1, 1, 'borrador', true)", [c.tech_id]), { code: '23514' });
  // Semana fuera de 1..4: no.
  await assert.rejects(q("INSERT INTO controls (id, tech_id, period_y, period_m, period_w, status) VALUES ('c-w5', $1, 2026, 1, 5, 'borrador')", [c.tech_id]), { code: '23514' });
});

test('restricciones: id de 2.1, pools, legajo y código de unidad únicos', async () => {
  await assert.rejects(q("INSERT INTO categories (id, name) VALUES ('a b', 'x')"), { code: '23514' });
  await assert.rejects(q("INSERT INTO categories (id, name) VALUES ('__proto__', 'x')"), { code: '23514' });
  await assert.rejects(q("INSERT INTO techs (id, name, legajo) VALUES ('t-x', 'X', 'DEV-001')"), { code: '23505' });
  await q("INSERT INTO techs (id, name) VALUES ('t-sin1', 'Sin legajo 1'), ('t-sin2', 'Sin legajo 2')");
  await assert.rejects(q("INSERT INTO units (id, tool_id, code, status) VALUES ('u-x', 'tool-taladro', 'tal-001', 'disponible')"), { code: '23505' });
  await assert.rejects(q("INSERT INTO units (id, tool_id, code, status) VALUES ('u-y', 'tool-taladro', 'TAL-099', 'perdido')"), { code: '23514' });
  await assert.rejects(q("INSERT INTO movements (id, type) VALUES ('m-x', 'regalo')"), { code: '23514' });
  await assert.rejects(q("INSERT INTO categories (id, name) VALUES ('c-long', $1)", ['x'.repeat(501)]), { code: '23514' });
});

test('una devolución pendiente se recibe una sola vez', async () => {
  await withTransaction(ctx.pool, async (c) => {
    let inv = await loadInventoryContext(c);
    const asgId = Object.entries(inv.assignments).find(([, a]) => a.techId === 't-ana' && a.toolId === 'tool-pinza')[0];
    let n = 0;
    const newId = (p) => `${p}t${++n}`;
    const rep = planMovement(inv, { type: 'reposicion', techId: 't-ana', asgId, returned: false }, { at: new Date().toISOString(), newId });
    await applyMovementPlan(c, rep);
    inv = await loadInventoryContext(c);
    assert.equal(inv.pendingReturns.length, 1);
    const rec = planMovement(inv, { type: 'recepcion', resolvesMovementId: rep.movement.id, cond: 'disponible' }, { at: new Date().toISOString(), newId });
    await applyMovementPlan(c, rec);
    const dup = { ...rec, movement: { ...rec.movement, id: 'm-dup' }, transfers: [] };
    await assert.rejects(applyMovementPlan(c, dup), { code: '23505' });
  });
});

test('fechas: la sesión usa la hora de Buenos Aires', async () => {
  const { rows } = await q("SELECT to_char(timestamptz '2026-03-08 01:30:00+00', 'YYYY-MM-DD HH24:MI') AS local");
  assert.equal(rows[0].local, '2026-03-07 22:30');
});
