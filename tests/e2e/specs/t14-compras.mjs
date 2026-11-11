// T14 (stage 7): purchase requests (Gerencia). A control with a faltante and a cambio creates the
// automatic requests (a correction with the same loss creates no duplicate), quick approve on a
// 390 px phone (one tap + confirm), reject with a comment -> the alert stays as "compra
// rechazada" with its reason, monthly totals; receive -> inventory ingreso, a reposición linked to
// the received request, manual requests from the tool sheet and from an alert, a novedad linked
// from the request detail, Gerencia vs. responsable vs. consulta permissions, layout at 1280/390.
import { assert, eq, loginAs, api, secondPage, state } from '../app.mjs';
import { sleep } from '../harness.mjs';

const idem = () => 'e2e-' + Math.random().toString(36).slice(2, 12);
const ok = (r, code, label) => { eq(r.status, code, `${label}: ${JSON.stringify(r.body)}`); return r.body; };
const sheetOpen = (page, label) => page.waitFor("!!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const modalClosed = (page, label) => page.waitFor("!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const cmpRows = (page, n, label) => page.waitFor(`document.querySelectorAll('#view .cmplist .cmprow').length===${n}&&!document.querySelector('#view .loading')`, 10000, label);
const rowOf = (text) => `[...document.querySelectorAll('#view .cmprow')].find((r)=>r.textContent.includes(${JSON.stringify(text)}))`;
async function noOverflow(page, label) {
  const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
  assert(v.sw <= v.iw + 1, `${label} overflows: ${v.sw} > ${v.iw}`);
}

// A tech with a tool by quantity (2 units) and a unit-tracked tool, and a finalized control of
// this week with 1 missing llave and the amoladora for cambio (as the responsable).
async function setup(adm, resp) {
  const tech = ok(await api(adm, 'POST', '/api/techs', { name: 'Teo Compra', legajo: 'CP-1', plantillaId: 'manana' }), 201, 'tech').tech;
  const llave = ok(await api(adm, 'POST', '/api/tools', { name: 'Llave Compra', serialized: false, stock: 10 }), 201, 'llave').tool;
  const amol = ok(await api(adm, 'POST', '/api/tools', { name: 'Amoladora Compra', serialized: true, codes: 'AM-1\nAM-2' }), 201, 'amoladora').tool;
  let st = await state(adm);
  const unit = Object.entries(st.units).find(([, u]) => u.code === 'AM-1')[0];
  ok(await api(adm, 'POST', '/api/movements', { type: 'entrega_inicial', techId: tech.id, toolId: llave.id, qty: 2 }, { idem: idem() }), 201, 'entrega llave');
  ok(await api(adm, 'POST', '/api/movements', { type: 'entrega_inicial', techId: tech.id, toolId: amol.id, unitId: unit }, { idem: idem() }), 201, 'entrega amoladora');
  st = await state(adm);
  const asg = (tool) => Object.entries(st.assignments).find(([, a]) => a.active && a.techId === tech.id && a.toolId === tool)[0];
  const aLlave = asg(llave.id); const aAmol = asg(amol.id);
  const c = ok(await api(resp, 'POST', '/api/controls', { techId: tech.id, period: st.derived.cur }, { idem: idem() }), 201, 'control').control;
  const items = { [aLlave]: { good: 1, change: 0, expected: 2, note: 'Se perdió en la línea 2' }, [aAmol]: { state: 'cambio', note: 'No arranca' } };
  const f = ok(await api(resp, 'POST', `/api/controls/${c.id}/finalize`, { items, cleaning: { status: 'limpio' } }, { version: c.version, idem: idem() }), 200, 'finalize');
  return { tech, llave, amol, aLlave, aAmol, control: f.control, created: f.purchases.created, items };
}
const comprasOf = async (page, qs = '') => ok(await api(page, 'GET', `/api/compras?${qs}`), 200, 'list').compras;
const byTool = (list, name) => list.find((p) => p.toolName === name);

export const tests = [
  {
    name: 'control with faltante -> automatic requests, no duplicate on a correction, approve at 390 px, reject -> "compra rechazada", totals',
    timeout: 180000,
    async fn(page, ctx) {
      const adm = await secondPage(ctx, 'admin');
      const resp = await secondPage(ctx, 'responsable');
      const s = await setup(adm, resp);
      eq(s.created.length, 2, 'two automatic requests (faltante and cambio)');
      // A correction with the same losses links to the open requests: no duplicates.
      const cr = ok(await api(resp, 'POST', '/api/controls', { correctionOf: s.control.id }, { idem: idem() }), 201, 'correction').control;
      const fr = ok(await api(resp, 'POST', `/api/controls/${cr.id}/finalize`, { items: s.items, cleaning: { status: 'limpio' } }, { version: cr.version, idem: idem() }), 200, 'finalize correction');
      eq(fr.purchases.created.length, 0, 'no new request on the correction');
      eq(fr.purchases.linked.length, 2, 'the correction is linked');
      const all = await comprasOf(adm, `techId=${s.tech.id}`);
      eq(all.length, 2, 'still two requests for the tech');
      const pLlave = byTool(all, 'Llave Compra'); const pAmol = byTool(all, 'Amoladora Compra');
      eq([pLlave.reason, pLlave.qty, pLlave.status, pLlave.observation].join('|'), 'faltante|1|pendiente|Se perdió en la línea 2', 'llave request');
      eq([pAmol.reason, pAmol.unitCode, pAmol.holderName, pAmol.plantillaName].join('|'), 'cambio|AM-1|Teo Compra|Turno mañana', 'amoladora request');

      // Gerencia on a phone: "compras pendientes" alert, inbox, quick approve with confirm.
      await page.viewport(390);
      await loginAs(page, 'gerencia');
      await page.hash('#alertas');
      await page.waitFor("document.querySelector('#view .cmpban')&&document.querySelector('#view .cmpban').textContent.includes('2 compras pendientes')", 10000, 'compras pendientes alert');
      await page.click('#view .cmpban a');
      await cmpRows(page, 2, 'inbox with two pending');
      await noOverflow(page, 'inbox at 390');
      await page.screenshot('t14-inbox-390');
      const btnH = await page.eval(`${rowOf('Amoladora Compra')}.querySelector('[data-act="cmpApprove"]').getBoundingClientRect().height`);
      assert(btnH >= 44, 'approve button is a 44 px target: ' + btnH);
      await page.eval(`${rowOf('Amoladora Compra')}.querySelector('[data-act="cmpApprove"]').click()`, { gesture: true });
      await sheetOpen(page, 'approve confirm');
      assert((await page.text('#mbody')).includes('¿Aprobás esta compra?'), 'confirm text');
      await noOverflow(page, 'approve sheet at 390');
      await page.screenshot('t14-approve-390');
      await page.modalBtn('Aprobar');
      await modalClosed(page, 'approved');
      await cmpRows(page, 1, 'one pending left');
      eq((await api(page, 'GET', `/api/compras/${pAmol.id}`)).body.compra.status, 'aprobada', 'approved on the server');
      // Reject needs a comment.
      await page.eval(`${rowOf('Llave Compra')}.querySelector('[data-act="cmpReject"]').click()`, { gesture: true });
      await sheetOpen(page, 'reject sheet');
      await page.modalBtn('Rechazar');
      assert((await page.text('#merr')).includes('Escribí el motivo del rechazo'), 'comment required: ' + await page.text('#merr'));
      await page.type('#cmp-rej', 'Hay llaves en el depósito central');
      await page.modalBtn('Rechazar');
      await modalClosed(page, 'rejected');
      await page.waitFor("!!document.querySelector('#view .empty')", 10000, 'inbox empty');
      // Totals of the month.
      await page.click('[data-act="cmpTab"][data-v="tot"]');
      await page.waitFor("!!document.querySelector('#view .cmpkpis')", 10000, 'totals');
      const kp = await page.text('#view .cmpkpis');
      assert(kp.includes('Aprobadas1') && kp.includes('Rechazadas1') && kp.includes('1 sin costo cargado'), 'totals KPIs: ' + kp);
      await noOverflow(page, 'totals at 390');
      // Gerencia cannot receive nor create.
      eq((await api(page, 'POST', `/api/compras/${pAmol.id}/receive`, { codes: 'AM-9' }, { version: 2, idem: idem() })).status, 403, 'gerencia cannot receive');
      eq((await api(page, 'POST', '/api/compras', { toolId: s.llave.id, reason: 'cambio', qty: 1 }, { idem: idem() })).status, 403, 'gerencia cannot create');

      // The responsable sees the faltante alert as "compra rechazada" with its reason, and can still ask manually.
      await resp.reload(); await resp.ready();
      await resp.hash('#alertas');
      await resp.waitFor("[...document.querySelectorAll('#view .al')].some((a)=>a.textContent.includes('Llave Compra')&&a.textContent.includes('compra rechazada')&&a.textContent.includes('Motivo: Hay llaves en el depósito central'))", 10000, 'compra rechazada on the alert');
      const al = "[...document.querySelectorAll('#view .al')].find((a)=>a.textContent.includes('Llave Compra')&&a.textContent.includes('Herramienta faltante'))";
      eq(await resp.eval(`!!${al}.querySelector('[data-act="cmpFromAlert"]')`), true, 'Solicitar compra on the rejected alert');
      eq(await resp.eval(`!![...document.querySelectorAll('#view .al')].find((a)=>a.textContent.includes('Amoladora Compra')).querySelector('[data-act="cmpFromAlert"]')`), false, 'no Solicitar compra while one is open');
      eq(await resp.count('#view .cmpban'), 0, 'responsable: no compras pendientes alert');
    },
  },
  {
    name: 'receive -> ingreso, reposición linked, manual requests (tool sheet, alert), novedad link, permissions, detail at 1280/390',
    timeout: 180000,
    async fn(page, ctx) {
      const adm = await secondPage(ctx, 'admin');
      const ger = await secondPage(ctx, 'gerencia');
      await loginAs(page, 'responsable');
      const s = await setup(adm, page);
      const list = await comprasOf(ger);
      const pAmol = byTool(list, 'Amoladora Compra'); const pLlave = byTool(list, 'Llave Compra');
      ok(await api(ger, 'POST', `/api/compras/${pAmol.id}/approve`, {}, { version: pAmol.version, idem: idem() }), 200, 'approve');
      ok(await api(ger, 'POST', `/api/compras/${pLlave.id}/reject`, { comment: 'No corresponde' }, { version: pLlave.version, idem: idem() }), 200, 'reject');

      // Responsable: only "A recibir" (no inbox, no totals); the server agrees.
      eq((await api(page, 'GET', '/api/compras')).status, 403, 'responsable: no full list');
      eq((await api(page, 'POST', `/api/compras/${pLlave.id}/approve`, {}, { version: 2, idem: idem() })).status, 403, 'responsable cannot decide');
      await page.reload(); await page.ready();
      await page.hash('#compras');
      await cmpRows(page, 1, 'a recibir');
      eq(await page.count('#view .cmpseg'), 0, 'only one tab');
      await page.eval(`${rowOf('Amoladora Compra')}.querySelector('[data-act="cmpReceive"]').click()`, { gesture: true });
      await sheetOpen(page, 'receive sheet');
      await page.modalBtn('Recibir');
      assert((await page.text('#merr')).includes('código de cada unidad'), 'codes required: ' + await page.text('#merr'));
      await page.type('#cmp-codes', 'AM-9');
      await page.type('#cmp-rn', 'Llegó con garantía');
      await page.modalBtn('Recibir');
      await modalClosed(page, 'received');
      await page.waitFor("!!document.querySelector('#view .empty')", 10000, 'nothing left to receive');
      const rec = ok(await api(page, 'GET', `/api/compras/${pAmol.id}`), 200, 'detail').compra;
      eq(rec.status, 'recibida', 'received');
      let st = await state(page);
      const ing = st.movements[rec.ingresoMovementId];
      eq(ing && ing.type, 'ingreso', 'ingreso movement linked');
      const am9 = Object.entries(st.units).find(([, u]) => u.code === 'AM-9');
      eq(am9 && am9[1].status, 'disponible', 'new unit available');

      // Reposición to the tech, linked to the received request.
      await page.hash('#entregas');
      await page.act('mvType', 'Reposición');
      await page.select('#mvtech', s.tech.id);
      await page.select('#mvasg', s.aAmol);
      await page.select('#mvnew', am9[0]);
      await page.waitFor("!!document.getElementById('mvpr')", 5000, 'purchase select');
      assert((await page.text('#mvpr')).includes(rec.name), 'received request offered');
      await page.select('#mvpr', pAmol.id);
      await page.act('mvSubmit');
      await page.waitFor(`!document.body.classList.contains('busy')`, 10000, 'movement sent');
      await sleep(300);
      const linked = ok(await api(page, 'GET', `/api/compras/${pAmol.id}`), 200, 'detail 2').compra;
      st = await state(page);
      eq(st.movements[linked.reposicionMovementId] && st.movements[linked.reposicionMovementId].type, 'reposicion', 'reposición linked to the request');
      assert(linked.timeline.some((x) => x.action === 'purchase_reposicion'), 'timeline has the reposición');

      // Manual request from the tool sheet (stock, no holder) with an estimated cost.
      await page.hash('#herramienta-' + s.llave.id);
      await page.click('[data-act="cmpNew"]');
      await sheetOpen(page, 'new request sheet');
      await page.click('#mbody [data-act="mset"][data-k="reason"]', 'Dañada');
      await page.type('#cmp-nq', '3');
      await page.type('#cmp-cost', '1500,50');
      await page.modalBtn('Crear solicitud');
      await modalClosed(page, 'manual created');
      const manual = (await comprasOf(ger, 'status=pendiente')).find((p) => p.origin === 'tool');
      eq([manual && manual.qty, manual && manual.estimatedCost, manual && manual.techId].join('|'), '3|1500.5|', 'manual request from the tool sheet');
      await page.waitFor(`document.querySelector('#view .cmpcard')&&document.querySelector('#view .cmpcard').textContent.includes(${JSON.stringify(manual.name)})`, 10000, 'tool sheet card');
      // From the rejected faltante alert (prefilled assignment and reason).
      await page.hash('#alertas');
      await page.waitFor("[...document.querySelectorAll('#view .al')].some((a)=>a.textContent.includes('Llave Compra')&&a.querySelector('[data-act=\"cmpFromAlert\"]'))", 10000, 'alert with Solicitar compra');
      await page.eval("[...document.querySelectorAll('#view .al')].find((a)=>a.textContent.includes('Llave Compra')).querySelector('[data-act=\"cmpFromAlert\"]').click()", { gesture: true });
      await sheetOpen(page, 'request from alert');
      assert((await page.text('#mbody')).includes('Teo Compra'), 'holder prefilled');
      await page.modalBtn('Crear solicitud');
      await modalClosed(page, 'alert request created');
      const fromAlert = (await comprasOf(ger, 'status=pendiente')).find((p) => p.origin === 'alert');
      eq([fromAlert && fromAlert.reason, fromAlert && fromAlert.assignmentId, fromAlert && fromAlert.qty].join('|'), `faltante|${s.aLlave}|1`, 'request from the alert');

      // A novedad linked from the request detail.
      await page.hash('#compra-' + fromAlert.id);
      await page.waitFor("!!document.querySelector('#view .cmpkv')", 10000, 'detail');
      await page.click('[data-act="cmpNov"]');
      await sheetOpen(page, 'novedad sheet');
      eq(await page.eval("document.getElementById('nov-pr').value"), fromAlert.id, 'request prefilled');
      await page.type('#nov-comment', 'Pedido urgente para la línea 2');
      await page.modalBtn('Guardar novedad');
      await modalClosed(page, 'novedad saved');
      const nov = ok(await api(page, 'GET', `/api/novedades?purchaseRequestId=${fromAlert.id}`), 200, 'novedades').novedades;
      eq(nov.length, 1, 'novedad linked to the request');
      await page.waitFor("document.getElementById('view').textContent.includes('Pedido urgente para la línea 2')", 10000, 'novedad on the detail');

      // Consulta: no Gerencia entry and no access.
      const cons = await secondPage(ctx, 'consulta');
      eq(await cons.count('#side a[href="#compras"]'), 0, 'consulta: no nav entry');
      await cons.hash('#compras');
      assert((await cons.text('#view')).includes('Tu perfil no puede ver las compras'), 'consulta: no access');
      eq((await api(cons, 'GET', '/api/compras?scope=receive')).status, 403, 'consulta: 403');
      // Gerencia: nav entry with the pending badge (two manual requests).
      await ger.reload(); await ger.ready();
      await ger.waitFor("(document.querySelector('#side a[href=\"#compras\"] .nb')||{}).textContent==='2'", 10000, 'gerencia nav badge');

      // Layout: detail and the reject sheet at 1280 and 390.
      for (const w of [1280, 390]) {
        await ger.viewport(w);
        await ger.hash('#compra-' + pAmol.id);
        await ger.waitFor("!!document.querySelector('#view .cmpkv')&&!!document.querySelector('#view .tl')", 10000, 'detail at ' + w);
        await noOverflow(ger, `detail at ${w}`);
        await ger.screenshot(`t14-detail-${w}`);
        await ger.hash('#compras');
        await cmpRows(ger, 2, 'inbox at ' + w);
        await noOverflow(ger, `inbox at ${w}`);
        await ger.eval(`${rowOf(manual.name)}.querySelector('[data-act="cmpReject"]').click()`, { gesture: true });
        await sheetOpen(ger, 'reject sheet at ' + w);
        await noOverflow(ger, `reject sheet at ${w}`);
        await ger.modalBtn('Cancelar');
        await ger.click('[data-act="cmpTab"][data-v="all"]');
        await ger.waitFor("document.querySelectorAll('#view .cmplist .cmprow').length===4", 10000, 'all at ' + w);
        await noOverflow(ger, `all at ${w}`);
        await ger.click('[data-act="cmpTab"][data-v="pend"]');
      }
    },
  },
];
