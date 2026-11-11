// Etapa 9: Administración › Importar Excel (permiso import_excel). Se elige el .xlsm/.xlsx del
// Excel anterior, el servidor arma la vista previa sin escribir nada y la pantalla muestra los
// totales y cada supuesto agrupado por tipo; los que se pueden omitir tienen Importar / Omitir.
// Si se cambia alguna decisión hay que recalcular la vista previa (el servidor vuelve a armar el
// plan con esas decisiones y da otro token); Confirmar manda el mismo archivo, el token y las
// decisiones, y el servidor lo aplica todo en una transacción o pide volver a previsualizar.
// El archivo solo vive en memoria mientras la pestaña está abierta.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { UI, render } from '../../ui/registry.js';
import { ACT } from '../../ui/actions.js';
import { confirmBox } from '../../ui/modal.js';
import { toast, errMsg } from '../../ui/feedback.js';
import { kpi, emptyBox } from '../../ui/components.js';
import { api } from '../../api/index.js';
import { can, refresh } from '../../state/store.js';
import { fdt } from '../../state/period.js';
import { groupCases, decisionOf, setDecision, setGroupDecision, decisionsOf, sameDecisions, totalsRows, checkFile, toBase64 } from '../../state/excelimport.js';

const PAGE = 30;
const X = () => UI.xim || (UI.xim = { phase: 'idle', file: null, report: null, local: {}, sent: {}, shown: {}, error: '', result: null, batches: null, loadingBatches: false });
const busy = (x) => x.phase === 'loading' || x.phase === 'applying';
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function loadBatches(force) {
  const x = X();
  if (x.loadingBatches || (!force && x.batches)) return;
  x.loadingBatches = true;
  try { x.batches = (await api.excelBatches()).batches; } catch (e) { x.batches = []; toast(errMsg(e), 'err'); } finally { x.loadingBatches = false; render(); }
}

function batchesCard(x) {
  loadBatches();
  if (!x.batches) return '';
  if (!x.batches.length) return '';
  return `<section class="card ximcard"><h2 class="si">Importaciones anteriores</h2><div class="list">${x.batches.map((b) => `<div class="row"><span class="mi">${icon('db', 18)}</span><div class="grow"><div class="t ell">${esc(b.fileName)}</div><div class="s">${fdt(b.createdAt)}, ${esc(b.byName || '')} · ${esc((b.counts && b.counts.controls) || 0)} controles, ${esc((b.counts && b.counts.techsCreate) || 0)} técnicos nuevos</div></div></div>`).join('')}</div></section>`;
}

function idleCard(x) {
  return `<section class="card ximcard"><h2 class="si">Importar el Excel anterior</h2>
  <p class="muted sm ximp">Elegí el archivo de herramientas (.xlsm o .xlsx). Primero se muestra una vista previa con todo lo que se va a importar y cada supuesto (ajustes, faltantes, semanas repetidas, conflictos), sin escribir nada. Las macros del archivo nunca se ejecutan.</p>
  ${x.error ? `<div class="hint warn" id="ximerr">${icon('alert', 16)}<span>${esc(x.error)}</span></div>` : ''}
  <div class="toolbar"><button class="btn pri" id="ximpick" data-act="ximPick">${icon('upload', 16)}Elegir archivo</button></div></section>`;
}

function caseRow(c, local) {
  const d = decisionOf(c, local);
  const seg = c.skippable ? `<div class="ximseg" role="group" aria-label="Decisión"><button type="button" class="${d === 'accept' ? 'on' : ''}" aria-pressed="${d === 'accept'}" data-act="ximCase" data-id="${esc(c.id)}" data-v="accept">Importar</button><button type="button" class="${d === 'skip' ? 'on' : ''}" aria-pressed="${d === 'skip'}" data-act="ximCase" data-id="${esc(c.id)}" data-v="skip">Omitir</button></div>` : '';
  return `<div class="row ximrow ${d === 'skip' ? 'skipped' : ''}" data-case="${esc(c.id)}"><div class="grow"><div class="s">${esc(c.message)}</div></div>${seg}</div>`;
}

function groupHTML(g, x) {
  const shown = x.shown[g.type] || PAGE;
  const more = g.cases.length - shown;
  const bulk = g.skippable && g.cases.length > 1 ? `<div class="toolbar ximbulk"><button class="btn sm" data-act="ximGroup" data-t="${esc(g.type)}" data-v="accept">Importar todos</button><button class="btn sm" data-act="ximGroup" data-t="${esc(g.type)}" data-v="skip">Omitir todos</button></div>` : '';
  return `<section class="card ximgrp" data-type="${esc(g.type)}"><div class="srow"><h3 class="si ximh">${icon(g.icon, 16)}${esc(g.label)}</h3><span class="chip ${g.tone}">${g.cases.length}${g.skipped ? ` · ${g.skipped} omitidos` : ''}</span></div>${bulk}
  <div class="list">${g.cases.slice(0, shown).map((c) => caseRow(c, x.local)).join('')}</div>
  ${more > 0 ? `<div class="toolbar ximmore"><button class="btn sm" data-act="ximMore" data-t="${esc(g.type)}">Ver ${Math.min(more, PAGE)} más (quedan ${more})</button></div>` : ''}</section>`;
}

function reportView(x) {
  const r = x.report;
  const dirty = !sameDecisions(x.local, x.sent);
  const tot = totalsRows(r.totals);
  const reason = busy(x) ? 'Esperá a que termine.' : !r.canApply ? 'El archivo tiene errores.' : dirty ? 'Cambiaste decisiones: recalculá la vista previa antes de confirmar.' : '';
  const groups = groupCases(r.cases, x.local);
  return `<section class="card ximcard" id="ximreport"><div class="srow"><h2 class="si">Vista previa</h2><span class="chip">${icon('upload', 12)}${esc(x.file.name)} · ${kb(x.file.size)}</span></div>
  ${r.canApply ? `<div class="hint ok">${icon('ok', 16)}<span>Todavía no se importó nada. Revisá los casos y confirmá.</span></div>` : `<div class="hint warn">${icon('alert', 16)}<span>${esc(r.errors.map((e) => e.message).join(' '))}</span></div>`}
  ${x.error ? `<div class="hint warn" id="ximerr">${icon('alert', 16)}<span>${esc(x.error)}</span></div>` : ''}
  ${tot.length ? `<section class="kpis ximkpis">${tot.map(([l, n]) => kpi(n, esc(l))).join('')}</section>` : ''}
  ${r.staleDecisions && r.staleDecisions.length ? `<p class="muted xs">${r.staleDecisions.length} decisiones ya no corresponden a ningún caso y no se usan.</p>` : ''}</section>
  ${dirty ? `<div class="banner warn" id="ximdirty"><div><b>Cambiaste decisiones.</b><div class="sm">Recalculá la vista previa para ver cómo queda la importación.</div></div><div class="acts"><button class="btn sm pri" data-act="ximRecalc" ${busy(x) ? 'disabled' : ''}>Recalcular vista previa</button></div></div>` : ''}
  ${groups.length ? groups.map((g) => groupHTML(g, x)).join('') : `<div class="list">${emptyBox('Sin supuestos', 'El archivo no tiene casos para revisar.')}</div>`}
  <div class="ximbar"><span class="s grow">${esc(reason)}</span><button class="btn" data-act="ximReset" ${busy(x) ? 'disabled' : ''}>Cancelar</button><button class="btn pri" id="ximconfirm" data-act="ximConfirm" ${reason ? 'disabled' : ''}>Confirmar importación</button></div>`;
}

function resultView(x) {
  const r = x.result;
  return `<section class="card ximcard" id="ximresult"><h2 class="si">Importación terminada</h2><div class="hint ok">${icon('ok', 16)}<span>Se importó ${esc(x.file.name)}. Lo importado queda marcado "Importado del Excel" en los controles y movimientos.</span></div>
  <section class="kpis ximkpis">${totalsRows(r.totals).map(([l, n]) => kpi(n, esc(l))).join('')}</section>
  <div class="toolbar"><a class="btn pri" href="#existencia">Ver existencia por técnico</a><a class="btn" href="#tecnicos">Ver técnicos</a><button class="btn" data-act="ximReset">Importar otro archivo</button></div></section>`;
}

export function excelTab() {
  if (!can('import_excel')) return '<p class="hint">Tu perfil no puede importar el Excel anterior.</p>';
  const x = X();
  let body;
  if (x.phase === 'loading') body = `<section class="card ximcard"><div class="loading"><div class="spin"></div>Leyendo ${esc(x.file ? x.file.name : 'el archivo')}…</div></section>`;
  else if (x.phase === 'done' && x.result) body = resultView(x);
  else if (x.report && x.file) body = reportView(x);
  else body = idleCard(x);
  return `<div class="ximwrap">${body}${x.phase === 'idle' || x.phase === 'done' ? batchesCard(x) : ''}</div>`;
}

async function runPreview() {
  const x = X();
  if (!x.file) return;
  const decisions = decisionsOf(x.local);
  x.phase = 'loading'; x.error = ''; render();
  try {
    x.report = await api.excelPreview({ fileName: x.file.name, file: x.file.b64, decisions });
    // Las decisiones que ya no nombran un caso no se conservan.
    x.local = Object.fromEntries(Object.entries(decisions).filter(([id]) => !x.report.staleDecisions.includes(id)));
    x.sent = { ...x.local };
    x.phase = 'report';
  } catch (e) {
    x.phase = x.report ? 'report' : 'idle';
    if (!x.report) x.file = null;
    x.error = errMsg(e);
  }
  render();
}

ACT.ximPick = () => {
  if (!can('import_excel') || busy(X())) return;
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsm,.xlsx,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; inp.hidden = true; document.body.appendChild(inp);
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; inp.remove(); if (!f) return;
    const x = X();
    const bad = checkFile(f);
    if (bad) { x.error = bad; render(); toast(bad, 'err'); return; }
    try {
      const b64 = toBase64(new Uint8Array(await f.arrayBuffer()));
      Object.assign(x, { file: { name: f.name, size: f.size, b64 }, report: null, local: {}, sent: {}, shown: {}, result: null, error: '' });
    } catch { toast('No se pudo leer el archivo.', 'err'); return; }
    runPreview();
  };
  inp.click();
};
ACT.ximCase = (ds) => { const x = X(); if (!x.report || busy(x)) return; x.local = setDecision(x.local, x.report.cases, ds.id, ds.v); render(); };
ACT.ximGroup = (ds) => { const x = X(); if (!x.report || busy(x)) return; x.local = setGroupDecision(x.local, x.report.cases, ds.t, ds.v); render(); };
ACT.ximMore = (ds) => { const x = X(); x.shown[ds.t] = (x.shown[ds.t] || PAGE) + PAGE; render(); };
ACT.ximRecalc = () => runPreview();
ACT.ximReset = () => { UI.xim = null; X(); loadBatches(true); render(); };
ACT.ximConfirm = async () => {
  const x = X(); const r = x.report;
  if (!r || !x.file || busy(x) || !r.canApply || !sameDecisions(x.local, x.sent)) return;
  const t = r.totals;
  if (!await confirmBox('Confirmar importación', `Se importan ${esc(t.techsCreate + t.techsAttach)} técnicos, ${esc(t.controls)} controles y ${esc(t.entregas + t.ajustes + t.reposiciones)} entregas en una sola operación. Lo importado queda marcado y el mismo archivo no se puede volver a importar.`, 'Importar')) return;
  x.phase = 'applying'; x.error = ''; render();
  try {
    x.result = await api.excelConfirm({ fileName: x.file.name, file: x.file.b64, token: r.token, decisions: decisionsOf(x.sent) });
    x.phase = 'done'; x.batches = null;
    await refresh().catch(() => {});
    toast('Excel importado');
  } catch (e) {
    x.phase = 'report';
    x.error = errMsg(e);
    // El plan cambió: el servidor manda la vista previa nueva para revisarla y confirmar otra vez.
    if (e.body && e.body.report) { x.report = e.body.report; x.local = { ...x.sent }; }
    toast(x.error, 'err');
  }
  render();
};
