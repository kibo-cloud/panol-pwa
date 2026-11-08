import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../../src/config.js';
import { cookieName, cookieOptions, checkSameOrigin } from '../../src/adapters/http/auth.js';

test('producción: cookie __Host-, Secure, HttpOnly, SameSite=Lax, Path=/', () => {
  const c = buildConfig({ NODE_ENV: 'production' });
  assert.equal(cookieName(c), '__Host-panol_sid');
  assert.deepEqual(cookieOptions(c), { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
});

test('desarrollo en http://localhost: Secure relajado', () => {
  const c = buildConfig({ NODE_ENV: 'development' });
  assert.equal(cookieName(c), 'panol_sid');
  assert.equal(cookieOptions(c).secure, false);
});

test('"Mantener la sesión": Max-Age hasta el vencimiento', () => {
  const c = buildConfig({});
  const o = cookieOptions(c, { remember: true, expiresAt: new Date(Date.now() + 3600e3) });
  assert.ok(o.maxAge > 3590 && o.maxAge <= 3600);
  assert.equal(cookieOptions(c, { remember: false, expiresAt: new Date() }).maxAge, undefined);
});

test('origen: acepta el mismo, rechaza otro sitio', () => {
  const c = buildConfig({ APP_ORIGIN: 'https://panol.example' });
  const req = (h) => ({ headers: h, protocol: 'https' });
  assert.doesNotThrow(() => checkSameOrigin(req({ origin: 'https://panol.example', 'sec-fetch-site': 'same-origin' }), c));
  assert.doesNotThrow(() => checkSameOrigin(req({}), c));
  assert.throws(() => checkSameOrigin(req({ origin: 'https://otro.example' }), c), { code: 'csrf' });
  assert.throws(() => checkSameOrigin(req({ origin: 'null' }), c), { code: 'csrf' });
  assert.throws(() => checkSameOrigin(req({ 'sec-fetch-site': 'cross-site' }), c), { code: 'csrf' });
});
