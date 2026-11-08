// Zero-dependency E2E harness: headless Edge/Chrome over the Chrome DevTools Protocol
// (Node >= 22 ships a global WebSocket). The Pañol server itself is started by server.mjs;
// the static server below only serves the 2.0.0 baseline for make-fixtures.mjs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E2E = path.join(ROOT, 'tests', 'e2e');
export const OUT = path.join(E2E, 'out');
export const FIX = path.join(E2E, 'fixtures');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

// Static server (make-fixtures.mjs). `srv.offline = true` drops every connection.
export function startStaticServer(root = ROOT) {
  const srv = { root, offline: false };
  const server = http.createServer((req, res) => {
    if (srv.offline) { req.socket.destroy(); return; }
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(srv.root, p);
    if (!file.startsWith(srv.root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<h1>not found</h1>'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      srv.port = server.address().port;
      srv.base = `http://127.0.0.1:${srv.port}`;
      srv.close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
      resolve(srv);
    });
  });
}

const BROWSERS = [
  process.env.PANOL_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function findBrowser() {
  for (const b of BROWSERS) if (fs.existsSync(b)) return b;
  throw new Error('No Chromium-based browser found. Set PANOL_BROWSER.');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners.slice()) l(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.listeners = this.listeners.filter((x) => x !== l); reject(new Error('timeout waiting ' + method)); }, timeout);
      const l = (msg) => {
        if (msg.method !== method) return;
        clearTimeout(t);
        this.listeners = this.listeners.filter((x) => x !== l);
        resolve(msg.params);
      };
      this.listeners.push(l);
    });
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return new Cdp(ws);
}

export async function launchBrowser() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panol-e2e-'));
  const proc = spawn(findBrowser(), [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + dir,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', 'about:blank'
  ], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) throw new Error('browser did not start (no DevToolsActivePort)');
  let port = '';
  for (let i = 0; i < 20 && !port; i++) { try { port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim(); } catch { await sleep(100); } }
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const root = await connect(v.webSocketDebuggerUrl);
  return {
    port, root,
    async close() {
      try { root.ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); await sleep(1200); } catch { /* gone */ }
      try { proc.kill(); } catch { /* ignore */ }
      if (process.platform === 'win32') {
        const tag = path.basename(dir).replace(/'/g, '');
        spawnSync('powershell', ['-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
          { stdio: 'ignore' });
      }
      for (let i = 0; i < 10; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(300); } }
    }
  };
}

// Runs before any page script: makes the <input type=file> import path usable headless,
// records CSP violations, toasts and every Blob handed to URL.createObjectURL (downloads).
const INIT = `(() => {
  try { Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }); } catch (e) {}
  window.__csp = []; window.__toasts = []; window.__blobs = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
  const o = URL.createObjectURL;
  URL.createObjectURL = function (b) { if (b instanceof Blob) window.__blobs.push(b); return o.call(URL, b); };
  const hook = () => { const t = document.getElementById('toast'); if (!t) return setTimeout(hook, 30);
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__toasts.push((n.className || '') + '|' + n.textContent); }).observe(t, { childList: true }); };
  document.addEventListener('DOMContentLoaded', hook);
})();`;

// Opens a tab in a fresh browser context (own IndexedDB, storage and service workers).
export async function openPage(browser, srv, { context } = {}) {
  const browserContextId = context || (await browser.root.send('Target.createBrowserContext', { disposeOnDetach: false })).browserContextId;
  const { targetId } = await browser.root.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const cdp = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`);
  const errors = [];
  cdp.listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|Failed to load resource/.test(m.params.entry.text)) errors.push('log: ' + m.params.entry.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

  const page = {
    cdp, errors, srv, browserContextId, targetId,
    async viewport(width, height = 844, mobile = width < 700) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    },
    async goto(p = '/') {
      const loaded = cdp.once('Page.loadEventFired'); loaded.catch(() => {});
      await cdp.send('Page.navigate', { url: srv.base + p });
      await loaded; await sleep(100);
    },
    async reload() {
      const loaded = cdp.once('Page.loadEventFired'); loaded.catch(() => {});
      await cdp.send('Page.reload', { ignoreCache: false });
      await loaded; await sleep(100);
    },
    async eval(expr, { gesture = false } = {}) {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: gesture });
      if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n' + expr.slice(0, 300));
      return r.result.value;
    },
    async waitFor(expr, timeout = 15000, label = expr) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await page.eval(expr)) return; } catch { /* page navigating */ }
        await sleep(50);
      }
      throw new Error('timeout: ' + label);
    },
    // Waits until the app finished booting: login screen, password change or the app chrome
    // (data loaded, first render done and no action in progress).
    async ready(timeout = 15000) {
      await page.waitFor("!!document.querySelector('#view')&&!document.querySelector('#view .loading')&&!document.body.classList.contains('busy')&&(!!document.querySelector('#a-user,#c-cur')||!!document.querySelector('#side nav'))", timeout, 'app ready');
      await sleep(80);
    },
    // Clicks the first visible element matching sel (optionally containing text), as a user gesture.
    async click(sel, text = null) {
      const ok = await page.eval(`(() => { const l = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.getClientRects().length && (${JSON.stringify(text)} === null || e.textContent.includes(${JSON.stringify(text)})));
        if (!l.length) return false; l[0].click(); return true; })()`, { gesture: true });
      if (!ok) throw new Error(`click: not found ${sel} ${text || ''}`);
      await sleep(120);
    },
    async act(name, text = null) { await page.click(`[data-act="${name}"]`, text); },
    async modalBtn(label) { await page.click('#modal-root .sheet-f button', label); await sleep(150); },
    async type(sel, value) {
      const ok = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.focus(); e.value = ${JSON.stringify(value)};
        e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      if (!ok) throw new Error('type: not found ' + sel);
      await sleep(60);
    },
    async select(sel, value) { await page.type(sel, value); await sleep(60); },
    async hash(h) { await page.eval(`location.hash=${JSON.stringify(h)}`); await sleep(250); },
    text(sel) { return page.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||''`); },
    count(sel) { return page.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`); },
    async toasts() { return page.eval('window.__toasts.splice(0)'); },
    // Opens the import file chooser with trigger() and answers it with file.
    async chooseFile(file, trigger) {
      const opened = cdp.once('Page.fileChooserOpened', 5000);
      await trigger();
      const { backendNodeId } = await opened;
      await cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId });
      await sleep(400);
    },
    // Text of the last downloaded Blob (or its first bytes as latin1 when binary=true).
    async lastBlob(binary = false) {
      return page.eval(`(async () => { const b = window.__blobs[window.__blobs.length - 1]; if (!b) return null;
        if (!${binary}) return await b.text(); const u = new Uint8Array(await b.arrayBuffer()); return { size: u.length, head: String.fromCharCode(...u.slice(0, 4)) }; })()`);
    },
    async screenshot(name) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    },
    async close() {
      try { await browser.root.send('Target.closeTarget', { targetId }); } catch { /* gone */ }
      try { cdp.ws.close(); } catch { /* ignore */ }
    },
    async dispose() {
      await page.close();
      if (!context) { try { await browser.root.send('Target.disposeBrowserContext', { browserContextId }); } catch { /* gone */ } }
    }
  };
  return page;
}
