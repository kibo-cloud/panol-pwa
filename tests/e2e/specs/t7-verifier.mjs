// Verifier correction for 2.1.0: unsaved copy lifecycle, Replace tombstones, input limits,
// quarantine of dropped records, date validation/clamping and the login re-entry guard.
import { sleep } from '../harness.mjs';
import { assert, eq, setupAdmin, login, logout, loadDemo, importFile, downloadTxt, outFile } from '../app.mjs';

const HEAD = 'PAÑOL · archivo de datos\r\nNo lo edites a mano.\r\n';
const parse = (txt) => JSON.parse(txt.slice(txt.indexOf('{')));

export const tests = [
  {
    name: 'the unsaved safety copy is removed once the write lands',
    async fn(page) {
      await setupAdmin(page);
      await page.eval("put('categories','gu',{name:'U'}); window.dispatchEvent(new Event('pagehide'));");
      // While a write is in flight the copy is expected; once everything landed it must be gone.
      await page.waitFor('writing===0&&!idbTimer', 5000, 'writes settled');
      await sleep(50);
      await page.waitFor('writing===0&&!idbTimer', 5000, 'writes settled');
      eq(await page.eval("localStorage.getItem('panol-unsaved')"), null, 'copy removed after a successful write');
    }
  },
  {
    name: 'Reemplazar todo leaves tombstones so dropped records never come back',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      const f0 = await downloadTxt(page);
      await page.eval("put('categories','gextra',{name:'Extra'})");
      await sleep(200);
      // A stale safety copy that still holds the record (e.g. from another tab) must not resurrect it.
      await page.eval("localStorage.setItem('panol-unsaved', JSON.stringify(payload()))");
      const r = await importFile(page, outFile('v-replace.txt', f0), 'replace');
      assert(r.opened && !r.err, 'replace ok: ' + r.err);
      eq(await page.eval("localStorage.getItem('panol-unsaved')"), null, 'replace clears the copy');
      assert(await page.eval("!!DEL['categories/gextra']"), 'tombstone for the dropped record');
      await page.eval("localStorage.setItem('panol-unsaved', " + JSON.stringify(JSON.stringify({ app: 'panol', data: { categories: { gextra: { name: 'Extra', updatedAt: '2026-01-01T00:00:00.000Z' } } } })) + ")");
      await page.reload(); await page.ready();
      eq(await page.eval('!!S.categories.gextra'), false, 'not resurrected after reload');
    }
  },
  {
    name: 'form inputs are limited to what the schema accepts',
    async fn(page) {
      await setupAdmin(page);
      await page.hash('#tecnicos');
      await page.act('techNew');
      const ml = await page.eval("({n:document.getElementById('f-name').maxLength,l:document.getElementById('f-leg').maxLength})");
      assert(ml.n > 0 && ml.n <= 500 && ml.l > 0 && ml.l <= 200, 'maxlength: ' + JSON.stringify(ml));
      await page.type('#f-name', 'x'.repeat(600)); await page.type('#f-leg', '1');
      await page.modalBtn('Crear técnico');
      assert((await page.text('#merr')).length > 0, 'long name rejected by the form');
      eq(await page.eval('Object.keys(S.techs).length'), 0, 'nothing created');
    }
  },
  {
    name: 'invalid stored records are quarantined and reported, not silently dropped',
    async fn(page) {
      await setupAdmin(page);
      await sleep(200);
      await page.eval("(async()=>{const p=payload();p.data.techs.tbad={name:'x'.repeat(600)};p.data.techs.tok={name:'Bien',createdAt:'ayer'};await idbSet('data',p)})()");
      await page.reload(); await page.ready();
      assert((await page.toasts()).some((t) => /apart/i.test(t)), 'visible notice');
      const q = await page.eval("idbGet('quarantine')");
      assert(q && JSON.stringify(q).includes('tbad'), 'raw record kept in quarantine');
      eq(await page.eval('S.techs.tok&&S.techs.tok.createdAt'), '', 'bad date coerced, record kept');
      assert(await page.eval("integrity().some((x)=>/apart/i.test(x.t))"), 'integrity entry');
    }
  },
  {
    name: 'imports require ISO dates and far-future stamps are clamped on merge',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      const p = parse(await downloadTxt(page));
      const t = Object.keys(p.data.techs)[0];
      const bad = structuredClone(p); bad.data.techs[t].createdAt = 'ayer';
      const r1 = await importFile(page, outFile('v-baddate.txt', HEAD + JSON.stringify(bad)), 'merge');
      assert(!r1.opened || r1.err, 'non-ISO date rejected');
      await page.eval('closeModal()');
      p.data.techs[t].name = 'Del futuro'; p.data.techs[t].updatedAt = '2099-01-01T00:00:00.000Z';
      const r2 = await importFile(page, outFile('v-future.txt', HEAD + JSON.stringify(p)), 'merge');
      assert(r2.opened && !r2.err, 'merge ok');
      const s = await page.eval(`S.techs[${JSON.stringify(t)}]`);
      eq(s.name, 'Del futuro', 'newer file still wins');
      assert(s.updatedAt < new Date(Date.now() + 2 * 864e5).toISOString(), 'stamp clamped: ' + s.updatedAt);
    }
  },
  {
    name: 'concurrent login submissions verify one PIN at a time',
    async fn(page) {
      await setupAdmin(page, 'Ana Admin', '2468');
      await logout(page);
      await page.ready();
      await page.eval("UI.auth.pin='0000'; Promise.all(Array.from({length:8},()=>ACT.authLogin()))");
      await sleep(3000);
      const n = await page.eval("idbGet('pinLocks').then((l)=>Object.values(l||{}).reduce((a,x)=>a+x.n,0))");
      eq(n, 1, 'only one attempt counted');
      eq(await login(page, '2468'), '', 'right PIN still works');
    }
  }
];
