// T12 (stage 5): Eliminar (logical archive) with a motivo for every type and Restaurar from
// Administración › Registros eliminados, a tech with tools archived resolving them in the same
// step, Eliminar definitivamente only without history (typed name), Anular an entrega and a
// devolución (inventory reverted, original kept with "Anulado", a void cannot be voided, refused
// with the exact reason when a later movement depends on it), permissions (non-admin), `.txt`
// export tombstones, and the new screens at 1280 and 390 without overflow.
import { assert, eq, loginAs, state, api, downloadTxt, parseTxt, ROUTES } from '../app.mjs';
import { sleep } from '../harness.mjs';

const R = { reason: 'Prueba E2E' };
const idem = () => 'e2e-' + Math.random().toString(36).slice(2, 12);
const modalClosed = (page, label) => page.waitFor("!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const sheetOpen = (page, label) => page.waitFor("!!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const fresh = async (page) => { await page.reload(); await page.ready(); };
const ok = (r, code, label) => { eq(r.status, code, `${label}: ${JSON.stringify(r.body)}`); return r.body; };
const newTech = async (page, name, legajo) => ok(await api(page, 'POST', '/api/techs', { name, legajo, plantillaId: 'manana' }), 201, 'tech ' + name).tech;
const newTool = async (page, name, stock = 10) => ok(await api(page, 'POST', '/api/tools', { name, serialized: false, stock }), 201, 'tool ' + name).tool;
const mov = async (page, body) => ok(await api(page, 'POST', '/api/movements', body, { idem: idem() }), 201, 'movement ' + body.type).movement;
const pools = async (page, toolId) => (await state(page)).derived.pools[toolId];

async function noOverflow(page, label) {
  const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
  assert(v.sw <= v.iw + 1, `${label} overflows: ${v.sw} > ${v.iw}`);
}
// Opens the delete sheet from a visible "Eliminar" button of the record and archives it.
async function eliminar(page, type, id, reason, res = {}) {
  await page.click(`[data-act="recDelete"][data-type="${type}"][data-id="${id}"]`);
  await sheetOpen(page, 'delete sheet ' + type);
  for (const [aid, v] of Object.entries(res)) await page.select(`#mbody [data-mi="res:${aid}"]`, v);
  await page.type('#rec-reason', reason);
  await page.modalBtn('Eliminar');
  await modalClosed(page, 'archived ' + type);
}
async function restoreInAdmin(page, name) {
  await page.hash('#admin');
  await page.act('adminTab', 'Registros eliminados');
  await page.waitFor(`[...document.querySelectorAll('.recdel')].some((r)=>r.textContent.includes(${JSON.stringify(name)}))`, 10000, 'listed ' + name);
  await page.type('#delq', name);
  await page.click('.recdel [data-act="recRestore"]');
  await sheetOpen(page, 'restore sheet');
  await page.type('#rec-reason', 'Volvió');
  await page.modalBtn('Restaurar');
  await modalClosed(page, 'restored ' + name);
  await page.type('#delq', '');
}

export const tests = [
  {
    name: 'tech with tools: Eliminar resolves every tool in the same step, hidden from lists and selectors, restored from Registros eliminados',
    timeout: 180000,
    async fn(page) {
      await loginAs(page);
      const t = await newTech(page, 'Bruno Baja', 'EL-1');
      const pinza = await newTool(page, 'Pinza E2E');
      const llave = await newTool(page, 'Llave E2E');
      const a1 = (await mov(page, { type: 'entrega_inicial', techId: t.id, toolId: pinza.id, qty: 2 })).newAssignmentId;
      const a2 = (await mov(page, { type: 'entrega_inicial', techId: t.id, toolId: llave.id, qty: 1 })).newAssignmentId;
      await fresh(page);
      const p0 = await pools(page, pinza.id);
      await page.hash('#tecnico-' + t.id);
      await page.click(`[data-act="recDelete"][data-type="techs"][data-id="${t.id}"]`);
      await sheetOpen(page, 'delete sheet');
      eq(await page.count('#mbody .recsel'), 2, 'one resolution per assigned tool');
      // Without choosing what to do with the tools nothing is written.
      await page.type('#rec-reason', 'Dejó la empresa');
      await page.modalBtn('Eliminar');
      assert((await page.text('#merr')).includes('Elegí qué hacer con 2 herramientas'), 'pending resolutions reason: ' + await page.text('#merr'));
      await page.select(`#mbody [data-mi="res:${a1}"]`, 'reparacion');
      await page.select(`#mbody [data-mi="res:${a2}"]`, 'retiro');
      await page.type('#rec-reason', 'Dejó la empresa');
      await page.modalBtn('Eliminar');
      await modalClosed(page, 'tech archived');
      await page.waitFor("location.hash==='#tecnicos'", 5000, 'back to the list');
      const st = await state(page);
      assert(st.techs[t.id].archived && st.techs[t.id].active === false, 'archived and inactive');
      eq(st.techs[t.id].archiveReason, 'Dejó la empresa', 'motivo stored');
      assert(!Object.values(st.assignments).some((a) => a.active && a.techId === t.id), 'no active assignments left');
      eq(st.derived.pools[pinza.id].reparacion, p0.reparacion + 2, 'pinza back to reparación');
      eq(st.derived.pools[llave.id].retirado, 1, 'llave retired');
      // Hidden from the list (also with Inactivos) and from the entrega selector.
      assert(!(await page.text('#view')).includes('Bruno Baja'), 'not in Técnicos');
      await page.act('techInactive');
      assert(!(await page.text('#view')).includes('Bruno Baja'), 'not in inactive techs either');
      await page.hash('#entregas');
      eq(await page.eval(`!!document.querySelector('#view option[value="${t.id}"]')`), false, 'not in the tech selector');
      // History keeps the name with the mark.
      assert((await page.text('#view')).includes('Bruno Baja (eliminado)'), 'movement history shows (eliminado)');
      await restoreInAdmin(page, 'Bruno Baja');
      const st2 = await state(page);
      assert(!st2.techs[t.id].archived && st2.techs[t.id].active, 'restored active');
      await page.hash('#tecnicos'); await page.act('techInactive');
      assert((await page.text('#view')).includes('Bruno Baja'), 'listed again');
    }
  },
  {
    name: 'every other type: Eliminar with a motivo and Restaurar (cajas, herramientas, categorías, plantillas, líneas, especialidades, kits, usuarios)',
    timeout: 240000,
    async fn(page) {
      await loginAs(page);
      const cat = ok(await api(page, 'POST', '/api/categories', { name: 'Categoría E2E' }), 201, 'cat').category;
      const tool = await newTool(page, 'Martillo E2E', 0);
      const lin = ok(await api(page, 'POST', '/api/lineas', { name: 'Línea E2E', kind: 'linea' }), 201, 'línea').linea;
      const lin2 = ok(await api(page, 'POST', '/api/lineas', { name: 'Sector E2E', kind: 'sector' }), 201, 'línea2').linea;
      const caja = ok(await api(page, 'POST', '/api/cajas', { name: 'Caja E2E', lineaId: lin.id }), 201, 'caja').caja;
      const pl = ok(await api(page, 'POST', '/api/plantillas', { name: 'Plantilla E2E' }), 201, 'plantilla').plantilla;
      const esp = ok(await api(page, 'POST', '/api/especialidades', { name: 'Especialidad E2E' }), 201, 'esp').especialidad;
      const esp2 = ok(await api(page, 'POST', '/api/especialidades', { name: 'Otra E2E' }), 201, 'esp2').especialidad;
      const kit = ok(await api(page, 'POST', '/api/kits', { especialidadId: esp2.id }), 201, 'kit').kit;
      await fresh(page);
      // Through the UI: caja (its sheet), plantilla (its sheet), línea (row), categoría, especialidad, kit (config), herramienta (edit sheet).
      await page.hash('#caja-' + caja.id); await eliminar(page, 'cajas', caja.id, 'Caja dada de baja');
      await page.hash('#plantilla-' + pl.id); await eliminar(page, 'plantillas', pl.id, 'Ya no se usa');
      await page.hash('#lineas'); await eliminar(page, 'lineas', lin2.id, 'Duplicado');
      await page.hash('#config'); await page.act('cfgTab', 'Herramientas');
      await eliminar(page, 'categories', cat.id, 'Duplicado');
      await page.click(`[data-act="toolEdit"][data-t="${tool.id}"]`); await sheetOpen(page, 'tool edit');
      await eliminar(page, 'tools', tool.id, 'Cargado por error');
      await page.act('cfgTab', 'Kits'); await eliminar(page, 'kits', kit.id, 'Ya no se usa');
      await page.act('cfgTab', 'Especialidades'); await eliminar(page, 'especialidades', esp.id, 'Duplicado');
      // Users through the API (admin only): archive = deactivate + hide.
      const u = ok(await api(page, 'POST', '/api/users', { username: 'baja.e2e', name: 'Usuario Baja', role: 'consulta' }), 201, 'user').user;
      ok(await api(page, 'POST', `/api/users/${u.id}/archive`, R, { version: u.version }), 200, 'user archived');
      await fresh(page);
      const st = await state(page);
      for (const [col, id] of [['cajas', caja.id], ['plantillas', pl.id], ['lineas', lin2.id], ['categories', cat.id], ['tools', tool.id], ['kits', kit.id], ['especialidades', esp.id]]) assert(st[col][id].archived, col + ' archived');
      eq(st.users[u.id].archived, true, 'user archived');
      // Registros eliminados: who, when and why; type filter.
      await page.hash('#admin'); await page.act('adminTab', 'Registros eliminados');
      await page.waitFor("document.querySelectorAll('.recdel').length>=8", 10000, 'archived list');
      const txt = await page.text('#view');
      assert(txt.includes('por Admin Prueba') && txt.includes('Motivo: Caja dada de baja'), 'who and why');
      await page.select('#deltype', 'kits');
      eq(await page.count('.recdel'), 1, 'type filter');
      await page.select('#deltype', 'all');
      for (const name of ['Caja E2E', 'Plantilla E2E', 'Sector E2E', 'Categoría E2E', 'Martillo E2E', 'Kit Otra E2E', 'Especialidad E2E', 'Usuario Baja']) await restoreInAdmin(page, name);
      const st2 = await state(page);
      for (const [col, id] of [['cajas', caja.id], ['plantillas', pl.id], ['lineas', lin2.id], ['categories', cat.id], ['tools', tool.id], ['kits', kit.id], ['especialidades', esp.id]]) assert(!st2[col][id].archived, col + ' restored');
      eq(st2.users[u.id].archived, false, 'user restored');
      eq(st2.users[u.id].active, false, 'restored user stays inactive');
      // A name taken in the meantime blocks the restore with a clear message.
      const t = await newTool(page, 'Serrucho E2E', 0);
      ok(await api(page, 'POST', `/api/tools/${t.id}/archive`, R, { version: t.version }), 200, 'archive serrucho');
      await newTool(page, 'Serrucho E2E', 0);
      await fresh(page);
      await page.hash('#admin'); await page.act('adminTab', 'Registros eliminados');
      await page.waitFor("document.querySelectorAll('.recdel').length>=1", 10000, 'list');
      await page.type('#delq', 'Serrucho');
      await page.click('.recdel [data-act="recRestore"]'); await sheetOpen(page, 'restore');
      await page.type('#rec-reason', 'Volvió'); await page.modalBtn('Restaurar');
      await page.waitFor("!!document.getElementById('merr').textContent", 10000, 'restore refused');
      assert((await page.text('#merr')).includes('Ya hay otro registro activo con el nombre Serrucho E2E'), 'name conflict message');
    }
  },
  {
    name: 'Eliminar definitivamente only without history, typing the exact name',
    async fn(page) {
      await loginAs(page);
      const t = await newTech(page, 'Carga Errónea', 'EL-9');
      const h = await newTech(page, 'Con Historia', 'EL-10');
      const tool = await newTool(page, 'Pinza Historia');
      await mov(page, { type: 'entrega_inicial', techId: h.id, toolId: tool.id, qty: 1 });
      await fresh(page);
      // With history: only Eliminar.
      await page.hash('#tecnico-' + h.id);
      await page.click(`[data-act="recDelete"][data-id="${h.id}"]`); await sheetOpen(page, 'sheet with history');
      eq(await page.count('#mbody [data-act="recPurgeOpen"]'), 0, 'no definitive delete with history');
      assert((await page.text('#mbody')).includes('Tiene historial'), 'explains why');
      await page.modalBtn('Cancelar');
      // Without history: double confirmation with the exact name.
      await page.hash('#tecnico-' + t.id);
      await page.click(`[data-act="recDelete"][data-id="${t.id}"]`); await sheetOpen(page, 'sheet');
      await page.click('#mbody [data-act="recPurgeOpen"]'); await sleep(300); await sheetOpen(page, 'purge sheet');
      await page.type('#rec-confirm', 'carga errónea'); await page.type('#rec-reason', 'Duplicado');
      await page.modalBtn('Eliminar definitivamente');
      assert((await page.text('#merr')).includes('El nombre no coincide'), 'typed name must match');
      eq((await state(page)).techs[t.id] !== undefined, true, 'still there');
      await page.type('#rec-confirm', 'Carga Errónea');
      await page.modalBtn('Eliminar definitivamente');
      await modalClosed(page, 'purged');
      eq((await state(page)).techs[t.id], undefined, 'gone');
      // The server re-checks: no history allowed even through the API.
      const v = (await state(page)).techs[h.id].version;
      const r = await api(page, 'DELETE', '/api/techs/' + h.id, { reason: 'x', confirmName: 'Con Historia' }, { version: v });
      eq(r.status, 409, 'server refuses with history'); eq(r.body.error, 'has_history', 'has_history');
      // The audit keeps the name and the motivo.
      const audit = await api(page, 'GET', '/api/audit?limit=20');
      assert(audit.body.items.some((a) => a.detail === 'Eliminación definitiva de técnico Carga Errónea. Motivo: Duplicado'), 'audit keeps the name');
    }
  },
  {
    name: 'Anular an entrega and a devolución: inventory reverted, original kept, a void cannot be voided, refused when a later movement depends on it',
    timeout: 180000,
    async fn(page) {
      await loginAs(page);
      const t = await newTech(page, 'Dana Anula', 'AN-1');
      const tool = await newTool(page, 'Destornillador E2E');
      const p0 = await pools(page, tool.id);
      const e1 = await mov(page, { type: 'entrega_inicial', techId: t.id, toolId: tool.id, qty: 3 });
      await fresh(page);
      // Void the entrega from Entregas › Historial de movimientos.
      await page.hash('#entregas');
      await page.click(`[data-act="mvVoid"][data-m="${e1.id}"]`); await sheetOpen(page, 'void sheet');
      await page.type('#rec-reason', 'Cargado por error');
      await page.modalBtn('Anular movimiento');
      await modalClosed(page, 'voided');
      let st = await state(page);
      eq(JSON.stringify(st.derived.pools[tool.id]), JSON.stringify(p0), 'inventory reverted');
      assert(st.movements[e1.id], 'original kept');
      const v1 = Object.entries(st.movements).find(([, m]) => m.voidsMovementId === e1.id);
      assert(v1, 'void movement'); eq(v1[1].type, 'anulacion', 'type');
      await page.waitFor(`!!document.querySelector('[data-mv="${e1.id}"].voided')`, 5000, 'Anulado mark');
      assert((await page.text(`[data-mv="${e1.id}"]`)).includes('Anulado'), 'Anulado chip');
      assert((await page.text(`[data-mv="${v1[0]}"]`)).includes('Anulación'), 'Anulación tag');
      eq(await page.count(`[data-act="mvVoid"][data-m="${v1[0]}"]`), 0, 'a void has no Anular');
      eq(await page.count(`[data-act="mvVoid"][data-m="${e1.id}"]`), 0, 'a voided movement has no Anular');
      eq((await api(page, 'POST', `/api/movements/${v1[0]}/void`, R, { idem: idem() })).body.message, 'Una anulación no se anula.', 'void of a void refused');
      // Entrega + devolución: the entrega cannot be voided (the sheet says why); the devolución can.
      const e2 = await mov(page, { type: 'entrega_inicial', techId: t.id, toolId: tool.id, qty: 2 });
      const d2 = await mov(page, { type: 'devolucion', techId: t.id, asgId: e2.newAssignmentId, qty: 2, cond: 'disponible' });
      await fresh(page);
      await page.hash('#tecnico-' + t.id); await page.act('techTab', 'Entregas');
      await page.click(`[data-act="mvVoid"][data-m="${e2.id}"]`); await sheetOpen(page, 'refused sheet');
      assert((await page.text('#mbody')).includes('No se puede anular: después se registró una Devolución'), 'exact reason: ' + await page.text('#mbody'));
      eq(await page.count('#modal-root .sheet-f button'), 1, 'only Cerrar');
      await page.modalBtn('Cerrar');
      const pBefore = await pools(page, tool.id);
      await page.click(`[data-act="mvVoid"][data-m="${d2.id}"]`); await sheetOpen(page, 'void devolución');
      await page.type('#rec-reason', 'Devolución equivocada'); await page.modalBtn('Anular movimiento');
      await modalClosed(page, 'devolución voided');
      st = await state(page);
      eq(st.derived.pools[tool.id].asignado, pBefore.asignado + 2, 'back to assigned');
      assert(st.assignments[e2.newAssignmentId].active, 'assignment active again');
    }
  },
  {
    name: 'permissions: a non-admin sees no Eliminar or Anular and the API refuses',
    async fn(page) {
      await loginAs(page);
      const t = await newTech(page, 'Eva Permiso', 'PE-1');
      const tool = await newTool(page, 'Pinza Permiso');
      const e = await mov(page, { type: 'entrega_inicial', techId: t.id, toolId: tool.id, qty: 1 });
      await page.hash('#mas'); await page.act('logout'); await page.modalBtn('Cerrar sesión');
      await page.waitFor("!!document.getElementById('a-user')", 10000, 'login screen');
      await loginAs(page, 'responsable');
      await page.hash('#tecnico-' + t.id);
      eq(await page.count('[data-act="recDelete"]'), 0, 'no Eliminar');
      await page.hash('#entregas');
      eq(await page.count('[data-act="mvVoid"]'), 0, 'no Anular');
      await page.hash('#admin');
      eq(await page.count('[data-act="adminTab"][data-v="deleted"]'), 0, 'no Registros eliminados tab');
      eq((await api(page, 'POST', `/api/techs/${t.id}/archive`, R, { version: t.version })).status, 403, 'archive 403');
      eq((await api(page, 'POST', `/api/movements/${e.id}/void`, R, { idem: idem() })).status, 403, 'void 403');
      eq((await api(page, 'GET', '/api/archived')).status, 403, 'archived list 403');
    }
  },
  {
    name: '.txt export: archived techs inactive, archived categories and definitive deletes as tombstones, no voids',
    async fn(page) {
      await loginAs(page);
      const t = await newTech(page, 'Tom Txt', 'TX-1');
      const g = ok(await api(page, 'POST', '/api/categories', { name: 'Cat Txt' }), 201, 'cat').category;
      const p = await newTech(page, 'Purgado Txt', 'TX-2');
      const tool = await newTool(page, 'Pinza Txt');
      const e = await mov(page, { type: 'entrega_inicial', techId: t.id, toolId: tool.id, qty: 1 });
      ok(await api(page, 'POST', `/api/movements/${e.id}/void`, R, { idem: idem() }), 201, 'void');
      ok(await api(page, 'POST', `/api/techs/${t.id}/archive`, R, { version: (await state(page)).techs[t.id].version }), 200, 'archive tech');
      ok(await api(page, 'POST', `/api/categories/${g.id}/archive`, R, { version: g.version }), 200, 'archive cat');
      ok(await api(page, 'DELETE', `/api/techs/${p.id}`, { reason: 'x', confirmName: 'Purgado Txt' }, { version: p.version }), 200, 'purge');
      await fresh(page);
      const f = parseTxt(await downloadTxt(page));
      eq(f.version, 2, 'v2');
      eq(f.data.techs[t.id].active, false, 'archived tech exported inactive');
      eq(f.data.categories[g.id], undefined, 'archived category not exported');
      assert(f.data.deleted['categories/' + g.id], 'category tombstone');
      assert(f.data.deleted['techs/' + p.id], 'definitive delete tombstone');
      assert(!Object.values(f.data.movements).some((m) => m.type === 'anulacion') && !f.data.movements[e.id], 'no void pair in v2');
    }
  },
  {
    name: 'every route, Registros eliminados and the delete sheet at 1280 and 390 without overflow',
    async fn(page) {
      await loginAs(page);
      const t = await newTech(page, 'Vista Ancha Con Un Nombre Bastante Largo', 'VW-1');
      const tool = await newTool(page, 'Herramienta Con Nombre Largo Para Probar');
      await mov(page, { type: 'entrega_inicial', techId: t.id, toolId: tool.id, qty: 2 });
      const g = ok(await api(page, 'POST', '/api/categories', { name: 'Categoría eliminada larga' }), 201, 'cat').category;
      ok(await api(page, 'POST', `/api/categories/${g.id}/archive`, { reason: 'Un motivo bastante largo para ver cómo se acomoda en la pantalla del celular' }, { version: g.version }), 200, 'archive');
      await fresh(page);
      for (const w of [1280, 390]) {
        await page.viewport(w);
        for (const r of ROUTES) { await page.hash('#' + r); await noOverflow(page, `#${r} at ${w}`); }
        await page.hash('#admin'); await page.act('adminTab', 'Registros eliminados');
        await page.waitFor("document.querySelectorAll('.recdel').length>=1", 10000, 'list');
        await noOverflow(page, `Registros eliminados at ${w}`);
        await page.screenshot(`t12-eliminados-${w}`);
        await page.hash('#tecnico-' + t.id);
        await page.click(`[data-act="recDelete"][data-id="${t.id}"]`); await sheetOpen(page, 'sheet');
        await noOverflow(page, `delete sheet at ${w}`);
        await page.screenshot(`t12-eliminar-${w}`);
        await page.modalBtn('Cancelar');
      }
    }
  },
];
