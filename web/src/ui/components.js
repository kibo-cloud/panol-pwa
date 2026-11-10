// Componentes compartidos de 2.1 (chips, avatar, KPI, gráficos, filas de movimientos y
// alertas). Todo dato de usuario pasa por `esc`; los estilos en línea van como `data-css`.
import { esc } from './dom.js';
import { icon } from './icons.js';
import { ST, MSHORT } from '../state/constants.js';
import { CLEAN, qtyText } from '../state/conteo.js';
import { S, derive, can, who, toolName, holderName } from '../state/store.js';
import { holderKey } from '../state/plantillas.js';
import { linkableMv } from '../state/novedades.js';
import { fdt, mlabel, pkeyOf, wrange, pnumOf, plabel } from '../state/period.js';

export const nf = (n) => Number(n || 0).toLocaleString('es-AR');
const ST_IC = { bueno: 'ok', cambio: 'wrench', faltante: 'x', pendiente: 'clock' };
export const stChip = (s) => `<span class="chip ${ST[s] ? ST[s].cls : 'pend'}">${icon(ST_IC[s] || 'clock', 12)}${ST[s] ? ST[s].label : esc(s)}</span>`;
// Cantidades del último control de una asignación con más de 1 unidad (si no cambió la cantidad).
export const qtyLine = (s, a) => { const t = s && s.expected === ((a && a.qty) || 1) ? qtyText(s) : ''; return t ? `<div class="s qline">${esc(t)}</div>` : ''; };
// Limpieza del último control efectivo de un poseedor (ficha del técnico o de la caja).
export function cleanSummary(hk) {
  const l = derive().effByTech[hk] || []; const last = l[l.length - 1]; if (!last) return '';
  return `<div class="card ctlclean" data-css="margin-bottom:12px"><div class="srow"><h2 class="si">Limpieza de herramientas y caja</h2>${cleanChip(last.cleaning)}</div><p class="muted xs" data-css="margin:6px 0 0">Último control: ${esc(plabel(last.period))}${last.cleaning && last.cleaning.status === 'requiere_limpieza' && last.cleaning.note ? '. ' + esc(last.cleaning.note) : ''}</p></div>`;
}
// Limpieza de un control (etapa 4): Limpio, Requiere limpieza o Sin dato (controles viejos).
export const cleanChip = (cl) => { const c = cl && CLEAN[cl.status]; return c ? `<span class="chip ${c.cls}">${icon(cl.status === 'limpio' ? 'ok' : 'clean', 12)}${c.label}</span>` : `<span class="chip pend">${icon('clock', 12)}Sin dato de limpieza</span>`; };
export const demoChip = (o) => (o && o.demo ? '<span class="chip demo">Demo</span>' : '');
export function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?'; }
const LIGHT_LABEL = { ok: 'Todo en buen estado', warn: 'Tiene herramientas para cambio', bad: 'Tiene faltantes', pend: 'Sin controlar' };
export function avatar(name, light, lg) { return `<span class="av ${lg ? 'lg' : ''}">${esc(initials(name))}${light ? `<span class="sem ${light}" role="img" aria-label="${LIGHT_LABEL[light]}"></span>` : ''}</span>`; }
export const SHIFT_IC = (i) => ['sun', 'sunset', 'moon'][i] || 'clock';
// Texto del turno actual de una plantilla (los migrados de 2.1 ya dicen "Turno ...").
export const turnoText = (l) => (!l ? 'Sin turno' : /^turno /i.test(l) ? l : 'Turno ' + l);
// Ícono de una plantilla según su turno actual (dato informativo).
export const plIcon = (p) => { const l = String((p && p.currentShiftLabel) || '').toLowerCase(); return /mañana|manana|día|dia/.test(l) ? 'sun' : /tarde/.test(l) ? 'sunset' : /noche/.test(l) ? 'moon' : 'users'; };
export function sbar(s) { const t = s.bueno + s.cambio + s.faltante + s.pendiente; if (!t) return '<div class="sbar" aria-hidden="true"></div>'; return `<div class="sbar" role="img" aria-label="${s.bueno} en buen estado, ${s.cambio} para cambio, ${s.faltante} faltantes, ${s.pendiente} sin controlar">${['bueno', 'cambio', 'faltante', 'pendiente'].filter((k) => s[k]).map((k) => `<span class="${ST[k].cls}" data-css="flex:${s[k]}"></span>`).join('')}</div>`; }
export function cnts(s) { if (!s.total) return '<span class="s">Sin herramientas asignadas</span>'; return `<span class="legend-dots"><span class="ld"><b data-css="color:var(--ok-ink)">${s.bueno}</b>ok</span><span class="ld"><b data-css="color:var(--warn-ink)">${s.cambio}</b>cam.</span><span class="ld"><b data-css="color:var(--bad-ink)">${s.faltante}</b>falt.</span>${s.pendiente ? `<span class="ld"><b>${s.pendiente}</b>sin ctrl.</span>` : ''}</span>`; }
const CTL_ST = { done: ['ok', 'Controlado', 'ok'], draft: ['warn', 'Incompleto', 'pencil'], pend: ['pend', 'Pendiente', 'clock'], fut: ['pend', 'Próximo', 'cal'] };
export const ctlBadge = (st) => `<span class="chip ${CTL_ST[st][0]}">${icon(CTL_ST[st][2], 12)}${CTL_ST[st][1]}</span>`;
export function kpi(n, l, href, cls = '', h = '') { const tg = href ? 'a' : 'div'; const dot = ['ok', 'warn', 'bad', 'pend'].includes(cls); return `<${tg} class="kpi ${cls}" ${href ? `href="${esc(href)}"` : ''}><span class="l">${dot ? '<i class="kd"></i>' : ''}${l}</span><span class="n">${typeof n === 'number' ? nf(n) : n}</span>${h ? `<span class="h">${h}</span>` : ''}</${tg}>`; }
export function pageHead(title, sub, { back, acts } = {}) { return `${back ? `<a class="backl" href="${esc(back)}">${icon('back', 16)}Volver</a>` : ''}<div class="ph"><div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${acts ? `<div class="acts">${acts}</div>` : ''}</div>`; }
const chartScale = (series) => { const max = Math.max(1, ...series.flatMap((s) => s.values)); const step = max > 20 ? 10 : max > 8 ? 5 : max > 4 ? 2 : 1; return { step, top: Math.ceil(max / step) * step }; };
const legend = (series) => `<div class="legend">${series.map((s) => `<span><i data-css="background:${esc(s.color)}"></i>${esc(s.name)}</span>`).join('')}</div>`;
export function barChart(labels, series) {
  const W = 620, H = 220, pl = 30, pr = 10, pt = 12, pb = 28; const { step, top } = chartScale(series);
  const n = labels.length, gw = (W - pl - pr) / n, bw = Math.min(22, (gw - 16) / series.length); const y = (v) => pt + (H - pt - pb) * (1 - v / top); let g = '';
  for (let v = 0; v <= top; v += step) g += `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  labels.forEach((l, i) => { const cx = pl + gw * i + gw / 2; g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`; const totalW = bw * series.length + 4 * (series.length - 1); series.forEach((s, j) => { const v = s.values[i]; const x = cx - totalW / 2 + j * (bw + 4); g += `<rect x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(0, y(0) - y(v))}" rx="3" data-css="fill:${esc(s.color)}"><title>${esc(s.name)}, ${esc(l)}: ${v}</title></rect>`; }); });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name + ': ' + s.values.join(', ')).join('. '))}">${g}</svg>${legend(series)}</div>`;
}
export function lineChart(labels, series) {
  const W = 620, H = 220, pl = 34, pr = 26, pt = 14, pb = 30; const { step, top } = chartScale(series);
  const x = (i) => pl + (labels.length < 2 ? (W - pl - pr) / 2 : i * (W - pl - pr) / (labels.length - 1)); const y = (v) => pt + (H - pt - pb) * (1 - v / top);
  let g = ''; for (let v = 0; v <= top; v += step) g += `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  labels.forEach((l, i) => { g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`; });
  for (const s of series) { g += `<polyline fill="none" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" data-css="stroke:${esc(s.color)}" points="${s.values.map((v, i) => x(i) + ',' + y(v)).join(' ')}"/>`; g += s.values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" data-css="fill:${esc(s.color)}"><title>${esc(s.name)}: ${v}</title></circle>`).join(''); }
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name + ': ' + s.values.join(', ')).join('. '))}">${g}</svg>${legend(series)}</div>`;
}
export const field = (label, inner, id = '') => `<div class="field">${label ? `<label ${id ? `for="${esc(id)}"` : ''}>${label}</label>` : ''}${inner}</div>`;
export const emptyBox = (t, s = '', a = '') => `<div class="empty"><b>${t}</b>${s}${a ? `<div data-css="margin-top:12px">${a}</div>` : ''}</div>`;
export function optList(items, sel, ph) { return (ph ? `<option value="">${esc(ph)}</option>` : '') + items.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`).join(''); }
// Técnicos activos agrupados por plantilla; con cajas = true agrega las cajas compartidas
// (valor `caja:<id>`).
export function techOptions(sel, ph = 'Elegí un técnico', cajas = false) { const d = derive(); return `<option value="">${esc(ph)}</option>` + (cajas && d.activeCajas.length ? `<optgroup label="Cajas compartidas">${d.activeCajas.map((k) => `<option value="caja:${esc(k.id)}" ${'caja:' + k.id === sel ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</optgroup>` : '') + d.shifts.map((s) => { const ts = d.activeTechs.filter((t) => t.shiftId === s.id); return ts.length ? `<optgroup label="${esc(s.name)}">${ts.map((t) => `<option value="${esc(t.id)}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)} (${esc(t.legajo)})</option>`).join('')}</optgroup>` : ''; }).join(''); }
const MV_TAG = { entrega_inicial: ['Entrega', ''], adicional: ['Adicional', ''], reposicion: ['Reposición', 'warn'], devolucion: ['Devolución', 'ok'], retiro: ['Retiro', 'pend'], ingreso: ['Ingreso', 'ok'], reparado: ['Reparación', 'ok'], baja: ['Baja', 'bad'], recupero: ['Recupero', 'ok'], recepcion: ['Recepción', 'ok'], anulacion: ['Anulación', 'void'] };
// Etapa 5: un movimiento anulado se conserva con la marca "Anulado" (y su anulación, "Anulación");
// "Anular" aparece si el perfil puede anular (el servidor revisa si es posible y explica por qué no).
export function mvRow(m, { plain = false } = {}) {
  const tn = toolName(m.toolId); const tg = MV_TAG[m.type] || [m.type, ''];
  const uc = (id) => (id && S.units[id] ? S.units[id].code : '');
  const title = m.type === 'reposicion' && (m.oldUnitId || m.newUnitId) ? `${tn} ${uc(m.oldUnitId) || ''} → ${uc(m.newUnitId) || 'nueva'}` : `${tn}${uc(m.unitId) ? ' ' + uc(m.unitId) : ''}${m.qty > 1 ? ` ×${m.qty}` : ''}`;
  const meta = [holderName(m), fdt(m.at), who(m.by)].filter(Boolean).join(' · ');
  const voidedBy = m.id ? derive().voidedBy[m.id] : null;
  const orig = m.voidsMovementId ? S.movements[m.voidsMovementId] : null;
  const voidOf = m.type === 'anulacion' ? `<div class="s">${orig ? `Anula: ${esc((MV_TAG[orig.type] || [orig.type])[0])} del ${fdt(orig.at)}` : 'Anula un movimiento'}</div>` : '';
  const mark = voidedBy ? `<span class="chip bad">${icon('x', 12)}Anulado</span>` : '';
  const voidBtn = !plain && m.id && m.type !== 'anulacion' && !voidedBy && can('movements_void') ? `<button class="btn sm" data-act="mvVoid" data-m="${esc(m.id)}">Anular</button>` : '';
  // Etapa 6: una entrega o reposición (no anulada) abre Nueva novedad con el vínculo y el técnico.
  const novBtn = !plain && m.id && linkableMv(m, voidedBy) && can('novedades_create') ? `<button class="btn sm" data-act="novNew" data-mv="${esc(m.id)}" data-tech="${esc(m.techId || '')}">Agregar novedad</button>` : '';
  return `<div class="row mvrow ${voidedBy ? 'voided' : ''}" data-mv="${esc(m.id || '')}"><span class="tag ${tg[1]}">${esc(tg[0])}</span><div class="grow"><div class="t">${esc(title)}</div><div class="s">${esc(meta)}</div>${voidOf}${m.reason || m.notes ? `<div class="s">${m.type === 'anulacion' ? 'Motivo: ' : ''}${esc([m.reason, m.notes].filter(Boolean).join('. '))}</div>` : ''}</div>${mark || voidBtn || novBtn || demoChip(m) ? `<span class="mvacts">${mark}${demoChip(m)}${novBtn}${voidBtn}</span>` : ''}</div>`;
}
export const mvList = (l) => (l.length ? `<div class="list">${l.map(mvRow).join('')}</div>` : `<div class="list">${emptyBox('Sin movimientos registrados', 'Las entregas, devoluciones y reposiciones aparecen acá.')}</div>`);
const AL_IC = { faltante: 'x', cambio: 'wrench', consecutiva: 'alert', devolucion: 'swap', pendiente: 'clock', limpieza: 'clean' };
function alertAction(a) {
  if (a.type === 'limpieza' && a.controlId) return `<a class="btn sm" href="#controlver-${esc(a.controlId)}">Ver control</a>`;
  if (a.type === 'pendiente' && can('controls_do')) return `<a class="btn sm" href="${esc(a.href)}">Controlar</a>`;
  if ((a.type === 'cambio' || a.type === 'consecutiva' || a.type === 'faltante') && can('movements_do')) return `<button class="btn sm" data-act="goRepo" data-t="${esc(holderKey(a))}" data-a="${esc(a.asgId)}">Registrar reposición</button>`;
  if (a.type === 'devolucion' && can('movements_do')) return `<button class="btn sm" data-act="recvPending" data-m="${esc(a.movId)}">Recibir devolución</button>`;
  return `<a class="btn sm" href="${esc(a.cajaId ? '#caja-' + a.cajaId : '#tecnico-' + a.techId)}">Ver ficha</a>`;
}
export function alertRow(a, full) {
  const cls = a.sev >= 3 ? 'bad' : a.sev === 2 ? 'warn' : 'pend';
  return `<div class="al"><span class="al-ic ${cls}">${icon(AL_IC[a.type] || 'alert', 16)}</span><div class="grow"><a class="t" href="${esc(a.href)}">${esc(a.title)}</a><div class="s">${esc(a.text)}</div>${full ? `<div class="al-acts">${alertAction(a)}${can('alerts_resolve') ? `<button class="btn sm dark" data-act="resolveAlert" data-k="${esc(a.key)}">Marcar resuelta</button>` : ''}</div>` : ''}</div></div>`;
}
export const alertList = (l, full) => (l.length ? `<div class="list">${l.map((a) => alertRow(a, full)).join('')}</div>` : `<div class="list">${emptyBox('Sin alertas abiertas', 'Todo en orden por ahora.')}</div>`);

export function periodStatus(techId, p) { const d = derive(); if (pnumOf(p) > d.curNum) return 'fut'; const k = techId + '|' + pkeyOf(p); if (d.eff[k]) return 'done'; if (d.drafts[k]) return 'draft'; return 'pend'; }
export function weekCells(techId, y, m) { const d = derive(); return `<div class="weeks">${[1, 2, 3, 4].map((w) => { const p = { y, m, w }; const st = periodStatus(techId, p); const e = d.eff[techId + '|' + pkeyOf(p)]; const lab = { done: 'Realizado', draft: 'Incompleto', pend: 'Pendiente', fut: 'Próximo' }[st]; const corr = e && e.correction; return `<button class="wk ${st}" data-act="openPeriod" data-t="${esc(techId)}" data-p="${esc(pkeyOf(p))}" aria-label="Semana ${w}, ${wrange(p)}: ${lab}${corr ? ', con corrección' : ''}"><span class="wn">Sem ${w}</span><span class="wr">${wrange(p)}</span><b>${lab}</b>${corr ? '<span class="corr" title="Con corrección">C</span>' : ''}</button>`; }).join('')}</div>`; }
export function monthNav(y, m, actName) { return `<div class="monthnav"><button class="icon-btn" data-act="${esc(actName)}" data-d="-1" aria-label="Mes anterior">${icon('back', 18)}</button><b>${mlabel(y, m)}</b><button class="icon-btn" data-act="${esc(actName)}" data-d="1" aria-label="Mes siguiente">${icon('right', 18)}</button></div>`; }
export const shortMonth = (m) => MSHORT[m - 1];
