// Cliente de la API: cabeceras (CSRF, If-Match, Idempotency-Key) y errores tipados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, toApiError, kindOf, ApiError, newIdempotencyKey, OFFLINE_MESSAGE } from '../src/api/client.js';

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => ({ 'content-type': 'application/json', ...headers })[k.toLowerCase()] ?? null },
  json: async () => body, text: async () => JSON.stringify(body),
});
function fake(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); const r = responses.shift(); if (r instanceof Error) throw r; return r; };
  return { calls, fetchImpl };
}

test('GET no manda CSRF; POST manda X-CSRF-Token, JSON, If-Match e Idempotency-Key', async () => {
  const f = fake(res(200, { ok: 1 }), res(201, { id: 'x' }));
  const c = createClient({ fetchImpl: f.fetchImpl, getCsrf: () => 'tok' });
  assert.deepEqual(await c.get('/api/state'), { ok: 1 });
  assert.equal(f.calls[0].init.headers['X-CSRF-Token'], undefined);
  assert.equal(f.calls[0].init.credentials, 'same-origin');
  await c.post('/api/controls', { a: 1 }, { version: 7, idempotencyKey: 'abcdefgh1' });
  const h = f.calls[1].init.headers;
  assert.equal(h['X-CSRF-Token'], 'tok');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['If-Match'], '"7"');
  assert.equal(h['Idempotency-Key'], 'abcdefgh1');
  assert.equal(f.calls[1].init.body, '{"a":1}');
});

test('POST sin cuerpo no manda Content-Type (Fastify rechaza JSON vacío)', async () => {
  const f = fake(res(200, { ok: true }));
  await createClient({ fetchImpl: f.fetchImpl }).post('/api/auth/logout');
  assert.equal(f.calls[0].init.headers['Content-Type'], undefined);
  assert.equal(f.calls[0].init.body, undefined);
});

test('cada código HTTP se traduce a un tipo estable', () => {
  assert.equal(kindOf(401), 'unauthenticated');
  assert.equal(kindOf(403, 'forbidden'), 'forbidden');
  assert.equal(kindOf(403, 'password_change_required'), 'password_change_required');
  assert.equal(kindOf(404), 'not_found');
  assert.equal(kindOf(409), 'conflict');
  assert.equal(kindOf(422), 'validation');
  assert.equal(kindOf(400), 'validation');
  assert.equal(kindOf(428), 'precondition');
  assert.equal(kindOf(429), 'rate_limited');
  assert.equal(kindOf(500), 'server');
});

test('409 conserva el registro actual; 429 lee Retry-After; se usa el mensaje del servidor', async () => {
  const f = fake(res(409, { error: 'conflict', message: 'Cambió.', current: { id: 't1', version: 3 } }), res(429, { error: 'locked', message: 'Esperá.' }, { 'retry-after': '60' }));
  const c = createClient({ fetchImpl: f.fetchImpl });
  const e1 = await c.patch('/api/techs/t1', { name: 'x' }, { version: 2 }).catch((e) => e);
  assert.ok(e1 instanceof ApiError);
  assert.equal(e1.kind, 'conflict');
  assert.equal(e1.status, 409);
  assert.equal(e1.message, 'Cambió.');
  assert.deepEqual(e1.current, { id: 't1', version: 3 });
  const e2 = await c.post('/api/auth/login', {}).catch((e) => e);
  assert.equal(e2.kind, 'rate_limited');
  assert.equal(e2.retryAfter, 60);
});

test('403 de cambio de contraseña obligatorio y 401 de sesión vencida', async () => {
  const f = fake(res(403, { error: 'password_change_required', message: 'Cambiá la contraseña.' }), res(401, { error: 'unauthenticated' }));
  const c = createClient({ fetchImpl: f.fetchImpl });
  assert.equal((await c.get('/api/state').catch((e) => e)).kind, 'password_change_required');
  const e = await c.get('/api/state').catch((x) => x);
  assert.equal(e.kind, 'unauthenticated');
  assert.match(e.message, /sesión/);
});

test('sin mensaje del servidor se usa un texto por defecto', () => {
  const e = toApiError(428, null, null);
  assert.equal(e.kind, 'precondition');
  assert.match(e.message, /versión del registro/);
  assert.equal(toApiError(429, { retryAfter: 30 }, null).retryAfter, 30);
});

test('falla de red: error network y aviso de conexión caída; un éxito avisa que volvió', async () => {
  const seen = [];
  const f = fake(new TypeError('Failed to fetch'), res(200, {}));
  const c = createClient({ fetchImpl: f.fetchImpl, onNetwork: (ok) => seen.push(ok) });
  const e = await c.get('/api/state').catch((x) => x);
  assert.equal(e.kind, 'network');
  await c.get('/api/state');
  assert.deepEqual(seen, [false, true]);
});

test('sin conexión solo salen los envíos permitidos (borrador del control)', async () => {
  const f = fake(res(201, { control: { id: 'c1' } }));
  const c = createClient({ fetchImpl: f.fetchImpl, isOffline: () => true });
  const e = await c.post('/api/movements', { type: 'ingreso' }).catch((x) => x);
  assert.equal(e.kind, 'offline');
  assert.equal(e.message, OFFLINE_MESSAGE);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await c.post('/api/controls', {}, { allowOffline: true }), { control: { id: 'c1' } });
});

test('texto plano: importación del .txt y descarga', async () => {
  const f = fake(res(200, { ok: 1 }), { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => 'PAÑOL' });
  const c = createClient({ fetchImpl: f.fetchImpl, getCsrf: () => 't' });
  await c.request('POST', '/api/import/txt?mode=merge&dryRun=1', { rawText: 'contenido' });
  assert.equal(f.calls[0].init.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(f.calls[0].init.body, 'contenido');
  assert.equal(await c.get('/api/export/txt', { text: true }), 'PAÑOL');
});

test('claves de idempotencia válidas para el servidor y distintas', () => {
  const a = newIdempotencyKey(), b = newIdempotencyKey();
  assert.match(a, /^[A-Za-z0-9]{8,200}$/);
  assert.notEqual(a, b);
});
