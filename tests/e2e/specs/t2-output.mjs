// T2: output hardening — CSP, escaping of user input, SRI on the Excel/PDF libraries.
// v3: the CSP is an HTTP header (no meta, no inline script hash; tests/csp-hash.mjs retired)
// and xlsx/jspdf are served by the app itself from /vendor/ with SRI (no cdnjs, no network).
import { sleep } from '../harness.mjs';
import { assert, eq, loginAs, loadDemo, state, ROUTES } from '../app.mjs';
import { CSP } from '../../../server/src/adapters/http/web-routes.js';

const EVIL = '<img src=x onerror="window.__xss=7">';

export const tests = [
  {
    name: 'CSP header is exact on pages, assets and API, with no inline code',
    async fn(page, { srv }) {
      assert(!/unsafe-inline|unsafe-eval/.test(CSP) && CSP.includes("script-src 'self'") && CSP.includes("object-src 'none'"), 'CSP directives: ' + CSP);
      for (const p of ['/', '/index.html', '/sw.js', '/manifest.webmanifest', '/api/health', '/tecnicos']) {
        const r = await fetch(srv.base + p);
        eq(r.headers.get('content-security-policy'), CSP, 'CSP header on ' + p);
        eq(r.headers.get('x-content-type-options'), 'nosniff', 'nosniff on ' + p);
      }
      eq(await page.count('meta[http-equiv="Content-Security-Policy"]'), 0, 'no CSP meta (it is a header)');
      eq(await page.count('script:not([src])'), 0, 'no inline scripts');
      eq(await page.count('[style]:not([data-css])'), 0, 'no inline style attributes outside data-css');
      const html = await (await fetch(srv.base + '/')).text();
      assert(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html) && !/\son[a-z]+=/i.test(html), 'built index.html has no inline script or handlers');
      assert(await page.eval("!!document.getElementById('a-user')"), 'app booted under the CSP');
      await loginAs(page);
      for (const r of ROUTES) await page.hash('#' + r);
      eq((await page.eval('window.__csp')).length, 0, 'no CSP violations on any route');
    }
  },
  {
    name: 'markup typed in forms is shown as text',
    async fn(page) {
      await loginAs(page);
      await page.hash('#config');
      await page.act('catNew'); await page.type('#f-cn', EVIL); await page.modalBtn('Crear');
      await page.act('toolNew'); await page.type('#f-tn', EVIL + ' herr'); await page.type('#f-td', EVIL); await page.type('#f-ts', '3'); await page.modalBtn('Crear herramienta');
      await page.hash('#tecnicos');
      await page.act('techNew'); await page.type('#f-name', EVIL + ' tec'); await page.type('#f-leg', '"><svg onload=window.__xss=8>'); await page.modalBtn('Crear técnico');
      const st = await state(page);
      const techId = Object.keys(st.techs)[0];
      const toolId = Object.keys(st.tools)[0];
      assert(techId && toolId && Object.keys(st.categories).length === 1, 'records created');
      eq(st.techs[techId].name, EVIL + ' tec', 'stored as typed');
      for (const r of [...ROUTES, 'tecnico-' + techId, 'herramienta-' + toolId, 'control-' + techId]) {
        await page.hash('#' + r);
        eq(await page.eval('window.__xss'), undefined, 'window.__xss on #' + r);
      }
      await page.hash('#tecnicos');
      assert((await page.text('#view')).includes('<img src=x'), 'markup visible as text');
    }
  },
  {
    name: 'Excel and PDF export load their libraries from /vendor/ with SRI',
    async fn(page) {
      await loginAs(page);
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
      const scripts = await page.eval("[...document.querySelectorAll('script[src]')].filter((s)=>s.src.includes('/vendor/')).map((s)=>({u:new URL(s.src).pathname,i:s.integrity,c:s.crossOrigin}))");
      eq(scripts.length, 2, 'two vendor scripts: ' + JSON.stringify(scripts));
      for (const s of scripts) {
        assert(/^\/vendor\/(xlsx|jspdf)-[\d.]+\./.test(s.u), 'served by the app: ' + s.u);
        assert(/^sha384-[A-Za-z0-9+/=]{64}$/.test(s.i), 'integrity set: ' + s.i);
        eq(s.c, 'anonymous', 'crossOrigin');
      }
      eq(await page.count('script[src*="cdnjs"]'), 0, 'no CDN');
      await sleep(200);
    }
  }
];
