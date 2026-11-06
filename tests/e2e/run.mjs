// E2E runner: `node tests/e2e/run.mjs [filter]` (Node 22+, Edge or Chrome; PANOL_BROWSER=<path> to force one).
// Every spec gets a fresh browser context (empty IndexedDB, storage and service workers).
// Screenshots land in tests/e2e/out/ (git-ignored).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { E2E, startServer, launchBrowser, openPage } from './harness.mjs';

const filter = process.argv[2] || '';
let stray = 0;
process.on('unhandledRejection', (e) => { stray++; console.log('  UNHANDLED ' + (e && e.stack || e)); });

const specDir = path.join(E2E, 'specs');
const tests = [];
for (const f of fs.readdirSync(specDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(pathToFileURL(path.join(specDir, f)).href);
  for (const t of mod.tests) tests.push({ ...t, name: `${f.replace('.mjs', '')}: ${t.name}` });
}

// Network check for the specs that need cdnjs (Excel/PDF libraries).
let online = false;
try { online = (await fetch('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', { method: 'HEAD', signal: AbortSignal.timeout(5000) })).ok; } catch { online = false; }

const srv = await startServer();
const browser = await launchBrowser();
let pass = 0, fail = 0, skip = 0;
const failures = [];
try {
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    if (t.online && !online) { skip++; console.log('  skip ' + t.name + ' (offline)'); continue; }
    srv.offline = false;
    const page = await openPage(browser, srv);
    const ctx = { browser, srv, online, extra: [] };
    try {
      await page.viewport(t.width || 1280, t.height || 860);
      await page.goto('/');
      await page.ready();
      await t.fn(page, ctx);
      const csp = await page.eval('window.__csp||[]').catch(() => []);
      const errs = [...page.errors, ...ctx.extra.flatMap((p) => p.errors), ...csp.map((c) => 'csp: ' + c)]
        .filter((e) => !(t.allowErrors || []).some((a) => e.includes(a)));
      if (errs.length) throw new Error('page errors: ' + errs.join(' | '));
      pass++;
      console.log('  ok   ' + t.name);
    } catch (e) {
      fail++;
      failures.push(t.name);
      console.log('  FAIL ' + t.name + '\n       ' + String(e.stack || e).split('\n').slice(0, 4).join('\n       '));
      try { await page.screenshot('FAIL-' + t.name.replace(/[^a-z0-9]+/gi, '-')); } catch { /* ignore */ }
    } finally {
      for (const p of ctx.extra) await p.close();
      await page.dispose();
    }
  }
} finally {
  await browser.close();
  await srv.close();
}
console.log(`\ne2e: ${pass} passed, ${fail} failed, ${skip} skipped` + (failures.length ? ' -> ' + failures.join(', ') : ''));
if (stray) console.log('e2e: ' + stray + ' unhandled rejection(s)');
process.exit(fail || stray ? 1 : 0);
