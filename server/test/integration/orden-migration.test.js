// Migraciones 009 + 010 sobre una base con categorías y herramientas de antes (etapa 2): el orden
// inicial es el de localeCompare('es') (acentos, mayúsculas, ñ, sin categoría, nombres iguales
// por id) sin depender de la intercalación de la base, y ninguna versión cambia. Un alcance que
// ya tenía orden propio (versión mayor a 1) no se toca.
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
const dirs = [];
const q = async (sql, p) => (await pool.query(sql, p)).rows;

// Copia de las migraciones hasta `last` (incluida).
async function migrationsUpTo(last) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panol-mig-'));
  dirs.push(dir);
  for (const n of (await fs.readdir(MIGRATIONS_DIR)).filter((x) => /^\d{3}_/.test(x) && x.slice(0, 3) <= last)) await fs.copyFile(path.join(MIGRATIONS_DIR, n), path.join(dir, n));
  return dir;
}

const CATS = [['g-z', 'zeta'], ['g-arbol', 'Árbol'], ['g-arco', 'arco'], ['g-enie', 'Ñandú'], ['g-nube', 'nube'], ['g-el2', 'Él'], ['g-el1', 'el'], ['g-med-b', 'Medición'], ['g-med-a', 'Medición']];
const TOOLS = [
  ['h-1', 'Llave', 'g-arco'], ['h-2', 'lima', 'g-arco'], ['h-3', 'Ñato', 'g-arco'], ['h-4', 'nuez', 'g-arco'], ['h-5', 'Martillo', 'g-arco'],
  ['h-6', 'martillo de goma', 'g-arco'], ['h-9', 'Pinza', 'g-arco'], ['h-7', 'Pinza', 'g-arco'], ['h-8', 'óhmetro', 'g-arco'],
  ['h-a', 'Éxito', null], ['h-b', 'exacto', null], ['h-c', 'Zapa', null], ['h-d', 'año', null], ['h-e', 'anillo', null],
  // Este alcance ya tiene un orden propio antes de la 010 (versión 2): se respeta.
  ['h-x', 'Bravo', 'g-z'], ['h-y', 'Alfa', 'g-z'], ['h-w', 'Charlie', 'g-z'],
];
const esOrder = (rows) => [...rows].sort((a, b) => a.name.localeCompare(b.name, 'es') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => r.id);
let versions0;

before(async () => {
  db = await createTestDatabase();
  pool = createPool(db.url, { max: 3 });
  await runMigrations(pool, { dir: await migrationsUpTo('008') });
  for (const [id, name] of CATS) await q('INSERT INTO categories (id, name) VALUES ($1, $2)', [id, name]);
  for (const [id, name, cat] of TOOLS) await q('INSERT INTO tools (id, name, category_id) VALUES ($1, $2, $3)', [id, name, cat]);
  // Una edición de antes: versiones distintas de 1.
  await q("UPDATE tools SET description = 'editada' WHERE id IN ('h-1', 'h-a')");
  versions0 = await q("SELECT * FROM (SELECT id, version, updated_at FROM tools UNION ALL SELECT id, version, updated_at FROM categories) x ORDER BY id COLLATE \"C\"");
  await runMigrations(pool, { dir: await migrationsUpTo('009') });
  // Orden propio de "zeta" (como si alguien lo hubiera reordenado): Charlie, Bravo, Alfa.
  await q("INSERT INTO order_versions (scope, version) VALUES ('tools:g-z', 2)");
  await q("UPDATE tools SET sort_order = CASE id WHEN 'h-w' THEN 1 WHEN 'h-x' THEN 2 ELSE 3 END WHERE category_id = 'g-z'");
  await runMigrations(pool);
});
after(async () => {
  await pool?.end().catch(() => {});
  await db?.cleanup();
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

const ordered = (sql, p) => q(sql, p).then((r) => r.map((x) => x.id));

test('categorías: orden de localeCompare(es), nombres iguales por id', async () => {
  const want = esOrder(CATS.map(([id, name]) => ({ id, name })));
  assert.deepEqual(await ordered('SELECT id FROM categories ORDER BY sort_order'), want);
  assert.deepEqual((await q('SELECT sort_order FROM categories ORDER BY sort_order')).map((r) => r.sort_order), want.map((_, i) => i + 1));
});

test('herramientas por categoría y sin categoría: orden de localeCompare(es)', async () => {
  const of = (cat) => TOOLS.filter((t) => t[2] === cat).map(([id, name]) => ({ id, name }));
  assert.deepEqual(await ordered("SELECT id FROM tools WHERE category_id = 'g-arco' ORDER BY sort_order"), esOrder(of('g-arco')));
  assert.deepEqual(await ordered('SELECT id FROM tools WHERE category_id IS NULL ORDER BY sort_order'), esOrder(of(null)));
  // Ejemplos explícitos: la ñ después de la n, acentos y mayúsculas no separan.
  assert.deepEqual(await ordered("SELECT id FROM tools WHERE category_id = 'g-arco' ORDER BY sort_order"), ['h-2', 'h-1', 'h-5', 'h-6', 'h-4', 'h-3', 'h-8', 'h-7', 'h-9']);
  assert.deepEqual(await ordered('SELECT id FROM tools WHERE category_id IS NULL ORDER BY sort_order'), ['h-e', 'h-d', 'h-b', 'h-a', 'h-c']);
});

test('un alcance ya reordenado no se toca', async () => {
  assert.deepEqual(await ordered("SELECT id FROM tools WHERE category_id = 'g-z' ORDER BY sort_order"), ['h-w', 'h-x', 'h-y']);
});

test('ninguna versión cambia (filas y alcances)', async () => {
  const now = await q("SELECT * FROM (SELECT id, version, updated_at FROM tools UNION ALL SELECT id, version, updated_at FROM categories) x ORDER BY id COLLATE \"C\"");
  assert.deepEqual(now, versions0);
  assert.deepEqual(await q('SELECT scope, version FROM order_versions'), [{ scope: 'tools:g-z', version: 2 }]);
});
