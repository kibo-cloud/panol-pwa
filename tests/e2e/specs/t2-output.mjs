// T2: output hardening — CSP, escaping of user input, SRI on the cdnjs libraries.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, sleep } from '../harness.mjs';
import { assert, eq, setupAdmin, loadDemo, ROUTES } from '../app.mjs';

const EVIL = '<img src=x onerror="window.__xss=7">';

export const tests = [
  {
    name: 'CSP meta is present and allows the inline script by hash',
    async fn(page) {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
      const m = /<script>([\s\S]*?)<\/script>/.exec(html);
      const hash = 'sha256-' + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
      const csp = await page.eval("(document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')||{}).content||''");
      assert(csp.includes("object-src 'none'") && csp.includes("base-uri 'self'"), 'CSP directives: ' + csp);
      assert(csp.includes(`'${hash}'`), `CSP must allow the inline script hash ${hash} (run: node tests/csp-hash.mjs)`);
      assert(!/script-src[^;]*'unsafe-inline'/.test(csp), 'no unsafe-inline scripts');
      eq(await page.eval("typeof ACT"), 'object', 'inline script ran under the CSP');
    }
  },
  {
    name: 'markup typed in forms is shown as text',
    async fn(page) {
      await setupAdmin(page);
      await page.hash('#config');
      await page.act('catNew'); await page.type('#f-cn', EVIL); await page.modalBtn('Crear');
      await page.act('toolNew'); await page.type('#f-tn', EVIL + ' herr'); await page.type('#f-td', EVIL); await page.type('#f-ts', '3'); await page.modalBtn('Crear herramienta');
      await page.hash('#tecnicos');
      await page.act('techNew'); await page.type('#f-name', EVIL + ' tec'); await page.type('#f-leg', '"><svg onload=window.__xss=8>'); await page.modalBtn('Crear técnico');
      const techId = await page.eval('Object.keys(S.techs)[0]');
      const toolId = await page.eval('Object.keys(S.tools)[0]');
      assert(techId && toolId, 'records created');
      for (const r of [...ROUTES, 'tecnico-' + techId, 'herramienta-' + toolId]) {
        await page.hash('#' + r);
        eq(await page.eval('window.__xss'), undefined, 'window.__xss on #' + r);
      }
    }
  },
  {
    name: 'Excel and PDF export load their libraries with SRI',
    online: true,
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      await page.hash('#reportes');
      await page.act('exportXlsx');
      await page.waitFor("window.__blobs.length>0&&!document.body.classList.contains('busy')", 30000, 'xlsx blob');
      const x = await page.lastBlob(true);
      eq(x.head.slice(0, 2), 'PK', 'xlsx is a zip');
      await page.act('exportPdf');
      await page.waitFor("window.__blobs.length>1&&!document.body.classList.contains('busy')", 30000, 'pdf blob');
      const p = await page.lastBlob(true);
      eq(p.head, '%PDF', 'pdf header');
      const scripts = await page.eval("[...document.querySelectorAll('script[src*=cdnjs]')].map((s)=>({i:s.integrity,c:s.crossOrigin}))");
      eq(scripts.length, 2, 'two cdnjs scripts');
      for (const s of scripts) { assert(/^sha512-/.test(s.i), 'integrity set'); eq(s.c, 'anonymous', 'crossOrigin'); }
      await sleep(200);
    }
  }
];
