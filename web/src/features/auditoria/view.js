// Etapa 10: Imprimir para auditoría (PEDIDO §2.11). Primero la selección (meses en rango o
// sueltos, plantillas, técnicos y cajas, secciones y "Formato planilla"), guardada en la dirección
// (#auditoria-<selección>) para volver a imprimir el mismo informe; después la vista previa A4 que
// arma el servidor en una sola lectura. Cada técnico o caja empieza en una página nueva, con el
// encabezado de la empresa en cada página y las referencias al pie. Excel con el xlsx propio.
// Permiso: exportar informes (reports_export), como Reportes y Existencia.
import vendor from 'virtual:panol-vendor';
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, CH } from '../../ui/actions.js';
import { act, toast, errMsg } from '../../ui/feedback.js';
import { pageHead, field, optList, emptyBox } from '../../ui/components.js';
import { saveFile, loadScript } from '../../ui/files.js';
import { gateUI } from '../tecnicos/view.js';
import { api } from '../../api/index.js';
import { S, derive, can, markArchived } from '../../state/store.js';
import { beforePrint } from '../../ui/print.js';
import {
  SECTIONS, MAX_MONTHS, defaultSel, encodeSel, decodeSel, selQuery, selMonths, monthOptions, monthText, auditWorkbook, chunk, half, dmy, periodShort, cleaningText, RESOLUTION_TONE,
} from '../../state/auditoria.js';

const A = () => UI.aud || (UI.aud = { sel: null, key: null, R: null, err: '', loading: false, seq: 0 });
const curMonth = () => { const c = derive().cur; return { y: c.y, m: c.m }; };
const sel = () => { const a = A(); if (!a.sel) a.sel = defaultSel(curMonth()); return a.sel; };
const toggle = (arr, v, on) => (on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v));

// ------------------------------------------------------------------ carga del informe
async function load(key, s) {
  const a = A(); const seq = ++a.seq;
  a.key = key; a.R = null; a.err = ''; a.loading = true;
  try {
    const R = await api.auditReport(selQuery(s));
    if (seq !== a.seq) return;
    a.R = R;
  } catch (e) { if (seq === a.seq) a.err = errMsg(e); } finally { if (seq === a.seq) { a.loading = false; render(); } }
}

// ------------------------------------------------------------------ selección
function selCard(s, d) {
  const months = monthOptions(curMonth(), MAX_MONTHS);
  const n = selMonths(s).length;
  const seg = (k, l) => `<button class="${s.mode === k ? 'on' : ''}" data-act="audMode" data-v="${k}" aria-pressed="${s.mode === k}">${l}</button>`;
  const monthsUi = s.mode === 'range'
    ? `<div class="formgrid c2">${field('Desde', `<select id="aud-from" data-ch="audFrom">${optList(months.map((m) => [m.key, m.label]), s.from)}</select>`, 'aud-from')}${field('Hasta', `<select id="aud-to" data-ch="audTo">${optList(months.map((m) => [m.key, m.label]), s.to)}</select>`, 'aud-to')}</div>`
    : `<div class="aud-grid" role="group" aria-label="Meses">${months.map((m) => `<label class="check"><input type="checkbox" data-ch="audMonth" value="${esc(m.key)}" ${s.months.includes(m.key) ? 'checked' : ''}>${esc(m.label)}</label>`).join('')}</div>`;
  const pick = (what, label, items, cur, none) => {
    const mode = cur === 'all' ? 'all' : cur === 'none' ? 'none' : 'some';
    const b = (k, l) => `<button class="fchip ${mode === k ? 'on' : ''}" data-act="audPick" data-w="${what}" data-v="${k}" aria-pressed="${mode === k}">${l}</button>`;
    return `<fieldset class="aud-fs"><legend>${label}</legend><div class="fchips">${b('all', 'Todos')}${none ? b('none', 'Ninguno') : ''}${b('some', 'Elegir')}</div>${mode === 'some' ? (items.length ? `<div class="aud-grid aud-pick">${items.map(([id, l]) => `<label class="check"><input type="checkbox" data-ch="audItem" data-w="${what}" value="${esc(id)}" ${cur.includes(id) ? 'checked' : ''}>${esc(l)}</label>`).join('')}</div>` : '<p class="muted sm">No hay para elegir.</p>') : ''}</fieldset>`;
  };
  const techs = [...d.activeTechs, ...(d.allTechs || []).filter((t) => t.archived || t.active === false).filter((t) => !d.activeTechs.includes(t))];
  const cajas = Object.entries(S.cajas || {}).map(([id, k]) => [id, markArchived(k, k.name)]).sort((a, b) => a[1].localeCompare(b[1], 'es'));
  const pls = Object.entries(S.plantillas || {}).map(([id, p]) => [id, markArchived(p, p.name)]);
  const secs = `<fieldset class="aud-fs"><legend>Secciones</legend><div class="aud-grid">${SECTIONS.map(([k, l], i) => `<label class="check"><input type="checkbox" data-ch="audSec" value="${k}" ${s.sections.includes(k) ? 'checked' : ''}>${i + 1}. ${esc(l)}</label>`).join('')}</div></fieldset>`;
  const why = !n ? 'Elegí al menos un mes.' : n > MAX_MONTHS ? `Elegí hasta ${MAX_MONTHS} meses (ahora son ${n}).` : !s.sections.length ? 'Elegí al menos una sección.' : '';
  return `<section class="card aud-selc" id="audsel"><h2 class="si">Qué imprimir</h2>
  <fieldset class="aud-fs"><legend>Meses</legend><div class="seg aud-seg">${seg('range', 'Un rango')}${seg('list', 'Meses sueltos')}</div>${monthsUi}<p class="muted xs">${n} ${n === 1 ? 'mes' : 'meses'}: ${esc(selMonths(s).map(monthText).slice(0, 6).join(', '))}${n > 6 ? '…' : ''}</p></fieldset>
  ${pick('plantillas', 'Plantillas', pls, s.plantillas, false)}
  ${pick('techs', 'Técnicos', techs.map((t) => [t.id, markArchived(t, t.name) + (t.legajo ? ` (${t.legajo})` : '')]), s.techs, true)}
  ${pick('cajas', 'Cajas compartidas', cajas, s.cajas, true)}
  ${secs}
  <label class="check"><input type="checkbox" id="aud-planilla" data-ch="audPlanilla" ${s.planilla ? 'checked' : ''}>Formato planilla: como el Excel anterior (ENTREGA, DEVOLUCIÓN y CONTEO por fecha)</label>
  ${why ? `<p class="aud-why" id="aud-why">${esc(why)}</p>` : ''}
  <div class="toolbar aud-go"><button class="btn pri" data-act="audPreview" ${why ? 'disabled' : ''}>${icon('print', 18)}Ver vista previa</button></div></section>`;
}

// ------------------------------------------------------------------ vista previa
const TONE = { bueno: 'ok', cambio: 'warn', faltante: 'bad', sindato: 'pend' };
const holderSub = (h) => (h.kind === 'caja' ? `Caja compartida${h.linea ? ' · ' + h.linea : ''}` : `Legajo ${h.legajo || '—'} · ${h.especialidad || 'Sin especialidad'}${h.plantillas.length ? ' · ' + h.plantillas.join(', ') : ''}`);
const tbl = (cls, headRow, rows) => `<div class="aud-tw"><table class="aud-t ${cls}"><thead>${headRow}</thead><tbody>${rows}</tbody></table></div>`;
const none = (t = 'Sin datos en el período.') => `<p class="aud-none">${esc(t)}</p>`;

function headerHTML(R) {
  const h = R.header;
  return `<div class="aud-hd">${h.logo ? `<img class="aud-logo" src="${esc(h.logo.url)}" alt="Logo de ${esc(h.company)}">` : ''}<div class="aud-hc"><b>${esc(h.company)}</b><span>Informe para auditoría · ${esc(h.period)}</span><span class="aud-hf">${esc(h.filters)}</span></div><div class="aud-hm"><span>Emitido el ${esc(dmy(h.issuedDay))}</span><span>por ${esc(h.issuer)}</span></div></div>`;
}
const legendShort = () => '<div class="aud-ft">✓ Bueno · C Cambio · F Faltante · — Sin dato · Corr. = corrección · Imp. = importado del Excel</div>';
function page(R, key, title, body, extra = '') {
  return `<section class="aud-sec ${extra}" data-sec="${esc(key)}"><table class="aud-pg"><thead><tr><td>${headerHTML(R)}</td></tr></thead><tbody><tr><td><h2 class="aud-h2">${title}</h2>${body}</td></tr></tbody><tfoot><tr><td>${legendShort()}</td></tr></tfoot></table></section>`;
}

function resumenHTML(R) {
  const s = R.summary;
  const pct = (v) => (v == null ? '—' : v + ' %');
  const k = (v, l, t = '') => `<div class="aud-k ${t}"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
  const body = `<div class="aud-ks">${k(s.techs, 'Técnicos')}${k(s.cajas, 'Cajas compartidas')}${k(s.units, `Herramientas asignadas (${s.tools} tipos)`)}${k(`${s.done} de ${s.expected}`, `Controles realizados (${pct(s.pctDone)})`)}${k(pct(s.pctCond), 'En condiciones (último control)', 'ok')}${k(s.faltante, `Faltantes · ${s.sinResolver} sin resolver`, 'bad')}${k(s.cambio, 'Para recambio', 'warn')}${k(s.reposiciones, 'Reposiciones')}${k(pct(s.pctLimpio), `Limpieza: ${s.limpio} limpios, ${s.sucio} requieren, ${s.sinDatoLimpieza} sin dato`)}</div>
  <p class="aud-note">Solo controles finalizados vigentes. Esperados: por cada semana de control ya empezada del período (${R.periods}), los técnicos y cajas que en esa semana tenían al menos una herramienta asignada (nunca antes de su primera entrega ni después de su baja); los realizados se cuentan sobre esas mismas semanas. ${s.corrections} ${s.corrections === 1 ? 'corrección' : 'correcciones'}, ${s.imported} ${s.imported === 1 ? 'control importado' : 'controles importados'} del Excel.</p>
  ${tbl('aud-month', '<tr><th>Mes</th><th class="n">Controles</th><th class="n">Esperados</th><th class="n">% en condiciones</th><th class="n">Faltantes</th><th class="n">% limpio</th></tr>', s.perMonth.map((m) => `<tr><td>${esc(m.label)}</td><td class="n">${m.done}</td><td class="n">${m.expected}</td><td class="n">${pct(m.pctCond)}</td><td class="n">${m.faltantes}</td><td class="n">${pct(m.pctLimpio)}</td></tr>`).join(''))}`;
  return page(R, 'resumen', '1. Resumen', body);
}

function holderHTML(R, h, planilla) {
  let body = `<p class="aud-hsub">${esc(holderSub(h))} · Controles: ${h.done} de ${h.expected}${h.last && h.last.pct != null ? ` · En condiciones: ${h.last.pct} %` : ''}</p>`;
  if (planilla) {
    if (!h.planilla.blocks.length) body += none('Sin controles ni movimientos en el período.');
    const parts = chunk(h.planilla.blocks.map((b, i) => ({ b, i })), 4);
    parts.forEach((part, pi) => {
      const end = pi === parts.length - 1;
      const top = `<tr><th rowspan="2" class="n">N°</th><th rowspan="2">Herramienta</th>${part.map(({ b }) => `<th colspan="3" class="aud-bd">${b.controlId ? esc(dmy(b.day)) + (b.correction ? ' <span class="aud-tag">Corr.</span>' : '') + (b.imported ? ' <span class="aud-tag">Imp.</span>' : '') : 'Sin control'}</th>`).join('')}${end ? '<th rowspan="2" class="n">SALDO</th>' : ''}</tr>`;
      const sub = `<tr>${part.map(() => '<th class="n">ENTREGA</th><th class="n">DEVOL.</th><th class="n aud-cnt">CONTEO</th>').join('')}</tr>`;
      body += tbl('aud-pl', top + sub, h.planilla.rows.map((r) => `<tr><td class="n">${r.n ?? ''}</td><td>${esc(r.name)}</td>${part.map(({ i }) => { const c = r.cells[i]; return `<td class="n">${half(c.entrega)}</td><td class="n">${half(c.devolucion)}</td><td class="n aud-cnt">${half(c.conteo)}</td>`; }).join('')}${end ? `<td class="n">${half(r.saldo)}</td>` : ''}</tr>`).join(''));
    });
    body += '<p class="aud-note">CONTEO: 1 = buen estado, 0,5 = requiere recambio (también suma 0,5 en DEVOLUCIÓN en el primer control del recambio, como en el Excel), 0 = falta; vacío = sin dato. SALDO = último conteo − (entregas − devoluciones); ENTREGA y DEVOLUCIÓN cubren solo el período elegido.</p>';
  } else if (!h.columns.length) body += none('Sin controles vigentes en el período.');
  else {
    for (const part of chunk(h.columns, 8)) {
      const hr = `<tr><th class="n">N°</th><th>Herramienta</th>${part.map((c) => `<th class="aud-cc">${esc(periodShort(c.period))}<span>${esc(dmy(c.day))}</span>${c.correction ? '<span class="aud-tag">Corr.</span>' : ''}${c.imported ? '<span class="aud-tag">Imp.</span>' : ''}</th>`).join('')}</tr>`;
      body += tbl('aud-ctl', hr, h.rows.map((r) => `<tr><td class="n">${r.n ?? ''}</td><td>${esc(r.name)}${r.unitCode ? ` <span class="aud-code">${esc(r.unitCode)}</span>` : ''}</td>${part.map((c) => { const x = r.cells[c.id]; return `<td class="aud-s ${TONE[x.state]}">${esc(x.text)}</td>`; }).join('')}</tr>`).join(''));
    }
  }
  if (h.columns.length) {
    body += `<h3 class="aud-h3">Controles: quién, cuándo y limpieza</h3><ul class="aud-list">${h.columns.map((c) => `<li><b>${esc(periodShort(c.period))}</b> · ${esc(dmy(c.day))} · Controló ${esc(c.byName || '—')} · Limpieza: ${esc(cleaningText(c.cleaning))}${c.imported ? ' · Importado del Excel' : ''}${c.corrects.length ? ` · <b>Corrección</b> del control de ${c.corrects.map((o) => `${esc(o.byName)} (${esc(dmy(o.finishedAt ? o.finishedAt.slice(0, 10) : ''))})`).join(', ')}` : ''}</li>`).join('')}</ul>`;
    body += `<h3 class="aud-h3">Observaciones</h3>${h.notes.length ? `<ul class="aud-list">${h.notes.map((n) => `<li><b>${esc(periodShort(n.period))}</b> · ${esc(n.toolName)}${n.unitCode ? ' ' + esc(n.unitCode) : ''}: ${esc(n.note)}</li>`).join('')}</ul>` : none('Sin observaciones.')}`;
  }
  return page(R, 'poseedor', `2. ${esc(h.name)}`, body, 'aud-holder');
}

function faltantesHTML(R) {
  const body = R.faltantes.length ? tbl('', '<tr><th>Técnico o caja</th><th>Herramienta</th><th class="n">Faltan</th><th>Desde</th><th>Motivo</th><th>Resolución</th></tr>', R.faltantes.map((f) => `<tr><td>${esc(f.holderName)}</td><td>${esc(f.toolName)}${f.unitCode ? ' ' + esc(f.unitCode) : ''}</td><td class="n">${f.missing} de ${f.expected}</td><td>${esc(dmy(f.firstDay))}${f.imported ? ' <span class="aud-tag">Imp.</span>' : ''}</td><td>${esc(f.note)}</td><td><span class="chip ${RESOLUTION_TONE[f.resolution.kind] || 'pend'}">${esc(f.resolution.label)}</span>${f.resolution.day ? ' ' + esc(dmy(f.resolution.day)) : ''}${f.purchase && f.resolution.kind !== 'compra' ? `<span class="aud-sub">${esc(f.purchase.name)} (${esc(f.purchase.statusLabel)})</span>` : ''}</td></tr>`).join('')) : none('Sin faltantes en el período.');
  return page(R, 'faltantes', '3. Faltantes y su resolución', body);
}

function movimientosHTML(R) {
  const t = R.movementTotals;
  const tot = `<p class="aud-note">Entregas iniciales: ${t.entrega_inicial.count} · Adicionales: ${t.adicional.count} · Reposiciones: ${t.reposicion.count} · Devoluciones: ${t.devolucion.count} · Retiros: ${t.retiro.count} · Anuladas: ${t.anuladas}</p>`;
  const body = tot + (R.movements.length ? tbl('', '<tr><th>Fecha</th><th>Tipo</th><th>Técnico o caja</th><th>Herramienta</th><th class="n">Cant.</th><th>Motivo</th><th>Registró</th></tr>', R.movements.map((m) => `<tr class="${m.voided ? 'aud-void' : ''}"><td>${esc(dmy(m.day))}</td><td>${esc(m.typeLabel)}${m.voided ? ' <span class="aud-tag">Anulado</span>' : ''}${m.voids ? `<span class="aud-sub">Anula: ${esc(m.voids.typeLabel)}</span>` : ''}${m.imported ? ' <span class="aud-tag">Imp.</span>' : ''}</td><td>${esc(m.holderName)}</td><td>${esc(m.toolName)}${m.unitCode ? ' ' + esc(m.unitCode) : ''}</td><td class="n">${m.qty}</td><td>${esc(m.reason || m.notes)}</td><td>${esc(m.byName)}</td></tr>`).join('')) : none());
  return page(R, 'movimientos', '4. Entregas, reposiciones, devoluciones y retiros', body);
}

function comprasHTML(R) {
  const c = R.costsShown; const T = R.purchaseTotals;
  const money = (v) => (v == null ? 'Sin costo' : `$ ${Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const tot = `<p class="aud-note">Aprobadas: ${T.aprobadas} · Rechazadas: ${T.rechazadas}${c ? ` · Costo estimado conocido: ${money(T.costoConocido)}${T.sinCosto ? ` (${T.sinCosto} sin costo)` : ''}` : ' · Los costos se muestran solo a quien puede ver el apartado de Gerencia.'}</p>`;
  const body = tot + (R.purchases.length ? tbl('', `<tr><th>Solicitud</th><th>Decisión</th><th>Herramienta</th><th>Técnico o caja</th><th class="n">Cant.</th><th>Comentario o motivo del rechazo</th>${c ? '<th class="n">Costo estimado</th>' : ''}</tr>`, R.purchases.map((p) => `<tr><td>${esc(p.name)}<span class="aud-sub">${p.reason === 'faltante' ? 'Extraviada' : 'Dañada'}</span></td><td><span class="chip ${p.status === 'rechazada' ? 'bad' : 'ok'}">${esc(p.statusLabel)}</span> ${esc(dmy(p.decidedDay))}<span class="aud-sub">${esc(p.decidedByName || '')}</span></td><td>${esc(p.toolName)}${p.unitCode ? ' ' + esc(p.unitCode) : ''}</td><td>${esc(p.holderName)}</td><td class="n">${p.qty}</td><td>${esc(p.decisionComment || '')}</td>${c ? `<td class="n">${esc(money(p.estimatedCost))}${p.supplier ? `<span class="aud-sub">${esc(p.supplier)}</span>` : ''}</td>` : ''}</tr>`).join('')) : none());
  return page(R, 'compras', '5. Compras aprobadas y rechazadas', body);
}

function novedadesHTML(R) {
  const body = R.novedades == null ? none('Tu perfil no puede ver las novedades.') : R.novedades.length ? tbl('', '<tr><th>Fecha</th><th>Autor</th><th>Sobre</th><th>Comentario</th></tr>', R.novedades.map((n) => `<tr><td>${esc(dmy(n.day))}${n.imported ? ' <span class="aud-tag">Imp.</span>' : ''}</td><td>${esc(n.authorName)}</td><td>${esc([n.techName, n.plantillaName, n.lineaName].filter(Boolean).join(' · ') || '—')}</td><td class="aud-wrap">${esc(n.comment)}</td></tr>`).join('')) : none();
  return page(R, 'novedades', '6. Novedades', body);
}

function plantillasHTML(R) {
  const P = R.plantillas;
  const rows = [
    ...P.moves.map((m) => [m.day, 'Cambio de plantilla', m.techName, `${m.fromName} → ${m.toName}`, m.note, m.byName]),
    ...P.supervisors.map((x) => [x.day, 'Cambio de supervisor', x.plantillaName, `${x.fromName} → ${x.toName}`, '', x.byName]),
    ...P.rotations.map((x) => [x.day, 'Rotación de turno', x.plantillaName, `${x.fromLabel || '—'} → ${x.label}`, '', x.byName]),
  ].sort((a, b) => a[0].localeCompare(b[0]));
  const body = rows.length ? tbl('', '<tr><th>Fecha</th><th>Cambio</th><th>Quién o qué</th><th>Antes → después</th><th>Motivo</th><th>Registró</th></tr>', rows.map((r) => `<tr><td>${esc(dmy(r[0]))}</td>${r.slice(1).map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')) : none('Sin cambios de plantilla en el período.');
  return page(R, 'plantillas', '7. Cambios de plantilla', body);
}

function firmasHTML(R) {
  const box = (t) => `<div class="aud-sign"><b>${t}</b><span>Nombre y apellido</span><span>Firma</span><span>Fecha</span></div>`;
  return page(R, 'firmas', '8. Firmas', `<p class="aud-note">Este informe resume los controles de herramientas y su limpieza del período indicado.</p><div class="aud-signs">${box('Responsable del pañol')}${box('Auditor')}</div>`);
}

const FIRST = 6; const STEP = 6;
function previewHTML(R, planilla) {
  const has = (k) => R.sections.includes(k);
  const holders = has('poseedores') ? R.holders : [];
  const before = (has('resumen') ? resumenHTML(R) : '') + holders.slice(0, FIRST).map((h) => holderHTML(R, h, planilla)).join('');
  const more = holders.length > FIRST ? `<div id="audmore" class="aud-more" data-n="${FIRST}">Preparando ${holders.length - FIRST} páginas más…</div>` : '';
  const after = (has('faltantes') ? faltantesHTML(R) : '') + (has('movimientos') ? movimientosHTML(R) : '') + (has('compras') ? comprasHTML(R) : '') + (has('novedades') ? novedadesHTML(R) : '') + (has('plantillas') ? plantillasHTML(R) : '') + (has('firmas') ? firmasHTML(R) : '');
  const legend = `<div class="aud-leg" id="audleg"><b>Referencias</b><ul>${R.legend.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  return `<div id="audprint" class="aud-root" data-holders="${holders.length}">${headerHTML(R).replace('class="aud-hd"', 'class="aud-hd aud-screenhd"')}${before}${more}${after}${legend}</div>`;
}

// Dibujo progresivo: después de las primeras páginas, el resto de a STEP (sin trabar la pantalla).
function appendMore(all) {
  const el = document.getElementById('audmore'); const a = A();
  if (!el || !a.R) return false;
  const holders = a.R.holders; const n = Number(el.dataset.n);
  const upto = all ? holders.length : Math.min(holders.length, n + STEP);
  el.insertAdjacentHTML('beforebegin', holders.slice(n, upto).map((h) => holderHTML(a.R, h, a.sel && a.sel.planilla)).join(''));
  if (upto >= holders.length) { el.remove(); return false; }
  el.dataset.n = String(upto); el.textContent = `Preparando ${holders.length - upto} páginas más…`;
  return true;
}
function scheduleMore() { const a = A(); const seq = a.seq; setTimeout(() => { if (seq === A().seq && appendMore(false)) scheduleMore(); }, 0); }
const flushAll = () => { while (appendMore(true)); };
beforePrint.push(flushAll);

VIEWS.auditoria = (id) => {
  const d = derive(); const a = A();
  if (!can('reports_export')) return pageHead('Imprimir para auditoría', '', { back: '#reportes' }) + `<div class="list">${emptyBox('Tu perfil no puede imprimir informes', 'Pedile el permiso de exportar informes a un administrador.')}</div>`;
  const fromHash = id ? decodeSel(id) : null;
  if (fromHash && a.key !== id) { a.sel = fromHash; load(id, fromHash); }
  if (!id && a.key) { a.key = null; a.R = null; a.err = ''; a.seq++; }
  const s = sel();
  const acts = a.R ? `<button class="btn" data-act="audXlsx">${icon('dl', 18)}Excel</button><button class="btn pri" data-act="audPrint">${icon('print', 18)}Imprimir</button>` : '';
  let prev = '';
  if (id && !fromHash) prev = '<p class="hint warn" id="auderr">La dirección no tiene una selección válida. Elegí qué imprimir.</p>';
  else if (a.loading) prev = '<div class="loading" id="audload"><div class="spin"></div>Armando el informe…</div>';
  else if (a.err) prev = `<p class="hint warn" id="auderr">${esc(a.err)}</p>`;
  else if (a.R) prev = previewHTML(a.R, s.planilla);
  if (a.R && document.getElementById) setTimeout(scheduleMore, 0);
  return pageHead('Imprimir para auditoría', a.R ? esc(a.R.header.period) : 'Elegí los meses, a quiénes y qué secciones', { back: '#reportes', acts }) + selCard(s, d) + prev;
};

// ------------------------------------------------------------------ acciones
ACT.audMode = (ds) => { const s = sel(); s.mode = ds.v; if (ds.v === 'list' && !s.months.length) s.months = selMonths({ ...s, mode: 'range' }); render(); };
CH.audFrom = (v) => { sel().from = v; render(); };
CH.audTo = (v) => { sel().to = v; render(); };
CH.audMonth = (v, el) => { const s = sel(); s.months = toggle(s.months, v, el.checked); render(); };
ACT.audPick = (ds) => { const s = sel(); s[ds.w] = ds.v === 'some' ? (Array.isArray(s[ds.w]) ? s[ds.w] : []) : ds.v; render(); };
CH.audItem = (v, el) => { const s = sel(); const w = el.dataset.w; s[w] = toggle(Array.isArray(s[w]) ? s[w] : [], v, el.checked); render(); };
CH.audSec = (v, el) => { const s = sel(); s.sections = SECTIONS.map(([k]) => k).filter((k) => (k === v ? el.checked : s.sections.includes(k))); render(); };
CH.audPlanilla = (v, el) => { sel().planilla = el.checked; render(); };
ACT.audPreview = () => {
  if (!gateUI('reports_export')) return;
  const s = sel(); const n = selMonths(s).length;
  if (!n || n > MAX_MONTHS || !s.sections.length) { toast(n > MAX_MONTHS ? `Elegí hasta ${MAX_MONTHS} meses.` : 'Completá la selección.', 'err'); return; }
  const h = '#auditoria-' + encodeSel(s);
  if (location.hash === h) { A().key = null; render(); } else location.hash = h;
};
ACT.audPrint = () => {
  if (!gateUI('reports_export') || !A().R) return;
  flushAll();
  document.body.classList.add('print-aud');
  window.print();
};
ACT.audXlsx = async () => {
  if (!gateUI('reports_export')) return;
  const R = A().R; if (!R) return;
  await act(async () => {
    await loadScript(vendor.xlsx, () => window.XLSX); const XLSX = window.XLSX; const wb = XLSX.utils.book_new();
    for (const sh of auditWorkbook(R)) { const ws = XLSX.utils.aoa_to_sheet(sh.rows); if (sh.cols) ws['!cols'] = sh.cols; XLSX.utils.book_append_sheet(wb, ws, sh.name); }
    const m = R.selection.months;
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }); await saveFile(`auditoria-${m[0]}${m.length > 1 ? '-a-' + m[m.length - 1] : ''}.xlsx`, new Blob([buf]));
  });
};
