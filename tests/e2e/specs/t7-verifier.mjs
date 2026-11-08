// Verifier corrections still meaningful on v3: input limits (LIM) in the forms and on the
// server, ISO dates and far-future clamping on import, the empty-date rule, and the login
// re-entry guard.
// Retired with 2.1's device storage (no v3 equivalent): the localStorage unsaved safety copy,
// Replace tombstones in the device and the quarantine of invalid stored records (the server
// validates every write against its schema instead, covered by the integration suite).
import { sleep } from '../harness.mjs';
import { assert, eq, login, loginAs, loadDemo, state, api, importFile, downloadTxt, outFile, parseTxt, TXT_HEAD, PASSWORD } from '../app.mjs';
import { LIM } from '../../../web/src/state/constants.js';

const AT = '2026-11-01T10:00:00.000Z';
const ADMIN = { name: 'Ana Admin', role: 'admin', active: true, salt: 'salt1', pinHash: 'sha256:' + '0'.repeat(64), createdAt: AT, updatedAt: AT };
const file = (data) => TXT_HEAD + JSON.stringify({ app: 'panol', format: 'panol-txt', version: 2, savedAt: AT, data });
const ingreso = (id, at) => ({ type: 'ingreso', toolId: 'h1', qty: 3, transfers: [{ toolId: 'h1', qty: 3, from: 'externo', to: 'disponible', unitId: null }], at });

export const tests = [
  {
    name: 'form inputs are limited to what the schema accepts',
    async fn(page) {
      await loginAs(page);
      await page.hash('#tecnicos');
      await page.act('techNew');
      const ml = await page.eval("({n:document.getElementById('f-name').maxLength,l:document.getElementById('f-leg').maxLength})");
      eq(ml.n, LIM.name, 'name maxlength = LIM.name');
      eq(ml.l, LIM.legajo, 'legajo maxlength = LIM.legajo');
      await page.type('#f-name', 'x'.repeat(600)); await page.type('#f-leg', '1');
      await page.modalBtn('Crear técnico');
      assert((await page.text('#merr')).includes(String(LIM.name)), 'long name rejected by the form: ' + await page.text('#merr'));
      const r = await api(page, 'POST', '/api/techs', { name: 'x'.repeat(LIM.name + 1), legajo: '2', shiftId: 'manana' });
      eq(r.status, 400, 'long name rejected by the server');
      eq(Object.keys((await state(page)).techs).length, 0, 'nothing created');
    }
  },
  {
    name: 'imports require ISO dates and far-future stamps are clamped on merge',
    async fn(page) {
      await loginAs(page);
      await loadDemo(page);
      const p = parseTxt(await downloadTxt(page));
      const t = Object.keys(p.data.techs)[0];
      const bad = structuredClone(p); bad.data.techs[t].createdAt = 'ayer';
      const r1 = await importFile(page, outFile('v-baddate.txt', TXT_HEAD + JSON.stringify(bad)), 'merge');
      assert(r1.opened && r1.err && r1.report.includes('createdAt'), 'non-ISO date rejected with the field: ' + r1.report.slice(0, 300));
      await page.eval("document.querySelector('#modal-root [data-act=\"modalClose\"]').click()");
      p.data.techs[t].name = 'Del futuro'; p.data.techs[t].updatedAt = '2099-01-01T00:00:00.000Z';
      const r2 = await importFile(page, outFile('v-future.txt', TXT_HEAD + JSON.stringify(p)), 'merge');
      assert(r2.opened && !r2.err, 'merge ok: ' + r2.err);
      const s = (await state(page)).techs[t];
      eq(s.name, 'Del futuro', 'newer file still wins');
      assert(s.updatedAt < new Date(Date.now() + 2 * 864e5).toISOString(), 'stamp clamped: ' + s.updatedAt);
    }
  },
  {
    name: 'empty optional dates import as null; an empty required date is a report error',
    async fn(page, { srv }) {
      await loginAs(page);
      const base = { users: { uadmin: ADMIN }, tools: { h1: { name: 'Pinza', serialized: false, active: true, createdAt: AT } } };
      const r1 = await importFile(page, outFile('v-required-empty.txt', file({ ...base, movements: { m1: ingreso('m1', '') } })), 'merge');
      assert(r1.opened && r1.err, 'confirm refused while the report has errors');
      assert(r1.report.includes('Movimientos') && r1.report.includes('at'), 'report names the movement and field: ' + r1.report.slice(0, 400));
      eq((await srv.db.query('SELECT count(*)::int AS n FROM movements')).rows[0].n, 0, 'nothing written');
      await page.eval("document.querySelector('#modal-root [data-act=\"modalClose\"]').click()");
      await sleep(100);
      const ok = file({ ...base, techs: { t1: { name: 'Tomás Uno', legajo: '100', shiftId: 'manana', active: true, alta: '', createdAt: AT } }, movements: { m1: ingreso('m1', AT) } });
      const r2 = await importFile(page, outFile('v-optional-empty.txt', ok), 'merge');
      assert(r2.opened && !r2.err, 'file with an empty optional date imports: ' + r2.err + ' ' + r2.report.slice(0, 300));
      const { rows } = await srv.db.query("SELECT alta FROM techs WHERE id = 't1'");
      eq(rows.length, 1, 'tech imported');
      eq(rows[0].alta, null, 'empty optional date stored as NULL');
    }
  },
  {
    name: 'concurrent login submissions verify one password at a time',
    async fn(page, { srv }) {
      await page.type('#a-user', 'admin');
      await page.type('#a-pass', 'clave-equivocada');
      await page.eval("(() => { const b = document.getElementById('a-go'); for (let i = 0; i < 8; i++) b.click(); })()", { gesture: true });
      await page.waitFor("!!document.getElementById('a-err').textContent", 10000, 'login answer');
      await sleep(500);
      const { rows } = await srv.db.query("SELECT count(*)::int AS n FROM login_attempts WHERE username = 'admin'");
      eq(rows[0].n, 1, 'only one attempt sent and counted');
      eq(await login(page, 'admin', PASSWORD), '', 'right password still works');
    }
  }
];
