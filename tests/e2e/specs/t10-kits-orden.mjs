// T10 (stage 3): especialidad (tech form, filter, report column), base kit edited in the UI,
// "Entregar kit" in one step (one movement per tool; refused with a clear message and nothing
// written when stock is short), custom order of categories and tools by drag and drop (1280) and
// arrows (390), the order in control/ficha/inventario/report/Excel, insert at position, a
// concurrent reorder from two sessions (conflict notice) and the new screens at 1280 and 390.
import { sleep } from '../harness.mjs';
import { assert, eq, loginAs, state, api, secondPage, ROUTES } from '../app.mjs';

const newCat = async (page, name) => { const r = await api(page, 'POST', '/api/categories', { name }); eq(r.status, 201, 'category ' + name); return r.body.category.id; };
const newTool = async (page, name, categoryId, extra = { stock: 10 }) => { const r = await api(page, 'POST', '/api/tools', { name, categoryId, serialized: false, ...extra }); eq(r.status, 201, 'tool ' + name); return r.body.tool.id; };
const newTech = async (page, name, legajo) => { const r = await api(page, 'POST', '/api/techs', { name, legajo, plantillaId: 'manana' }); eq(r.status, 201, 'tech ' + name); return r.body.tech.id; };
const fresh = async (page) => { await page.reload(); await page.ready(); };
const modalClosed = (page, label) => page.waitFor("!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const texts = (page, sel) => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.trim())`);
const movementsOf = async (srv, techId) => (await srv.db.query('SELECT count(*)::int AS n FROM movements WHERE tech_id = $1', [techId])).rows[0].n;

// Catálogo de prueba: Eléctricas (Taladro por código) y Manuales (Pinza, Martillo, Llave).
async function catalog(page) {
  const elec = await newCat(page, 'Eléctricas');
  const man = await newCat(page, 'Manuales');
  const taladro = await newTool(page, 'Taladro', elec, { serialized: true, codes: 'TAL-1\nTAL-2' });
  const pinza = await newTool(page, 'Pinza', man);
  const martillo = await newTool(page, 'Martillo', man);
  const llave = await newTool(page, 'Llave', man);
  return { elec, man, taladro, pinza, martillo, llave };
}

// Arrastra la manija del elemento `id` de la lista `scope` hasta antes del elemento `beforeId`.
async function drag(page, scope, id, beforeId) {
  const r = await page.eval(`(() => { const ol = document.querySelector('.ordlist[data-scope="${scope}"]');
    const g = ol.querySelector('.orditem[data-id="${id}"] [data-grip]').getBoundingClientRect(); const t = ol.querySelector('.orditem[data-id="${beforeId}"]').getBoundingClientRect();
    return { x: g.x + g.width / 2, y: g.y + g.height / 2, ty: t.y + 4 }; })()`);
  const m = (type, y, extra = {}) => page.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  await m('mousePressed', r.y);
  for (let i = 1; i <= 6; i++) { await m('mouseMoved', r.y + ((r.ty - r.y) * i) / 6); await sleep(30); }
  await m('mouseReleased', r.ty);
  await sleep(200);
}
const listIds = (page, scope) => page.eval(`[...document.querySelectorAll('.ordlist[data-scope="${scope}"] > .orditem')].map((e) => e.dataset.id)`);

async function checkRoutes(page, width, extra) {
  await page.viewport(width);
  for (const r of ROUTES) {
    await page.hash('#' + r);
    const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
    assert(v.sw <= v.iw + 1, `#${r} overflows at ${width}: ${v.sw} > ${v.iw}`);
  }
  for (const fn of extra) {
    await fn();
    const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth, h: document.getElementById("view").innerHTML.length })');
    assert(v.h > 200, 'extra screen rendered at ' + width);
    assert(v.sw <= v.iw + 1, `extra screen overflows at ${width}: ${v.sw} > ${v.iw}`);
  }
  await page.screenshot(`t10-routes-${width}`);
}

export const tests = [
  {
    name: 'especialidad on the tech form, filter in Técnicos and column/filter in the report',
    async fn(page) {
      await loginAs(page);
      const ana = await newTech(page, 'Ana Eléctrica', 'ES-1');
      await newTech(page, 'Beto Mecánico', 'ES-2');
      await fresh(page);
      await page.hash('#tecnico-' + ana);
      await page.act('techEdit');
      await page.select('#f-esp', 'esp-electricista');
      await page.modalBtn('Guardar cambios');
      await modalClosed(page, 'tech saved');
      eq((await state(page)).techs[ana].especialidadId, 'esp-electricista', 'especialidad saved');
      assert((await page.text('#view')).includes('Electricista'), 'sheet shows the especialidad');
      await page.hash('#tecnicos');
      await page.select('#tech-esp', 'esp-electricista');
      const names = await texts(page, '#view .list a.row .t');
      assert(names.length === 1 && names[0].includes('Ana Eléctrica'), 'filter keeps only Ana: ' + names);
      await page.select('#tech-esp', 'none');
      assert((await texts(page, '#view .list a.row .t')).some((n) => n.includes('Beto Mecánico')), 'sin especialidad shows Beto');
      await page.hash('#reportes');
      const head = await texts(page, '#view table.cards thead th');
      assert(head.includes('Especialidad'), 'report has the especialidad column');
      await page.select('#rpe', 'esp-electricista');
      const rows = await texts(page, '#view table.cards tbody tr td[data-l="Técnico"]');
      eq(rows.length, 1, 'report filtered by especialidad');
      assert((await page.text('#view table.cards tbody tr td[data-l="Especialidad"]')).includes('Electricista'), 'report column value');
      const r = await api(page, 'GET', '/api/reports?especialidad=esp-electricista');
      eq(r.body.rows.map((x) => x.especialidad).join(), 'Electricista', 'API report column');
    },
  },
  {
    name: 'edit the base kit and deliver it in one step; short stock is refused and nothing is written',
    async fn(page, { srv }) {
      await loginAs(page);
      const c = await catalog(page);
      const tech = await newTech(page, 'Kit Uno', 'KT-1');
      await fresh(page);
      await page.hash('#config');
      await page.click('[data-act="cfgTab"][data-v="kits"]');
      await page.select('#ka-kit-base', c.pinza);
      await page.type('[data-in="kitAddQty"][data-k="kit-base"]', '2');
      await page.click('[data-act="kitAdd"][data-k="kit-base"]');
      await page.select('#ka-kit-base', c.taladro);
      await page.click('[data-act="kitAdd"][data-k="kit-base"]');
      await page.select('#ka-kit-base', c.llave);
      await page.click('[data-act="kitAdd"][data-k="kit-base"]');
      // Llave sube un lugar con la flecha.
      await page.click(`.ordlist[data-scope="kit:kit-base"] .orditem[data-id="${c.llave}"] [data-act="ordMove"][data-d="-1"]`);
      eq((await listIds(page, 'kit:kit-base')).join(), [c.pinza, c.llave, c.taladro].join(), 'kit order after the arrow');
      await page.act('kitSave');
      await page.waitFor("!document.querySelector('[data-act=\"kitSave\"]')&&!document.body.classList.contains('busy')", 10000, 'kit saved');
      const kit = (await state(page)).kits['kit-base'];
      eq(JSON.stringify(kit.items), JSON.stringify([{ toolId: c.pinza, qty: 2 }, { toolId: c.llave, qty: 1 }, { toolId: c.taladro, qty: 1 }]), 'base kit saved');

      await page.hash('#tecnico-' + tech);
      await page.act('kitDeliver');
      const pv = await page.text('#mbody');
      assert(pv.includes('Pinza ×2') && pv.includes('Entrega inicial') && pv.includes('TAL-1'), 'preview lists tools, kind and units: ' + pv.slice(0, 300));
      assert(pv.includes('Se registran 3 movimientos'), 'preview counts movements');
      await page.modalBtn('Entregar kit');
      await modalClosed(page, 'kit delivered');
      eq(await movementsOf(srv, tech), 3, 'one movement per tool');
      const st = await state(page);
      const types = Object.values(st.movements).filter((m) => m.techId === tech).map((m) => m.type);
      assert(types.every((t) => t === 'entrega_inicial'), 'entregas iniciales');
      // Segunda entrega: adicionales en la vista previa.
      await page.act('kitDeliver');
      assert((await page.text('#mbody')).includes('Adicional'), 'second time is adicional');
      await page.eval("document.querySelector('#modal-root [data-act=\"modalClose\"]').click()");

      // Falta stock: la vista previa lo dice, la confirmación no escribe nada.
      const k2 = (await state(page)).kits['kit-base'];
      eq((await api(page, 'PUT', '/api/kits/kit-base', { items: [{ toolId: c.martillo, qty: 1 }, { toolId: c.pinza, qty: 99 }] }, { version: k2.version })).status, 200, 'kit with too many pinzas');
      const tech2 = await newTech(page, 'Kit Dos', 'KT-2');
      await fresh(page);
      await page.hash('#tecnico-' + tech2);
      await page.act('kitDeliver');
      assert((await page.text('#mbody')).includes('Pinza: se necesitan 99'), 'preview names the short tool');
      await page.modalBtn('Entregar kit');
      await sleep(300);
      assert((await page.text('#merr')).includes('No se puede entregar'), 'clear message on confirm');
      eq(await movementsOf(srv, tech2), 0, 'nothing written');
      const r = await api(page, 'POST', '/api/kits/kit-base/deliver', { holder: { techId: tech2 } }, { idem: 'kit-short-0001' });
      eq(r.status, 422, 'server refuses');
      assert(r.body.message.startsWith('No se entregó nada.') && r.body.problems.length === 1, 'server names the tool: ' + r.body.message);
      eq(await movementsOf(srv, tech2), 0, 'still nothing written');
    },
  },
  {
    name: 'reorder by drag and drop (1280): order in control, ficha, inventario, report and Excel; insert at position',
    timeout: 180000,
    async fn(page) {
      await loginAs(page);
      const c = await catalog(page);
      const tech = await newTech(page, 'Orden Uno', 'OR-1');
      for (const [t, q] of [[c.pinza, 1], [c.martillo, 1], [c.llave, 1]]) eq((await api(page, 'POST', '/api/assignments', { holder: { techId: tech }, toolId: t, qty: q }, { idem: 'or-' + t })).status, 201, 'assign');
      const unit = Object.entries((await state(page)).units).find(([, u]) => u.code === 'TAL-1')[0];
      eq((await api(page, 'POST', '/api/assignments', { holder: { techId: tech }, toolId: c.taladro, unitIds: [unit] }, { idem: 'or-taladro-1' })).status, 201, 'assign taladro');
      await fresh(page);
      await page.hash('#config');
      // Manuales antes que Eléctricas; Llave primera de Manuales.
      await drag(page, 'categories', c.man, c.elec);
      eq((await listIds(page, 'categories')).join(), [c.man, c.elec].join(), 'categories dragged');
      await page.click('[data-act="ordSave"][data-scope="categories"]');
      await page.waitFor("!document.querySelector('[data-act=\"ordSave\"][data-scope=\"categories\"]')&&!document.body.classList.contains('busy')", 10000, 'categories saved');
      await drag(page, 'tools:' + c.man, c.llave, c.pinza);
      eq((await listIds(page, 'tools:' + c.man)).join(), [c.llave, c.pinza, c.martillo].join(), 'tools dragged');
      // Teclado: Martillo sube con Alt+↑ (queda antes que Pinza).
      await page.eval(`document.querySelector('.ordlist[data-scope="tools:${c.man}"] .orditem[data-id="${c.martillo}"]').focus()`);
      await page.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 1 });
      await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 1 });
      await sleep(150);
      eq((await listIds(page, 'tools:' + c.man)).join(), [c.llave, c.martillo, c.pinza].join(), 'Alt+ArrowUp moved Martillo');
      await page.click(`[data-act="ordSave"][data-scope="tools:${c.man}"]`);
      await page.waitFor("!document.querySelector('[data-act=\"ordSave\"]')&&!document.body.classList.contains('busy')", 10000, 'tools saved');
      const st = await state(page);
      eq(Object.entries(st.categories).sort((a, b) => a[1].order - b[1].order).map(([id]) => id).join(), [c.man, c.elec].join(), 'categories saved on the server');
      const want = ['Llave', 'Martillo', 'Pinza', 'Taladro'];

      await page.hash('#control-' + tech);
      // Etapa 4: la tarjeta de limpieza va después de las herramientas (fuera de #ckitems).
      eq((await texts(page, '#ckitems .item-name')).join(), want.join(), 'control checklist order');
      await page.hash('#tecnico-' + tech);
      eq((await texts(page, '#view .list a.row .t')).join(), want.join(), 'ficha order');
      await page.hash('#inventario');
      eq((await texts(page, '#view table tbody td.lead a')).join(), want.join(), 'inventario order');
      await page.hash('#reportes');
      eq((await texts(page, '#view table.reptools tbody td.lead a')).join(), want.join(), 'report order');
      const n = await page.eval('window.__blobs.length');
      await page.act('exportXlsx');
      await page.waitFor(`window.__blobs.length>${n}&&!document.body.classList.contains('busy')`, 30000, 'xlsx blob');
      const sheet = await page.eval(`(async () => { const b = window.__blobs[window.__blobs.length - 1]; const wb = window.XLSX.read(new Uint8Array(await b.arrayBuffer()), { type: 'array' });
        return window.XLSX.utils.sheet_to_json(wb.Sheets['Por herramienta'], { header: 1 }).slice(3).map((r) => r[0]); })()`);
      eq(sheet.join(), want.join(), 'Excel sheet order');

      // Insertar en posición: Destornillador en la posición 2 de Manuales.
      await page.hash('#config');
      await page.act('toolNew');
      await page.type('#f-tn', 'Destornillador');
      await page.select('#f-tc', c.man);
      await page.select('#f-tp', '2');
      await page.modalBtn('Crear herramienta');
      await modalClosed(page, 'tool created');
      const st2 = await state(page);
      const man = Object.entries(st2.tools).filter(([, t]) => t.categoryId === c.man).sort((a, b) => a[1].order - b[1].order).map(([, t]) => t.name);
      eq(man.join(), 'Llave,Destornillador,Martillo,Pinza', 'inserted at position 2');
      eq((await listIds(page, 'tools:' + c.man)).length, 4, 'list shows the new tool');
    },
  },
  {
    name: 'reorder with arrows on mobile (390), concurrent reorder gets a conflict notice, new screens at 1280 and 390',
    width: 390,
    timeout: 180000,
    async fn(page, ctx) {
      await loginAs(page);
      const c = await catalog(page);
      await fresh(page);
      await page.hash('#config');
      const btn = await page.eval(`(() => { const b = document.querySelector('.ordlist[data-scope="tools:${c.man}"] .orditem[data-id="${c.pinza}"] [data-act="ordMove"][data-d="1"]').getBoundingClientRect(); return { w: b.width, h: b.height, grip: getComputedStyle(document.querySelector('[data-grip]')).display }; })()`);
      assert(btn.w >= 44 && btn.h >= 44, 'arrow buttons are 44 px on mobile: ' + JSON.stringify(btn));
      eq(btn.grip, 'none', 'no drag handle on mobile');
      await page.click(`.ordlist[data-scope="tools:${c.man}"] .orditem[data-id="${c.pinza}"] [data-act="ordMove"][data-d="1"]`);
      eq((await listIds(page, 'tools:' + c.man)).join(), [c.martillo, c.pinza, c.llave].join(), 'arrow moved Pinza down');
      await page.click(`[data-act="ordSave"][data-scope="tools:${c.man}"]`);
      await page.waitFor("!document.querySelector('[data-act=\"ordSave\"]')&&!document.body.classList.contains('busy')", 10000, 'saved');
      const ord = Object.entries((await state(page)).tools).filter(([, t]) => t.categoryId === c.man).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
      eq(ord.join(), [c.martillo, c.pinza, c.llave].join(), 'server order');

      // Dos sesiones reordenan las categorías a la vez: la segunda recibe el aviso y no pisa.
      const other = await secondPage(ctx);
      await other.hash('#config');
      await page.click(`.ordlist[data-scope="categories"] .orditem[data-id="${c.man}"] [data-act="ordMove"][data-d="-1"]`);
      await other.click(`.ordlist[data-scope="categories"] .orditem[data-id="${c.elec}"] [data-act="ordMove"][data-d="1"]`);
      await page.click('[data-act="ordSave"][data-scope="categories"]');
      await page.waitFor("!document.querySelector('[data-act=\"ordSave\"]')&&!document.body.classList.contains('busy')", 10000, 'first saved');
      await other.click('[data-act="ordSave"][data-scope="categories"]');
      await other.waitFor("(document.querySelector('#view')||{}).textContent.includes('Otra persona cambió el orden')", 10000, 'conflict notice');
      const cats = Object.entries((await state(page)).categories).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
      eq(cats.join(), [c.man, c.elec].join(), 'first order kept');
      await other.click('[data-act="ordDiscard"][data-scope="categories"]');
      assert(!(await other.text('#view')).includes('Otra persona cambió el orden'), 'notice gone after reload');

      const tab = (v) => async () => { await page.hash('#config'); await page.click(`[data-act="cfgTab"][data-v="${v}"]`); };
      const tech = await newTech(page, 'Rutas Uno', 'RT-1');
      const kitSheet = async () => { await page.hash('#tecnico-' + tech); await page.act('kitDeliver'); };
      const k = (await state(page)).kits['kit-base'];
      eq((await api(page, 'PUT', '/api/kits/kit-base', { items: [{ toolId: c.pinza, qty: 1 }, { toolId: c.taladro, qty: 1 }] }, { version: k.version })).status, 200, 'kit for the sheet');
      await fresh(page);
      const close = async () => { await page.eval("(document.querySelector('#modal-root [data-act=\"modalClose\"]')||{click(){}}).click()"); await sleep(100); };
      await checkRoutes(page, 390, [tab('tools'), tab('kits'), tab('esp'), kitSheet, close]);
      await checkRoutes(page, 1280, [tab('tools'), tab('kits'), tab('esp'), kitSheet, close]);
    },
  },
];
