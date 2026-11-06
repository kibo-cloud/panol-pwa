// T1: the .txt import is gated (logged-in admin, or first run) and validated before it touches data.
import fs from 'node:fs';
import { sleep } from '../harness.mjs';
import { fixture, outFile, assert, eq, setupAdmin, login, logout, loadDemo, snapshot, importFile, ROUTES } from '../app.mjs';

async function visitAll(page, extra = []) {
  for (const r of [...ROUTES, ...extra]) {
    await page.hash('#' + r);
    eq(await page.eval('window.__xss'), undefined, 'window.__xss after #' + r);
  }
}

export const tests = [
  {
    name: 'malformed files are rejected and leave data unchanged',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      const before = await snapshot(page);
      const big = outFile('oversized.txt', '{"app":"panol","data":{"techs":{}},"pad":"' + 'x'.repeat(21 * 1024 * 1024) + '"}');
      for (const f of ['garbage.txt', 'empty.txt', 'data-array.txt', 'data-empty.txt', 'wrong-shape.txt', 'proto-key.txt', big]) {
        const r = await importFile(page, f.includes('/') || f.includes('\\') ? f : fixture(f), 'replace');
        assert(!r.opened || r.err, `${f} should be rejected (opened=${r.opened}, err=${r.err})`);
        await page.eval('closeModal()');
        eq(await snapshot(page), before, 'data unchanged after ' + f);
        eq(await page.eval('({}).polluted'), undefined, 'no prototype pollution after ' + f);
        assert(await page.eval('!!ME.id'), 'still logged in after ' + f);
      }
      await visitAll(page);
    }
  },
  {
    name: 'imported ids, turnos ids and numbers cannot inject markup',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      const before = await snapshot(page);
      for (const [f, mode] of [['xss-ids.txt', 'replace'], ['xss-numbers.txt', 'replace'], ['xss-turnos.txt', 'merge']]) {
        const r = await importFile(page, fixture(f), mode);
        await page.eval('closeModal()');
        if (!(await page.eval('!!ME.id'))) await login(page, '1234', 'Ana Admin');
        await visitAll(page);
        assert(!r.opened || r.err, `${f} should be rejected`);
        eq(await snapshot(page), before, 'data unchanged after ' + f);
      }
    }
  },
  {
    name: 'imported text is rendered escaped',
    async fn(page) {
      await setupAdmin(page);
      const r = await importFile(page, fixture('xss-text.txt'), 'replace');
      assert(r.opened && !r.err, 'xss-text.txt is a valid file: ' + r.err);
      eq(await login(page, '1234', 'Ana Admin'), '', 'login with the file admin');
      await visitAll(page, ['tecnico-t1', 'herramienta-h1', 'turno-manana', 'control-t1']);
      assert((await page.text('#view')).includes('<img'), 'payload shown as text');
    }
  },
  {
    name: 'replace refuses a file without an active admin',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      const before = await snapshot(page);
      const r = await importFile(page, fixture('no-admin.txt'), 'replace');
      assert(r.opened && r.err, 'replace should fail with a message');
      await page.eval('closeModal()');
      eq(await snapshot(page), before, 'data unchanged');
      assert(await page.eval('!!ME.id'), 'still logged in');
    }
  },
  {
    name: 'import is blocked while logged out (auth view and launch handler)',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      const before = await snapshot(page);
      await logout(page);
      await page.ready();
      eq(await page.count('#view [data-act="dataOpen"]'), 0, 'no open-file button on the login screen');
      await page.toasts();
      const chooser = page.cdp.once('Page.fileChooserOpened', 1500).then(() => true, () => false);
      await page.eval('ACT.dataOpen()', { gesture: true });
      assert(!(await chooser), 'file chooser must not open');
      assert((await page.toasts()).some((t) => t.includes('err')), 'error toast');
      const txt = JSON.stringify(fs.readFileSync(fixture('legacy-2.0.0.txt'), 'utf8'));
      await page.eval(`onLaunch({ files: [{ getFile: async () => new File([${txt}], 'x.txt') }] })`);
      await sleep(400);
      eq(await page.count('#modal-root:not([hidden]) .sheet'), 0, 'no import dialog from the launch handler');
      eq(await snapshot(page), before, 'data unchanged');
    }
  }
];
