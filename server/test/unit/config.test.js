import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig, loadEnvFile, requireDevEnvironment, TIME_ZONE } from '../../src/config.js';

const PROD = { NODE_ENV: 'production', APP_ORIGIN: 'https://panol.example', DATABASE_URL: 'postgres://panol_app:x@db:5432/panol' };

test('fuerza la zona horaria de la empresa en el proceso', () => {
  assert.equal(process.env.TZ, TIME_ZONE);
  assert.equal(TIME_ZONE, 'America/Argentina/Buenos_Aires');
});

test('valores por defecto de desarrollo (NODE_ENV explícito)', () => {
  const c = buildConfig({ NODE_ENV: 'development' });
  assert.equal(c.nodeEnv, 'development');
  assert.equal(c.port, 3000);
  assert.equal(c.cookieSecure, false);
  assert.match(c.databaseUrl, /^postgres:\/\/panol_app:/);
  assert.match(c.migrationDatabaseUrl, /^postgres:\/\/postgres:/);
});

test('sin NODE_ENV se toma producción y exige APP_ORIGIN y DATABASE_URL', () => {
  assert.throws(() => buildConfig({}), /APP_ORIGIN/);
  assert.throws(() => buildConfig({ APP_ORIGIN: 'https://panol.example' }), /DATABASE_URL/);
  const c = buildConfig({ APP_ORIGIN: 'https://panol.example', DATABASE_URL: PROD.DATABASE_URL });
  assert.equal(c.nodeEnv, 'production');
  assert.equal(c.migrationDatabaseUrl, '');
});

test('NODE_ENV desconocido: se rechaza', () => {
  assert.throws(() => buildConfig({ ...PROD, NODE_ENV: 'staging' }), /NODE_ENV/);
});

test('en producción la cookie es siempre Secure', () => {
  assert.equal(buildConfig({ ...PROD, COOKIE_SECURE: 'false' }).cookieSecure, true);
});

test('la semilla y db:reset solo corren en desarrollo o pruebas', () => {
  assert.throws(() => requireDevEnvironment(buildConfig(PROD), 'db:reset'), /db:reset/);
  assert.doesNotThrow(() => requireDevEnvironment(buildConfig({ NODE_ENV: 'development' }), 'db:reset'));
  assert.doesNotThrow(() => requireDevEnvironment(buildConfig({ NODE_ENV: 'test' }), 'db:reset'));
});

test('rechaza números inválidos', () => {
  assert.throws(() => buildConfig({ NODE_ENV: 'development', PORT: 'abc' }), /numérico/);
});

test('.env no pisa variables ya definidas', () => {
  const file = path.join(os.tmpdir(), `panol-env-${process.pid}`);
  fs.writeFileSync(file, 'PORT=4000\nHOST=0.0.0.0\n');
  try {
    const env = { PORT: '5000' };
    assert.equal(loadEnvFile(file, env), true);
    assert.equal(env.PORT, '5000');
    assert.equal(env.HOST, '0.0.0.0');
  } finally {
    fs.rmSync(file);
  }
});
