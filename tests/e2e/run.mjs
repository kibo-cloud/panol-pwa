// E2E runner: `node tests/e2e/run.mjs [filter]` or `npm run test:e2e` (Node 22+, Edge or Chrome;
// PANOL_BROWSER=<path> to force one). Starts the Pañol server on a seeded PostgreSQL (embedded,
// or TEST_DATABASE_URL in CI); see server.mjs. Every spec gets a clean database cloned from the
// seeded template, a fresh server and a fresh browser context (empty IndexedDB, storage, cookies
// and service workers). Screenshots land in tests/e2e/out/ (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E, OUT, launchBrowser, openPage } from './harness.mjs';
import { startE2EServer } from './server.mjs';

const filter = process.argv[2] || '';
// Tope por spec: una llamada CDP que nunca resuelve tiene que fallar con mensaje, no colgar la corrida.
const SPEC_TIMEOUT_MS = Number(process.env.PANOL_SPEC_TIMEOUT_MS) || 120000;
const withTimeout = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout after ' + ms + ' ms: ' + what)), ms); })])
    .finally(() => clearTimeout(timer));
};
let stray = 0;
process.on('unhandledRejection', (e) => { stray++; console.log('  UNHANDLED ' + (e && e.stack || e)); });

// Screenshots of failures from earlier runs would be misleading.
if (fs.existsSync(OUT)) for (const f of fs.readdirSync(OUT)) if (f.startsWith('FAIL-')) fs.rmSync(path.join(OUT, f));

const specDir = path.join(E2E, 'specs');
const tests = [];
for (const f of fs.readdirSync(specDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(pathToFileURL(path.join(specDir, f)).href);
  for (const t of mod.tests) tests.push({ ...t, name: `${f.replace('.mjs', '')}: ${t.name}` });
}
const selected = tests.filter((t) => !filter || t.name.includes(filter));

const t0 = Date.now();
const srv = await startE2EServer();
const browser = await launchBrowser();
let pass = 0, fail = 0, skip = 0;
const failures = [];
try {
  for (const t of selected) {
    if (t.skip) { skip++; console.log('  skip ' + t.name + ' (' + t.skip + ')'); continue; }
    await srv.reset();
    const page = await openPage(browser, srv);
    const ctx = { browser, srv, extra: [] };
    try {
      await withTimeout((async () => {
        await page.viewport(t.width || 1280, t.height || 860);
        await page.goto('/');
        await page.ready();
        await t.fn(page, ctx);
      })(), t.timeout || SPEC_TIMEOUT_MS, 'spec ' + t.name);
      const csp = (await page.eval('window.__csp||[]').catch(() => [])) || [];
      const extraCsp = [];
      for (const p of ctx.extra) extraCsp.push(...((await p.eval('window.__csp||[]').catch(() => [])) || []));
      const errs = [...page.errors, ...ctx.extra.flatMap((p) => p.errors), ...[...csp, ...extraCsp].map((c) => 'csp: ' + c)]
        .filter((e) => !(t.allowErrors || []).some((a) => e.includes(a)));
      if (errs.length) throw new Error('page errors: ' + errs.join(' | '));
      pass++;
      console.log('  ok   ' + t.name);
    } catch (e) {
      fail++;
      failures.push(t.name);
      console.log('  FAIL ' + t.name + '\n       ' + String(e.stack || e).split('\n').slice(0, 4).join('\n       '));
      try { await withTimeout(page.screenshot('FAIL-' + t.name.replace(/[^a-z0-9]+/gi, '-')), 10000, 'screenshot'); } catch { /* ignore */ }
    } finally {
      srv.offline = false;
      for (const p of ctx.extra) await withTimeout(p.dispose(), 10000, 'dispose extra page').catch((e) => console.log('       ' + e.message));
      await withTimeout(page.dispose(), 10000, 'dispose page').catch((e) => console.log('       ' + e.message));
    }
  }
} finally {
  await browser.close();
  await srv.close();
}
console.log(`\ne2e: ${pass} passed, ${fail} failed, ${skip} skipped (${Math.round((Date.now() - t0) / 1000)} s)` + (failures.length ? ' -> ' + failures.join(', ') : ''));
if (stray) console.log('e2e: ' + stray + ' unhandled rejection(s)');
process.exit(fail || stray ? 1 : 0);
