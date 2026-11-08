// T8: flows new in v3 — server session ("Mantener la sesión"), forced change after an admin
// reset, live updates between sessions (SSE), 409 conflict notice, the .txt migration from
// 2.0.0 end to end, and the CSV export with spreadsheet formulas neutralized.
import { sleep } from '../harness.mjs';
import { fixture, assert, eq, login, loginAs, logout, changePassword, importFile, state, api, idOf, secondPage, PASSWORD } from '../app.mjs';

const sessionCookie = async (page) => {
  const { cookies } = await page.cdp.send('Network.getCookies', { urls: [page.srv.base + '/'] });
  return cookies.find((c) => c.name === 'panol_sid') || null;
};

export const tests = [
  {
    name: 'login with "Mantener la sesión" sets a persistent httpOnly cookie; without it, a session cookie',
    async fn(page) {
      await page.cdp.send('Network.enable');
      eq(await login(page, 'admin', PASSWORD, { keep: false }), '', 'login without keeping the session');
      let c = await sessionCookie(page);
      assert(c && c.httpOnly && c.sameSite === 'Lax' && c.session === true, 'session cookie: ' + JSON.stringify(c));
      await logout(page);
      eq(await sessionCookie(page), null, 'logout clears the cookie');
      eq(await login(page, 'admin', PASSWORD, { keep: true }), '', 'login keeping the session');
      c = await sessionCookie(page);
      const days = (c.expires * 1000 - Date.now()) / 864e5;
      assert(c.httpOnly && c.session === false && days > 29 && days <= 30.01, 'persistent cookie for 30 days: ' + JSON.stringify(c));
      await page.reload(); await page.ready();
      assert(await page.eval("!!document.querySelector('#side nav')"), 'session kept after reload');
      const me = await api(page, 'GET', '/api/auth/me');
      eq(me.body.user.username, 'admin', 'server session');
      assert(!(await page.eval('document.cookie')).includes('panol_sid'), 'cookie not readable from scripts');
    }
  },
  {
    name: 'an admin reset forces a password change on the next login',
    async fn(page) {
      await loginAs(page);
      await page.hash('#admin');
      await page.waitFor("!!document.querySelector('[data-act=\"userReset\"][data-u=\"u-responsable\"]')", 10000, 'users list');
      await page.click('[data-act="userReset"][data-u="u-responsable"]');
      await page.modalBtn('Restablecer');
      await page.waitFor("!!document.getElementById('tmppw')", 10000, 'temporary password shown');
      const tmp = await page.text('#tmppw');
      assert(tmp.length >= 10, 'temporary password');
      await page.modalBtn('Listo');
      assert((await page.text('#view')).includes('debe cambiar la contraseña'), 'list shows the pending change');
      await logout(page);
      eq((await login(page, 'responsable', PASSWORD)).length > 0, true, 'old password no longer works');
      eq(await login(page, 'responsable', tmp), 'change', 'temporary password opens the change screen');
      await page.type('#c-cur', tmp); await page.type('#c-new', 'una-clave-nueva'); await page.type('#c-new2', 'otra-clave-nueva');
      await page.act('authChange');
      assert((await page.text('#a-err')).includes('no coinciden'), 'mismatch rejected');
      eq(await changePassword(page, tmp, 'una-clave-nueva'), '', 'new password saved, app opens');
      await logout(page);
      assert((await login(page, 'responsable', tmp)).length > 0, 'temporary password used up');
      eq(await login(page, 'responsable', 'una-clave-nueva'), '', 'new password logs in');
    }
  },
  {
    name: 'changes from another session show up live (SSE)',
    async fn(page, ctx) {
      await loginAs(page);
      await page.hash('#config');
      const b = await secondPage(ctx, 'admin');
      await b.hash('#config');
      await b.act('catNew'); await b.type('#f-cn', 'Creada en otra sesión'); await b.modalBtn('Crear');
      await page.waitFor("document.getElementById('view').textContent.includes('Creada en otra sesión')", 10000, 'live update in the first session');
      await b.hash('#tecnicos');
      await b.act('techNew'); await b.type('#f-name', 'Técnico en vivo'); await b.type('#f-leg', 'V-9'); await b.modalBtn('Crear técnico');
      await page.hash('#tecnicos');
      await page.waitFor("document.getElementById('view').textContent.includes('Técnico en vivo')", 10000, 'tech list updated');
    }
  },
  {
    name: 'editing the same record in two sessions shows the conflict notice and never overwrites',
    async fn(page, ctx) {
      await loginAs(page);
      const id = (await api(page, 'POST', '/api/categories', { name: 'Original' })).body.category.id;
      await page.hash('#config');
      await page.waitFor(`!!document.querySelector('[data-act="catEdit"][data-c="${id}"]')`, 10000, 'category listed');
      await page.click(`[data-act="catEdit"][data-c="${id}"]`);
      await page.type('#f-cn', 'Cambio de A');
      const b = await secondPage(ctx, 'admin');
      await b.hash('#config');
      await b.click(`[data-act="catEdit"][data-c="${id}"]`);
      await b.type('#f-cn', 'Cambio de B'); await b.modalBtn('Guardar');
      eq((await state(b)).categories[id].name, 'Cambio de B', 'B saved');
      await page.waitFor("(document.getElementById('mconf')||{}).textContent.includes('Alguien modificó este registro')", 10000, 'conflict notice in A');
      await page.modalBtn('Guardar');
      assert(/modificó este registro/.test(await page.text('#merr')), '409 shown in the dialog: ' + await page.text('#merr'));
      eq((await state(page)).categories[id].name, 'Cambio de B', 'B not overwritten');
      await page.click('#modal-root [data-act="conflictKeep"]');
      await page.modalBtn('Guardar');
      await page.waitFor("document.getElementById('modal-root').hidden", 5000, 'saved after choosing to keep');
      eq((await state(page)).categories[id].name, 'Cambio de A', 'explicit "Mantener mis cambios" saves over the new version');
    }
  },
  {
    name: '.txt migration from 2.0.0: users, techs, controls and history visible',
    async fn(page, { srv }) {
      await loginAs(page);
      const r = await importFile(page, fixture('legacy-2.0.0.txt'), 'replace');
      assert(r.opened && !r.err, 'replace import ok: ' + r.err);
      for (const n of ['Ana Admin', 'Rita Resp', 'Fede Fnv']) assert(r.report.includes(n), 'report lists ' + n);
      const st = await state(page);
      const counts = Object.fromEntries(['techs', 'tools', 'units', 'assignments', 'controls', 'movements', 'categories'].map((c) => [c, Object.keys(st[c]).length]));
      eq(JSON.stringify(counts), JSON.stringify({ techs: 6, tools: 7, units: 23, assignments: 39, controls: 12, movements: 46, categories: 3 }), 'counts as in the file');
      await page.hash('#tecnicos');
      for (const n of ['Martín Gómez', 'Lucía Fernández', 'Carla Medina']) assert((await page.text('#view')).includes(n), 'tech listed: ' + n);
      await page.hash('#controles');
      assert((await page.text('#view')).length > 200, 'control history rendered');
      const t = idOf(st, 'techs', 'Martín Gómez');
      await page.hash('#tecnico-' + t);
      await page.click('[data-act="techTab"][data-v="ctl"]');
      assert((await page.text('#view')).includes('Finalizado'), 'tech sheet shows finalized controls');
      await page.hash('#admin');
      await page.waitFor("document.getElementById('view').textContent.includes('Rita Resp')", 10000, 'migrated users listed');
      assert((await page.text('#view')).includes('debe cambiar la contraseña'), 'migrated users must change the password');
      const { rows } = await srv.db.query("SELECT count(*)::int AS n FROM users WHERE id <> 'u-admin'");
      eq(rows[0].n, 3, 'server users = file users (+ the importer)');
      eq((await api(page, 'GET', '/api/integrity')).body.issues.length, 0, 'migrated data has no integrity issues');
    }
  },
  {
    name: 'CSV export neutralizes spreadsheet formulas',
    async fn(page) {
      await loginAs(page);
      const evil = ['=HYPERLINK("http://x";"clic")', '+SUM(1;2)', '-2+3 técnico', '@cmd técnico'];
      for (const [i, name] of evil.entries()) eq((await api(page, 'POST', '/api/techs', { name, legajo: i === 0 ? '=1+1' : 'F-' + i, shiftId: 'manana' })).status, 201, 'tech ' + name);
      await page.hash('#reportes');
      await page.waitFor("document.getElementById('view').textContent.includes('@cmd técnico')", 10000, 'report lists the new techs');
      const n = await page.eval('window.__blobs.length');
      await page.act('exportCsv');
      await page.waitFor(`window.__blobs.length>${n}`, 10000, 'csv blob');
      const csv = await page.lastBlob();
      for (const s of ["\"'=HYPERLINK(\"\"http://x\"\";\"\"clic\"\")\"", "\"'+SUM(1;2)\"", "'-2+3 técnico", "'@cmd técnico", ";'=1+1;"]) assert(csv.includes(s), 'neutralized cell ' + JSON.stringify(s));
      const cells = csv.replace(/^﻿/, '').split(/\r\n/).flatMap((l) => l.match(/("([^"]|"")*"|[^;]*)(;|$)/g) || []).map((c) => c.replace(/;$/, '').replace(/^"|"$/g, ''));
      const bad = cells.filter((c) => /^[=+@\t\r]/.test(c) || /^-\D/.test(c));
      eq(bad.length, 0, 'no cell starts a formula: ' + JSON.stringify(bad));
      await sleep(100);
    }
  }
];
