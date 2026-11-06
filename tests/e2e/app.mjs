// App-level helpers shared by the specs (they drive the real UI where it matters).
import fs from 'node:fs';
import path from 'node:path';
import { OUT, FIX, sleep } from './harness.mjs';

export const fixture = (name) => path.join(FIX, name);
export function outFile(name, text) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, name);
  fs.writeFileSync(f, text);
  return f;
}
export function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }
export function eq(a, b, msg) { if (a !== b) throw new Error(`assert: ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

export async function fresh(page) { await page.goto('/'); await page.ready(); }

export async function setupAdmin(page, name = 'Ana Admin', pin = '1234') {
  await page.type('#a-name', name);
  await page.type('#a-pin', pin);
  await page.type('#a-pin2', pin);
  await page.act('authSetup');
  await page.waitFor('!!ME.id', 10000, 'admin setup');
}

// Tries a PIN on the login screen. Returns '' on success or the error text shown.
export async function login(page, pin, userName = null) {
  if (userName) {
    const v = await page.eval(`([...document.querySelectorAll('#a-user option')].find((o) => o.textContent.startsWith(${JSON.stringify(userName)}))||{}).value||''`);
    assert(v, 'user option ' + userName);
    await page.select('#a-user', v);
  }
  await page.eval("document.getElementById('a-err').textContent=''");
  await page.type('#a-pin', pin);
  await page.act('authLogin');
  await page.waitFor("!!ME.id||!!(document.getElementById('a-err')||{}).textContent", 10000, 'login result');
  return page.eval("ME.id?'':document.getElementById('a-err').textContent");
}

export async function logout(page) { await page.eval('logout(true)'); await sleep(150); }

export async function loadDemo(page) {
  await page.hash('#inicio');
  await page.act('loadDemo');
  await page.modalBtn('Cargar datos');
  await page.waitFor('Object.keys(S.controls).length>=12&&!document.body.classList.contains("busy")', 15000, 'demo loaded');
  await sleep(400);
}

// Everything the app persists, as JSON (stable for before/after comparisons).
export const snapshot = (page) => page.eval("JSON.stringify(Object.fromEntries(COLS.map((c)=>[c,S[c]])))");
export const idbSnapshot = (page) => page.eval("idbGet('data').then((p)=>JSON.stringify(Object.fromEntries(COLS.map((c)=>[c,(p&&p.data[c])||{}]))))");

// Opens a .txt through Más › Abrir archivo (input fallback). mode: 'merge' | 'replace' | null.
export async function importFile(page, file, mode = null) {
  await page.toasts();
  await page.chooseFile(file, () => page.eval('ACT.dataOpen()', { gesture: true }));
  await page.waitFor("!!document.querySelector('#modal-root:not([hidden]) .sheet')||window.__toasts.length>0", 8000, 'import modal or toast');
  if (!(await page.eval("!!document.querySelector('#modal-root:not([hidden]) .sheet')"))) return { opened: false, toasts: await page.toasts() };
  if (mode && await page.count(`#modal-root [data-k="mode"][data-v="${mode}"]`)) await page.click(`#modal-root [data-k="mode"][data-v="${mode}"]`);
  await page.modalBtn('Abrir datos');
  await page.waitFor("document.getElementById('modal-root').hidden||!!(document.getElementById('merr')||{}).textContent||window.__toasts.length>0", 8000, 'import done');
  await sleep(500);
  return { opened: true, err: await page.text('#merr'), toasts: await page.toasts() };
}

// Downloads the .txt through Más › Archivo de datos and returns its text.
export async function downloadTxt(page) {
  await page.hash('#mas');
  await page.act('backup');
  await page.act('fileDownload');
  await sleep(300);
  const txt = await page.lastBlob();
  await page.eval('closeModal()');
  return txt;
}

export const ROUTES = ['inicio', 'turnos', 'tecnicos', 'control', 'entregas', 'inventario', 'controles', 'reportes', 'alertas', 'config', 'admin', 'mas'];
