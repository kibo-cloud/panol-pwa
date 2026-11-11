// T17 (stage 10): Imprimir para auditoría. Selection -> preview with all eight sections (from one
// server report), print media (scoped named pages, a page break before each holder, header and
// legend on every page, no app chrome), Ctrl+P on other screens, "Formato planilla", the Excel
// file, re-printing from the URL, costs hidden without purchases_view, Administración › Empresa
// (name and logo, refusal of non-images and oversized files) and the screen at 390 px.
import { assert, eq, loginAs, logout, api, state } from '../app.mjs';
import { sleep } from '../harness.mjs';

const idem = () => 'e2e-' + Math.random().toString(36).slice(2, 12);
const ok = (r, code, label) => { eq(r.status, code, `${label}: ${JSON.stringify(r.body)}`); return r.body; };
async function noOverflow(page, label) {
  const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
  assert(v.sw <= v.iw + 1, `${label} overflows: ${v.sw} > ${v.iw}`);
}
const previewReady = (page, label) => page.waitFor("!!document.getElementById('audprint')&&!document.getElementById('audmore')", 20000, label);
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// Puts a file into the logo input (DataTransfer) and fires its change event.
const pickLogo = (page, { b64 = null, text = null, size = 0, type, name }) => page.eval(`(() => {
  const bytes = ${b64 ? `Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0))` : text != null ? `new TextEncoder().encode(${JSON.stringify(text)})` : `new Uint8Array(${size})`};
  const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  const inp = document.getElementById('emp-logo'); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); return true;
})()`);

// Tech A with a llave x3 (control: 1 good, 1 recambio, 1 missing -> automatic purchase request),
// tech B with a pinza and no control, a caja with a llave; an adicional to B that is voided.
async function setup(page) {
  const a = ok(await api(page, 'POST', '/api/techs', { name: 'Ada Auditoría', legajo: 'AU-1', plantillaId: 'manana' }), 201, 'tech A').tech;
  const b = ok(await api(page, 'POST', '/api/techs', { name: 'Blas Auditoría', legajo: 'AU-2', plantillaId: 'tarde' }), 201, 'tech B').tech;
  const linea = ok(await api(page, 'POST', '/api/lineas', { name: 'Línea Auditoría', kind: 'linea' }), 201, 'linea').linea;
  const caja = ok(await api(page, 'POST', '/api/cajas', { name: 'Caja Auditoría', lineaId: linea.id }), 201, 'caja').caja;
  const llave = ok(await api(page, 'POST', '/api/tools', { name: 'Llave Auditoría', serialized: false, stock: 10 }), 201, 'llave').tool;
  const pinza = ok(await api(page, 'POST', '/api/tools', { name: 'Pinza Auditoría', serialized: false, stock: 10 }), 201, 'pinza').tool;
  const give = async (body, label) => ok(await api(page, 'POST', '/api/movements', { type: 'entrega_inicial', ...body }, { idem: idem() }), 201, label);
  await give({ techId: a.id, toolId: llave.id, qty: 3 }, 'llave A');
  await give({ techId: b.id, toolId: pinza.id, qty: 1 }, 'pinza B');
  await give({ cajaId: caja.id, toolId: llave.id, qty: 1 }, 'llave caja');
  const add = await give({ type: 'adicional', techId: b.id, toolId: pinza.id, qty: 1 }, 'adicional B');
  const mv = add.movement || (add.movements && add.movements[0]);
  ok(await api(page, 'POST', `/api/movements/${mv.id}/void`, { reason: 'Cargada por error' }, { idem: idem() }), 201, 'void');
  let st = await state(page);
  const asg = Object.entries(st.assignments).find(([, x]) => x.active && x.techId === a.id && x.toolId === llave.id)[0];
  const c = ok(await api(page, 'POST', '/api/controls', { techId: a.id, period: st.derived.cur }, { idem: idem() }), 201, 'control').control;
  ok(await api(page, 'POST', `/api/controls/${c.id}/finalize`, { items: { [asg]: { good: 1, change: 1, expected: 3, note: 'Una se perdió en la línea' } }, cleaning: { status: 'limpio' } }, { version: c.version, idem: idem() }), 200, 'finalize');
  st = await state(page);
  return { a, b, caja, llave, pinza, control: c.id };
}

async function preview(page) {
  await page.hash('#auditoria');
  await page.waitFor("!!document.getElementById('audsel')", 10000, 'selection card');
  await page.act('audPreview');
  await previewReady(page, 'preview');
}

export const tests = [
  {
    name: 'selection -> preview with all sections, print media with named pages, Ctrl+P elsewhere, planilla format, Excel, reprint from the URL',
    timeout: 180000,
    async fn(page) {
      await loginAs(page, 'admin');
      const s = await setup(page);
      // Entry points: Reportes and Más.
      await page.hash('#reportes');
      assert(await page.eval("!!document.querySelector('#rep-aud[href=\"#auditoria\"]')"), 'Reportes has Imprimir para auditoría');
      await page.hash('#mas');
      assert(await page.eval("!!document.querySelector('#view a[href=\"#auditoria\"]')"), 'Más has Imprimir para auditoría');
      await preview(page);
      assert(/^#auditoria-/.test(await page.eval('location.hash')), 'the selection is kept in the URL');
      const secs = await page.eval("[...document.querySelectorAll('#audprint .aud-sec')].map((x) => x.dataset.sec)");
      for (const k of ['resumen', 'poseedor', 'faltantes', 'movimientos', 'compras', 'novedades', 'plantillas', 'firmas']) assert(secs.includes(k), `section ${k}: ${secs.join(',')}`);
      const holders = await page.eval("[...document.querySelectorAll('#audprint .aud-holder .aud-h2')].map((h) => h.textContent)");
      assert(holders.some((h) => h.includes('Ada Auditoría')) && holders.some((h) => h.includes('Blas Auditoría')) && holders.some((h) => h.includes('Caja Auditoría')), 'holders: ' + holders.join(' | '));
      // Ada: the control column with the symbols (1 good, 1 recambio, 1 missing).
      const ada = await page.eval("[...document.querySelectorAll('#audprint .aud-holder')].find((x) => x.textContent.includes('Ada Auditoría')).querySelector('.aud-ctl tbody tr').textContent");
      assert(ada.includes('Llave Auditoría') && ada.includes('✓1 C1 F1'), 'Ada row: ' + ada);
      const falt = await page.text('[data-sec="faltantes"]');
      assert(falt.includes('Llave Auditoría') && falt.includes('Una se perdió en la línea') && falt.includes('Compra'), 'faltante with its resolution (a purchase request): ' + falt);
      const mov = await page.text('[data-sec="movimientos"]');
      assert(mov.includes('Anulado') && mov.includes('Anulación') && mov.includes('Anula: Entrega adicional'), 'voided adicional marked: ' + mov);
      const sum = await page.text('[data-sec="resumen"]');
      assert(sum.includes('Controles realizados') && sum.includes('Limpieza') && sum.includes('Reposiciones'), 'resumen: ' + sum);
      assert((await page.text('#audleg')).includes('✓ Bueno') && (await page.text('#audleg')).includes('F Faltante'), 'legend');
      assert((await page.text('[data-sec="firmas"]')).includes('Auditor'), 'signature block');
      // Print: window.print with the print root; in print media only the report remains.
      await page.eval('window.__printed = 0; window.print = () => { window.__printed++; }');
      await page.act('audPrint');
      eq(await page.eval('window.__printed'), 1, 'window.print called');
      assert(await page.eval("document.body.classList.contains('print-aud')"), 'print class on');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(150);
      const pv = await page.eval(`(() => { const cs = (el) => getComputedStyle(el);
        const hs = [...document.querySelectorAll('#audprint .aud-holder')];
        return { side: cs(document.getElementById('side')).display, bottom: cs(document.getElementById('bottom')).display, top: cs(document.getElementById('top')).display,
          sel: cs(document.getElementById('audsel')).display, acts: cs(document.querySelector('.ph')).display, page: cs(document.getElementById('view')).page,
          thead: [...document.querySelectorAll('#audprint .aud-pg > thead')].every((t) => cs(t).display === 'table-header-group'),
          tfoot: [...document.querySelectorAll('#audprint .aud-pg > tfoot')].every((t) => cs(t).display === 'table-footer-group'),
          breaks: hs.map((h) => cs(h).breakBefore), head: document.querySelector('.aud-holder .aud-pg > thead').textContent, foot: document.querySelector('.aud-holder .aud-pg > tfoot').textContent,
          cellColor: cs(document.querySelector('.aud-s.bad')).color }; })()`);
      eq([pv.side, pv.bottom, pv.top, pv.sel, pv.acts].join(','), 'none,none,none,none,none', 'app chrome and selection hidden when printing');
      eq(pv.page, 'audit', 'named page audit (portrait)');
      assert(pv.thead && pv.tfoot, 'header and legend repeated on each page');
      assert(pv.breaks.length >= 3 && pv.breaks.every((b) => b === 'page'), 'each holder starts a new page: ' + pv.breaks.join(','));
      assert(pv.head.includes("Villa D'agri") && pv.head.includes('Emitido') && pv.head.includes('Informe para auditoría'), 'page header: ' + pv.head);
      assert(pv.foot.includes('✓ Bueno') && pv.foot.includes('F Faltante'), 'legend at the foot: ' + pv.foot);
      eq(pv.cellColor, 'rgb(0, 0, 0)', 'symbols printed in black');
      const css = await page.eval("(async () => { const l = [...document.querySelectorAll('link[rel=stylesheet]')].map((x) => x.href); let t = ''; for (const h of l) t += await (await fetch(h)).text(); return t; })()");
      assert(/@page audit\{[^}]*portrait/.test(css.replace(/\s+/g, ' ').replace(/ ?\{ ?/g, '{')) && css.includes('counter(page)') && /@page exi\{[^}]*landscape/.test(css.replace(/\s+/g, ' ').replace(/ ?\{ ?/g, '{')), 'named pages with page numbers in the stylesheet');
      await page.screenshot('t17-print');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: '' });
      await page.eval("window.dispatchEvent(new Event('afterprint'))");
      assert(!(await page.eval("document.body.classList.contains('print-aud')")), 'print class removed after printing');
      // Ctrl+P (beforeprint without the button) on the preview, on Existencia and on another screen.
      const ctrlP = async () => { await page.eval("window.dispatchEvent(new Event('beforeprint'))"); return page.eval("['print-aud','print-exi','print-screen'].filter((c) => document.body.classList.contains(c)).join(',')"); };
      eq(await ctrlP(), 'print-aud', 'Ctrl+P on the preview prints the report');
      await page.eval("window.dispatchEvent(new Event('afterprint'))");
      await page.hash('#existencia');
      await page.waitFor("!!document.getElementById('exitbl')", 10000, 'existencia');
      eq(await ctrlP(), 'print-exi', 'Ctrl+P on Existencia prints the matrix');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      eq(await page.eval("getComputedStyle(document.getElementById('view')).page"), 'exi', 'named page exi (landscape)');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: '' });
      await page.eval("window.dispatchEvent(new Event('afterprint'))");
      await page.hash('#inicio');
      eq(await ctrlP(), 'print-screen', 'Ctrl+P elsewhere prints a clean screen');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      eq(await page.eval("[getComputedStyle(document.getElementById('side')).display, getComputedStyle(document.getElementById('bottom')).display, getComputedStyle(document.getElementById('top')).display].join(',')"), 'none,none,none', 'no app chrome on a plain screen');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: '' });
      await page.eval("window.dispatchEvent(new Event('afterprint'))");
      eq(await page.eval("document.body.className.includes('print-')"), false, 'classes removed');
      // Planilla format, then reprint the same report from its URL.
      await page.hash('#auditoria');
      await page.waitFor("!!document.getElementById('aud-planilla')", 10000, 'selection');
      await page.click('#aud-planilla');
      await sleep(100);
      await page.act('audPreview');
      await previewReady(page, 'planilla preview');
      const pl = await page.eval("(() => { const h = [...document.querySelectorAll('#audprint .aud-holder')].find((x) => x.textContent.includes('Ada Auditoría')); const t = h.querySelector('.aud-pl'); return t ? t.textContent : ''; })()");
      assert(pl.includes('ENTREGA') && pl.includes('DEVOL.') && pl.includes('CONTEO') && pl.includes('1,5'), 'planilla: 1 + 0,5 for the recambio: ' + pl);
      const url = await page.eval('location.hash');
      await page.hash('#inicio');
      await page.hash(url);
      await previewReady(page, 'reprint from the URL');
      assert(await page.eval("document.getElementById('aud-planilla').checked && !!document.querySelector('#audprint .aud-pl')"), 'same selection restored from the URL');
      // Excel: a real xlsx file.
      const n = await page.eval('window.__blobs.length');
      await page.act('audXlsx');
      await page.waitFor(`window.__blobs.length>${n}`, 20000, 'xlsx download');
      const x = await page.lastBlob(true);
      assert(x.head.startsWith('PK') && x.size > 4000, 'xlsx file: ' + JSON.stringify(x));
      // Let the browser finish the download (closing the tab mid-download stalls the target close).
      await sleep(6000);
      // Server: the same report in one request; too many months refused with a clear message.
      const R = ok(await api(page, 'GET', '/api/audit-report?months=' + new URLSearchParams(url.replace(/^#auditoria-/, '')).get('m')), 200, 'GET audit-report');
      assert(R.holders.some((h) => h.id === s.a.id && h.columns.some((c) => c.id === s.control)), 'server holder with the control');
      const big = await api(page, 'GET', '/api/audit-report?from=2020-01&to=2026-01');
      eq(big.status, 422, 'size guard');
      assert(/24 meses/.test(big.body.message), 'size guard message');
    },
  },
  {
    name: 'costs hidden without purchases_view; Empresa name and logo (refusals); 390 px without overflow',
    width: 390,
    height: 844,
    timeout: 180000,
    async fn(page) {
      await loginAs(page, 'admin');
      const s = await setup(page);
      // The automatic request of the faltante: cost set and approved (decided this month).
      const list = ok(await api(page, 'GET', '/api/compras'), 200, 'compras').compras;
      const req = list.find((p) => p.toolId === s.llave.id && p.reason === 'faltante');
      assert(req, 'automatic request exists');
      ok(await api(page, 'POST', `/api/compras/${req.id}/approve`, { estimatedCost: 2500 }, { version: req.version, idem: idem() }), 200, 'approve');
      // Empresa: name and logo.
      await page.hash('#admin');
      await page.click('[data-act="adminTab"][data-v="empresa"]');
      await page.waitFor("!!document.getElementById('emp-name')", 10000, 'empresa tab');
      await noOverflow(page, 'empresa tab at 390');
      await page.type('#emp-name', 'Planta Auditoría · Mantenimiento');
      await page.act('empSave');
      await page.waitFor("document.querySelector('[data-act=\"empSave\"]').disabled", 10000, 'name saved');
      await page.toasts();
      await pickLogo(page, { text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', type: 'image/svg+xml', name: 'logo.svg' });
      await sleep(300);
      assert((await page.toasts()).some((t) => t.includes('PNG o JPEG')), 'SVG refused in the browser');
      await pickLogo(page, { size: 600 * 1024, type: 'image/png', name: 'grande.png' });
      await sleep(300);
      assert((await page.toasts()).some((t) => t.includes('512 KB')), 'oversized refused');
      await pickLogo(page, { text: 'esto no es una imagen', type: 'image/png', name: 'falso.png' });
      await page.waitFor("window.__toasts.some((t) => t.includes('PNG o JPEG'))", 10000, 'server refused a fake PNG');
      await page.toasts();
      eq(await page.eval("document.getElementById('emp-img').tagName"), 'DIV', 'still no logo');
      await pickLogo(page, { b64: PNG_1X1, type: 'image/png', name: 'logo.png' });
      await page.waitFor("document.getElementById('emp-img').tagName==='IMG'&&document.getElementById('emp-img').complete&&document.getElementById('emp-img').naturalWidth===1", 10000, 'logo shown');
      const big = await api(page, 'PUT', '/api/settings/empresa/logo', { file: btoa('x'.repeat(600 * 1024)) }, { version: 99 });
      assert(big.status === 413 || big.status === 409, 'oversized upload refused by the server: ' + big.status);
      // Preview at 390 px: header with the name and the logo, no page overflow.
      await preview(page);
      await noOverflow(page, 'preview at 390');
      const hd = await page.eval("(() => { const h = document.querySelector('.aud-screenhd'); const i = h.querySelector('img.aud-logo'); return { t: h.textContent, img: !!i && i.complete && i.naturalWidth === 1 }; })()");
      assert(hd.t.includes('Planta Auditoría · Mantenimiento') && hd.img, 'header with name and logo: ' + JSON.stringify(hd));
      const adm = await page.text('[data-sec="compras"]');
      assert(adm.includes('Costo estimado') && adm.includes('2.500,00'), 'admin sees costs: ' + adm);
      await page.screenshot('t17-preview-390');
      // Responsable: may print, but without purchases_view the costs are not there.
      await logout(page);
      await loginAs(page, 'responsable');
      await preview(page);
      const resp = await page.text('[data-sec="compras"]');
      assert(resp.includes('Compra') && !resp.includes('Costo estimado') && !resp.includes('2.500') && resp.includes('solo a quien puede ver'), 'responsable without costs: ' + resp);
      const R = ok(await api(page, 'GET', '/api/audit-report?months=' + (await page.eval('(() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); })()'))), 200, 'responsable report');
      assert(R.purchases.every((p) => !('estimatedCost' in p)) && R.costsShown === false, 'API without costs');
      await noOverflow(page, 'responsable preview at 390');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      await page.eval("window.dispatchEvent(new Event('beforeprint'))");
      eq(await page.eval("getComputedStyle(document.getElementById('bottom')).display"), 'none', 'no bottom nav when printing on a phone');
      await page.cdp.send('Emulation.setEmulatedMedia', { media: '' });
      await page.eval("window.dispatchEvent(new Event('afterprint'))");
      // The Empresa settings are read-only for the responsable (403 on the API).
      const e = ok(await api(page, 'GET', '/api/settings/empresa'), 200, 'empresa');
      eq((await api(page, 'PUT', '/api/settings/empresa', { name: 'X' }, { version: e.version })).status, 403, 'responsable cannot change the name');
    },
  },
];
