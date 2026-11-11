// T15 (stage 8): Existencia por técnico (the Excel RESUMEN). Matrix values after entregas and a
// control with recambio and faltante (recambio never counted as missing), plantilla filter and
// the cajas / "solo con herramientas" toggles, the Excel file, the print view (print media, B/W
// marks and legend), days since the last control in the tech sheet and the plantilla members,
// the "Sin control hace N días" alert crossing a threshold changed in Administración, and the
// screen at 390 px without page overflow (the matrix scrolls inside its own box).
import { assert, eq, loginAs, logout, api, state } from '../app.mjs';
import { sleep } from '../harness.mjs';

const idem = () => 'e2e-' + Math.random().toString(36).slice(2, 12);
const ok = (r, code, label) => { eq(r.status, code, `${label}: ${JSON.stringify(r.body)}`); return r.body; };
async function noOverflow(page, label) {
  const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
  assert(v.sw <= v.iw + 1, `${label} overflows: ${v.sw} > ${v.iw}`);
}
const matrixReady = (page, label) => page.waitFor("!!document.getElementById('exitbl')&&!document.body.classList.contains('busy')", 10000, label);
// Text of the cell of a tool row (by name) and a holder column (by holder key).
const cellText = (page, tool, hk) => page.eval(`(() => {
  const t = document.getElementById('exitbl'); const hs = [...t.querySelectorAll('thead th')]; const i = hs.findIndex((h) => h.dataset.h === ${JSON.stringify(hk)});
  const r = [...t.querySelectorAll('tbody tr')].find((x) => x.querySelector('th').textContent.includes(${JSON.stringify(tool)}));
  return i < 0 || !r ? null : r.children[i].textContent.trim();
})()`);
const rowTail = (page, tool) => page.eval(`(() => { const r = [...document.querySelectorAll('#exitbl tbody tr')].find((x) => x.querySelector('th').textContent.includes(${JSON.stringify(tool)})); return r ? [...r.children].slice(-4).map((c) => c.textContent.trim()) : null; })()`);
const holderKeys = (page) => page.eval("[...document.querySelectorAll('#exitbl thead th[data-h]')].map((h) => h.dataset.h)");

// Two techs (mañana and tarde), a caja, a quantity tool and a unit-tracked one, entregas and a
// finalized control of this week of the first tech with 1 llave for recambio and 1 missing.
async function setup(page) {
  const a = ok(await api(page, 'POST', '/api/techs', { name: 'Ema Existencia', legajo: 'EX-1', plantillaId: 'manana' }), 201, 'tech A').tech;
  const b = ok(await api(page, 'POST', '/api/techs', { name: 'Fede Existencia', legajo: 'EX-2', plantillaId: 'tarde' }), 201, 'tech B').tech;
  const linea = ok(await api(page, 'POST', '/api/lineas', { name: 'Línea Existencia', kind: 'linea' }), 201, 'linea').linea;
  const caja = ok(await api(page, 'POST', '/api/cajas', { name: 'Caja Existencia', lineaId: linea.id }), 201, 'caja').caja;
  const llave = ok(await api(page, 'POST', '/api/tools', { name: 'Llave Existencia', serialized: false, stock: 10 }), 201, 'llave').tool;
  const tal = ok(await api(page, 'POST', '/api/tools', { name: 'Taladro Existencia', serialized: true, codes: 'TX-1\nTX-2' }), 201, 'taladro').tool;
  let st = await state(page);
  const unit = Object.entries(st.units).find(([, u]) => u.code === 'TX-1')[0];
  const give = async (body, label) => ok(await api(page, 'POST', '/api/movements', { type: 'entrega_inicial', ...body }, { idem: idem() }), 201, label);
  await give({ techId: a.id, toolId: llave.id, qty: 3 }, 'llave A');
  await give({ techId: a.id, toolId: tal.id, unitId: unit }, 'taladro A');
  await give({ techId: b.id, toolId: llave.id, qty: 1 }, 'llave B');
  await give({ cajaId: caja.id, toolId: llave.id, qty: 2 }, 'llave caja');
  st = await state(page);
  const asg = (tool) => Object.entries(st.assignments).find(([, x]) => x.active && x.techId === a.id && x.toolId === tool)[0];
  const c = ok(await api(page, 'POST', '/api/controls', { techId: a.id, period: st.derived.cur }, { idem: idem() }), 201, 'control').control;
  const items = { [asg(llave.id)]: { good: 1, change: 1, expected: 3, note: 'Una se perdió' }, [asg(tal.id)]: { state: 'bueno' } };
  ok(await api(page, 'POST', `/api/controls/${c.id}/finalize`, { items, cleaning: { status: 'limpio' } }, { version: c.version, idem: idem() }), 200, 'finalize');
  return { a, b, caja, llave, tal };
}

export const tests = [
  {
    name: 'matrix after entregas and a control, plantilla filter, cajas toggle, Excel file and print view',
    timeout: 150000,
    async fn(page, ctx) {
      await loginAs(page, 'admin');
      const s = await setup(page);
      const ck = `caja:${s.caja.id}`;
      // Más › Existencia por técnico, and the nav item.
      await page.hash('#mas');
      assert(await page.eval("!!document.querySelector('#view a.mrow[href=\"#existencia\"]')"), 'Más has Existencia por técnico');
      assert(await page.eval("!!document.querySelector('#side a[href=\"#existencia\"]')"), 'side nav has Existencia');
      await page.hash('#existencia');
      await matrixReady(page, 'matrix');
      eq((await holderKeys(page)).join(','), [s.a.id, s.b.id, ck].join(','), 'columns: techs (by name) then cajas');
      // Llave: A has 3 with C 1 and F 1 (recambio is not missing), B 1, the caja 2.
      const ca = await cellText(page, 'Llave Existencia', s.a.id);
      assert(/^3/.test(ca) && ca.includes('C 1') && ca.includes('F 1'), 'A llave cell: ' + ca);
      eq(await cellText(page, 'Llave Existencia', s.b.id), '1', 'B llave cell');
      eq(await cellText(page, 'Llave Existencia', ck), '2', 'caja llave cell');
      const tal = await cellText(page, 'Taladro Existencia', s.a.id);
      eq(tal, '1', 'unit-tracked taladro counted, good in the control');
      eq((await rowTail(page, 'Llave Existencia')).join('|'), '6|C 1|F 1|4', 'row totals: assigned, recambio, faltante, pañol stock');
      eq((await rowTail(page, 'Taladro Existencia')).join('|'), '1|0|0|1', 'taladro totals');
      // Header: legajo, especialidad, last control today and its days.
      const head = await page.eval(`document.querySelector('#exitbl thead th[data-h="${s.a.id}"]').textContent`);
      assert(head.includes('Leg. EX-1') && head.includes('Sin especialidad') && head.includes('Último:') && head.includes('0 días'), 'A header: ' + head);
      const bh = await page.eval(`document.querySelector('#exitbl thead th[data-h="${s.b.id}"]').textContent`);
      assert(bh.includes('Sin controles'), 'B header: ' + bh);
      const foot = await page.eval("[...document.querySelectorAll('#exitbl tfoot td')].slice(-4).map((c) => c.textContent.trim()).join('|')");
      eq(foot, '7|1|1|5', 'grand totals');
      // Plantilla filter, cajas and "solo con herramientas" toggles.
      await page.select('#exi-pl', 'tarde');
      await matrixReady(page, 'filtered');
      eq((await holderKeys(page)).join(','), [s.b.id, ck].join(','), 'tarde + cajas');
      await page.act('exiCajas');
      await matrixReady(page, 'no cajas');
      eq((await holderKeys(page)).join(','), s.b.id, 'tarde without cajas');
      eq((await rowTail(page, 'Llave Existencia')).join('|'), '1|0|0|4', 'row totals only of the shown columns');
      await page.select('#exi-pl', 'all');
      await page.act('exiCajas');
      await page.act('exiWith');
      await matrixReady(page, 'with tools');
      eq((await holderKeys(page)).length, 3, 'all three have tools');
      await page.act('exiWith');
      // Excel: a real xlsx (zip) file.
      const n = await page.eval('window.__blobs.length');
      await page.act('exiXlsx');
      await page.waitFor(`window.__blobs.length>${n}`, 20000, 'xlsx download');
      const x = await page.lastBlob(true);
      assert(x.head.startsWith('PK') && x.size > 2000, 'xlsx file: ' + JSON.stringify(x));
      // Print: window.print() is called with the print class; in print media only the matrix,
      // the company header and the legend remain.
      await page.eval('window.__printed = 0; window.print = () => { window.__printed++; }');
      await page.act('exiPrint');
      eq(await page.eval('window.__printed'), 1, 'window.print called');
      assert(await page.eval("document.body.classList.contains('print-exi')"), 'print class on');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(150);
      const pv = await page.eval(`({ side: getComputedStyle(document.getElementById('side')).display, bottom: getComputedStyle(document.getElementById('bottom')).display, ph: getComputedStyle(document.querySelector('.exi-ph')).display,
        filters: getComputedStyle(document.querySelector('.exi-f')).display, acts: getComputedStyle(document.querySelector('.ph .acts')).display, thead: getComputedStyle(document.querySelector('#exitbl thead')).display,
        legend: document.getElementById('exileg').textContent, ph_text: document.querySelector('.exi-ph').textContent, mk: getComputedStyle(document.querySelector('#exitbl .mk.f')).color, wrap: getComputedStyle(document.getElementById('exiwrap')).overflow })`);
      eq([pv.side, pv.bottom, pv.filters, pv.acts].join(','), 'none,none,none,none', 'chrome hidden when printing');
      eq(pv.ph, 'flex', 'company header shown when printing');
      eq(pv.thead, 'table-header-group', 'header repeated on each page');
      eq(pv.wrap, 'visible', 'matrix not clipped when printing');
      eq(pv.mk, 'rgb(0, 0, 0)', 'marks in black for B/W printing');
      assert(pv.ph_text.includes("Villa D'agri") && pv.ph_text.includes('Emitido'), 'print header: ' + pv.ph_text);
      assert(pv.legend.includes('C n') && pv.legend.includes('F n'), 'legend at the foot');
      await page.screenshot('t15-print');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: '' });
      await page.eval("window.dispatchEvent(new Event('afterprint'))");
      assert(!(await page.eval("document.body.classList.contains('print-exi')")), 'print class removed after printing');
      // API parity: the server builds the same matrix.
      const X = ok(await api(page, 'GET', '/api/existencia'), 200, 'GET existencia');
      const row = X.rows.find((r) => r.toolId === s.llave.id);
      eq(JSON.stringify(row.cells[s.a.id]), JSON.stringify({ qty: 3, cambio: 1, faltante: 1 }), 'server cell');
      eq([X.totals.total, X.totals.cambio, X.totals.faltante].join('|'), '7|1|1', 'server totals');
    },
  },
  {
    name: 'days since control in sheets and plantillas, "Sin control hace N días" alert vs. threshold in Administración, 390 px',
    width: 390,
    height: 844,
    timeout: 150000,
    async fn(page, ctx) {
      await loginAs(page, 'admin');
      const s = await setup(page);
      // B never had a control: its first entrega was 20 days ago.
      await ctx.srv.db.query("UPDATE assignments SET since = now() - interval '20 days' WHERE tech_id = $1", [s.b.id]);
      await page.reload();
      await page.ready();
      const alertOf = () => `[...document.querySelectorAll('#view .al')].find((a)=>a.textContent.includes('Sin control hace 20 días')&&a.textContent.includes('Fede Existencia'))`;
      await page.hash('#alertas');
      await page.waitFor(`!!${alertOf()}`, 10000, 'overdue alert with the default 14 days');
      assert(!(await page.eval("[...document.querySelectorAll('#view .al')].some((a)=>a.textContent.includes('Ema Existencia')&&a.textContent.includes('Sin control'))")), 'A controlled today: no alert');
      eq(await page.eval(`${alertOf()}.textContent.includes('Sin controles desde la primera entrega')`), true, 'alert text');
      eq(await page.eval(`!!${alertOf()}.querySelector('a.btn[href="#control-${s.b.id}"]')`), true, 'Controlar from the alert');
      // Sheets and plantilla members show the days.
      await page.hash('#tecnico-' + s.b.id);
      const bChip = await page.text('#view .ctlage');
      assert(bChip.includes('Sin controles (20 días desde la primera entrega)') && bChip.includes('más de 14 días'), 'B sheet: ' + bChip);
      eq(await page.eval("!!document.querySelector('#view .ctlage .chip.bad')"), true, 'overdue chip in red (with text)');
      await page.hash('#tecnico-' + s.a.id);
      assert((await page.text('#view .ctlage')).includes('Último control hoy'), 'A sheet: today');
      await page.hash('#caja-' + s.caja.id);
      assert((await page.text('#view .ctlage')).includes('Sin controles (0 días'), 'caja sheet');
      await page.hash('#plantilla-tarde');
      await page.waitFor(`!!document.querySelector('#view .tc .ctlage')`, 10000, 'member card age');
      assert((await page.text('#view .tc .ctlage')).includes('20 días'), 'plantilla member card');
      await noOverflow(page, 'plantilla 390');
      // Threshold in Administración › Configuración: 30 -> no alert; 10 -> back.
      const setDays = async (n) => {
        await page.hash('#admin');
        await page.click('[data-act="adminTab"][data-v="config"]');
        await page.waitFor("!!document.getElementById('cfg-overdue')", 10000, 'threshold input');
        await page.type('#cfg-overdue', String(n));
        await page.act('cfgOverdueSave');
        await page.waitFor(`!document.body.classList.contains('busy')&&document.getElementById('cfg-overdue').value==='${n}'&&!!document.querySelector('[data-act="cfgOverdueSave"][disabled]')`, 10000, 'threshold saved ' + n);
        await noOverflow(page, 'admin config 390');
      };
      await setDays(30);
      eq((await state(page)).settings.controlOverdueDays, 30, 'threshold stored');
      await page.hash('#alertas');
      await sleep(200);
      assert(!(await page.eval(`!!${alertOf()}`)), 'no alert with 30 days');
      await setDays(10);
      await page.hash('#alertas');
      await page.waitFor(`!!${alertOf()}`, 10000, 'alert back with 10 days');
      // Out of range: refused with a message, nothing saved.
      await page.hash('#admin');
      await page.click('[data-act="adminTab"][data-v="config"]');
      await page.waitFor("!!document.getElementById('cfg-overdue')", 10000, 'threshold input');
      await page.toasts();
      await page.type('#cfg-overdue', '400');
      await page.act('cfgOverdueSave');
      assert((await page.toasts()).some((t) => t.includes('entre 0 y 365')), 'range message');
      eq((await state(page)).settings.controlOverdueDays, 10, 'threshold unchanged');
      // Existencia at 390 px: no page overflow, the matrix scrolls inside its box with a sticky
      // first column and header.
      await page.hash('#existencia');
      await matrixReady(page, 'matrix 390');
      await noOverflow(page, 'existencia 390');
      const box = await page.eval(`(() => { const w = document.getElementById('exiwrap'); const th = document.querySelector('#exitbl tbody th'); const hh = document.querySelector('#exitbl thead th');
        return { sw: w.scrollWidth, cw: w.clientWidth, ov: getComputedStyle(w).overflowX, first: getComputedStyle(th).position, head: getComputedStyle(hh).position }; })()`);
      assert(box.sw > box.cw, 'matrix wider than its box at 390: ' + JSON.stringify(box));
      eq([box.ov, box.first, box.head].join(','), 'auto,sticky,sticky', 'scroll inside the box, sticky first column and header');
      const late = await page.eval(`document.querySelector('#exitbl thead th[data-h="${s.b.id}"] .exi-age').className`);
      assert(late.includes('bad'), 'B header marked overdue: ' + late);
      await page.screenshot('t15-existencia-390');
      // A stale version is refused (two admins editing at once).
      ok(await api(page, 'PUT', '/api/settings/alerts', { controlOverdueDays: 10 }, { version: 0 }), 409, 'stale version');
    },
  },
  {
    name: 'gerencia sees the read-only matrix; responsable sees the threshold but cannot change it',
    width: 390,
    height: 844,
    timeout: 90000,
    async fn(page) {
      await loginAs(page, 'gerencia');
      await page.hash('#existencia');
      await page.waitFor("!!document.querySelector('#view h1')&&!document.body.classList.contains('busy')", 10000, 'existencia for gerencia');
      eq(await page.text('#view h1'), 'Existencia por técnico', 'gerencia opens Existencia');
      eq(await page.eval("!!document.querySelector('[data-act=\"exiXlsx\"]')"), true, 'gerencia may export (reports_export)');
      await noOverflow(page, 'gerencia existencia 390');
      const r = await api(page, 'PUT', '/api/settings/alerts', { controlOverdueDays: 3 }, { version: 0 });
      eq(r.status, 403, 'gerencia cannot change the threshold');
      await logout(page);
      await loginAs(page, 'responsable');
      await page.hash('#admin');
      await page.click('[data-act="adminTab"][data-v="config"]');
      await page.waitFor("!!document.querySelector('#view .cfgcard')", 10000, 'threshold card');
      eq(await page.eval("!!document.getElementById('cfg-overdue')"), false, 'no input without permission');
      assert((await page.text('#view .cfgcard')).includes('más de 14 días'), 'current value shown');
    },
  },
];
