// T3: merge semantics — stamps, strict newer-wins, tombstones, negative pools.
import { assert, eq, setupAdmin, loadDemo, snapshot, importFile, downloadTxt, outFile, login } from '../app.mjs';

const FUTURE = '2099-01-01T00:00:00.000Z';
const parse = (txt) => JSON.parse(txt.slice(txt.indexOf('{')));
const HEAD = 'PAÑOL · archivo de datos\r\nNo lo edites a mano.\r\n';

export const tests = [
  {
    name: 'put and patch stamp updatedAt; delete leaves a tombstone',
    async fn(page) {
      await setupAdmin(page);
      const r = await page.eval(`(async () => {
        await put('categories', 'gx', { name: 'Uno' }); const a = S.categories.gx.updatedAt;
        await new Promise((r) => setTimeout(r, 5)); await patch('categories', 'gx', { name: 'Dos' }); const b = S.categories.gx.updatedAt;
        await del('categories', 'gx');
        return { a, b, gone: !S.categories.gx, tomb: (payload().data.deleted || {})['categories/gx'] || null }; })()`);
      assert(r.a && r.b && r.b > r.a, 'stamps: ' + JSON.stringify(r));
      assert(r.gone && r.tomb, 'tombstone: ' + JSON.stringify(r));
    }
  },
  {
    name: 'Combinar: strict newer wins, ties keep local, deletions are not resurrected',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      await page.hash('#config');
      await page.act('catNew'); await page.type('#f-cn', 'Temporal'); await page.modalBtn('Crear');
      const f0 = await downloadTxt(page);
      assert(f0 && f0.includes('Temporal'), 'export has the new category');
      const ids = await page.eval("Object.keys(S.techs).sort()");
      const catId = await page.eval("Object.entries(S.categories).find(([,c])=>c.name==='Temporal')[0]");
      // Local changes after the export: delete the category and rename a tech (local is newer).
      await page.eval(`del('categories', ${JSON.stringify(catId)})`);
      await page.eval(`patch('techs', ${JSON.stringify(ids[0])}, { name: 'Nombre local' })`);
      const tieStamp = await page.eval(`S.techs[${JSON.stringify(ids[3])}].updatedAt`);
      // File changes: one tech newer in the file, one tie with different content, one deleted in the file.
      const p = parse(f0);
      p.data.techs[ids[1]].name = 'Nombre del archivo'; p.data.techs[ids[1]].updatedAt = FUTURE;
      p.data.techs[ids[3]].name = 'Empate archivo'; p.data.techs[ids[3]].updatedAt = tieStamp;
      p.data.deleted = { ...(p.data.deleted || {}), ['techs/' + ids[2]]: FUTURE };
      const f1 = outFile('merge-f1.txt', HEAD + JSON.stringify(p));
      const r = await importFile(page, f1, 'merge');
      assert(r.opened && !r.err, 'merge ok: ' + r.err);
      const s = await page.eval(`({ cat: !!S.categories[${JSON.stringify(catId)}], t0: S.techs[${JSON.stringify(ids[0])}].name,
        t1: S.techs[${JSON.stringify(ids[1])}].name, t2: !!S.techs[${JSON.stringify(ids[2])}], t3: S.techs[${JSON.stringify(ids[3])}].name })`);
      eq(s.cat, false, 'deleted category not resurrected');
      eq(s.t0, 'Nombre local', 'local newer kept');
      eq(s.t1, 'Nombre del archivo', 'file newer wins');
      eq(s.t2, false, 'file tombstone deletes the record');
      assert(s.t3 !== 'Empate archivo', 'tie keeps local');
      const before = await snapshot(page);
      await page.reload(); await page.ready();
      eq(await snapshot(page), before, 'merged state persisted');
    }
  },
  {
    name: 'Reemplazar todo restores the exported state',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      const f0 = await downloadTxt(page);
      const want = JSON.stringify(Object.fromEntries(Object.entries(parse(f0).data).filter(([k]) => k !== 'deleted')));
      await page.eval("put('categories','gextra',{name:'Extra'})");
      const r = await importFile(page, outFile('replace-f0.txt', f0), 'replace');
      assert(r.opened && !r.err, 'replace ok: ' + r.err);
      if (!(await page.eval('!!ME.id'))) eq(await login(page, '1234'), '', 'login again');
      const got = await page.eval("JSON.stringify(Object.fromEntries(COLS.map((c)=>[c,S[c]]).filter(([c])=>c!=='audit')))");
      const w = JSON.parse(want); delete w.audit;
      eq(got, JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(got)).map((k) => [k, w[k] || {}]))), 'state equals the file (audit aside)');
    }
  },
  {
    name: 'integrity flags negative pools',
    async fn(page) {
      await setupAdmin(page);
      const issues = await page.eval(`(async () => {
        await put('tools', 'hneg', { name: 'Negativa', serialized: false, active: true });
        await put('movements', 'mneg', { type: 'baja', toolId: 'hneg', qty: 2, transfers: [{ toolId: 'hneg', qty: 2, from: 'asignado', to: 'baja', unitId: null }], at: nowISO() });
        return integrity().map((x) => x.t + ' ' + x.s); })()`);
      assert(issues.some((t) => t.includes('saldo negativo') && t.includes(-2)), 'negative pool flagged: ' + issues.join(' | '));
    }
  }
];
