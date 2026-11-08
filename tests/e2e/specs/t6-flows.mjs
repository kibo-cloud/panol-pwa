// T6: end-to-end flows of normal use on the v3 server (regression net).
// v3: the 2.1 first-run setup (create the first admin on the device) no longer exists; the
// server always has users and boot shows the login screen. Reads go through /api/state.
import { sleep } from '../harness.mjs';
import { assert, eq, loginAs, loadDemo, snapshot, state, api, idOf, forgedAct, modalOpen, isLoggedIn, ROUTES } from '../app.mjs';

async function checkRoutes(page, routes, width) {
  await page.viewport(width);
  for (const r of routes) {
    await page.hash('#' + r);
    const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.getElementById("view").innerHTML.length })');
    assert(v.h > 200, `#${r} rendered at ${width}`);
    assert(v.sw <= v.iw + 1, `#${r} overflows at ${width}: ${v.sw} > ${v.iw}`);
  }
  await page.screenshot(`routes-${width}`);
}

const pool = async (page, tool) => (await api(page, 'GET', '/api/inventory')).body.pools[tool];

// Read-only profile: no edit buttons, forged clicks open nothing, the API answers 403.
async function readOnly(page, username) {
  await loginAs(page, username);
  await sleep(300);
  const before = await snapshot(page);
  for (const r of ROUTES) await page.hash('#' + r);
  await page.hash('#tecnicos'); eq(await page.count('[data-act="techNew"]'), 0, username + ': no new tech button');
  await page.hash('#config'); eq(await page.count('[data-act="toolNew"],[data-act="catNew"]'), 0, username + ': no tool buttons');
  await page.hash('#entregas'); eq(await page.count('#mvform'), 0, username + ': no movement form');
  const st = await state(page);
  const t = Object.values(st.assignments).find((a) => a.active).techId;
  await page.hash('#control-' + t);
  eq(await page.count('[data-act="ckFinish"]'), 0, username + ': cannot finish controls');
  await page.hash('#mas');
  for (const a of ['techNew', 'toolNew', 'catNew', 'dataImport', 'loadDemo', 'userNew']) {
    await forgedAct(page, a);
    eq(await modalOpen(page), false, `${username}: no dialog from ${a}`);
  }
  const w = await api(page, 'POST', '/api/techs', { name: 'No debería', legajo: 'X1', shiftId: 'manana' });
  eq(w.status, 403, username + ': API refuses the write');
  eq(await snapshot(page), before, username + ': data unchanged');
}

export const tests = [
  {
    name: 'boot shows the login screen without errors',
    async fn(page) {
      assert(await page.eval('!!document.getElementById("a-user")&&!!document.getElementById("a-pass")'), 'login form');
      eq(await page.eval('document.getElementById("a-keep").checked'), true, '"Mantener la sesión" checked by default');
      eq((await api(page, 'GET', '/api/auth/me')).status, 401, 'nobody logged in');
      eq(await page.count('#side nav'), 0, 'no app chrome before login');
    }
  },
  {
    name: 'demo data: every route renders at 1280 and 390 without overflow',
    async fn(page) {
      await loginAs(page);
      const st = await loadDemo(page);
      const t = Object.keys(st.techs)[0];
      const h = Object.keys(st.tools)[0];
      const c = Object.values(st.derived.effective)[0];
      assert(c, 'an effective control in the demo data');
      const routes = [...ROUTES, 'tecnico-' + t, 'herramienta-' + h, 'turno-' + st.shifts[0].id, 'control-' + t, 'controlver-' + c];
      await checkRoutes(page, routes, 1280);
      await checkRoutes(page, routes, 390);
      await page.viewport(1280);
      await page.hash('#admin');
      for (const tab of ['users', 'shifts', 'data', 'audit']) {
        await page.click(`[data-act="adminTab"][data-v="${tab}"]`);
        await page.waitFor("!document.querySelector('#view .loading')", 10000, 'admin tab ' + tab);
        assert((await page.text('#view')).length > 50, 'admin tab ' + tab);
      }
      await page.click('[data-act="adminTab"][data-v="data"]');
      assert((await page.text('#view')).includes('Sin inconsistencias'), 'integrity view clean');
      eq((await api(page, 'GET', '/api/integrity')).body.issues.length, 0, 'demo data has no integrity issues');
    }
  },
  {
    name: 'tool, tech, entrega, control and reposicion persist after reload',
    async fn(page) {
      await loginAs(page);
      await page.hash('#config');
      await page.act('catNew'); await page.type('#f-cn', 'Manuales'); await page.modalBtn('Crear');
      await page.act('toolNew'); await page.type('#f-tn', 'Martillo'); await page.type('#f-ts', '5'); await page.modalBtn('Crear herramienta');
      let st = await state(page);
      const tool = idOf(st, 'tools', 'Martillo');
      assert(tool, 'tool created');
      await page.hash('#tecnicos');
      await page.act('techNew'); await page.type('#f-name', 'Juan Pérez'); await page.type('#f-leg', '555'); await page.modalBtn('Crear técnico');
      st = await state(page);
      const tech = idOf(st, 'techs', 'Juan Pérez');
      assert(tech, 'tech created');
      await page.hash('#entregas');
      await page.select('#mvtech', tech); await page.select('#mvtool', tool);
      await page.act('mvSubmit');
      await page.waitFor("!document.body.classList.contains('busy')", 10000, 'entrega sent');
      st = await state(page);
      assert(Object.values(st.assignments).some((a) => a.active && a.techId === tech), 'assignment');
      eq((await pool(page, tool)).disponible, 4, 'stock decreased');
      await page.hash('#control-' + tech);
      await page.act('ckAllOk'); await page.act('ckFinish'); await page.modalBtn('Confirmar y guardar');
      await page.waitFor("!!document.querySelector('#modal-root .success')", 10000, 'control saved');
      st = await state(page);
      assert(Object.values(st.controls).some((c) => c.status === 'finalizado' && c.techId === tech), 'control finalized');
      await page.eval("document.querySelector('#modal-root .scrim').click()");
      await page.hash('#entregas');
      await page.click('[data-act="mvType"][data-v="reposicion"]');
      await page.select('#mvtech', tech);
      const asg = Object.entries(st.assignments).find(([, a]) => a.active && a.techId === tech)[0];
      await page.select('#mvasg', asg);
      await page.act('mvSubmit');
      await page.waitFor("!document.body.classList.contains('busy')", 10000, 'reposicion sent');
      st = await state(page);
      assert(Object.values(st.movements).some((m) => m.type === 'reposicion'), 'reposicion');
      const p = await pool(page, tool);
      eq(p.asignado, 1, 'one assigned after reposicion'); eq(p.reparacion, 1, 'old one in repair'); eq(p.disponible, 3, 'stock');
      const before = await snapshot(page);
      await page.reload(); await page.ready();
      assert(await isLoggedIn(page), 'session kept');
      eq(await snapshot(page), before, 'everything persisted');
      eq((await api(page, 'GET', '/api/integrity')).body.issues.length, 0, 'no integrity issues');
    }
  },
  {
    name: 'consulta and gerencia users cannot change data',
    async fn(page) {
      await loginAs(page);
      await loadDemo(page);
      await page.hash('#mas'); await page.act('logout'); await page.modalBtn('Cerrar sesión');
      await page.ready();
      await readOnly(page, 'consulta');
      await page.hash('#mas'); await page.act('logout'); await page.modalBtn('Cerrar sesión');
      await page.ready();
      await readOnly(page, 'gerencia');
      await page.hash('#reportes');
      eq(await page.count('[data-act="exportCsv"]'), 1, 'gerencia can export reports');
    }
  }
];
