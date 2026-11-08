// T1: the .txt import is admin-only and validated by the server before it touches data.
// v3: the import goes through Más › Copia de seguridad › Importar .txt (server report first,
// then "Confirmar importación"). The 2.1 first-run import and the PWA launch handler no
// longer exist; their v3 equivalent is that a logged-out or non-admin user cannot import
// (no UI entry, forged clicks refused, the API answers 401/403).
import { sleep } from '../harness.mjs';
import { fixture, outFile, assert, eq, loginAs, loadDemo, snapshot, importFile, visitAll, logout, forgedAct, modalOpen } from '../app.mjs';

// One file per kind of damage. The import must report it and leave the data unchanged.
async function rejectAll(page, files) {
  const before = await snapshot(page);
  for (const f of files) {
    const r = await importFile(page, f.includes('/') || f.includes('\\') ? f : fixture(f), 'merge');
    assert(!r.opened || r.err, `${f} should be rejected (opened=${r.opened}, err=${r.err})`);
    await page.eval("document.getElementById('modal-root').hidden||document.querySelector('#modal-root [data-act=\"modalClose\"]').click()");
    await sleep(100);
    eq(await snapshot(page), before, 'data unchanged after ' + f);
    eq(await page.eval('({}).polluted'), undefined, 'no prototype pollution after ' + f);
    assert(await page.eval("!!document.querySelector('#side nav')"), 'still logged in after ' + f);
  }
}

export const tests = [
  {
    name: 'malformed files are rejected and leave data unchanged',
    async fn(page) {
      await loginAs(page);
      await loadDemo(page);
      const big = outFile('oversized.txt', '{"app":"panol","format":"panol-txt","version":2,"data":{"techs":{}},"pad":"' + 'x'.repeat(21 * 1024 * 1024) + '"}');
      await rejectAll(page, ['garbage.txt', 'empty.txt', 'data-array.txt', 'data-empty.txt', 'wrong-shape.txt', 'proto-key.txt', big]);
      await visitAll(page);
    }
  },
  {
    name: 'imported ids, turnos ids and numbers cannot inject markup',
    async fn(page) {
      await loginAs(page);
      await loadDemo(page);
      await rejectAll(page, ['xss-ids.txt', 'xss-numbers.txt', 'xss-turnos.txt']);
      await visitAll(page);
    }
  },
  {
    name: 'imported text is rendered escaped on every route',
    async fn(page) {
      await loginAs(page);
      const r = await importFile(page, fixture('xss-text.txt'), 'replace');
      assert(r.opened && !r.err, 'xss-text.txt is a valid file: ' + r.err);
      await visitAll(page, ['tecnico-t1', 'herramienta-h1', 'turno-manana', 'control-t1', 'admin']);
      await page.hash('#tecnicos');
      assert((await page.text('#view')).includes('<img'), 'payload shown as text');
      await page.hash('#herramienta-h1');
      assert((await page.text('#view')).includes('<img'), 'payload shown as text in the tool sheet');
    }
  },
  {
    name: 'replace refuses a file without an active admin',
    async fn(page) {
      await loginAs(page);
      const before = await snapshot(page);
      const r = await importFile(page, fixture('no-admin.txt'), 'replace');
      assert(r.opened && r.err, 'replace should fail with a message');
      assert(r.report.includes('administrador activo'), 'report explains the missing admin: ' + r.report.slice(0, 300));
      eq(await snapshot(page), before, 'data unchanged');
      assert(await page.eval("!!document.querySelector('#side nav')"), 'still logged in');
    }
  },
  {
    name: 'import is blocked while logged out and for non-admin users',
    async fn(page) {
      await loginAs(page);
      await loadDemo(page);
      const before = await snapshot(page);
      await logout(page);
      eq(await page.count('[data-act="dataImport"],[data-act="backup"]'), 0, 'no import entry on the login screen');
      await page.toasts();
      const chooser = page.cdp.once('Page.fileChooserOpened', 1500).then(() => true, () => false);
      await forgedAct(page, 'dataImport');
      assert(!(await chooser), 'file chooser must not open while logged out');
      assert((await page.toasts()).some((t) => t.includes('err')), 'error toast');
      const anon = await page.eval("fetch('/api/import/txt?mode=merge&dryRun=1',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'}).then((r)=>r.status)");
      eq(anon, 401, 'API refuses the import without a session');
      await loginAs(page, 'responsable');
      await page.hash('#mas'); await page.act('backup');
      eq(await page.count('#modal-root [data-act="dataImport"]'), 0, 'no import button for a non-admin');
      await page.eval("document.querySelector('#modal-root [data-act=\"modalClose\"]').click()");
      const chooser2 = page.cdp.once('Page.fileChooserOpened', 1500).then(() => true, () => false);
      await forgedAct(page, 'dataImport');
      assert(!(await chooser2), 'file chooser must not open for a non-admin');
      eq(await modalOpen(page), false, 'no import dialog');
      const st = await page.eval("(async()=>{const me=await fetch('/api/auth/me').then((r)=>r.json());return fetch('/api/import/txt?mode=merge&dryRun=1',{method:'POST',headers:{'Content-Type':'text/plain','X-CSRF-Token':me.csrfToken},body:'{}'}).then((r)=>r.status)})()");
      eq(st, 403, 'API refuses the import for a non-admin');
      eq(await snapshot(page), before, 'data unchanged');
    }
  }
];
