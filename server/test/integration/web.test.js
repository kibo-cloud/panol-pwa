// La app web compilada: cabeceras de seguridad (CSP, nosniff, Referrer-Policy, HSTS solo en
// producción), caché por tipo de archivo y respuesta index.html para las rutas de la app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupApp } from './harness.js';
import { CSP } from '../../src/adapters/http/web-routes.js';

const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'panol-web-'));
fs.mkdirSync(path.join(dist, 'assets'));
fs.mkdirSync(path.join(dist, 'vendor'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Pañol</title>');
fs.writeFileSync(path.join(dist, 'sw.js'), '/* sw */');
fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), '{}');
fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'export {}');
fs.writeFileSync(path.join(dist, 'vendor', 'xlsx-0.18.5.full.min.js'), '/* xlsx */');

let ctx, prod;
before(async () => {
  ctx = await setupApp({ migrate: false, env: { WEB_DIST: dist } });
  prod = await setupApp({ migrate: false, env: { WEB_DIST: dist, NODE_ENV: 'production', APP_ORIGIN: 'https://panol.example' } });
});
after(async () => {
  await ctx?.close();
  await prod?.close();
  fs.rmSync(dist, { recursive: true, force: true });
});

const get = (app, url) => app.app.inject({ method: 'GET', url });

test('la CSP es la pedida, sin unsafe-inline', () => {
  assert.equal(CSP, "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  assert.doesNotMatch(CSP, /unsafe/);
});

test('index.html con CSP, nosniff, Referrer-Policy y sin caché; sin HSTS fuera de producción', async () => {
  const r = await get(ctx, '/');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.headers['content-security-policy'], CSP);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'same-origin');
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers['strict-transport-security'], undefined);
});

test('assets con hash y vendor: caché larga inmutable; sw.js y manifiesto sin caché', async () => {
  assert.equal((await get(ctx, '/assets/index-abc123.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal((await get(ctx, '/vendor/xlsx-0.18.5.full.min.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
  const sw = await get(ctx, '/sw.js');
  assert.equal(sw.statusCode, 200);
  assert.equal(sw.headers['cache-control'], 'no-cache');
  assert.equal((await get(ctx, '/manifest.webmanifest')).headers['cache-control'], 'no-cache');
});

test('una ruta de la app devuelve index.html; /api y archivos inexistentes, 404', async () => {
  const r = await get(ctx, '/tecnicos');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /<title>Pañol<\/title>/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  const api = await get(ctx, '/api/nada');
  assert.equal(api.statusCode, 404);
  assert.equal(api.json().error, 'route_not_found');
  assert.equal(api.headers['cache-control'], 'no-store');
  assert.equal((await get(ctx, '/assets/no-existe.js')).statusCode, 404);
  assert.equal((await ctx.app.inject({ method: 'POST', url: '/tecnicos' })).statusCode, 404);
});

test('las respuestas de la API también llevan las cabeceras de seguridad', async () => {
  const r = await get(ctx, '/api/health');
  assert.equal(r.headers['content-security-policy'], CSP);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('en producción se agrega HSTS', async () => {
  const r = await get(prod, '/');
  assert.equal(r.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
});
