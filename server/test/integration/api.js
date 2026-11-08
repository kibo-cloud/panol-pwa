// Ayudas para probar la API: base sembrada con los datos inventados de desarrollo
// (server/scripts/seed.js) y sesiones por usuario.
import { setupApp } from './harness.js';
import { seed, DEV_PASSWORD } from '../../scripts/seed.js';

export async function setupApi(opts = {}) {
  const ctx = await setupApp(opts);
  await seed(ctx.pool);
  const sessions = {};
  const app = ctx.app;

  async function login(username) {
    if (sessions[username]) return sessions[username];
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: DEV_PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`login ${username}: ${res.statusCode} ${res.body}`);
    const cookie = [].concat(res.headers['set-cookie'])[0].split(';')[0];
    sessions[username] = { cookie, csrf: res.json().csrfToken, id: res.json().user.id };
    return sessions[username];
  }

  // call('admin', 'POST', '/api/techs', body, { 'if-match': '1' })
  async function call(user, method, url, payload, headers = {}) {
    const h = { ...headers };
    if (user) {
      const s = await login(user);
      h.cookie = s.cookie;
      if (method !== 'GET') h['x-csrf-token'] = s.csrf;
    }
    return app.inject({ method, url, headers: h, ...(payload !== undefined ? { payload } : {}) });
  }

  const q = async (sql, params) => (await ctx.pool.query(sql, params)).rows;
  return { ...ctx, login, call, q };
}

export const ifMatch = (v) => ({ 'if-match': `"${v}"` });
