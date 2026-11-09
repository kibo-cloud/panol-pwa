// Migración 011 sobre una base con controles de antes (etapa 3): los ítems pasan a cantidades
// según su estado (bueno -> todas en buen estado, cambio -> todas para recambio, faltante -> todas
// faltan), las notas y los totales no cambian, el trigger de inmutabilidad queda activo y los
// controles finalizados siguen sin poder modificarse. La limpieza queda sin dato.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createTestDatabase } from './harness.js';
import { createPool } from '../../src/adapters/pg/pool.js';
import { runMigrations, MIGRATIONS_DIR } from '../../src/adapters/pg/migrate.js';

let db;
let pool;
let dir;
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const codeOf = (p) => p.then(() => 'ok', (e) => e.code);

// Ítems de antes: [control, asignación, estado, nota, qty]. qty 0 solo puede venir de un .txt.
const ITEMS = [
  ['c-fin', 'a-1', 'bueno', null, 2],
  ['c-fin', 'a-2', 'cambio', 'gastada', 3],
  ['c-fin', 'a-3', 'faltante', 'no está', 4],
  ['c-fin', 'a-4', 'faltante', 'del txt', 0],
  ['c-bor', 'a-1', 'cambio', null, 1],
];
let before0;

before(async () => {
  db = await createTestDatabase();
  pool = createPool(db.url, { max: 3 });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panol-mig-'));
  for (const n of (await fs.readdir(MIGRATIONS_DIR)).filter((x) => /^\d{3}_/.test(x) && x.slice(0, 3) <= '010')) await fs.copyFile(path.join(MIGRATIONS_DIR, n), path.join(dir, n));
  await runMigrations(pool, { dir });
  await q("INSERT INTO techs (id, name, legajo) VALUES ('t-mig', 'Técnico Migración', 'MIG-1')");
  for (const [id, w] of [['c-fin', 1], ['c-bor', 2]]) {
    await q("INSERT INTO controls (id, tech_id, period_y, period_m, period_w, status, count_bueno, count_cambio, count_faltante) VALUES ($1, 't-mig', 2026, 3, $2, 'borrador', 2, 3, 4)", [id, w]);
  }
  for (const [c, a, st, note, qty] of ITEMS) await q('INSERT INTO control_items (control_id, assignment_id, state, note, qty) VALUES ($1, $2, $3, $4, $5)', [c, a, st, note, qty]);
  await q("UPDATE controls SET status = 'finalizado', finished_at = now() WHERE id = 'c-fin'");
  before0 = await q('SELECT id, version, updated_at, count_bueno, count_cambio, count_faltante FROM controls ORDER BY id');
  await runMigrations(pool);
});
after(async () => {
  await pool?.end().catch(() => {});
  await db?.cleanup();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('cantidades desde el estado; notas, estado y totales sin cambios', async () => {
  const rows = await q('SELECT control_id, assignment_id, state, note, qty, qty_expected, qty_good, qty_change, qty_missing, linea_id FROM control_items ORDER BY control_id, assignment_id');
  const want = {
    'c-bor|a-1': ['cambio', null, 1, 1, 0, 1, 0],
    'c-fin|a-1': ['bueno', null, 2, 2, 2, 0, 0],
    'c-fin|a-2': ['cambio', 'gastada', 3, 3, 0, 3, 0],
    'c-fin|a-3': ['faltante', 'no está', 4, 4, 0, 0, 4],
    'c-fin|a-4': ['faltante', 'del txt', 0, 0, 0, 0, 0],
  };
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.deepEqual([r.state, r.note, r.qty, r.qty_expected, r.qty_good, r.qty_change, r.qty_missing], want[`${r.control_id}|${r.assignment_id}`], r.assignment_id);
    assert.equal(r.linea_id, null);
  }
  // Los controles (finalizado incluido) no cambiaron: ni versión, ni fecha, ni totales; limpieza sin dato.
  assert.deepEqual(await q('SELECT id, version, updated_at, count_bueno, count_cambio, count_faltante FROM controls ORDER BY id'), before0);
  assert.deepEqual(await q('SELECT DISTINCT cleaning_status, cleaning_note FROM controls'), [{ cleaning_status: null, cleaning_note: null }]);
});

test('el trigger de inmutabilidad quedó activo: un finalizado no se toca', async () => {
  assert.deepEqual(await q("SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('control_items_immutable', 'controls_immutable') ORDER BY tgname"), [
    { tgname: 'control_items_immutable', tgenabled: 'O' },
    { tgname: 'controls_immutable', tgenabled: 'O' },
  ]);
  assert.equal(await codeOf(q("UPDATE control_items SET note = 'x' WHERE control_id = 'c-fin'")), '23001');
  assert.equal(await codeOf(q("UPDATE controls SET cleaning_status = 'limpio' WHERE id = 'c-fin'")), '23001');
  // El borrador sí se edita.
  assert.equal(await codeOf(q("UPDATE controls SET cleaning_status = 'limpio' WHERE id = 'c-bor'")), 'ok');
});

test('las restricciones nuevas: suma, no negativos, estado derivado, qty = esperadas, limpieza válida', async () => {
  const ins = (st, exp, g, c, m, qty = exp) => codeOf(q(
    'INSERT INTO control_items (control_id, assignment_id, state, qty, qty_expected, qty_good, qty_change, qty_missing) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    ['c-bor', `x-${Math.random().toString(36).slice(2)}`, st, qty, exp, g, c, m],
  ));
  assert.equal(await ins('faltante', 5, 3, 1, 1), 'ok');
  assert.equal(await ins('cambio', 5, 3, 2, 0), 'ok');
  assert.equal(await ins('bueno', 5, 3, 1, 0), '23514'); // no suma 5
  assert.equal(await ins('bueno', 2, 3, -1, 0), '23514'); // negativo
  assert.equal(await ins('bueno', 5, 4, 0, 1), '23514'); // estado no derivado
  assert.equal(await ins('cambio', 5, 0, 0, 5), '23514');
  assert.equal(await ins('bueno', 2, 2, 0, 0, 3), '23514'); // qty distinta
  assert.equal(await codeOf(q("INSERT INTO control_items (control_id, assignment_id, state, qty) VALUES ('c-bor', 'x-sin', 'bueno', 1)")), '23502');
  assert.equal(await codeOf(q("UPDATE controls SET cleaning_status = 'sucio' WHERE id = 'c-bor'")), '23514');
  assert.equal(await codeOf(q("UPDATE control_items SET linea_id = 'no-existe' WHERE control_id = 'c-bor' AND assignment_id = 'a-1'")), '23503');
});
