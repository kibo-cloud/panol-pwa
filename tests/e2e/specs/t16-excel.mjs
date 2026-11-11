// T16 (stage 9): Administración › Importar Excel with a synthetic workbook (invented names and
// legajos, built with server/test/fixtures/excel.js): preview grouped by case type with totals,
// skip a case (recalculate before confirming), confirm, result, re-import refused, the imported
// data in Existencia, the "Importado del Excel" marks in controls and movements, permissions,
// and the screen at 390 px without page overflow (44 px decision buttons).
import fs from 'node:fs';
import path from 'node:path';
import { assert, eq, loginAs, logout, api, state } from '../app.mjs';
import { OUT, sleep } from '../harness.mjs';
import { buildWorkbook, sampleSpec } from '../../../server/test/fixtures/excel.js';

function workbookFile(name, spec = sampleSpec()) {
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, name);
  fs.writeFileSync(f, buildWorkbook(spec, { bookType: 'xlsm' }));
  return f;
}
async function noOverflow(page, label) {
  const v = await page.eval('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
  assert(v.sw <= v.iw + 1, `${label} overflows: ${v.sw} > ${v.iw}`);
}
async function openTab(page) {
  await page.hash('#admin');
  await page.act('adminTab', 'Importar Excel');
  await page.waitFor("!!document.getElementById('ximpick')", 10000, 'import tab');
}
async function choose(page, file) {
  await page.chooseFile(file, () => page.act('ximPick'));
  await page.waitFor("!!document.getElementById('ximreport')||!!document.getElementById('ximerr')", 20000, 'preview');
}
const groupCount = (page, type) => page.eval(`document.querySelectorAll('section.ximgrp[data-type="${type}"] .ximrow').length`);

export const tests = [
  {
    name: 'preview, skip a case, confirm, re-import refused, data and marks visible',
    timeout: 180000,
    async fn(page) {
      await loginAs(page, 'admin');
      const file = workbookFile('t16-herramientas.xlsm');
      await openTab(page);
      await choose(page, file);
      assert(await page.eval("!!document.getElementById('ximreport')"), 'report shown: ' + await page.text('#ximerr'));
      const report = await page.text('#ximreport');
      assert(report.includes('Todavía no se importó nada') && report.includes('Técnicos nuevos') && report.includes('Controles'), 'report head: ' + report);
      eq(await groupCount(page, 'tecnico_nuevo'), 3, 'tecnico_nuevo cases');
      eq(await groupCount(page, 'ajuste'), 1, 'ajuste cases');
      eq(await groupCount(page, 'semana_duplicada'), 1, 'semana_duplicada cases');
      eq(await groupCount(page, 'novedad_sin_tecnico'), 1, 'novedad sin técnico');
      // Nothing written by the preview.
      let st = await state(page);
      eq(Object.keys(st.techs).length, 0, 'no techs after the preview');
      // Skip a new tool (Martillo): the confirm button waits for a recalculated preview.
      const skip = '[data-act="ximCase"][data-id="herr:t2"][data-v="skip"]';
      assert(await page.eval(`!!document.querySelector('${skip}')`), 'Martillo has Omitir');
      await page.click(skip);
      assert(await page.eval("!!document.getElementById('ximdirty')"), 'dirty banner');
      assert(await page.eval("document.getElementById('ximconfirm').disabled"), 'confirm disabled until recalculated');
      await page.act('ximRecalc');
      await page.waitFor("!!document.getElementById('ximreport')&&!document.getElementById('ximdirty')", 20000, 'recalculated');
      assert(await page.eval(`document.querySelector('${skip}').getAttribute('aria-pressed')==='true'`), 'skip kept after recalculating');
      assert((await page.text('section.ximgrp[data-type="herramienta_nueva"] .chip')).includes('1 omitidos'), 'group shows the skipped case');
      await page.act('ximConfirm');
      await page.modalBtn('Importar');
      await page.waitFor("!!document.getElementById('ximresult')", 30000, 'result');
      assert((await page.text('#ximresult')).includes('Importación terminada'), 'result card');
      // Server data: techs without plantilla, Martillo not created, one batch.
      st = await state(page);
      const techs = Object.entries(st.techs).filter(([, t]) => ['9101', '9102', '9103'].includes(t.legajo));
      eq(techs.length, 3, 'three techs created');
      assert(techs.every(([, t]) => !t.plantillaId), 'imported techs without plantilla');
      assert(!Object.values(st.tools).some((t) => t.name === 'Martillo'), 'skipped tool not created');
      const batches = await api(page, 'GET', '/api/import/excel/batches');
      eq(batches.body.batches.length, 1, 'one batch');
      // Re-import of the same file is refused with a clear message.
      await page.act('ximReset');
      await choose(page, file);
      assert((await page.text('#ximerr')).includes('ya se importó'), 're-import refused: ' + await page.text('#ximerr'));
      eq((await api(page, 'GET', '/api/import/excel/batches')).body.batches.length, 1, 'still one batch');
      // Existencia shows the imported holdings (Ana: Alicate 1, Pinza 1 for recambio).
      const ana = techs.find(([, t]) => t.legajo === '9101')[0];
      await page.hash('#existencia');
      await page.waitFor("!!document.getElementById('exitbl')", 10000, 'matrix');
      const pinza = await page.eval(`(() => { const t = document.getElementById('exitbl'); const i = [...t.querySelectorAll('thead th')].findIndex((h) => h.dataset.h === ${JSON.stringify(ana)});
        const r = [...t.querySelectorAll('tbody tr')].find((x) => x.querySelector('th').textContent.includes('Pinza')); return i < 0 || !r ? null : r.children[i].textContent.trim(); })()`);
      assert(pinza && pinza.startsWith('1') && pinza.includes('C 1'), 'Pinza cell of Ana: ' + pinza);
      // Marks: control rows and detail, movement rows.
      await page.hash('#tecnico-' + ana);
      await page.click('.tabs button', 'Controles');
      assert((await page.text('#view')).includes('(importado del Excel)'), 'control rows marked');
      const ctl = Object.values(st.controls).find((c) => c.techId === ana && c.importBatchId);
      const ctlId = Object.entries(st.controls).find(([, c]) => c === ctl)[0];
      await page.hash('#controlver-' + ctlId);
      assert((await page.text('#ctlimp')).includes('Importado del Excel'), 'control detail banner');
      await page.hash('#entregas');
      assert((await page.count('#view .mvrow .ximark')) > 0, 'movement rows marked');
      await page.screenshot('t16-import');
    },
  },
  {
    name: 'permissions and the screen at 390 px',
    width: 390,
    height: 844,
    timeout: 150000,
    async fn(page) {
      await loginAs(page, 'responsable');
      await page.hash('#admin');
      assert(!(await page.eval("[...document.querySelectorAll('.tabs button')].some((b) => b.textContent.includes('Importar Excel'))")), 'responsable has no import tab');
      eq((await api(page, 'POST', '/api/import/excel/preview', { fileName: 'a.xlsx', file: 'UEs=' })).status, 403, 'responsable refused by the server');
      await logout(page);
      await loginAs(page, 'admin');
      const file = workbookFile('t16-mobile.xlsm');
      await openTab(page);
      await noOverflow(page, 'import tab at 390');
      await choose(page, file);
      await sleep(200);
      await noOverflow(page, 'preview at 390');
      const h = await page.eval("Math.min(...[...document.querySelectorAll('.ximseg button')].map((b) => b.getBoundingClientRect().height))");
      assert(h >= 44, 'decision buttons are 44 px targets: ' + h);
      await page.screenshot('t16-mobile');
      await page.act('ximReset');
      await page.waitFor("!!document.getElementById('ximpick')", 10000, 'back to the start');
      eq(Object.keys((await state(page)).techs).length, 0, 'cancel wrote nothing');
    },
  },
];
