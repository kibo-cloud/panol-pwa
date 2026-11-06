// T6: end-to-end flows of normal use (regression net for the hardening work).
import { sleep } from '../harness.mjs';
import { assert, eq, setupAdmin, login, logout, loadDemo, snapshot, ROUTES } from '../app.mjs';

const idOf = (page, col, name) => page.eval(`(Object.entries(S.${col}).find(([,x])=>x.name===${JSON.stringify(name)})||[''])[0]`);

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

export const tests = [
  {
    name: 'boot shows the first-run setup without errors',
    async fn(page) {
      assert(await page.eval('!!document.getElementById("a-name")'), 'setup form');
      eq(await page.eval('ME.id'), null, 'nobody logged in');
    }
  },
  {
    name: 'demo data: every route renders at 1280 and 390 without overflow',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      const d = await page.eval(`(() => { const d = derive(); return { t: d.techs[0].id, h: d.tools[0].id, s: d.shifts[0].id, c: d.effList[0].id }; })()`);
      const routes = [...ROUTES, 'tecnico-' + d.t, 'herramienta-' + d.h, 'turno-' + d.s, 'control-' + d.t, 'controlver-' + d.c];
      await checkRoutes(page, routes, 1280);
      await checkRoutes(page, routes, 390);
      await page.viewport(1280);
      await page.hash('#admin');
      for (const tab of ['users', 'shifts', 'data', 'audit']) { await page.click(`[data-act="adminTab"][data-v="${tab}"]`); assert((await page.text('#view')).length > 50, 'admin tab ' + tab); }
      const issues = await page.eval('integrity().length');
      eq(issues, 0, 'demo data has no integrity issues');
    }
  },
  {
    name: 'tool, tech, entrega, control and reposicion persist after reload',
    async fn(page) {
      await setupAdmin(page);
      await page.hash('#config');
      await page.act('catNew'); await page.type('#f-cn', 'Manuales'); await page.modalBtn('Crear');
      await page.act('toolNew'); await page.type('#f-tn', 'Martillo'); await page.type('#f-ts', '5'); await page.modalBtn('Crear herramienta');
      const tool = await idOf(page, 'tools', 'Martillo');
      assert(tool, 'tool created');
      await page.hash('#tecnicos');
      await page.act('techNew'); await page.type('#f-name', 'Juan Pérez'); await page.type('#f-leg', '555'); await page.modalBtn('Crear técnico');
      const tech = await idOf(page, 'techs', 'Juan Pérez');
      assert(tech, 'tech created');
      await page.hash('#entregas');
      await page.select('#mvtech', tech); await page.select('#mvtool', tool);
      await page.act('mvSubmit');
      await page.waitFor(`Object.values(S.assignments).some((a)=>a.active&&a.techId===${JSON.stringify(tech)})`, 5000, 'assignment');
      eq(await page.eval(`derive().pools[${JSON.stringify(tool)}].disponible`), 4, 'stock decreased');
      await page.hash('#control-' + tech);
      await page.act('ckAllOk'); await page.act('ckFinish'); await page.modalBtn('Confirmar y guardar');
      await page.waitFor(`Object.values(S.controls).some((c)=>c.status==='finalizado'&&c.techId===${JSON.stringify(tech)})`, 5000, 'control');
      await page.eval('closeModal()');
      await page.hash('#entregas');
      await page.click('[data-act="mvType"][data-v="reposicion"]');
      await page.select('#mvtech', tech);
      const asg = await page.eval(`Object.entries(S.assignments).find(([,a])=>a.active&&a.techId===${JSON.stringify(tech)})[0]`);
      await page.select('#mvasg', asg);
      await page.act('mvSubmit');
      await page.waitFor(`Object.values(S.movements).some((m)=>m.type==='reposicion')`, 5000, 'reposicion');
      const p = await page.eval(`derive().pools[${JSON.stringify(tool)}]`);
      eq(p.asignado, 1, 'one assigned after reposicion'); eq(p.reparacion, 1, 'old one in repair'); eq(p.disponible, 3, 'stock');
      await sleep(400);
      const before = await snapshot(page);
      await page.reload(); await page.ready();
      eq(await snapshot(page), before, 'everything persisted');
      assert(await page.eval('!!ME.id'), 'session kept');
      eq(await page.eval('integrity().length'), 0, 'no integrity issues');
    }
  },
  {
    name: 'a consulta user cannot change data',
    async fn(page) {
      await setupAdmin(page);
      await loadDemo(page);
      await page.hash('#admin');
      await page.act('userNew');
      await page.type('#u-name', 'Carla Consulta');
      await page.click('#modal-root [data-act="mset"][data-k="role"][data-v="consulta"]');
      await page.type('#u-pin', '4321'); await page.type('#u-pin2', '4321');
      await page.modalBtn('Crear usuario');
      await page.waitFor("Object.values(S.users).some((u)=>u.role==='consulta')", 5000, 'consulta user');
      await logout(page);
      eq(await login(page, '4321', 'Carla Consulta'), '', 'consulta logs in');
      await sleep(400);
      const before = await snapshot(page);
      for (const r of ROUTES) await page.hash('#' + r);
      await page.hash('#tecnicos'); eq(await page.count('[data-act="techNew"]'), 0, 'no new tech button');
      await page.hash('#config'); eq(await page.count('[data-act="toolNew"],[data-act="catNew"]'), 0, 'no tool buttons');
      await page.hash('#entregas'); eq(await page.count('#mvform'), 0, 'no movement form');
      await page.hash('#control'); const t = await page.eval('derive().activeTechs[0].id'); await page.hash('#control-' + t);
      eq(await page.count('[data-act="ckFinish"]'), 0, 'cannot finish controls');
      await page.toasts();
      await page.eval('ACT.techNew(); ACT.dataOpen(); ACT.loadDemo(); ACT.userNew();', { gesture: true });
      await sleep(300);
      eq(await page.count('#modal-root:not([hidden]) .sheet'), 0, 'no dialogs opened');
      eq(await snapshot(page), before, 'data unchanged');
    }
  }
];
