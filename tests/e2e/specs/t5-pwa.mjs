// T5: robustness and PWA on v3 — service worker cache rules, offline banner and draft,
// live refreshes that keep what is being typed, failed actions with a visible message.
// v3: data lives on the server, so the 2.1 device-write mechanisms (BroadcastChannel reload,
// pagehide flush, localStorage safety copy) are replaced by their v3 equivalents: an SSE
// refresh keeps the form being typed, leaving the checklist saves its draft, and a write is
// confirmed by the server before it shows (it survives an immediate reload).
import { sleep } from '../harness.mjs';
import { assert, eq, loginAs, loadDemo, state, api, idOf, secondPage } from '../app.mjs';

const CACHE = 'panol-v3.0.0-dev';
const idbDrafts = (page) => page.eval("new Promise((res,rej)=>{const r=indexedDB.open('panol-v3',1);r.onupgradeneeded=()=>r.result.createObjectStore('panol-drafts',{keyPath:'key'});r.onsuccess=()=>{const t=r.result.transaction('panol-drafts','readonly').objectStore('panol-drafts').getAll();t.onsuccess=()=>{res(t.result);r.result.close()};t.onerror=()=>rej(t.error)};r.onerror=()=>rej(r.error)})");

async function swControlled(page) {
  await page.waitFor("navigator.serviceWorker.ready.then(()=>true)", 15000, 'sw ready');
  if (!(await page.eval('!!navigator.serviceWorker.controller'))) { await page.reload(); await page.ready(); }
  await page.waitFor('!!navigator.serviceWorker.controller', 10000, 'page controlled by the SW');
}

// A tech with assignments and no finalized control this week.
function pendingTech(st) {
  const withAsg = new Set(Object.values(st.assignments).filter((a) => a.active).map((a) => a.techId));
  return Object.keys(st.techs).find((t) => st.techs[t].active !== false && withAsg.has(t) && st.derived.techInfo[t].curStatus !== 'done');
}
const serverDraft = (st, t) => Object.values(st.controls).find((c) => c.techId === t && c.status === 'borrador' && !c.correction);

export const tests = [
  {
    name: 'service worker activates, never caches /api or error pages, and the shell opens offline',
    allowErrors: ['ERR_', 'net::'],
    async fn(page, { srv }) {
      await loginAs(page);
      await swControlled(page);
      assert((await page.eval('caches.keys()')).includes(CACHE), 'cache name ' + CACHE);
      eq(await page.eval("fetch('/api/health').then((r)=>r.status)"), 200, 'api through the SW');
      eq(await page.eval("fetch('/assets/no-existe.js').then((r)=>r.status)"), 404, 'missing asset');
      await page.goto('/no-existe'); await page.ready();
      await page.goto('/'); await page.ready();
      const keys = await page.eval(`caches.open('${CACHE}').then((c)=>c.keys()).then((l)=>l.map((r)=>new URL(r.url).pathname))`);
      assert(!keys.some((k) => k.startsWith('/api')), 'no /api response cached: ' + keys.join(','));
      assert(!keys.includes('/assets/no-existe.js'), 'error response not cached');
      assert(keys.some((k) => k.startsWith('/assets/')), 'hashed assets cached');
      const cached = await page.eval(`caches.open('${CACHE}').then((c)=>c.match('/index.html')).then((r)=>r.text())`);
      assert(cached.includes('<title>Pañol</title>') && cached.includes('type="module"'), 'cached shell is the app, not an error page');
      srv.offline = true;
      await page.goto('/');
      await page.waitFor("(document.getElementById('view')||{}).textContent.includes('No se pudo conectar')", 15000, 'offline notice from the cached shell');
      srv.offline = false;
      await page.waitFor("!!document.querySelector('#side nav')", 20000, 'app recovers when the server answers again');
    }
  },
  {
    name: 'offline: banner, checklist draft kept on the device across a reload and resent on reconnect',
    allowErrors: ['ERR_', 'net::'],
    async fn(page, { srv }) {
      await loginAs(page);
      const st = await loadDemo(page);
      const t = pendingTech(st);
      assert(t, 'a tech pending control');
      await swControlled(page);
      await page.hash('#control-' + t);
      await page.waitFor("!!document.querySelector('[data-act=\"ckSet\"]')", 10000, 'checklist');
      const aid = await page.eval("document.querySelector('[data-act=\"ckSet\"]').dataset.aid");
      srv.offline = true;
      await page.waitFor("!document.getElementById('netbar').hidden", 15000, 'offline banner');
      assert((await page.text('#netbar')).includes('Sin conexión con el servidor'), 'banner text');
      await page.toasts();
      await page.click(`[data-act="ckSet"][data-aid="${aid}"][data-s="cambio"]`);
      await page.act('ckSave');
      await page.waitFor("window.__toasts.some((t)=>t.includes('borrador quedó guardado en este equipo'))", 5000, 'saved on the device');
      let local = await idbDrafts(page);
      eq(local.length, 1, 'one local draft');
      eq(local[0].items[aid].state, 'cambio', 'local draft content');
      await page.reload();
      await page.waitFor("(document.getElementById('view')||{}).textContent.includes('No se pudo conectar')", 15000, 'offline boot');
      local = await idbDrafts(page);
      eq(local.length, 1, 'draft survives the reload');
      srv.offline = false;
      await page.waitFor("window.__toasts.some((t)=>t.includes('Se envió el borrador guardado sin conexión'))", 25000, 'draft resent');
      const d = serverDraft(await state(page), t);
      assert(d && JSON.stringify(d).includes('cambio'), 'server has the draft: ' + JSON.stringify(d).slice(0, 300));
      eq((await idbDrafts(page)).length, 0, 'local copy removed once sent');
    }
  },
  {
    name: 'a live refresh from another session keeps the form being typed',
    async fn(page, ctx) {
      await loginAs(page);
      await page.hash('#entregas');
      await page.type('#mvreason', 'Motivo en curso');
      const b = await secondPage(ctx, 'admin');
      eq((await api(b, 'POST', '/api/techs', { name: 'Llegó en vivo', legajo: 'V-1', shiftId: 'manana' })).status, 201, 'other session writes');
      await page.waitFor("[...document.querySelectorAll('#mvtech option')].some((o)=>o.textContent.includes('Llegó en vivo'))", 10000, 'live refresh reached the form');
      eq(await page.eval("document.getElementById('mvreason').value"), 'Motivo en curso', 'typed text kept');
    }
  },
  {
    name: 'leaving the checklist saves its draft on the server',
    async fn(page) {
      await loginAs(page);
      const st = await loadDemo(page);
      const t = pendingTech(st);
      await page.hash('#control-' + t);
      await page.waitFor("!!document.querySelector('[data-act=\"ckSet\"]')", 10000, 'checklist');
      const aid = await page.eval("document.querySelector('[data-act=\"ckSet\"]').dataset.aid");
      await page.click(`[data-act="ckSet"][data-aid="${aid}"][data-s="cambio"]`);
      await page.hash('#inicio');
      const t0 = Date.now(); let d = null;
      while (Date.now() - t0 < 8000) { d = serverDraft(await state(page), t); if (d && JSON.stringify(d).includes('cambio')) break; await sleep(200); }
      assert(d && JSON.stringify(d).includes('cambio'), 'draft saved when leaving: ' + JSON.stringify(d || null).slice(0, 300));
    }
  },
  {
    name: 'a change survives an immediate reload',
    async fn(page) {
      await loginAs(page);
      for (let i = 0; i < 3; i++) {
        await page.hash('#config');
        await page.act('catNew'); await page.type('#f-cn', 'Recarga ' + i); await page.modalBtn('Crear');
        await page.reload(); await page.ready();
        assert(idOf(await state(page), 'categories', 'Recarga ' + i), 'change kept after reload ' + i);
        await page.hash('#config');
        assert((await page.text('#view')).includes('Recarga ' + i), 'shown after reload ' + i);
      }
    }
  },
  {
    name: 'failed actions show a message instead of an unhandled rejection',
    allowErrors: ['ERR_', 'net::'],
    async fn(page, { srv }) {
      await loginAs(page);
      await page.hash('#config');
      await page.act('toolNew'); await page.type('#f-tn', 'Pinza'); await page.modalBtn('Crear herramienta');
      srv.offline = true;
      await page.waitFor("!document.getElementById('netbar').hidden", 15000, 'offline banner');
      await page.toasts();
      await page.act('toolToggle');
      await sleep(300);
      assert((await page.toasts()).some((t) => t.includes('err') && t.includes('Sin conexión')), 'error toast for a direct action');
      await page.act('catNew'); await page.type('#f-cn', 'Sin red'); await page.modalBtn('Crear');
      assert((await page.text('#merr')).includes('Sin conexión'), 'error shown in the dialog');
      srv.offline = false;
    }
  }
];
