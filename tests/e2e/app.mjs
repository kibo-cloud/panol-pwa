// App-level helpers shared by the specs. The v3 app is ES modules (no globals), so the specs
// drive the real UI and read the server state through the API from the page (same session,
// cookie + X-CSRF-Token) or straight from the database (owner connection, `srv.db`).
import fs from 'node:fs';
import path from 'node:path';
import { OUT, FIX, sleep, openPage } from './harness.mjs';
import { PASSWORD, USERS } from './seed.mjs';

export { PASSWORD, USERS };
export const fixture = (name) => path.join(FIX, name);
export function outFile(name, text) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, name);
  fs.writeFileSync(f, text);
  return f;
}
export function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }
export function eq(a, b, msg) { if (a !== b) throw new Error(`assert: ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

export const TXT_HEAD = 'PAÑOL · archivo de datos\r\nNo lo edites a mano.\r\n';
export const parseTxt = (txt) => JSON.parse(txt.slice(txt.indexOf('{')));
export const ROUTES = ['inicio', 'plantillas', 'tecnicos', 'control', 'entregas', 'inventario', 'lineas', 'controles', 'reportes', 'existencia', 'auditoria', 'alertas', 'novedades', 'compras', 'config', 'admin', 'mas'];

// API call from the page (its session). Returns { status, body, etag }.
export function api(page, method, url, body, { version, idem } = {}) {
  return page.eval(`(async () => {
    const h = { Accept: 'application/json' };
    const m = ${JSON.stringify(method)};
    if (m !== 'GET') { const me = await fetch('/api/auth/me', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)); h['X-CSRF-Token'] = me ? me.csrfToken : ''; }
    const v = ${JSON.stringify(version ?? null)}; if (v != null) h['If-Match'] = '"' + v + '"';
    const k = ${JSON.stringify(idem ?? null)}; if (k) h['Idempotency-Key'] = k;
    const b = ${JSON.stringify(body === undefined ? null : JSON.stringify(body))};
    if (b != null) h['Content-Type'] = 'application/json';
    const r = await fetch(${JSON.stringify(url)}, { method: m, headers: h, body: b == null ? undefined : b, cache: 'no-store' });
    let j = null; try { j = await r.json(); } catch { j = null; }
    return { status: r.status, body: j, etag: r.headers.get('etag') };
  })()`);
}
export async function state(page) {
  const r = await api(page, 'GET', '/api/state');
  assert(r.status === 200, 'GET /api/state ' + r.status);
  return r.body;
}
// Everything the server keeps (no clock, no derived data): stable for before/after comparisons.
export async function snapshot(page) {
  const s = await state(page);
  delete s.now; delete s.derived;
  return JSON.stringify(s);
}
export const idOf = (st, col, name) => (Object.entries(st[col]).find(([, x]) => x.name === name) || [''])[0];

export const isLoggedIn = (page) => page.eval("!!document.querySelector('#side nav')&&!document.body.classList.contains('auth')");

// Tries a login on the login screen. Returns '' when the app opens, 'change' when the forced
// password change screen opens, or the error text shown.
export async function login(page, username = 'admin', password = PASSWORD, { keep = true } = {}) {
  await page.waitFor("!!document.getElementById('a-user')", 10000, 'login screen');
  await page.eval("document.getElementById('a-err').textContent=''");
  await page.waitFor("!document.getElementById('a-go').disabled", 10000, 'login button enabled');
  await page.type('#a-user', username);
  await page.type('#a-pass', password);
  await page.eval(`document.getElementById('a-keep').checked=${keep ? 'true' : 'false'}`);
  await page.act('authLogin');
  await page.waitFor("(!!document.querySelector('#side nav')&&!document.body.classList.contains('auth'))||!!document.getElementById('c-cur')||!!(document.getElementById('a-err')||{}).textContent", 15000, 'login result');
  await page.ready();
  if (await page.eval("!!document.getElementById('c-cur')")) return 'change';
  if (await isLoggedIn(page)) return '';
  return page.text('#a-err');
}
export async function loginAs(page, username = 'admin', password = PASSWORD) {
  const r = await login(page, username, password);
  eq(r, '', `login as ${username}`);
}

// Forced password change screen: current (temporary or 2.x PIN) and new password.
export async function changePassword(page, current, next) {
  await page.type('#c-cur', current);
  await page.type('#c-new', next);
  await page.type('#c-new2', next);
  await page.act('authChange');
  await page.waitFor("(!!document.querySelector('#side nav')&&!document.body.classList.contains('auth'))||!!(document.getElementById('a-err')||{}).textContent", 15000, 'change result');
  await page.ready();
  return (await isLoggedIn(page)) ? '' : page.text('#a-err');
}

export async function logout(page) {
  await page.hash('#mas');
  await page.act('logout');
  await page.modalBtn('Cerrar sesión');
  await page.waitFor("!!document.getElementById('a-user')", 10000, 'login screen after logout');
  await page.ready();
}

// Second user in its own browser context (own cookies, storage and SSE stream).
export async function secondPage(ctx, username = 'admin', password = PASSWORD) {
  const p = await openPage(ctx.browser, ctx.srv);
  ctx.extra.push(p);
  await p.viewport(1280, 860);
  await p.goto('/');
  await p.ready();
  await loginAs(p, username, password);
  return p;
}

export async function loadDemo(page) {
  await page.hash('#admin');
  await page.click('[data-act="adminTab"][data-v="data"]');
  await page.act('loadDemo');
  await page.modalBtn('Cargar datos');
  await page.waitFor("!document.body.classList.contains('busy')&&!!document.querySelector('[data-act=\"clearDemo\"]')", 20000, 'demo loaded');
  await sleep(200);
  const st = await state(page);
  assert(Object.keys(st.techs).length >= 3 && Object.keys(st.controls).length >= 1, 'demo data present');
  return st;
}

export const modalOpen = (page) => page.eval("!!document.querySelector('#modal-root:not([hidden]) .sheet')");
export async function closeModal(page) {
  if (await modalOpen(page)) await page.eval("document.querySelector('#modal-root [data-act=\"modalClose\"]').click()");
  await sleep(100);
}

// Imports a .txt through Más › Copia de seguridad › Importar .txt: the server report is shown
// first, then "Confirmar importación". Returns { opened, report, err, toasts }.
export async function importFile(page, file, mode = 'merge') {
  await page.toasts();
  await page.hash('#mas');
  await page.act('backup');
  await page.chooseFile(file, () => page.act('dataImport'));
  await page.waitFor("(document.getElementById('mtitle')||{}).textContent==='Importar archivo .txt'||window.__toasts.length>0", 10000, 'import report or toast');
  if (!(await page.eval("(document.getElementById('mtitle')||{}).textContent==='Importar archivo .txt'"))) return { opened: false, report: '', err: '', toasts: await page.toasts() };
  const settled = "!document.querySelector('#mbody .loading')";
  await page.waitFor(settled, 60000, 'import report');
  if (mode !== 'merge') {
    await page.click(`#modal-root [data-act="importMode"][data-v="${mode}"]`);
    await page.waitFor(settled, 60000, 'import report (' + mode + ')');
  }
  const report = await page.text('#mbody');
  await page.modalBtn('Confirmar importación');
  await page.waitFor("!document.querySelector('#modal-root:not([hidden]) .sheet')||!!(document.getElementById('merr')||{}).textContent", 30000, 'import done');
  await sleep(300);
  return { opened: true, report, err: await page.text('#merr'), toasts: await page.toasts() };
}

// Downloads the .txt through Más › Copia de seguridad and returns its text.
export async function downloadTxt(page) {
  await page.hash('#mas');
  await page.act('backup');
  const n = await page.eval('window.__blobs.length');
  await page.act('fileDownload');
  await page.waitFor(`window.__blobs.length>${n}`, 10000, 'txt download');
  const txt = await page.lastBlob();
  await closeModal(page);
  return txt;
}

// Visits every route (plus extra ones) and fails if injected markup ran.
export async function visitAll(page, extra = []) {
  for (const r of [...ROUTES, ...extra]) {
    await page.hash('#' + r);
    eq(await page.eval('window.__xss'), undefined, 'window.__xss after #' + r);
  }
}

// Clicks a button created on the fly with data-act (what a forged click would do).
export async function forgedAct(page, act, data = {}) {
  await page.eval(`(() => { const b = document.createElement('button'); b.dataset.act = ${JSON.stringify(act)}; for (const [k, v] of Object.entries(${JSON.stringify(data)})) b.dataset[k] = v; b.textContent = 'x'; document.body.appendChild(b); b.click(); b.remove(); })()`, { gesture: true });
  await sleep(250);
}
