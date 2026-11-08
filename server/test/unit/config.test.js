import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig, loadEnvFile, TIME_ZONE } from '../../src/config.js';

test('fuerza la zona horaria de la empresa en el proceso', () => {
  assert.equal(process.env.TZ, TIME_ZONE);
  assert.equal(TIME_ZONE, 'America/Argentina/Buenos_Aires');
});

test('valores por defecto de desarrollo', () => {
  const c = buildConfig({});
  assert.equal(c.nodeEnv, 'development');
  assert.equal(c.port, 3000);
  assert.equal(c.cookieSecure, false);
  assert.match(c.databaseUrl, /^postgres:\/\//);
});

test('en producción la cookie es siempre Secure', () => {
  assert.equal(buildConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure, true);
});

test('rechaza números inválidos', () => {
  assert.throws(() => buildConfig({ PORT: 'abc' }));
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
