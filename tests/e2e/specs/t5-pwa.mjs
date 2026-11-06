// T5: robustness and PWA — service worker cache rules, pending writes, handler rejections.
import { sleep } from '../harness.mjs';
import { assert, eq, setupAdmin } from '../app.mjs';

export const tests = [
  {
    name: 'service worker activates, never caches error pages as the shell, and works offline',
    allowErrors: ['ERR_FAILED', 'net::'],
    async fn(page, { srv }) {
      await setupAdmin(page);
      await page.waitFor("navigator.serviceWorker.ready.then(()=>true)", 15000, 'sw ready');
      await page.reload(); await page.ready();
      assert(await page.eval('!!navigator.serviceWorker.controller'), 'page controlled by the SW');
      const keys = await page.eval('caches.keys()');
      assert(keys.includes('panol-v2.1.0'), 'cache name: ' + keys.join(','));
      await page.goto('/no-existe');
      await sleep(600);
      srv.offline = true;
      await page.goto('/');
      await page.ready();
      const off = await page.eval("idbGet('data').then((p)=>({me:ME.id,users:Object.keys(S.users).length,stored:p?Object.keys(p.data.users).length:0,err:B.storageError,view:!!document.querySelector('#view .ph,#view .hero,#view .card')}))");
      assert(off.me && off.view, 'app renders offline from the cache: ' + JSON.stringify(off));
      const cached = await page.eval("caches.open('panol-v2.1.0').then((c)=>c.match('./index.html')).then((r)=>r.text())");
      assert(cached.includes('<title>Pañol</title>'), 'cached shell is the app, not an error page');
      srv.offline = false;
    }
  },
  {
    name: 'a pending write survives a BroadcastChannel reload from another tab',
    async fn(page) {
      await setupAdmin(page);
      await sleep(400);
      await page.eval("put('categories','gpend',{name:'Pendiente'}); new BroadcastChannel('panol').postMessage('saved');");
      await sleep(900);
      eq(await page.eval('!!S.categories.gpend'), true, 'record kept in memory');
      eq(await page.eval("idbGet('data').then((p)=>!!p.data.categories.gpend)"), true, 'record persisted');
    }
  },
  {
    name: 'pending writes are flushed on pagehide',
    async fn(page) {
      await setupAdmin(page);
      await sleep(400);
      await page.eval("put('categories','gflush',{name:'Flush'}); window.dispatchEvent(new Event('pagehide'));");
      await sleep(60);
      eq(await page.eval("idbGet('data').then((p)=>!!p.data.categories.gflush)"), true, 'persisted before the 250 ms debounce');
    }
  },
  {
    name: 'a change survives an immediate reload',
    async fn(page) {
      await setupAdmin(page);
      for (let i = 0; i < 3; i++) {
        await page.eval(`put('categories','gr${i}',{name:'Recarga ${i}'})`);
        await page.reload(); await page.ready();
        eq(await page.eval(`!!S.categories.gr${i}`), true, 'change kept after reload ' + i);
      }
      eq(await page.eval("localStorage.getItem('panol-unsaved')"), null, 'safety copy cleared after recovery');
    }
  },
  {
    name: 'rejected action handlers show a message instead of an unhandled rejection',
    async fn(page) {
      await setupAdmin(page);
      await page.toasts();
      await page.eval("ACT.__boom=async()=>{throw new UErr('Falla de prueba')}; const b=document.createElement('button'); b.dataset.act='__boom'; b.textContent='boom'; document.getElementById('view').appendChild(b);");
      await page.click('[data-act="__boom"]');
      await sleep(200);
      assert((await page.toasts()).some((t) => t.includes('Falla de prueba')), 'error toast shown');
    }
  }
];
