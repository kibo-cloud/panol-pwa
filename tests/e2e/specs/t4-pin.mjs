// T4: credential hardening on the server — argon2id passwords, progressive lockout, and the
// 2.0.0/2.1 PIN users migrated through the .txt import.
// v3: PINs are replaced by user + password (argon2id, verified on the server); the lockout
// lives in the database (`login_locks`), not in the device; legacy PINs (sha256:/fnv:/pbkdf2$)
// work once as a temporary password and force a password change.
import { fixture, assert, eq, login, loginAs, logout, changePassword, importFile, state, PASSWORD, ROUTES } from '../app.mjs';

export const tests = [
  {
    name: 'passwords are argon2id; a wrong password is rejected, the right one logs in',
    async fn(page, { srv }) {
      const { rows } = await srv.db.query("SELECT password_hash FROM users WHERE username = 'admin'");
      assert(/^\$argon2id\$v=19\$m=\d+,(t=\d+,p=\d+|p=\d+,t=\d+)\$/.test(rows[0].password_hash), 'argon2id hash: ' + rows[0].password_hash.slice(0, 30));
      const bad = await login(page, 'admin', 'no-es-la-clave');
      assert(bad.length > 0 && bad !== 'change', 'wrong password rejected: ' + bad);
      const unknown = await login(page, 'nadie', 'no-es-la-clave');
      eq(unknown, bad, 'same message for an unknown user');
      eq(await login(page, 'admin', PASSWORD), '', 'right password accepted');
    }
  },
  {
    name: 'five failed logins lock the user, also after a reload',
    async fn(page, { srv }) {
      let msg = '';
      for (let i = 0; i < 5; i++) msg = await login(page, 'admin', 'clave-mala-' + i);
      assert(/Podés volver a intentar en/.test(msg), 'countdown after 5 failures: ' + msg);
      eq(await page.eval("document.getElementById('a-go').disabled"), true, 'login button disabled during the lock');
      const api = await page.eval("fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:" + JSON.stringify(PASSWORD) + "})}).then((r)=>r.status)");
      eq(api, 429, 'right password refused by the server while locked');
      await page.reload(); await page.ready();
      const again = await login(page, 'admin', PASSWORD);
      assert(/Podés volver a intentar en/.test(again), 'lock persists after reload: ' + again);
      const { rows } = await srv.db.query("SELECT fails, locked_until > now() AS locked FROM login_locks WHERE username = 'admin'");
      assert(rows[0] && rows[0].locked && rows[0].fails >= 5, 'lock stored in the database: ' + JSON.stringify(rows));
      await srv.db.query("DELETE FROM login_locks WHERE username = 'admin'");
      await page.reload(); await page.ready();
      eq(await login(page, 'admin', PASSWORD), '', 'login after the lock is cleared');
    }
  },
  {
    name: 'a 2.0.0 export imports and its legacy PIN users log in once with the PIN and must change it',
    async fn(page, { srv }) {
      await loginAs(page);
      const r = await importFile(page, fixture('legacy-2.0.0.txt'), 'merge');
      assert(r.opened && !r.err, 'legacy import ok: ' + r.err);
      assert(r.report.includes('PIN de 2.0'), 'report lists the migrated PIN users');
      const { rows } = await srv.db.query("SELECT name, username, password_hash IS NULL AS nopw, legacy_pin_hash, must_change_password FROM users WHERE legacy_pin_hash IS NOT NULL ORDER BY name");
      eq(rows.length, 3, 'three users with a legacy PIN');
      assert(rows.every((u) => u.nopw && u.must_change_password), 'no password yet, change required');
      const user = Object.fromEntries(rows.map((u) => [u.name, u.username]));
      assert(rows.find((u) => u.name === 'Ana Admin').legacy_pin_hash.startsWith('sha256:'), 'sha256 hash kept until the first login');
      const st = await state(page);
      assert(Object.keys(st.controls).length >= 12, 'legacy controls present');
      await logout(page);
      eq(await login(page, user['Ana Admin'], '1234'), 'change', 'legacy sha256 PIN opens the password change');
      eq((await page.eval("fetch('/api/state').then((r)=>r.status)")), 403, 'nothing else is allowed before the change');
      eq(await changePassword(page, '1234', 'clave-nueva-ana'), '', 'new password saved');
      const ana = (await srv.db.query('SELECT password_hash, legacy_pin_hash, must_change_password FROM users WHERE username = $1', [user['Ana Admin']])).rows[0];
      assert(ana.password_hash.startsWith('$argon2id$') && ana.legacy_pin_hash === null && !ana.must_change_password, 'legacy PIN replaced by argon2id');
      for (const x of ROUTES) await page.hash('#' + x);
      await logout(page);
      eq(await login(page, user['Fede Fnv'], '9999'), 'change', 'legacy fnv PIN works as temporary password');
      await page.act('authLeave'); await page.ready();
      const wrong = await login(page, user['Rita Resp'], '0000');
      assert(wrong.length > 0 && wrong !== 'change', 'wrong PIN for a legacy user rejected: ' + wrong);
      assert((await login(page, user['Ana Admin'], '1234')).length > 0, 'the PIN no longer works after the change');
      eq(await login(page, user['Ana Admin'], 'clave-nueva-ana'), '', 'new password logs in');
      await page.reload(); await page.ready();
      assert(await page.eval("!!document.querySelector('#side nav')"), 'session kept after reload');
    }
  }
];
