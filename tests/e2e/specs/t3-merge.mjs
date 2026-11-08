// T3: merge semantics of the .txt import and integrity checks, on the server.
// v3: records carry a server `version` (If-Match) instead of 2.1's client stamps and the server
// keeps no tombstones of its own: a stale write is refused (409) instead of merged. Tombstones
// still travel in the file (`data.deleted`) and are applied by Combinar. "Reemplazar todo" is
// only for the initial migration (no movements or controls on the server).
import { sleep } from '../harness.mjs';
import { assert, eq, loginAs, loadDemo, snapshot, state, api, idOf, importFile, downloadTxt, outFile, parseTxt, TXT_HEAD } from '../app.mjs';

const FUTURE = '2099-01-01T00:00:00.000Z';

export const tests = [
  {
    name: 'edits bump version and updatedAt; a stale version is refused with 409',
    async fn(page) {
      await loginAs(page);
      await page.hash('#config');
      await page.act('catNew'); await page.type('#f-cn', 'Uno'); await page.modalBtn('Crear');
      let st = await state(page);
      const id = idOf(st, 'categories', 'Uno');
      const a = st.categories[id];
      await sleep(20);
      await page.click(`[data-act="catEdit"][data-c="${id}"]`);
      await page.type('#f-cn', 'Dos'); await page.modalBtn('Guardar');
      st = await state(page);
      const b = st.categories[id];
      eq(b.name, 'Dos', 'renamed');
      assert(b.version > a.version && b.updatedAt > a.updatedAt, 'version/updatedAt advanced: ' + JSON.stringify([a, b]));
      const stale = await api(page, 'DELETE', '/api/categories/' + id, undefined, { version: a.version });
      eq(stale.status, 409, 'stale delete refused');
      eq(stale.body.current.name, 'Dos', '409 carries the current record');
      eq((await api(page, 'DELETE', '/api/categories/' + id)).status, 428, 'delete without If-Match refused');
      await page.click(`[data-act="catDel"][data-c="${id}"]`); await page.modalBtn('Eliminar');
      await page.waitFor(`!document.querySelector('[data-act="catDel"][data-c="${id}"]')`, 5000, 'deleted');
      eq((await state(page)).categories[id], undefined, 'deleted with the current version');
    }
  },
  {
    name: 'Combinar: strict newer wins, ties keep the server, file tombstones delete, no resurrection',
    async fn(page) {
      await loginAs(page);
      await loadDemo(page);
      // A tech without history, so the file can delete it (techs with units/assignments cannot go).
      const gone = (await api(page, 'POST', '/api/techs', { name: 'Para borrar', legajo: 'B-1', shiftId: 'manana' })).body.tech.id;
      const f0 = await downloadTxt(page);
      const p = parseTxt(f0);
      eq(Object.keys(p.data.deleted || {}).length, 0, 'export carries no tombstones');
      const st0 = await state(page);
      const ids = Object.keys(st0.techs).filter((t) => t !== gone).sort();
      // On the server after the export: tech 0 renamed (server newer than the file).
      await page.hash('#tecnico-' + ids[0]);
      await page.click(`[data-act="techEdit"][data-t="${ids[0]}"]`);
      await page.type('#f-name', 'Nombre del servidor'); await page.modalBtn('Guardar cambios');
      // In the file: tech 1 newer, tech 2 tie with other content, "Para borrar" deleted, and a new
      // category that the same file deletes (a tombstoned record must not be created).
      p.data.techs[ids[1]].name = 'Nombre del archivo'; p.data.techs[ids[1]].updatedAt = FUTURE;
      p.data.techs[ids[2]].name = 'Empate archivo';
      p.data.categories.gfantasma = { name: 'Fantasma', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
      p.data.deleted = { ['techs/' + gone]: FUTURE, 'categories/gfantasma': '2026-02-01T00:00:00.000Z' };
      const r = await importFile(page, outFile('merge-f1.txt', TXT_HEAD + JSON.stringify(p)), 'merge');
      assert(r.opened && !r.err, 'merge ok: ' + r.err + ' ' + r.report.slice(0, 600));
      const s = await state(page);
      eq(s.techs[ids[0]].name, 'Nombre del servidor', 'server newer kept');
      eq(s.techs[ids[1]].name, 'Nombre del archivo', 'file newer wins');
      assert(s.techs[ids[1]].updatedAt < new Date(Date.now() + 2 * 864e5).toISOString(), 'future stamp clamped');
      assert(s.techs[ids[2]].name !== 'Empate archivo', 'tie keeps the server');
      eq(s.techs[gone], undefined, 'file tombstone deletes the record');
      eq(s.categories.gfantasma, undefined, 'tombstoned record not created');
      const before = await snapshot(page);
      await page.reload(); await page.ready();
      eq(await snapshot(page), before, 'merged state persisted');
    }
  },
  {
    name: 'Reemplazar todo restores the exported state; re-importing the export changes nothing',
    async fn(page) {
      await loginAs(page);
      await page.hash('#config');
      await page.act('catNew'); await page.type('#f-cn', 'Eléctricas'); await page.modalBtn('Crear');
      await page.act('toolNew'); await page.type('#f-tn', 'Taladro'); await page.modalBtn('Crear herramienta');
      await page.hash('#tecnicos');
      await page.act('techNew'); await page.type('#f-name', 'Tomás Uno'); await page.type('#f-leg', '100'); await page.modalBtn('Crear técnico');
      // Replace needs another active admin in the file (it never leaves the server without one).
      eq((await api(page, 'POST', '/api/users', { username: 'admin2', name: 'Otra Admin', role: 'admin' })).status, 201, 'second admin');
      const f0 = await downloadTxt(page);
      const keep = (s) => JSON.stringify(['techs', 'categories', 'tools', 'shifts'].map((c) => s[c]));
      const want = keep(await state(page));
      const same = await importFile(page, outFile('roundtrip-f0.txt', f0), 'merge');
      assert(same.opened && !same.err && /\b0 cambios a aplicar/.test(same.report), 'export re-imported: 0 changes: ' + same.report.slice(0, 200));
      await page.hash('#config');
      await page.act('catNew'); await page.type('#f-cn', 'Extra'); await page.modalBtn('Crear');
      const r = await importFile(page, outFile('replace-f0.txt', f0), 'replace');
      assert(r.opened && !r.err, 'replace ok: ' + r.err + ' ' + r.report.slice(0, 400));
      const got = await state(page);
      eq(idOf(got, 'categories', 'Extra'), '', 'record created after the export is gone');
      eq(keep(got), want, 'catalog equals the file');
      assert(await page.eval("!!document.querySelector('#side nav')"), 'importer stays logged in');
    }
  },
  {
    name: 'integrity flags a negative pool written straight into the ledger',
    async fn(page, { srv }) {
      await loginAs(page);
      await page.hash('#config');
      await page.act('toolNew'); await page.type('#f-tn', 'Negativa'); await page.modalBtn('Crear herramienta');
      const tool = idOf(await state(page), 'tools', 'Negativa');
      // The API never lets a pool go negative; the owner connection bypasses it on purpose.
      await srv.db.query("INSERT INTO movements (id, type, tool_id, qty) VALUES ('mneg', 'baja', $1, 2)", [tool]);
      await srv.db.query("INSERT INTO movement_transfers (movement_id, seq, tool_id, qty, from_pool, to_pool) VALUES ('mneg', 0, $1, 2, 'asignado', 'baja')", [tool]);
      const issues = (await api(page, 'GET', '/api/integrity')).body.issues;
      assert(issues.length > 0, 'server integrity reports the issue');
      await page.reload(); await page.ready();
      await page.hash('#admin');
      await page.click('[data-act="adminTab"][data-v="data"]');
      const txt = await page.text('#view');
      assert(txt.includes('Negativa: saldo negativo') && txt.includes('-2'), 'negative pool flagged: ' + txt.slice(0, 500));
    }
  }
];
