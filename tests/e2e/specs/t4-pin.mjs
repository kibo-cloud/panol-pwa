// T4: PIN hardening — PBKDF2, legacy hashes upgraded on login, progressive lockout.
import { sleep } from '../harness.mjs';
import { fixture, assert, eq, setupAdmin, login, logout, ROUTES } from '../app.mjs';

const hashOf = (page, name) => page.eval(`(Object.values(S.users).find((u)=>u.name===${JSON.stringify(name)})||{}).pinHash||''`);

export const tests = [
  {
    name: 'new PINs use PBKDF2; wrong PIN is rejected, right PIN logs in',
    async fn(page) {
      await setupAdmin(page, 'Ana Admin', '2468');
      const h = await hashOf(page, 'Ana Admin');
      assert(/^pbkdf2\$\d{6,}\$[0-9a-f]{64}$/.test(h) && +h.split('$')[1] >= 210000, 'pbkdf2 hash: ' + h);
      await logout(page);
      assert((await login(page, '1111')).includes('no es correcto'), 'wrong PIN rejected');
      eq(await login(page, '2468'), '', 'right PIN accepted');
    }
  },
  {
    name: 'five failed PINs lock the user, also after a reload',
    async fn(page) {
      await setupAdmin(page, 'Ana Admin', '2468');
      await logout(page);
      let msg = '';
      for (let i = 0; i < 5; i++) msg = await login(page, '0000');
      assert(/Esper/.test(msg), 'locked after 5 failures: ' + msg);
      assert(/Esper/.test(await login(page, '2468')), 'right PIN refused while locked');
      await page.reload(); await page.ready();
      assert(/Esper/.test(await login(page, '2468')), 'lock persists after reload');
      await page.eval("idbDel('pinLocks')");
      await page.reload(); await page.ready();
      eq(await login(page, '2468'), '', 'login after the lock is cleared');
    }
  },
  {
    name: 'a 2.0.0 export opens on a new device and its legacy PINs log in and upgrade',
    async fn(page) {
      await page.chooseFile(fixture('legacy-2.0.0.txt'), () => page.click('#view [data-act="dataOpen"]'));
      await page.waitFor("!!document.querySelector('#modal-root:not([hidden]) .sheet')", 5000, 'import dialog on first run');
      await page.modalBtn('Abrir datos');
      await page.waitFor("Object.keys(S.users).length===3&&!!document.querySelector('#a-user')", 8000, 'legacy data loaded');
      assert((await hashOf(page, 'Ana Admin')).startsWith('sha256:'), 'legacy hash kept until login');
      eq(await login(page, '1234', 'Ana Admin'), '', 'legacy sha256 PIN logs in');
      assert((await hashOf(page, 'Ana Admin')).startsWith('pbkdf2$'), 'upgraded to pbkdf2');
      for (const r of ROUTES) await page.hash('#' + r);
      eq(await page.eval('Object.keys(S.controls).length>=12'), true, 'legacy controls present');
      await logout(page);
      eq(await login(page, '9999', 'Fede Fnv'), '', 'legacy fnv PIN logs in');
      assert((await hashOf(page, 'Fede Fnv')).startsWith('pbkdf2$'), 'fnv upgraded');
      await logout(page);
      assert((await login(page, '0000', 'Rita Resp')).length > 0, 'wrong PIN for a legacy user rejected');
      eq(await login(page, '1234', 'Ana Admin'), '', 'upgraded PIN still logs in');
      await page.reload(); await page.ready();
      assert((await hashOf(page, 'Ana Admin')).startsWith('pbkdf2$'), 'upgrade persisted');
      await sleep(100);
    }
  }
];
