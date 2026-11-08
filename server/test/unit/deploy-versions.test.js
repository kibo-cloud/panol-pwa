// La versión de PostgreSQL es una sola: server/pg-version.json manda y la siguen
// embedded-postgres (desarrollo y pruebas), el Compose, la imagen de copias y el CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../../src/config.js';

const read = (f) => fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
const pgv = JSON.parse(read('server/pg-version.json'));
const images = (text, name) => [...text.matchAll(new RegExp(`(?:image:|FROM)\\s+(${name}:[^\\s'"]+)`, 'g'))].map((m) => m[1]);

test('pg-version.json es coherente consigo mismo y con embedded-postgres', () => {
  assert.equal(pgv.composeImage, `postgres:${pgv.postgres}`);
  assert.ok(pgv.embeddedPostgres.startsWith(pgv.postgres + '.'), pgv.embeddedPostgres);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.devDependencies['embedded-postgres'], pgv.embeddedPostgres);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/embedded-postgres'].version, pgv.embeddedPostgres);
});

test('el Compose usa la imagen de pg-version.json', () => {
  assert.deepEqual(images(read('docker-compose.yml'), 'postgres'), [pgv.composeImage]);
});

test('la imagen de copias usa la misma versión (variante alpine)', () => {
  assert.deepEqual(images(read('deploy/backup/Dockerfile'), 'postgres'), [`${pgv.composeImage}-alpine`]);
});

test('el CI prueba contra la misma imagen', () => {
  const ci = images(read('.github/workflows/ci.yml'), 'postgres');
  assert.ok(ci.length >= 2, 'servicios postgres en el CI');
  for (const img of ci) assert.equal(img, pgv.composeImage);
});

test('la imagen de la app es Node 22 con la versión menor fijada', () => {
  const node = images(read('Dockerfile'), 'node');
  assert.ok(node.length >= 1);
  for (const img of node) assert.match(img, /^node:22\.\d+-alpine$/);
});
