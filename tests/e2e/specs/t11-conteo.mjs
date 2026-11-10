// T11 (stage 4): count by quantity and cleaning in the control. Steppers for qty > 1 with a live
// "Faltan N" and a required motivo, the three buttons for qty = 1, optional línea on missing or
// change, the cleaning card (required to finalize, note required when it needs cleaning),
// Finalizar disabled with the exact reason, confirmation in units, the consecutive cleaning
// alert, "para recambio" never counted as missing in the report, losses by línea, old (2.x)
// controls still readable, an offline draft that keeps quantities and cleaning, and every
// route at 1280 and 390 without overflow.
import { sleep } from '../harness.mjs';
import { assert, eq, loginAs, state, api, importFile, fixture, ROUTES, PASSWORD } from '../app.mjs';

const idbDrafts = (page) => page.eval("new Promise((res,rej)=>{const r=indexedDB.open('panol-v3',1);r.onupgradeneeded=()=>r.result.createObjectStore('panol-drafts',{keyPath:'key'});r.onsuccess=()=>{const t=r.result.transaction('panol-drafts','readonly').objectStore('panol-drafts').getAll();t.onsuccess=()=>{res(t.result);r.result.close()};t.onerror=()=>rej(t.error)};r.onerror=()=>rej(r.error)})");
const newTech = async (page, name, legajo) => { const r = await api(page, 'POST', '/api/techs', { name, legajo, plantillaId: 'manana' }); eq(r.status, 201, 'tech ' + name); return r.body.tech.id; };
const newTool = async (page, name, stock = 10) => { const r = await api(page, 'POST', '/api/tools', { name, serialized: false, stock }); eq(r.status, 201, 'tool ' + name); return r.body.tool.id; };
const assign = async (page, techId, toolId, qty) => eq((await api(page, 'POST', '/api/assignments', { holder: { techId }, toolId, qty }, { idem: 'asg-' + Math.random().toString(36).slice(2) })).status, 201, 'assignment');
const fresh = async (page) => { await page.reload(); await page.ready(); };
const why = (page) => page.text('#ckwhy');
const finDisabled = (page) => page.eval("document.getElementById('ckfin').disabled");
const modalClosed = (page, label) => page.waitFor("!document.querySelector('#modal-root:not([hidden]) .sheet')&&!document.body.classList.contains('busy')", 15000, label);
const prevP = (p) => (p.w > 1 ? { ...p, w: p.w - 1 } : p.m > 1 ? { y: p.y, m: p.m - 1, w: 4 } : { y: p.y - 1, m: 12, w: 4 });
const asgOf = (st, techId, toolId) => (Object.entries(st.assignments).find(([, a]) => a.active && a.techId === techId && a.toolId === toolId) || [null])[0];

// Técnico con una herramienta de 5 unidades y otra de 1, y una línea activa.
async function setup(page) {
  const tech = await newTech(page, 'Ana Conteo', 'CT-1');
  const llave = await newTool(page, 'Llave combinada');
  const pinza = await newTool(page, 'Pinza universal');
  await assign(page, tech, llave, 5);
  await assign(page, tech, pinza, 1);
  const lin = await api(page, 'POST', '/api/lineas', { name: 'Línea Envasado', kind: 'linea' });
  eq(lin.status, 201, 'línea');
  await fresh(page);
  const st = await state(page);
  return { tech, llave, pinza, linea: lin.body.linea.id, aLlave: asgOf(st, tech, llave), aPinza: asgOf(st, tech, pinza), cur: st.derived.cur };
}

async function noOverflow(page, label) {
  const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
  assert(v.sw <= v.iw + 1, `${label} overflows: ${v.sw} > ${v.iw}`);
}

export const tests = [
  {
    name: 'quantity count: steppers, live "Faltan N", required motivo, optional línea, cleaning required with note, confirmation in units',
    async fn(page) {
      await loginAs(page);
      const s = await setup(page);
      await page.hash('#control-' + s.tech);
      await page.waitFor(`!!document.getElementById('it-${s.aLlave}')`, 10000, 'checklist');
      // qty = 1: the three buttons as a radiogroup; qty > 1: steppers (no buttons).
      eq(await page.count(`#it-${s.aPinza} [role="radiogroup"] [role="radio"]`), 3, 'three buttons for qty 1');
      eq(await page.count(`#it-${s.aLlave} [data-act="ckSet"]`), 0, 'no buttons for qty 5');
      eq(await page.count(`#it-${s.aLlave} [data-act="ckStep"]`), 4, 'two steppers');
      const btnH = await page.eval(`Math.min(...[...document.querySelectorAll('#it-${s.aLlave} [data-act="ckStep"]')].map((b)=>b.getBoundingClientRect().height))`);
      assert(btnH >= 44, 'stepper buttons >= 44px: ' + btnH);
      assert(await finDisabled(page), 'finalize disabled at start');
      eq(await why(page), 'Faltan 2 herramientas por controlar', 'reason: pending');
      // 3 in good state, 1 for change: 1 missing.
      for (let i = 0; i < 3; i++) await page.click(`#it-${s.aLlave} [data-act="ckStep"][data-k="good"][data-d="1"]`);
      await page.click(`#it-${s.aLlave} [data-act="ckStep"][data-k="change"][data-d="1"]`);
      assert((await page.text('#qm-' + s.aLlave)).includes('Faltan 1'), 'live missing count');
      // The + buttons stop at the assigned quantity.
      await page.type(`#qgood-${s.aLlave}`, '9');
      eq(await page.eval(`document.getElementById('qgood-${s.aLlave}').value`), '4', 'typed value clamped to 5 - 1 change');
      assert((await page.text('#qm-' + s.aLlave)).includes('Están todas'), 'nothing missing');
      await page.type(`#qgood-${s.aLlave}`, '3');
      assert((await page.text('#qm-' + s.aLlave)).includes('Faltan 1'), 'missing again');
      await page.click(`#it-${s.aPinza} [data-act="ckSet"][data-s="bueno"]`);
      eq(await page.eval(`document.querySelector('#it-${s.aPinza} [data-s="bueno"]').getAttribute('aria-checked')`), 'true', 'aria-checked');
      eq(await why(page), 'Completá el motivo de 1 faltante', 'reason: motivo');
      assert((await page.text('#it-' + s.aLlave)).includes('La nota es obligatoria para registrar un faltante.'), 'motivo required message');
      await page.click(`#it-${s.aLlave} [data-act="ckQuick"]`, 'Extraviada en el trabajo');
      await page.select('#ln-' + s.aLlave, s.linea);
      eq(await why(page), 'Indicá la limpieza de herramientas y caja', 'reason: cleaning');
      assert(await finDisabled(page), 'still disabled without cleaning');
      await page.click('#it-clean [data-act="ckClean"][data-s="requiere_limpieza"]');
      eq(await why(page), 'Completá la nota de limpieza', 'reason: cleaning note');
      assert((await page.text('#it-clean')).includes('La nota es obligatoria si requiere limpieza.'), 'cleaning note message');
      await page.type('#nt-clean', 'Herramientas con grasa');
      eq(await why(page), '', 'no reason left');
      assert(!(await finDisabled(page)), 'finalize enabled');
      await page.act('ckFinish');
      const sheet = await page.text('#modal-root .sheet');
      assert(sheet.includes('4Buen estado') && sheet.includes('1Para cambio') && sheet.includes('1Faltante'), 'confirmation tiles in units: ' + sheet.slice(0, 300));
      assert(sheet.includes('Requiere limpieza. Herramientas con grasa'), 'cleaning in the confirmation');
      assert(sheet.includes('Se generarán 2 alertas automáticas'), 'alerts for missing and change');
      await page.modalBtn('Confirmar y guardar');
      await page.waitFor("!!document.querySelector('#modal-root .success')", 15000, 'control saved');
      await page.eval("document.querySelector('#modal-root .scrim').click()");
      await modalClosed(page, 'success closed');
      const st = await state(page);
      const [cid, c] = Object.entries(st.controls).find(([, x]) => x.techId === s.tech && x.status === 'finalizado');
      const it = c.items[s.aLlave];
      eq(JSON.stringify([it.state, it.good, it.change, it.missing, it.expected, it.lineaId, it.note]), JSON.stringify(['faltante', 3, 1, 1, 5, s.linea, 'Extraviada en el trabajo']), 'stored quantities');
      eq(JSON.stringify(c.counts), JSON.stringify({ bueno: 4, cambio: 1, faltante: 1 }), 'counts in units');
      eq(JSON.stringify(c.cleaning), JSON.stringify({ status: 'requiere_limpieza', note: 'Herramientas con grasa' }), 'cleaning stored');
      // Control detail and tech sheet show quantities, línea and cleaning.
      await page.hash('#controlver-' + cid);
      const det = await page.text('#view');
      assert(det.includes('Requiere limpieza') && det.includes('Herramientas con grasa') && det.includes('Línea Envasado'), 'detail shows cleaning and línea: ' + det.slice(0, 900));
      await page.hash('#tecnico-' + s.tech);
      const ficha = await page.text('#view');
      assert(ficha.includes('3 bien · 1 para recambio · 1 falta'), 'sheet shows quantities: ' + ficha.slice(0, 400));
      assert(ficha.includes('Limpieza de herramientas y caja') && ficha.includes('Requiere limpieza'), 'sheet shows cleaning');
      const al = (await api(page, 'GET', '/api/alerts')).body.open;
      assert(al.some((a) => a.type === 'faltante' && a.text.includes('faltan 1 de 5')), 'missing alert by quantity');
      assert(al.some((a) => a.type === 'cambio' && a.text.includes('1 de 5 para recambio')), 'change alert by quantity');
    }
  },
  {
    name: 'consecutive cleaning alert, change never counted as missing, report by línea and % limpio',
    async fn(page) {
      await loginAs(page);
      const s = await setup(page);
      // Previous week by API, requiring cleaning.
      const p = prevP(s.cur);
      const cr = await api(page, 'POST', '/api/controls', { techId: s.tech, period: p, items: { [s.aLlave]: { state: 'bueno' }, [s.aPinza]: { state: 'bueno' } } }, { idem: 'ctl-prev-0001' });
      eq(cr.status, 201, 'previous control');
      const fr = await api(page, 'POST', `/api/controls/${cr.body.control.id}/finalize`, { cleaning: { status: 'requiere_limpieza', note: 'Caja sucia' } }, { version: cr.body.control.version, idem: 'ctl-prev-0002' });
      eq(fr.status, 200, 'previous finalized');
      await fresh(page);
      // This week in the UI: 2 for change and 3 good (nothing missing), cleaning required again.
      await page.hash('#control-' + s.tech);
      await page.waitFor(`!!document.getElementById('it-${s.aLlave}')`, 10000, 'checklist');
      await page.type(`#qchange-${s.aLlave}`, '2');
      await page.type(`#qgood-${s.aLlave}`, '3');
      assert((await page.text('#qm-' + s.aLlave)).includes('Están todas'), 'change is not missing');
      assert((await page.text('#it-' + s.aLlave)).includes('Observación (opcional)'), 'note optional with change only');
      await page.select('#ln-' + s.aLlave, s.linea);
      await page.click(`#it-${s.aPinza} [data-act="ckSet"][data-s="faltante"]`);
      await page.type('#nt-' + s.aPinza, 'No está en el pañol');
      await page.click('#it-clean [data-act="ckClean"][data-s="requiere_limpieza"]');
      await page.click('#it-clean [data-act="ckCleanQuick"]', 'Polvo y viruta');
      eq(await why(page), '', 'ready to finalize');
      await page.act('ckFinish');
      assert((await page.text('#modal-root .sheet')).includes('Se generarán 3 alertas automáticas'), 'change + missing + cleaning alerts');
      await page.modalBtn('Confirmar y guardar');
      await page.waitFor("!!document.querySelector('#modal-root .success')", 15000, 'control saved');
      await page.eval("document.querySelector('#modal-root .scrim').click()");
      await modalClosed(page, 'success closed');
      await page.hash('#alertas');
      const at = await page.text('#view');
      assert(at.includes('Requiere limpieza en controles consecutivos') && at.includes('Ana Conteo. Polvo y viruta'), 'consecutive cleaning alert shown');
      const key = (await api(page, 'GET', '/api/alerts')).body.open.find((a) => a.type === 'limpieza').key;
      await page.click(`[data-act="resolveAlert"][data-k="${key}"]`);
      await page.type('#f-an', 'Se limpió la caja');
      await page.modalBtn('Marcar resuelta');
      await modalClosed(page, 'alert resolved');
      assert(!(await api(page, 'GET', '/api/alerts')).body.open.some((a) => a.type === 'limpieza'), 'cleaning alert resolved');
      // Report: units, change never missing, % limpio, losses by línea (UI and API agree).
      const ym = `${s.cur.y}-${String(s.cur.m).padStart(2, '0')}`;
      const R = (await api(page, 'GET', `/api/reports?ym=${ym}&w=${s.cur.w}`)).body;
      const row = R.rows.find((r) => r.id === s.tech);
      eq(JSON.stringify([row.bueno, row.cambio, row.faltante, row.pct, row.pctLimpio]), JSON.stringify([3, 2, 1, 50, 0]), 'report row in units');
      eq(JSON.stringify(R.lineas.map((l) => [l.name, l.faltante, l.cambio])), JSON.stringify([['Línea Envasado', 0, 2], ['Sin línea', 1, 0]]), 'losses by línea');
      await page.hash('#reportes');
      await page.select('#rpw', String(s.cur.w));
      await sleep(200);
      const rep = await page.text('#view');
      assert(rep.includes('% limpio') && rep.includes('Faltantes y recambios por línea'), 'report sections');
      const lineRow = await page.eval("[...document.querySelectorAll('.replineas tbody tr')].map((tr)=>tr.textContent).join('|')");
      assert(lineRow.includes('Línea Envasado02') && lineRow.includes('Sin línea10'), 'línea table: ' + lineRow);
      const cells = await page.eval(`(() => { const tr = [...document.querySelectorAll('.tbl.cards tbody tr')].find((x)=>x.textContent.includes('Ana Conteo')); return tr ? [tr.querySelector('[data-l="% en condiciones"]').textContent, tr.querySelector('[data-l="% limpio"]').textContent] : null; })()`);
      eq(JSON.stringify(cells), JSON.stringify(['50%', '0%']), 'tech row % cond and % limpio');
    }
  },
  {
    name: 'old controls from a 2.x .txt stay readable (state by quantity, no cleaning data)',
    async fn(page) {
      await loginAs(page);
      const r = await importFile(page, fixture('legacy-2.0.0.txt'), 'merge');
      assert(r.opened && !r.err, 'legacy import: ' + r.err);
      const st = await state(page);
      const [cid, c] = Object.entries(st.controls).find(([, x]) => x.status === 'finalizado') || [];
      assert(c, 'an imported finalized control');
      eq(c.cleaning.status, null, 'no cleaning data');
      const it = Object.values(c.items)[0];
      assert(it.expected >= 0 && it.good + it.change + it.missing === it.expected, 'quantities from the state');
      await page.hash('#controlver-' + cid);
      const t = await page.text('#view');
      assert(t.includes('Sin dato de limpieza') && t.includes('Buen estado'), 'detail readable: ' + t.slice(0, 300));
      await page.hash('#controles');
      assert((await page.text('#view')).length > 200, 'history renders');
    }
  },
  {
    name: 'offline draft keeps quantities and cleaning and is resent on reconnect',
    allowErrors: ['ERR_', 'net::'],
    async fn(page, { srv }) {
      await loginAs(page);
      const s = await setup(page);
      await page.hash('#control-' + s.tech);
      await page.waitFor(`!!document.getElementById('it-${s.aLlave}')`, 10000, 'checklist');
      srv.offline = true;
      await page.waitFor("!document.getElementById('netbar').hidden", 15000, 'offline banner');
      await page.toasts();
      await page.type(`#qgood-${s.aLlave}`, '2');
      await page.type(`#qchange-${s.aLlave}`, '1');
      await page.click('#it-clean [data-act="ckClean"][data-s="limpio"]');
      await page.act('ckSave');
      await page.waitFor("window.__toasts.some((t)=>t.includes('borrador quedó guardado en este equipo'))", 5000, 'saved on the device');
      const local = await idbDrafts(page);
      eq(local.length, 1, 'one local draft');
      const li = local[0].items[s.aLlave];
      eq(JSON.stringify([li.good, li.change, li.expected]), JSON.stringify([2, 1, 5]), 'local quantities');
      eq(local[0].cleaning.status, 'limpio', 'local cleaning');
      srv.offline = false;
      await page.waitFor("window.__toasts.some((t)=>t.includes('Se envió el borrador guardado sin conexión'))", 25000, 'draft resent');
      const d = Object.values((await state(page)).controls).find((c) => c.techId === s.tech && c.status === 'borrador');
      assert(d, 'server draft');
      const it = d.items[s.aLlave];
      eq(JSON.stringify([it.good, it.change, it.missing, it.state]), JSON.stringify([2, 1, 2, 'faltante']), 'server quantities');
      eq(d.cleaning.status, 'limpio', 'server cleaning');
      eq((await idbDrafts(page)).length, 0, 'local copy removed');
    }
  },
  {
    name: 'offline draft with a línea survives the línea being archived elsewhere: synced without the línea, nothing lost',
    allowErrors: ['ERR_', 'net::'],
    async fn(page, { srv }) {
      await loginAs(page);
      const s = await setup(page);
      await page.hash('#control-' + s.tech);
      await page.waitFor(`!!document.getElementById('it-${s.aLlave}')`, 10000, 'checklist');
      srv.offline = true;
      await page.waitFor("!document.getElementById('netbar').hidden", 15000, 'offline banner');
      await page.toasts();
      // 2 good + 1 for change of 5: 2 missing, with motivo and línea; pinza bueno with no línea.
      await page.type(`#qgood-${s.aLlave}`, '2');
      await page.type(`#qchange-${s.aLlave}`, '1');
      await page.type('#nt-' + s.aLlave, 'Se perdieron en la línea');
      await page.select('#ln-' + s.aLlave, s.linea);
      await page.click(`#it-${s.aPinza} [data-act="ckSet"][data-s="bueno"]`);
      await page.click('#it-clean [data-act="ckClean"][data-s="limpio"]');
      await page.act('ckSave');
      await page.waitFor("window.__toasts.some((t)=>t.includes('borrador quedó guardado en este equipo'))", 5000, 'saved on the device');
      const local = await idbDrafts(page);
      eq(local.length, 1, 'one local draft');
      eq(local[0].items[s.aLlave].lineaId, s.linea, 'local draft keeps the línea');
      eq(local[0].items[s.aPinza].lineaId, null, 'no línea on a good item');
      // Another session archives the línea while this device is offline (straight to the app,
      // the browser proxy is down).
      const lg = await srv.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } });
      eq(lg.statusCode, 200, 'second session login');
      const ver = (await srv.db.query('SELECT version FROM lineas WHERE id = $1', [s.linea])).rows[0].version;
      const ar = await srv.app.inject({ method: 'POST', url: `/api/lineas/${s.linea}/archive`, payload: { reason: 'Línea cerrada' }, headers: { cookie: [].concat(lg.headers['set-cookie'])[0].split(';')[0], 'x-csrf-token': lg.json().csrfToken, 'if-match': `"${ver}"` } });
      eq(ar.statusCode, 200, 'línea archived: ' + ar.body);
      srv.offline = false;
      await page.waitFor("window.__toasts.some((t)=>t.includes('Se envió el borrador guardado sin conexión'))", 25000, 'draft resent');
      assert((await page.toasts()).some((t) => t.includes('ya no está activa: se guardó sin línea')), 'línea dropped notice');
      const d = Object.values((await state(page)).controls).find((c) => c.techId === s.tech && c.status === 'borrador');
      assert(d, 'server draft');
      const it = d.items[s.aLlave];
      eq(JSON.stringify([it.good, it.change, it.missing, it.note, it.lineaId]), JSON.stringify([2, 1, 2, 'Se perdieron en la línea', null]), 'server keeps quantities and motivo, línea dropped');
      eq(d.items[s.aPinza].state, 'bueno', 'other item kept');
      eq(d.cleaning.status, 'limpio', 'server cleaning');
      eq((await idbDrafts(page)).length, 0, 'local copy removed after the successful save');
      assert(!(await page.text('#ckreview')), 'no review notice');
    }
  },
  {
    name: 'every route and the checklist at 1280 and 390 without overflow',
    async fn(page) {
      await loginAs(page);
      const s = await setup(page);
      for (const w of [1280, 390]) {
        await page.viewport(w);
        for (const r of ROUTES) {
          await page.hash('#' + r);
          const v = await page.eval('({ h: document.getElementById("view").innerHTML.length })');
          assert(v.h > 200, `#${r} rendered at ${w}`);
          await noOverflow(page, `#${r} at ${w}`);
        }
        await page.hash('#control-' + s.tech);
        await page.waitFor(`!!document.getElementById('it-${s.aLlave}')`, 10000, 'checklist');
        await page.click(`#it-${s.aLlave} [data-act="ckStep"][data-k="good"][data-d="1"]`);
        await page.click('#it-clean [data-act="ckClean"][data-s="requiere_limpieza"]');
        await noOverflow(page, `checklist at ${w}`);
        await page.screenshot(`t11-checklist-${w}`);
        await page.hash('#reportes');
        await noOverflow(page, `reportes at ${w}`);
      }
    }
  },
];
