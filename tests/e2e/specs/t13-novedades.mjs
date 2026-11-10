// T13 (stage 6): Novedades. Create with and without subjects, link to an entrega from its row
// (prefilled tech), the tech sheet's latest novedades, server-side filters (text, tech, link,
// period), edit by the author vs. without permission (another user's novedad), admin edit, live
// update in a second client, archive / restore / definitive delete with the generic records
// model, permissions, the offline message, and the screen and sheet at 1280 and 390.
import { assert, eq, loginAs, api, secondPage } from '../app.mjs';
import { sleep } from '../harness.mjs';

const idem = () => 'e2e-' + Math.random().toString(36).slice(2, 12);
const modalClosed = (page, label) => page.waitFor("!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const sheetOpen = (page, label) => page.waitFor("!!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const ok = (r, code, label) => { eq(r.status, code, `${label}: ${JSON.stringify(r.body)}`); return r.body; };
const rows = (page) => page.count('#view .novlist .novrow');
const rowsWith = (text) => `[...document.querySelectorAll('#view .novrow')].filter((r)=>r.textContent.includes(${JSON.stringify(text)})).length`;
const waitRows = (page, n, label) => page.waitFor(`document.querySelectorAll('#view .novlist .novrow').length===${n}&&!document.querySelector('#view .loading')`, 10000, label);
async function noOverflow(page, label) {
  const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
  assert(v.sw <= v.iw + 1, `${label} overflows: ${v.sw} > ${v.iw}`);
}
async function setup(adm) {
  const tech = ok(await api(adm, 'POST', '/api/techs', { name: 'Nora Novedad', legajo: 'NV-1', plantillaId: 'manana' }), 201, 'tech').tech;
  const linea = ok(await api(adm, 'POST', '/api/lineas', { name: 'Línea Tres', kind: 'linea' }), 201, 'linea').linea;
  const tool = ok(await api(adm, 'POST', '/api/tools', { name: 'Pinza Novedad', serialized: false, stock: 5 }), 201, 'tool').tool;
  const entrega = ok(await api(adm, 'POST', '/api/movements', { type: 'entrega_inicial', techId: tech.id, toolId: tool.id, qty: 1 }, { idem: idem() }), 201, 'entrega').movement;
  return { tech, linea, tool, entrega };
}
// Fills and saves the open Nueva/Editar novedad sheet.
async function saveSheet(page, comment, subjects = {}, label = 'Guardar novedad') {
  await page.type('#nov-comment', comment);
  for (const [k, v] of Object.entries(subjects)) await page.select(`#nov-${k}`, v);
  await page.modalBtn(label);
  await modalClosed(page, 'saved ' + comment);
}

export const tests = [
  {
    name: 'create with and without subjects, link to an entrega, tech sheet, filters, edit by author vs. others, live update',
    timeout: 180000,
    async fn(page, ctx) {
      const adm = await secondPage(ctx, 'admin');
      const s = await setup(adm);
      await adm.reload(); await adm.ready();
      await adm.hash('#novedades');
      await adm.waitFor("document.querySelector('#view .empty')&&document.querySelector('#view').textContent.includes('Todavía no hay novedades')", 10000, 'admin empty state');

      await loginAs(page, 'responsable');
      await page.hash('#novedades');
      await page.waitFor("!!document.querySelector('#view .empty')", 10000, 'empty state');
      // Without a comment nothing is saved.
      await page.act('novNew');
      await sheetOpen(page, 'new sheet');
      assert((await page.text('#mbody')).includes('La fecha y la hora se registran al guardar'), 'automatic date and author');
      await page.modalBtn('Guardar novedad');
      assert((await page.text('#merr')).includes('Escribí el comentario'), 'comment required: ' + await page.text('#merr'));
      await saveSheet(page, 'Se cortó la luz en el pañol');
      await waitRows(page, 1, 'first novedad listed');
      // Live update in the second client (SSE).
      await adm.waitFor(rowsWith('Se cortó la luz en el pañol') + '===1', 10000, 'live update in the admin client');

      await page.act('novNew');
      await sheetOpen(page, 'new sheet 2');
      await saveSheet(page, 'Nora avisó que falta la pinza', { techId: s.tech.id, plantillaId: 'manana', lineaId: s.linea.id });
      await waitRows(page, 2, 'second novedad listed');
      const row2 = await page.eval(`[...document.querySelectorAll('#view .novrow')].find((r)=>r.textContent.includes('falta la pinza')).textContent`);
      assert(row2.includes('Nora Novedad') && row2.includes('Línea Tres') && row2.includes('Responsable Prueba'), 'subjects and author shown: ' + row2);

      // "Agregar novedad" on the entrega row: link and tech prefilled.
      await page.hash('#tecnico-' + s.tech.id);
      await page.click('[data-act="techTab"][data-v="mov"]');
      await page.click(`[data-act="novNew"][data-mv="${s.entrega.id}"]`);
      await sheetOpen(page, 'sheet from the entrega');
      assert((await page.text('#mbody')).includes('Vinculada a'), 'link shown');
      eq(await page.eval("document.getElementById('nov-techId').value"), s.tech.id, 'tech prefilled');
      await saveSheet(page, 'Entregada con el estuche roto');
      const linked = ok(await api(page, 'GET', '/api/novedades?linked=yes'), 200, 'linked').novedades;
      eq(linked.length, 1, 'one linked novedad');
      eq(linked[0].movementId, s.entrega.id, 'linked to the entrega');
      eq(linked[0].techId, s.tech.id, 'tech of the entrega');
      // The tech sheet shows its latest novedades.
      await page.click('[data-act="techTab"][data-v="nov"]');
      await page.waitFor("document.querySelectorAll('.novcard .novrow').length===2", 10000, 'tech sheet novedades');

      // Server-side filters.
      await page.hash('#novedades');
      await waitRows(page, 3, 'three novedades');
      await page.type('#novq', 'pinza');
      await waitRows(page, 1, 'text filter');
      await page.act('novClear');
      await waitRows(page, 3, 'cleared');
      await page.select('#novf-techId', s.tech.id);
      await waitRows(page, 2, 'tech filter');
      await page.select('#novf-linked', 'yes');
      await waitRows(page, 1, 'tech + linked filter');
      await page.act('novClear');
      await page.select('#novf-from', '2020-01-01');
      await page.select('#novf-to', '2020-01-31');
      await page.waitFor("document.querySelector('#view').textContent.includes('Ninguna novedad coincide')", 10000, 'empty period');
      await page.act('novClear');
      await waitRows(page, 3, 'cleared again');

      // The author edits their own.
      const mine = linked[0];
      await page.click(`[data-act="novEdit"][data-id="${mine.id}"]`);
      await sheetOpen(page, 'edit sheet');
      assert((await page.text('#mbody')).includes('La fecha, el autor y el vínculo no cambian'), 'fixed fields explained');
      await saveSheet(page, 'Entregada con el estuche roto (cambiado)', {}, 'Guardar cambios');
      await page.waitFor(rowsWith('estuche roto (cambiado)') + '===1', 10000, 'edited row');
      // Someone else's novedad: no Editar for the responsable, 403 from the server; admin edits it.
      const other = ok(await api(adm, 'POST', '/api/novedades', { comment: 'Novedad del administrador' }, { idem: idem() }), 201, 'admin novedad').novedad;
      await page.waitFor(rowsWith('Novedad del administrador') + '===1', 10000, 'admin novedad arrives live');
      eq(await page.count(`[data-act="novEdit"][data-id="${other.id}"]`), 0, 'no Editar on another user novedad');
      eq((await api(page, 'PATCH', `/api/novedades/${other.id}`, { comment: 'x' }, { version: other.version })).status, 403, 'server refuses');
      await adm.waitFor(rowsWith('estuche roto (cambiado)') + '===1', 10000, 'admin sees the edit');
      await adm.click(`[data-act="novEdit"][data-id="${mine.id}"]`);
      await sheetOpen(adm, 'admin edit sheet');
      await saveSheet(adm, 'Corregida por administración', { techId: '' }, 'Guardar cambios');
      await page.waitFor(rowsWith('Corregida por administración') + '===1', 10000, 'responsable sees the admin edit live');
      const after = ok(await api(page, 'GET', `/api/novedades/${mine.id}`), 200, 'get').novedad;
      eq(after.techId, null, 'tech removed');
      eq(after.occurredAt, mine.occurredAt, 'date unchanged');
      eq(after.authorId, 'u-responsable', 'author unchanged');
      eq(await page.count('#view [data-act="recDelete"]'), 0, 'responsable has no Eliminar');
    },
  },
  {
    name: 'archive, restore and definitive delete (typed label), permissions and offline message',
    allowErrors: ['ERR_', 'net::'],
    timeout: 180000,
    async fn(page, ctx) {
      await loginAs(page, 'admin');
      const n = ok(await api(page, 'POST', '/api/novedades', { comment: 'Para eliminar' }, { idem: idem() }), 201, 'novedad').novedad;
      await page.hash('#novedades');
      await waitRows(page, 1, 'listed');
      await page.click(`[data-act="recDelete"][data-type="novedades"][data-id="${n.id}"]`);
      await sheetOpen(page, 'delete sheet');
      assert(await page.count('#mbody [data-act="recPurgeOpen"]') === 1, 'definitive delete offered (no history)');
      await page.type('#rec-reason', 'Duplicada');
      await page.modalBtn('Eliminar');
      await modalClosed(page, 'archived');
      await page.waitFor("document.querySelector('#view').textContent.includes('Todavía no hay novedades')", 10000, 'hidden from the list');
      await page.act('novArch');
      await waitRows(page, 1, 'shown with Incluir eliminadas');
      assert((await page.text('#view .novrow')).includes('Eliminada'), 'archived mark');
      // Restore from Administración › Registros eliminados.
      await page.hash('#admin');
      await page.act('adminTab', 'Registros eliminados');
      await page.waitFor(`[...document.querySelectorAll('.recdel')].some((r)=>r.textContent.includes(${JSON.stringify(n.name)})&&r.textContent.includes('Para eliminar'))`, 10000, 'listed in Registros eliminados');
      await page.click('.recdel [data-act="recRestore"]');
      await sheetOpen(page, 'restore sheet');
      await page.type('#rec-reason', 'Era válida');
      await page.modalBtn('Restaurar');
      await modalClosed(page, 'restored');
      await page.hash('#novedades');
      await page.act('novArch');
      await waitRows(page, 1, 'back in the list');
      assert(!(await page.text('#view .novrow')).includes('Eliminada'), 'no archived mark');
      // Definitive delete: wrong typed label refused, the exact label deletes it.
      await page.click(`[data-act="recDelete"][data-type="novedades"][data-id="${n.id}"]`);
      await sheetOpen(page, 'delete sheet 2');
      await page.click('#mbody [data-act="recPurgeOpen"]');
      await page.waitFor("(document.getElementById('mtitle')||{}).textContent==='Eliminar definitivamente'", 10000, 'purge sheet');
      assert((await page.text('#mbody')).includes(n.name), 'asks for the label');
      await page.type('#rec-confirm', 'Novedad');
      await page.type('#rec-reason', 'Prueba');
      await page.modalBtn('Eliminar definitivamente');
      assert((await page.text('#merr')).includes('no coincide'), 'wrong label refused');
      await page.type('#rec-confirm', n.name);
      await page.modalBtn('Eliminar definitivamente');
      await modalClosed(page, 'purged');
      eq((await api(page, 'GET', `/api/novedades/${n.id}`)).status, 404, 'gone');

      // Permissions: consulta cannot see; responsable gets 403 on archive.
      const cons = await secondPage(ctx, 'consulta');
      await cons.hash('#novedades');
      assert((await cons.text('#view')).includes('Tu perfil no puede ver las novedades'), 'consulta: no permission message');
      eq((await api(cons, 'GET', '/api/novedades')).status, 403, 'consulta: 403');
      const resp = await secondPage(ctx, 'responsable');
      const m = ok(await api(resp, 'POST', '/api/novedades', { comment: 'Del responsable' }, { idem: idem() }), 201, 'resp novedad').novedad;
      eq((await api(resp, 'POST', `/api/novedades/${m.id}/archive`, { reason: 'x' }, { version: m.version })).status, 403, 'responsable cannot archive');

      // Offline: the sheet says so and keeps the text.
      await page.act('novNew');
      await sheetOpen(page, 'new sheet');
      await page.type('#nov-comment', 'Escrita sin conexión');
      ctx.srv.offline = true;
      await page.waitFor("!document.getElementById('netbar').hidden", 15000, 'offline banner');
      await page.modalBtn('Guardar novedad');
      assert((await page.text('#merr')).includes('Sin conexión'), 'offline message: ' + await page.text('#merr'));
      eq(await page.eval("document.getElementById('nov-comment').value"), 'Escrita sin conexión', 'text kept');
      ctx.srv.offline = false;
      await page.waitFor("document.getElementById('netbar').hidden", 25000, 'back online');
      await page.modalBtn('Guardar novedad');
      await modalClosed(page, 'saved after reconnect');
      await page.waitFor(rowsWith('Escrita sin conexión') + '===1', 10000, 'listed after reconnect');
    },
  },
  {
    name: 'Novedades screen, sheet and tech sheet at 1280 and 390 without overflow',
    async fn(page) {
      await loginAs(page, 'admin');
      const s = await setup(page);
      const long = 'Un comentario largo para ver cómo se acomoda en la pantalla del celular, con palabras como Herramientaconnombremuylargoquenoentra y saltos\nde línea.';
      ok(await api(page, 'POST', '/api/novedades', { comment: long, techId: s.tech.id, plantillaId: 'manana', lineaId: s.linea.id, movementId: s.entrega.id }, { idem: idem() }), 201, 'novedad');
      await page.reload(); await page.ready();
      for (const w of [1280, 390]) {
        await page.viewport(w);
        await page.hash('#novedades');
        await waitRows(page, 1, 'list at ' + w);
        await noOverflow(page, `#novedades at ${w}`);
        await page.screenshot(`t13-novedades-${w}`);
        await page.act('novNew');
        await sheetOpen(page, 'sheet at ' + w);
        await noOverflow(page, `sheet at ${w}`);
        await page.screenshot(`t13-sheet-${w}`);
        await page.modalBtn('Cancelar');
        await page.hash('#tecnico-' + s.tech.id);
        await page.click('[data-act="techTab"][data-v="nov"]');
        await page.waitFor("document.querySelectorAll('.novcard .novrow').length===1", 10000, 'tech card at ' + w);
        await noOverflow(page, `tech sheet at ${w}`);
        await page.hash('#mas');
        assert((await page.text('#view')).includes('Novedades'), 'Más lists Novedades');
        await sleep(50);
      }
    },
  },
];
