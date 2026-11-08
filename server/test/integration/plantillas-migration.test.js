// Migración 005 sobre una base con datos de la etapa 1: turnos -> plantillas, techs.shift_id +
// shift_changes -> historial de pertenencia, foto de la plantilla en los controles.
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

before(async () => {
  db = await createTestDatabase();
  pool = createPool(db.url, { max: 3 });
  // Solo las migraciones de la etapa 1 (001-004), para cargar datos con el esquema viejo.
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panol-mig-'));
  for (const n of (await fs.readdir(MIGRATIONS_DIR)).filter((x) => /^00[1-4]_/.test(x))) await fs.copyFile(path.join(MIGRATIONS_DIR, n), path.join(dir, n));
  await runMigrations(pool, { dir });

  await q("INSERT INTO shifts (id, name, sort_order) VALUES ('rotativo', 'Rotativo', 4)");
  await q(`INSERT INTO techs (id, name, legajo, shift_id) VALUES
    ('tA', 'Ana Migrada', 'M1', 'tarde'), ('tB', 'Beto Migrado', 'M2', 'manana'), ('tC', 'Caro Migrada', 'M3', NULL), ('tD', 'Dani Migrado', 'M4', 'tarde')`);
  await q(`INSERT INTO shift_changes (id, tech_id, from_shift_id, to_shift_id, from_name, to_name, effective_from, note, at, created_by) VALUES
    ('sc1', 'tA', 'manana', 'noche', 'Turno mañana', 'Turno noche', '2026-03-01', 'Pidió noche', '2026-02-28T12:00:00Z', 'u-old'),
    ('sc2b', 'tA', 'noche', 'rotativo', 'Turno noche', 'Rotativo', '2026-05-10', 'Primero', '2026-05-09T12:00:00Z', 'u-old'),
    ('sc2', 'tA', 'noche', 'tarde', 'Turno noche', 'Turno tarde', '2026-05-10', 'Corrección', '2026-05-09T13:00:00Z', 'u-old'),
    ('sc3', 'tC', NULL, 'noche', '', 'Turno noche', NULL, '', '2026-04-02T15:00:00Z', NULL),
    ('sc4', 'tD', 'viejo', 'tarde', 'Viejo', 'Turno tarde', '2026-02-01', '', '2026-02-01T12:00:00Z', NULL)`);
  // Controles finalizados: se insertan como borrador y se cierran (como la app).
  await q(`INSERT INTO controls (id, tech_id, tech_name, shift_id, period_y, period_m, period_w, status) VALUES
    ('cA', 'tA', 'Ana Migrada', 'manana', 2026, 4, 2, 'borrador'), ('cD', 'tD', 'Dani Migrado', 'tarde', 2026, 1, 1, 'borrador')`);
  await q("UPDATE controls SET status = 'finalizado', finished_at = '2026-04-10T12:00:00-03:00' WHERE id = 'cA'");
  await q("UPDATE controls SET status = 'finalizado', finished_at = '2026-01-05T12:00:00-03:00' WHERE id = 'cD'");

  await runMigrations(pool);
});
after(async () => {
  await pool?.end().catch(() => {});
  await db?.cleanup();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

const ranges = (tech) => q('SELECT id, plantilla_id AS p, valid_from::text AS f, valid_to::text AS t, reason, created_by FROM tech_plantilla_history WHERE tech_id = $1 ORDER BY valid_from NULLS FIRST', [tech]);

test('cada turno pasa a ser una plantilla con el mismo id, nombre y turno actual', async () => {
  const pl = await q('SELECT id, name, current_shift_label, supervisor_user_id, sort_order FROM plantillas ORDER BY sort_order');
  assert.deepEqual(pl.map((p) => [p.id, p.name, p.current_shift_label, p.supervisor_user_id]), [
    ['manana', 'Turno mañana', 'Turno mañana', null], ['tarde', 'Turno tarde', 'Turno tarde', null],
    ['noche', 'Turno noche', 'Turno noche', null], ['rotativo', 'Rotativo', 'Rotativo', null],
  ]);
  // Las tablas viejas quedan para lectura.
  assert.equal((await q('SELECT count(*)::int AS n FROM shift_changes'))[0].n, 5);
});

test('cambios de turno -> rangos por fecha desde; mismo día gana el último; el último rango es el turno actual', async () => {
  assert.deepEqual((await ranges('tA')).map((r) => [r.id.startsWith('ph-') ? 'ph' : r.id, r.p, r.f, r.t]), [
    ['ph', 'manana', null, '2026-03-01'],
    ['sc1', 'noche', '2026-03-01', '2026-05-10'],
    ['sc2', 'tarde', '2026-05-10', null],
  ]);
  const [, sc1] = await ranges('tA');
  assert.deepEqual([sc1.reason, sc1.created_by], ['Pidió noche', 'u-old']);
  assert.deepEqual((await ranges('tB')).map((r) => [r.p, r.f, r.t, r.reason]), [['manana', null, null, 'Migración de turnos']]);
  // Sin fecha desde: se usa la fecha local de `at`.
  assert.deepEqual((await ranges('tC')).map((r) => [r.id, r.p, r.f, r.t]), [['sc3', 'noche', '2026-04-02', null]]);
  // Turno de origen que ya no existe: hueco hasta el cambio.
  assert.deepEqual((await ranges('tD')).map((r) => [r.id, r.p, r.f, r.t]), [['sc4', 'tarde', '2026-02-01', null]]);
});

test('foto de la plantilla en los controles existentes (también finalizados), que siguen inmutables', async () => {
  const c = await q('SELECT id, plantilla_id_snapshot AS p FROM controls ORDER BY id');
  // cA: el 10/04 Ana estaba en noche (aunque el control decía manana). cD: sin rango ese día -> su turno.
  assert.deepEqual(c, [{ id: 'cA', p: 'noche' }, { id: 'cD', p: 'tarde' }]);
  await assert.rejects(q("UPDATE controls SET tech_name = 'x' WHERE id = 'cA'"), /finalizado/);
  assert.equal((await q("SELECT plantilla_on('tA', '2026-04-10') AS p"))[0].p, 'noche');
  assert.equal((await q("SELECT period_end(2026, 2, 4)::text AS d"))[0].d, '2026-02-28');
});
