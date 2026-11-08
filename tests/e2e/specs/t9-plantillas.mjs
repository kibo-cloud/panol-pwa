// T9 (stage 2): plantillas instead of turnos, moving techs (one from the tech sheet, several in
// one step, temporary coverage with automatic return, permanent move during a coverage),
// rotation and supervisor change, the supervisor's "Mi plantilla", read-only profiles, shared
// boxes (línea + caja, one-form assignment, caja control), the 2.0.0 .txt turnos as plantillas,
// and every route at 1280 and 390.
import { sleep } from '../harness.mjs';
import { assert, eq, loginAs, logout, state, api, forgedAct, modalOpen, importFile, fixture, loadDemo, idOf, ROUTES } from '../app.mjs';

const today = async (srv) => (await srv.db.query('SELECT current_date::text AS d')).rows[0].d;
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const newTech = async (page, name, legajo, plantillaId) => { const r = await api(page, 'POST', '/api/techs', { name, legajo, plantillaId }); eq(r.status, 201, 'tech ' + name); return r.body.tech.id; };
const newTool = async (page, name, stock = 5) => { const r = await api(page, 'POST', '/api/tools', { name, serialized: false, stock }); eq(r.status, 201, 'tool ' + name); return r.body.tool.id; };
const assign = async (page, holder, toolId, qty = 1) => eq((await api(page, 'POST', '/api/assignments', { holder, toolId, qty }, { idem: 'asg-' + Math.random().toString(36).slice(2) })).status, 201, 'assignment');
const modalClosed = (page, label) => page.waitFor("!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const viewText = (page) => page.text('#view');
// Lo creado por la API desde la página llega a la app por SSE; recargar lo hace determinista.
const fresh = async (page) => { await page.reload(); await page.ready(); };

async function finishControl(page, hk) {
  await page.hash('#control-' + hk);
  await page.act('ckAllOk'); await page.act('ckFinish'); await page.modalBtn('Confirmar y guardar');
  await page.waitFor("!!document.querySelector('#modal-root .success')", 15000, 'control saved');
  await page.eval("document.querySelector('#modal-root .scrim').click()");
  await sleep(200);
}

// Abre "Cambiar de plantilla" en la ficha y completa el formulario.
async function moveFromSheet(page, techId, to, reason, { until } = {}) {
  await page.hash('#tecnico-' + techId);
  await page.act('shiftChange');
  await page.click(`#modal-root [data-act="mset"][data-k="to"][data-v="${to}"]`);
  await page.type('#mv-reason', reason);
  if (until) { await page.click('#mv-cov'); await page.type('#mv-until', until); }
  await page.modalBtn('Confirmar cambio');
}

async function checkRoutes(page, routes, width) {
  await page.viewport(width);
  for (const r of routes) {
    await page.hash('#' + r);
    const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.getElementById("view").innerHTML.length })');
    assert(v.h > 200, `#${r} rendered at ${width}`);
    assert(v.sw <= v.iw + 1, `#${r} overflows at ${width}: ${v.sw} > ${v.iw}`);
  }
  await page.screenshot(`t9-routes-${width}`);
}

export const tests = [
  {
    name: 'move one tech from the tech sheet: history shows it and old controls keep their plantilla in reports',
    async fn(page) {
      await loginAs(page);
      const tool = await newTool(page, 'Pinza');
      const t = await newTech(page, 'Ana Mover', 'MV-1', 'manana');
      await assign(page, { techId: t }, tool);
      await fresh(page);
      await finishControl(page, t);
      let st = await state(page);
      const [ctlId, ctl] = Object.entries(st.controls).find(([, c]) => c.techId === t && c.status === 'finalizado');
      eq(ctl.plantillaId, 'manana', 'control snapshot');
      await moveFromSheet(page, t, 'tarde', 'Pidió el cambio');
      await modalClosed(page, 'move done');
      st = await state(page);
      eq(st.techs[t].plantillaId, 'tarde', 'tech moved');
      assert((await viewText(page)).includes('Turno tarde'), 'sheet shows the new plantilla');
      await page.click('[data-act="techTab"][data-v="shift"]');
      assert((await viewText(page)).includes('Turno mañana → Turno tarde'), 'history shows the move');
      assert((await viewText(page)).includes('Pidió el cambio'), 'history shows the reason');
      eq(st.controls[ctlId].plantillaId, 'manana', 'old control keeps its plantilla');
      await page.hash('#reportes');
      const row = await page.eval(`[...document.querySelectorAll('#view tbody tr')].map((r) => r.textContent).find((x) => x.includes('Ana Mover')) || ''`);
      assert(row.includes('Turno mañana'), 'report row uses the control plantilla: ' + row);
      await page.select('#rps', 'manana');
      assert((await viewText(page)).includes('Ana Mover'), 'filter by the old plantilla still finds the tech');
      const rep = (await api(page, 'GET', '/api/reports')).body;
      eq(rep.rows.find((r) => r.id === t).plantillaId, 'manana', 'server report agrees');
    }
  },
  {
    name: '"Mover seleccionados" moves 2 techs in one step and leaves the rest',
    async fn(page, { srv }) {
      await loginAs(page);
      const a = await newTech(page, 'Sel Uno', 'S-1', 'noche');
      const b = await newTech(page, 'Sel Dos', 'S-2', 'noche');
      const c = await newTech(page, 'Sel Tres', 'S-3', 'noche');
      await fresh(page);
      await page.hash('#plantilla-noche');
      eq(await page.eval("document.querySelector('[data-act=\"plMoveSel\"]').disabled"), true, 'move disabled with nothing selected');
      assert((await viewText(page)).includes('Tildá a los técnicos'), 'disabled action says why');
      await page.click('#sel-' + a); await page.click('#sel-' + b);
      assert((await viewText(page)).includes('2 seleccionados'), 'selection count');
      await page.screenshot('t9-plantilla-selected');
      await page.act('plMoveSel');
      await page.click('#modal-root [data-act="mset"][data-k="to"][data-v="manana"]');
      await page.type('#mv-reason', 'Reorganización');
      await page.toasts();
      await page.modalBtn('Mover 2 técnicos');
      await modalClosed(page, 'move-selected done');
      const toasts = await page.toasts();
      assert(toasts.some((x) => x.includes('Se movieron 2 técnicos')), 'success toast: ' + toasts.join(' | '));
      const st = await state(page);
      eq(st.techs[a].plantillaId, 'manana', 'a moved'); eq(st.techs[b].plantillaId, 'manana', 'b moved'); eq(st.techs[c].plantillaId, 'noche', 'c stays');
      const { rows } = await srv.db.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'tech_move' AND entity_id = ANY($1)", [[a, b, c]]);
      eq(rows[0].n, 2, 'two moves audited');
      eq(await page.count('#view [data-ch="plSel"]:checked'), 0, 'selection cleared');
    }
  },
  {
    name: 'temporary coverage: back in the base plantilla after the return date; a permanent move during coverage cancels the return',
    async fn(page, { srv }) {
      await loginAs(page);
      const day = await today(srv);
      // Cobertura ya terminada (fechas en el pasado): hoy está de nuevo en su plantilla base.
      const x = await newTech(page, 'Cubre Pasado', 'C-1', 'tarde');
      eq((await api(page, 'POST', `/api/techs/${x}/move`, { plantillaId: 'noche', from: addDays(day, -6), until: addDays(day, -2), reason: 'Cubrió vacaciones' })).status, 200, 'past coverage');
      const y = await newTech(page, 'Cubre Ahora', 'C-2', 'tarde');
      await fresh(page);
      let st = await state(page);
      eq(st.techs[x].plantillaId, 'tarde', 'back in the base plantilla');
      await page.hash('#tecnico-' + x);
      await page.click('[data-act="techTab"][data-v="shift"]');
      assert((await viewText(page)).includes('Cobertura temporal en Turno noche'), 'history shows the coverage');
      assert((await viewText(page)).includes('vuelve a Turno tarde'), 'history shows the return');
      // Cobertura en curso desde la ficha, con fecha hasta en el futuro.
      const until = addDays(day, 3);
      await moveFromSheet(page, y, 'noche', 'Cobertura', { until });
      await modalClosed(page, 'coverage saved');
      st = await state(page);
      eq(st.techs[y].plantillaId, 'noche', 'covering today');
      assert((await viewText(page)).includes('Cobertura temporal hasta el'), 'sheet shows the coverage and its end');
      // Otra cobertura durante la primera: se avisa en la hoja y no se envía.
      await moveFromSheet(page, y, 'manana', 'Otra', { until: addDays(day, 2) });
      await page.waitFor("(document.getElementById('merr')||{}).textContent.includes('cobertura temporal hasta')", 5000, 'coverage refused in the sheet');
      eq((await api(page, 'POST', `/api/techs/${y}/move`, { plantillaId: 'manana', from: day, until: addDays(day, 2), reason: 'x' })).body.error, 'coverage_active', 'server refuses too');
      await page.eval("document.querySelector('#modal-root [data-act=\"modalClose\"]').click()");
      await sleep(150);
      // Cambio definitivo durante la cobertura: termina hoy y se cancela la vuelta.
      await moveFromSheet(page, y, 'manana', 'Se queda en mañana');
      await modalClosed(page, 'permanent move');
      st = await state(page);
      eq(st.techs[y].plantillaId, 'manana', 'moved for good');
      const rs = st.plantillaHistory[y];
      const live = rs.filter((r) => !(r.validFrom && r.validTo && r.validTo <= r.validFrom));
      eq(live.find((r) => r.validTo == null).plantillaId, 'manana', 'open range is the new plantilla');
      assert(!live.some((r) => r.validFrom === until), 'the automatic return is cancelled');
      const on = async (d) => (await srv.db.query('SELECT plantilla_on($1, $2::date) AS p', [y, d])).rows[0].p;
      eq(await on(addDays(until, 1)), 'manana', 'no return after the old until');
    }
  },
  {
    name: 'rotation and supervisor change are recorded; the supervisor sees "Mi plantilla" first and rotates only their own',
    async fn(page) {
      await loginAs(page);
      const t = await newTech(page, 'Gente Sup', 'G-1', 'tarde');
      const tool = await newTool(page, 'Llave');
      await assign(page, { techId: t }, tool);
      await fresh(page);
      await page.hash('#plantilla-tarde');
      await page.act('plSupervisor');
      await page.click('#modal-root [data-act="mset"][data-k="sup"][data-v="u-supervisor"]');
      await page.modalBtn('Confirmar supervisor');
      await modalClosed(page, 'supervisor saved');
      let st = await state(page);
      eq(st.plantillas.tarde.supervisorUserId, 'u-supervisor', 'supervisor set');
      assert((await viewText(page)).includes('Supervisor: Supervisor Prueba'), 'supervisor history');
      await logout(page);
      await loginAs(page, 'supervisor');
      await page.hash('#inicio');
      const first = await page.eval("document.querySelector('#view .plcard').getAttribute('href')");
      eq(first, '#plantilla-tarde', 'own plantilla first on the panel');
      assert((await viewText(page)).includes('Mi plantilla') && (await viewText(page)).includes('Alertas de tu gente'), 'Mi plantilla and their alerts');
      await page.hash('#plantillas');
      eq(await page.eval("document.querySelector('#view .plcard').getAttribute('href')"), '#plantilla-tarde', 'own plantilla first in the list');
      await page.hash('#alertas');
      eq(await page.eval("(document.querySelector('[data-act=\"alertPl\"].on')||{}).dataset.v"), 'tarde', 'alerts filter defaults to their plantilla');
      assert((await viewText(page)).includes('Gente Sup'), 'their pending control alert is listed');
      await page.hash('#plantilla-tarde');
      await page.act('plRotate');
      await page.click('#modal-root [data-act="mset"][data-k="label"][data-v="Noche"]');
      await page.modalBtn('Confirmar cambio de turno');
      await modalClosed(page, 'rotation saved');
      st = await state(page);
      eq(st.plantillas.tarde.currentShiftLabel, 'Noche', 'rotated');
      assert(st.plantillaRotations.some((r) => r.plantillaId === 'tarde' && r.label === 'Noche' && r.by === 'u-supervisor'), 'rotation recorded with the actor');
      assert((await viewText(page)).includes('Turno tarde → Noche'), 'rotation history');
      await page.hash('#plantilla-manana');
      eq(await page.count('[data-act="plRotate"]'), 0, 'no rotate button on another plantilla');
      await forgedAct(page, 'plRotate', { p: 'manana' });
      eq(await modalOpen(page), false, 'forged rotate opens nothing');
      eq((await api(page, 'POST', '/api/plantillas/manana/rotate', { label: 'Tarde' }, { version: st.plantillas.manana.version })).status, 403, 'server refuses');
    }
  },
  {
    name: 'consulta and gerencia cannot move techs or rotate plantillas',
    async fn(page) {
      await loginAs(page);
      const t = await newTech(page, 'Solo Leer', 'R-1', 'manana');
      await fresh(page);
      await logout(page);
      for (const u of ['consulta', 'gerencia']) {
        await loginAs(page, u);
        await page.hash('#plantilla-manana');
        eq(await page.count('[data-act="plRotate"],[data-act="plMoveSel"],[data-ch="plSel"],[data-act="plSupervisor"],[data-act="plRename"]'), 0, u + ': no move/rotate controls');
        await page.hash('#tecnico-' + t);
        eq(await page.count('[data-act="shiftChange"]'), 0, u + ': no Cambiar de plantilla');
        for (const [a, d] of [['shiftChange', { t }], ['plMoveSel', { p: 'manana' }], ['plRotate', { p: 'manana' }], ['plNew', {}]]) {
          await forgedAct(page, a, d);
          eq(await modalOpen(page), false, `${u}: no dialog from ${a}`);
        }
        const st = await state(page);
        eq((await api(page, 'POST', `/api/techs/${t}/move`, { plantillaId: 'tarde', from: '2026-01-01', reason: 'x' })).status, 403, u + ': move refused');
        eq((await api(page, 'POST', '/api/plantillas/manana/rotate', { label: 'Tarde' }, { version: st.plantillas.manana.version })).status, 403, u + ': rotate refused');
        eq(st.techs[t].plantillaId, 'manana', u + ': unchanged');
        await logout(page);
      }
    }
  },
  {
    name: 'caja: create línea and caja, assign a tool in one form, run and finalize a caja control',
    async fn(page) {
      await loginAs(page);
      const tool = await newTool(page, 'Amoladora', 4);
      const ref = await newTech(page, 'Referente Caja', 'K-1', 'manana');
      await fresh(page);
      await page.hash('#lineas');
      await page.act('lineaNew'); await page.type('#ln-name', 'Línea 3'); await page.modalBtn('Crear');
      await modalClosed(page, 'línea created');
      await page.act('cajaNew'); await page.type('#cj-name', 'Caja línea 3'); await page.select('#cj-ref', ref); await page.modalBtn('Crear caja');
      await modalClosed(page, 'caja created');
      let st = await state(page);
      const caja = idOf(st, 'cajas', 'Caja línea 3');
      assert(caja && st.cajas[caja].lineaId === idOf(st, 'lineas', 'Línea 3'), 'caja in its línea');
      eq(st.cajas[caja].referenteTechId, ref, 'referente');
      await page.waitFor(`location.hash==='#caja-${caja}'`, 5000, 'caja sheet');
      await page.act('asgNew');
      await page.select('#as-tool', tool);
      await page.type('#as-qty', '2');
      await page.modalBtn('Asignar');
      await modalClosed(page, 'assigned');
      st = await state(page);
      const asg = Object.values(st.assignments).find((a) => a.active && a.cajaId === caja);
      assert(asg && asg.qty === 2 && !asg.techId, 'assignment held by the caja');
      eq((await api(page, 'GET', '/api/inventory')).body.pools[tool].disponible, 2, 'stock decreased');
      assert((await viewText(page)).includes('Amoladora'), 'caja sheet lists the tool');
      await page.hash('#control');
      assert((await viewText(page)).includes('Caja línea 3'), 'caja listed to control');
      await finishControl(page, 'caja:' + caja);
      st = await state(page);
      const [cid, c] = Object.entries(st.controls).find(([, x]) => x.cajaId === caja && x.status === 'finalizado') || [];
      assert(c && !c.techId, 'caja control finalized');
      eq(st.derived.cajaInfo[caja].curStatus, 'done', 'caja controlled this week');
      await page.hash('#caja-' + caja);
      await page.click('[data-act="cajaTab"][data-v="ctl"]');
      assert((await viewText(page)).includes('Finalizado'), 'caja sheet shows the control');
      await page.hash('#controlver-' + cid);
      assert((await viewText(page)).includes('Caja compartida (sin plantilla)'), 'control detail of a caja');
    }
  },
  {
    name: '.txt 2.0.0 migration: turnos show as plantillas with their techs',
    async fn(page) {
      await loginAs(page);
      const r = await importFile(page, fixture('legacy-2.0.0.txt'), 'replace');
      assert(r.opened && !r.err, 'replace import ok: ' + r.err);
      await page.hash('#plantillas');
      for (const n of ['Turno mañana', 'Turno tarde', 'Turno noche']) assert((await viewText(page)).includes(n), 'plantilla listed: ' + n);
      await page.hash('#plantilla-manana');
      for (const n of ['Martín Gómez', 'Lucía Fernández']) assert((await viewText(page)).includes(n), 'member listed: ' + n);
      const st = await state(page);
      const t = idOf(st, 'techs', 'Carla Medina');
      eq(st.techs[t].plantillaId, 'noche', 'membership from the file');
      assert((st.plantillaHistory[t] || []).length >= 1, 'history range created');
      await page.hash('#tecnico-' + t);
      assert((await viewText(page)).includes('Plantilla actual') && (await viewText(page)).includes('Turno noche'), 'tech sheet shows the plantilla');
    }
  },
  {
    name: 'every route (plantillas, líneas, cajas included) renders at 1280 and 390 without overflow',
    async fn(page) {
      await loginAs(page);
      const st0 = await loadDemo(page);
      const l = await api(page, 'POST', '/api/lineas', { name: 'Sector envasado', kind: 'sector' });
      const k = await api(page, 'POST', '/api/cajas', { name: 'Caja envasado con un nombre bastante largo para probar', lineaId: l.body.linea.id, referenteTechId: Object.keys(st0.techs)[0] });
      const caja = k.body.caja.id;
      await assign(page, { cajaId: caja }, await newTool(page, 'Cinta métrica', 3));
      await fresh(page);
      const st = await state(page);
      const t = Object.keys(st.techs)[0];
      const p = st.shifts[0].id;
      const routes = [...ROUTES, 'plantilla-' + p, 'tecnico-' + t, 'caja-' + caja, 'control-caja:' + caja, 'control-' + t];
      await checkRoutes(page, routes, 1280);
      await checkRoutes(page, routes, 390);
      // Hojas nuevas en el celular: cambiar de plantilla y mover seleccionados.
      await page.hash('#tecnico-' + t);
      await page.act('shiftChange');
      eq(await page.eval('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'move sheet fits at 390');
      await page.screenshot('t9-move-sheet-390');
      await page.eval("document.querySelector('#modal-root [data-act=\"modalClose\"]').click()");
      await page.viewport(1280);
      await page.hash('#admin');
      await page.click('[data-act="adminTab"][data-v="config"]');
      await page.waitFor("!document.querySelector('#view .loading')", 10000, 'config tab');
      assert((await viewText(page)).includes('Turnos de las plantillas'), 'shift labels editor');
    }
  },
];
