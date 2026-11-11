// Etapa 7: apartado de Gerencia (compras). Bandeja de pendientes con aprobación rápida (un toque y
// confirmar, también en el celular) y rechazo con comentario; todas las solicitudes con filtros en
// el servidor; totales aprobados por mes; "A recibir" para quien recibe (hoja Recibir: genera el
// ingreso al inventario); detalle con datos, controles vinculados, novedades y línea de tiempo;
// alta manual desde la ficha de la herramienta o una alerta; tarjeta de compras de la ficha.
// Solo con conexión (las altas y transiciones llevan Idempotency-Key, las transiciones If-Match).
// Cancelar (eliminar) y restaurar van por el modelo genérico (records/view.js, tipo `compras`).
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN, CH } from '../../ui/actions.js';
import { openModal, modalRerender, MOD } from '../../ui/modal.js';
import { toast, UErr, tooLong, errMsg } from '../../ui/feedback.js';
import { pageHead, emptyBox, field, optList, kpi, mvRow } from '../../ui/components.js';
import { deleteBtn, archivedBanner } from '../records/view.js';
import { openNovedad } from '../novedades/view.js';
import { hooks } from '../../ui/app.js';
import { api, newIdempotencyKey } from '../../api/index.js';
import { net } from '../../api/net.js';
import { S, derive, can, who, markArchived, toolName, holderName, plantillaName } from '../../state/store.js';
import { LIM } from '../../state/constants.js';
import { fdt, fdate, plabel, mlabel } from '../../state/period.js';
import { parseRoute } from '../../ui/router.js';
import { CMP_ST, CMP_REASON, CMP_ORIGIN, CMP_EMPTY, TL_LABEL, cmpQuery, activeCmpFilters, money, parseCost, toolPurchases, cmpActions, lossGoneNote } from '../../state/compras.js';

const PAGE = 30;
const OFFLINE_TXT = 'Sin conexión con el servidor: las compras se ven y se deciden cuando vuelve la conexión.';
// Lista abierta (key = pestaña + filtros), totales, detalles por id y las solicitudes conocidas.
const CMP = { list: null, next: null, total: 0, key: null, errKey: null, error: '', loading: false, again: false, byId: {}, tot: null, totKey: null, totErr: '', det: {} };
UI.cmp = { ...CMP_EMPTY };
UI.cmpTab = null;

const failText = (e) => (e && (e.kind === 'network' || e.kind === 'offline') ? OFFLINE_TXT : errMsg(e));
const remember = (list) => { for (const p of list) CMP.byId[p.id] = { ...(CMP.byId[p.id] || {}), ...p }; };
export const canSeeCompras = () => can('purchases_view') || can('purchases_receive');
const canSeeDetail = () => can('purchases_view') || can('purchases_receive') || can('purchases_create');

function tabs() {
  const t = [];
  if (can('purchases_view')) t.push(['pend', 'Pendientes'], ['all', 'Todas'], ['tot', 'Totales por mes']);
  if (can('purchases_receive')) t.push(['recv', 'A recibir']);
  return t;
}
const curTab = () => { const t = tabs(); return t.some(([k]) => k === UI.cmpTab) ? UI.cmpTab : (t[0] || [''])[0]; };
function listQuery(tab, page = {}) {
  if (tab === 'pend') return cmpQuery({ ...CMP_EMPTY, status: 'pendiente' }, page);
  if (tab === 'recv') return cmpQuery(CMP_EMPTY, { ...page, scope: 'receive' });
  return cmpQuery(UI.cmp, page);
}
const totQuery = () => cmpQuery({ ...UI.cmp, status: '', month: '', archived: false });

async function loadList({ force = false, more = false } = {}) {
  const tab = curTab();
  if (!tab || tab === 'tot') return;
  const key = tab + '|' + listQuery(tab);
  if (CMP.loading) { CMP.again = CMP.again || force || key !== CMP.key; return; }
  if (!force && !more && (CMP.key === key || CMP.errKey === key)) return;
  CMP.loading = true;
  try {
    const limit = more ? PAGE : force && CMP.key === key && CMP.list ? Math.min(200, Math.max(PAGE, CMP.list.length)) : PAGE;
    const r = await api.compras(listQuery(tab, { limit, before: more ? CMP.next : '' }));
    remember(r.compras);
    if (key === curTab() + '|' + listQuery(curTab())) {
      CMP.list = more && CMP.list ? [...CMP.list, ...r.compras] : r.compras;
      CMP.next = r.next; CMP.total = r.total; CMP.key = key; CMP.errKey = null; CMP.error = '';
    } else CMP.again = true;
  } catch (e) {
    console.warn(e);
    CMP.error = failText(e); CMP.errKey = key;
    if (CMP.key !== key) CMP.list = null;
  } finally {
    CMP.loading = false;
    if (CMP.again) { CMP.again = false; loadList({ force: true }); } else render();
  }
}

async function loadTotals(force = false) {
  const key = totQuery();
  if (!force && (CMP.totKey === key || CMP.totLoading)) return;
  CMP.totLoading = true; CMP.totKey = key;
  try { CMP.tot = await api.compraTotals(key); CMP.totErr = ''; } catch (e) { CMP.totErr = failText(e); CMP.tot = null; }
  CMP.totLoading = false; render();
}

async function loadDetail(id, force = false) {
  const cur = CMP.det[id];
  if (cur && (cur.loading || (!force && (cur.row || cur.err)))) return;
  CMP.det[id] = { ...(cur || {}), loading: true };
  try {
    const r = await api.compra(id);
    CMP.det[id] = { row: r.compra, err: '', loading: false };
    remember([r.compra]);
  } catch (e) {
    CMP.det[id] = { ...(CMP.det[id] || {}), err: failText(e), loading: false };
  }
  render();
}

// Después de guardar o de un cambio en vivo: se vuelve a pedir lo que se está viendo.
function reloadVisible() {
  const r = parseRoute(location.hash);
  if (r.name === 'compras' && canSeeCompras()) {
    if (curTab() === 'tot') loadTotals(true);
    else if (CMP.list || CMP.errKey) loadList({ force: true });
  } else { CMP.key = null; CMP.totKey = null; }
  if (r.name === 'compra' && CMP.det[r.id]) loadDetail(r.id, true);
  for (const id of Object.keys(CMP.det)) if (!(r.name === 'compra' && r.id === id)) delete CMP.det[id];
}
hooks.afterState.push(reloadVisible);
hooks.beforeRoute.push((r) => { if (r.name === 'compras') { CMP.key = null; CMP.errKey = null; CMP.totKey = null; } });

// ------------------------------------------------------------------ piezas
export const stChipCmp = (status) => { const s = CMP_ST[status] || CMP_ST.pendiente; return `<span class="chip ${s.cls}">${icon(s.ic, 12)}${s.label}</span>`; };
const holderTxt = (p) => (p.techId || p.cajaId ? markArchived({ archived: p.holderArchived }, p.holderName || holderName(p)) : 'Stock (sin poseedor)');
const titleOf = (p) => `${p.name} · ${p.toolName || toolName(p.toolId)}${p.unitCode ? ' ' + p.unitCode : ''}${p.qty > 1 ? ` ×${p.qty}` : ''}`;
const holderHref = (p) => (p.cajaId ? `#caja-${p.cajaId}` : p.techId ? `#tecnico-${p.techId}` : '');

function rowActions(p, tab) {
  const a = cmpActions(p, can); const out = [];
  if (tab === 'pend' || tab === 'all') {
    if (a.approve) out.push(`<button class="btn sm pri cmpbtn" data-act="cmpApprove" data-id="${esc(p.id)}">${icon('ok', 14)}Aprobar</button>`);
    if (a.reject) out.push(`<button class="btn sm cmpbtn" data-act="cmpReject" data-id="${esc(p.id)}">${icon('x', 14)}Rechazar</button>`);
  }
  if (tab === 'recv') {
    if (a.receive) out.push(`<button class="btn sm pri cmpbtn" data-act="cmpReceive" data-id="${esc(p.id)}">${icon('box', 14)}Recibir</button>`);
    if (a.purchase) out.push(`<button class="btn sm cmpbtn" data-act="cmpPurchase" data-id="${esc(p.id)}">Marcar comprada</button>`);
  }
  return out.join('');
}

// E7.V1: la pérdida ya no figura en el último control (texto e ícono, además del color).
const lossChip = (p) => { const t = lossGoneNote(p); return t ? `<span class="chip warn">${icon('info', 12)}${esc(t)}</span>` : ''; };

export function cmpRow(p, tab = 'all') {
  const sub = [holderTxt(p), CMP_REASON[p.reason], p.plantillaName ? markArchived({ archived: p.plantillaArchived }, p.plantillaName) : '', fdt(p.createdAt)].filter(Boolean).join(' · ');
  const cost = can('purchases_view') ? `<span class="s">${esc(money(p.estimatedCost))}${p.supplier ? ' · ' + esc(p.supplier) : ''}</span>` : '';
  const acts = rowActions(p, tab);
  return `<div class="row cmprow${p.archived ? ' novarch' : ''}" data-cmp="${esc(p.id)}"><span class="tile cmpic">${icon('cart', 18)}</span><div class="grow"><a class="t cmpt" href="#compra-${esc(p.id)}">${esc(titleOf(p))}</a><div class="s">${esc(sub)}</div>${p.observation ? `<div class="s cmpobs">${esc(p.observation)}</div>` : ''}${p.status === 'rechazada' && p.decisionComment ? `<div class="s cmpobs">Motivo del rechazo: ${esc(p.decisionComment)}</div>` : ''}<div class="cmpmeta">${stChipCmp(p.status)}${lossChip(p)}${p.archived ? '<span class="chip pend">Eliminada</span>' : ''}${cost}</div></div>${acts ? `<span class="cmpacts">${acts}</span>` : ''}</div>`;
}

// ------------------------------------------------------------------ pantalla
const sel = (k, label, items, ph) => `<label class="novf" for="cmpf-${k}"><span>${label}</span><select id="cmpf-${k}" data-ch="cmpF" data-k="${k}">${optList(items, UI.cmp[k], ph)}</select></label>`;
function filterBar(withStatus = true) {
  const f = UI.cmp; const d = derive();
  const holders = [...d.allTechs.map((t) => [t.id, markArchived(t, t.name)]), ...d.allCajas.map((k) => ['caja:' + k.id, markArchived(k, k.name) + ' (caja)'])];
  const pls = [...d.shifts, ...d.archivedPlantillas].map((p) => [p.id, markArchived(p, p.name)]);
  const tools = Object.entries(S.tools || {}).map(([id, t]) => [id, markArchived(t, t.name)]).sort((a, b) => a[1].localeCompare(b[1]));
  const n = activeCmpFilters(f);
  return `<div class="toolbar"><div class="search">${icon('search', 18)}<input id="cmpq" type="search" placeholder="Buscar por herramienta, poseedor, proveedor u observación" value="${esc(f.q)}" data-in="cmpQ" aria-label="Buscar compras"></div></div>
  <div class="novfil">${withStatus ? sel('status', 'Estado', [['open', 'Abiertas'], ...Object.entries(CMP_ST).map(([k, s]) => [k, s.label])], 'Todos') : ''}
    ${withStatus ? `<label class="novf" for="cmpf-month"><span>Mes del alta</span><input id="cmpf-month" type="month" value="${esc(f.month)}" data-ch="cmpF" data-k="month"></label>` : ''}
    ${sel('plantillaId', 'Plantilla', pls, 'Todas')}${sel('holder', 'Técnico o caja', holders, 'Todos')}${sel('toolId', 'Herramienta', tools, 'Todas')}${sel('reason', 'Motivo', Object.entries(CMP_REASON), 'Todos')}</div>
  <div class="fchips novchips">${withStatus && can('records_delete') ? `<button class="fchip ${f.archived ? 'on' : ''}" data-act="cmpArch" aria-pressed="${f.archived}">Incluir eliminadas</button>` : ''}${n ? `<button class="btn sm" data-act="cmpClear">${icon('x', 14)}Limpiar filtros (${n})</button>` : ''}</div>`;
}

function listBody(tab) {
  if (!CMP.list && CMP.error) return `<div class="banner warn" role="alert"><div><b>No se pudieron cargar las compras.</b><div class="sm">${esc(CMP.error)}</div></div><div class="acts"><button class="btn sm" data-act="cmpRetry">Reintentar</button></div></div>`;
  if (!CMP.list) return '<div class="loading"><div class="spin"></div>Cargando compras…</div>';
  const empty = { pend: ['No hay compras pendientes', 'Las solicitudes nuevas aparecen acá para aprobarlas o rechazarlas.'], recv: ['No hay compras para recibir', 'Las aprobadas aparecen acá hasta que se reciben.'], all: activeCmpFilters(UI.cmp) ? ['Ninguna compra coincide', 'Probá con otros filtros o limpialos.'] : ['Todavía no hay solicitudes de compra', ''] }[tab];
  if (!CMP.list.length) return `<div class="list">${emptyBox(empty[0], empty[1])}</div>`;
  return `${CMP.error ? `<p class="hint warn">${icon('alert', 16)}<span>${esc(CMP.error)}</span></p>` : ''}<div class="list cmplist">${CMP.list.map((p) => cmpRow(p, tab)).join('')}</div>${CMP.next ? '<button class="btn block novmore" data-act="cmpMore">Ver más</button>' : ''}`;
}

const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); return mlabel(y, m); };
function totalsBody() {
  loadTotals();
  if (CMP.totErr) return `<div class="banner warn" role="alert"><div><b>No se pudieron cargar los totales.</b><div class="sm">${esc(CMP.totErr)}</div></div><div class="acts"><button class="btn sm" data-act="cmpTotRetry">Reintentar</button></div></div>`;
  const t = CMP.tot;
  if (!t) return '<div class="loading"><div class="spin"></div>Cargando totales…</div>';
  const sum = t.months.reduce((a, m) => ({ approved: a.approved + m.approved, costSum: a.costSum + m.costSum, withoutCost: a.withoutCost + m.withoutCost, rejected: a.rejected + m.rejected }), { approved: 0, costSum: 0, withoutCost: 0, rejected: 0 });
  const kpis = `<section class="kpis cmpkpis">${kpi(t.pending, 'Pendientes', '', 'warn')}${kpi(sum.approved, 'Aprobadas', '', 'ok', `${esc(monthName(t.from))} a ${esc(monthName(t.to))}`)}${kpi(esc(money(sum.costSum)), 'Costo estimado aprobado', '', '', sum.withoutCost ? `${sum.withoutCost} sin costo cargado` : 'todas con costo')}${kpi(sum.rejected, 'Rechazadas', '', 'bad')}</section>`;
  const rows = t.months.length ? `<div class="twrap"><table class="tbl cards cmptot"><thead><tr><th>Mes</th><th class="n">Aprobadas</th><th class="n">Costo estimado</th><th class="n">Sin costo</th><th class="n">Rechazadas</th></tr></thead><tbody>${t.months.slice().reverse().map((m) => `<tr><td class="lead" data-l="Mes">${esc(monthName(m.month))}</td><td class="n" data-l="Aprobadas">${m.approved}</td><td class="n" data-l="Costo estimado">${esc(money(m.costSum))}${m.withCost ? ` <span class="muted xs">(${m.withCost})</span>` : ''}</td><td class="n" data-l="Sin costo">${m.withoutCost}</td><td class="n" data-l="Rechazadas">${m.rejected}</td></tr>`).join('')}</tbody></table></div>` : `<div class="list">${emptyBox('Sin decisiones en estos meses', 'Los totales cuentan las compras por el mes en que se aprobaron.')}</div>`;
  return kpis + `<p class="muted sm">Por mes de la aprobación. La suma usa los costos estimados cargados; las aprobadas sin costo se cuentan aparte.</p>` + rows;
}

VIEWS.compras = () => {
  if (!canSeeCompras()) return pageHead('Gerencia: compras', '') + `<p class="hint">${icon('info', 16)}<span>Tu perfil no puede ver las compras.</span></p>`;
  const tab = curTab(); const ts = tabs();
  if (tab !== 'tot') loadList();
  const head = pageHead('Gerencia: compras', tab === 'recv' ? 'Compras aprobadas para recibir en el pañol' : 'Solicitudes de compra: aprobar, rechazar y totales');
  const seg = ts.length > 1 ? `<div class="seg cmpseg" role="tablist">${ts.map(([k, l]) => `<button role="tab" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}" data-act="cmpTab" data-v="${esc(k)}">${l}${k === 'pend' && CMP.key && CMP.key.startsWith('pend|') && CMP.list ? ` (${CMP.total})` : ''}</button>`).join('')}</div>` : '';
  const off = net.offline ? `<p class="hint warn">${icon('alert', 16)}<span>${OFFLINE_TXT}</span></p>` : '';
  let body;
  if (tab === 'tot') body = filterBar(false) + totalsBody();
  else body = (tab === 'all' ? filterBar() : '') + (tab === 'all' && CMP.list ? `<p class="muted sm">${CMP.total} ${CMP.total === 1 ? 'solicitud' : 'solicitudes'}</p>` : '') + listBody(tab);
  return head + seg + off + body;
};

let qTimer = null;
IN.cmpQ = (v) => { UI.cmp.q = v; clearTimeout(qTimer); qTimer = setTimeout(() => { if (curTab() === 'tot') loadTotals(); else loadList(); }, 300); };
CH.cmpF = (v, el) => { UI.cmp[el.dataset.k] = v; if (curTab() === 'tot') loadTotals(); else loadList(); render(); };
ACT.cmpTab = (ds) => { UI.cmpTab = ds.v; CMP.list = null; CMP.key = null; render(); };
ACT.cmpArch = () => { UI.cmp.archived = !UI.cmp.archived; loadList(); render(); };
ACT.cmpClear = () => { UI.cmp = { ...CMP_EMPTY }; if (curTab() === 'tot') loadTotals(); else loadList(); render(); };
ACT.cmpMore = () => loadList({ more: true });
ACT.cmpRetry = () => { CMP.errKey = null; loadList({ force: true }); render(); };
ACT.cmpTotRetry = () => loadTotals(true);

// ------------------------------------------------------------------ detalle
const kv = (k, v) => (v ? `<div class="cmpkv-i"><span class="k">${k}</span><span class="v">${v}</span></div>` : '');

function detailActions(p) {
  const a = cmpActions(p, can); const out = [];
  if (a.approve) out.push(`<button class="btn pri" data-act="cmpApprove" data-id="${esc(p.id)}">${icon('ok', 16)}Aprobar</button>`);
  if (a.reject) out.push(`<button class="btn" data-act="cmpReject" data-id="${esc(p.id)}">${icon('x', 16)}Rechazar</button>`);
  if (a.purchase) out.push(`<button class="btn" data-act="cmpPurchase" data-id="${esc(p.id)}">Marcar comprada</button>`);
  if (a.receive) out.push(`<button class="btn pri" data-act="cmpReceive" data-id="${esc(p.id)}">${icon('box', 16)}Recibir</button>`);
  if (a.edit) out.push(`<button class="btn" data-act="cmpEdit" data-id="${esc(p.id)}">${icon('pencil', 16)}Editar</button>`);
  if (can('novedades_create') && !p.archived) out.push(`<button class="btn" data-act="cmpNov" data-id="${esc(p.id)}">${icon('note', 16)}Agregar novedad</button>`);
  if (p.status === 'pendiente' && !p.archived) out.push(deleteBtn('compras', p.id, { back: '#compras' }));
  return out.join('');
}

VIEWS.compra = (id) => {
  const back = canSeeCompras() ? '#compras' : '#alertas';
  if (!canSeeDetail()) return pageHead('Solicitud de compra', '', { back }) + `<p class="hint">${icon('info', 16)}<span>Tu perfil no puede ver las compras.</span></p>`;
  loadDetail(id);
  const st = CMP.det[id];
  if (!st || (!st.row && !st.err)) return pageHead('Solicitud de compra', '', { back }) + '<div class="loading"><div class="spin"></div>Cargando…</div>';
  if (!st.row) return pageHead('Solicitud de compra', '', { back }) + `<div class="banner warn" role="alert"><div><b>No se pudo cargar la solicitud.</b><div class="sm">${esc(st.err)}</div></div></div>`;
  const p = st.row; const href = holderHref(p);
  const holder = href ? `<a href="${esc(href)}">${esc(holderTxt(p))}</a>` : esc(holderTxt(p));
  const origin = p.origin === 'control' && p.originControlId ? `<a href="#controlver-${esc(p.originControlId)}">${CMP_ORIGIN.control}</a>` : esc(CMP_ORIGIN[p.origin] || p.origin);
  const data = `<section class="card cmpcard"><h2 class="si">Datos de la solicitud</h2><div class="cmpkv">${kv('Herramienta', esc(markArchived({ archived: p.toolArchived }, p.toolName)))}${kv('Código', esc(p.unitCode || ''))}${kv('Técnico o caja', holder)}${kv('Plantilla', p.plantillaId ? esc(markArchived({ archived: p.plantillaArchived }, p.plantillaName || plantillaName(p.plantillaId))) : '')}${kv('Motivo', esc(CMP_REASON[p.reason]))}${kv('Cantidad', String(p.qty))}${kv('Observación', esc(p.observation))}${can('purchases_view') ? kv('Costo estimado', esc(money(p.estimatedCost))) + kv('Proveedor', esc(p.supplier || '')) : ''}${kv('Origen', origin)}${kv('Generada', esc(`${fdt(p.createdAt)} por ${p.byName || who(p.by)}`))}</div></section>`;
  const steps = [];
  if (p.decidedAt) steps.push(`<div class="cmpstep">${stChipCmp(p.status === 'rechazada' ? 'rechazada' : 'aprobada')}<span class="s">${esc(`${fdt(p.decidedAt)} · ${p.decidedByName || who(p.decidedBy)}`)}</span>${p.decisionComment ? `<div class="s cmpobs">${p.status === 'rechazada' ? 'Motivo' : 'Comentario'}: ${esc(p.decisionComment)}</div>` : ''}</div>`);
  if (p.purchasedAt) steps.push(`<div class="cmpstep">${stChipCmp('comprada')}<span class="s">${esc(`${fdt(p.purchasedAt)} · ${p.purchasedByName || who(p.purchasedBy)}`)}</span>${p.purchaseNote ? `<div class="s cmpobs">${esc(p.purchaseNote)}</div>` : ''}</div>`);
  if (p.receivedAt) steps.push(`<div class="cmpstep">${stChipCmp('recibida')}<span class="s">${esc(`${fdt(p.receivedAt)} · ${p.receivedByName || who(p.receivedBy)} · ${p.receivedQty} ${p.receivedQty === 1 ? 'unidad' : 'unidades'}`)}</span>${p.receptionNote ? `<div class="s cmpobs">${esc(p.receptionNote)}</div>` : ''}</div>`);
  const mvs = [p.ingresoMovementId, p.reposicionMovementId].map((m) => m && S.movements[m] ? mvRow({ id: m, ...S.movements[m] }, { plain: true }) : '').join('');
  const decision = steps.length || mvs ? `<section class="card cmpcard"><h2 class="si">Decisión, compra y recepción</h2>${steps.join('')}${mvs ? `<div class="list cmpmvs">${mvs}</div>` : ''}${p.status === 'recibida' && !p.reposicionMovementId ? `<p class="muted sm">La reposición al ${p.cajaId ? 'poseedor' : 'técnico'} se vincula desde Entregas y reposiciones.</p>` : ''}</section>` : '';
  const ctls = p.controls && p.controls.length ? `<section class="card cmpcard"><h2 class="si">Controles vinculados (${p.controls.length})</h2><div class="list">${p.controls.map((c) => `<a class="row" href="#controlver-${esc(c.controlId)}"><div class="grow"><div class="t">${esc(plabel(c.period))}${c.correction ? ' (corrección)' : ''}</div><div class="s">${esc(`${fdate(c.finishedAt)} · cantidad ${c.qty}`)}</div></div>${icon('right', 16)}</a>`).join('')}</div></section>` : '';
  const novs = p.novedades && p.novedades.length ? `<section class="card cmpcard"><h2 class="si">Novedades</h2><div class="list">${p.novedades.map((n) => `<div class="row"><div class="grow"><div class="s">${esc(`${fdt(n.occurredAt)} · ${n.name}`)}</div><div class="t novtxt">${esc(n.comment)}</div></div></div>`).join('')}</div></section>` : '';
  const tl = p.timeline && p.timeline.length ? `<section class="card cmpcard"><h2 class="si">Línea de tiempo</h2><div class="tl">${p.timeline.map((x) => `<div class="tl-i"><span class="tl-dot ${x.action === 'purchase_reject' ? 'bad' : x.action === 'purchase_approve' || x.action === 'purchase_receive' ? 'ok' : 'pri'}"></span><div class="grow"><div class="cmptlt">${esc(TL_LABEL[x.action] || x.action)}</div><div class="muted sm">${esc(`${fdt(x.at)} · ${x.byName || who(x.by)}`)}</div><div class="muted sm cmpobs">${esc(x.detail || '')}</div></div></div>`).join('')}</div></section>` : '';
  return pageHead(esc(p.name), `${stChipCmp(p.status)} <span class="cmpsub">${esc(`${p.toolName}${p.unitCode ? ' ' + p.unitCode : ''} · ${holderTxt(p)}`)}</span>`, { back, acts: detailActions(p) })
    + (p.archived ? archivedBanner(p, 'compras') : '') + (lossGoneNote(p) ? `<p class="hint warn">${icon('info', 16)}<span>${esc(lossGoneNote(p))}. Revisá el control antes de decidir.</span></p>` : '') + `<div class="two cmptwo"><div>${data}${decision}</div><div>${ctls}${novs}${tl}</div></div>`;
};

// ------------------------------------------------------------------ decisión y recepción
const known = (id) => CMP.byId[id] || (CMP.det[id] && CMP.det[id].row) || null;
const summaryOf = (p) => `<p class="muted mt0">${esc(`${titleOf(p)} · ${holderTxt(p)} · ${CMP_REASON[p.reason]}`)}</p>${p.observation ? `<p class="sm mt0">${esc(p.observation)}</p>` : ''}`;
const done = async (msg, id) => { toast(msg); if (CMP.det[id]) loadDetail(id, true); reloadVisible(); render(); };
const offlineCheck = () => { if (net.offline) throw new UErr(OFFLINE_TXT); };

// Transición con la misma clave mientras no cambie lo que se manda (un doble toque no duplica).
function openAction(id, { title, label, kind = 'pri', render: body, build }) {
  const p = known(id); if (!p) return;
  let key = newIdempotencyKey(); let sent = '';
  openModal({
    title, rec: { get: () => known(id), version: p.version }, reload: () => ({}),
    render: (st) => summaryOf(p) + (body ? body(st, p) : ''),
    actions: [{ label: 'Cancelar', close: true }, { label, kind, run: async (st, m) => {
      offlineCheck();
      const { action, payload } = build(st, p);
      const sig = JSON.stringify([action, payload, m.rec.version]); if (sent && sent !== sig) key = newIdempotencyKey(); sent = sig;
      const r = await api.compraAction(id, action, payload, m.rec.version, { idempotencyKey: key });
      CMP.byId[id] = { ...CMP.byId[id], ...r.compra };
      await done({ approve: 'Compra aprobada', reject: 'Compra rechazada', purchase: 'Compra marcada como comprada', receive: 'Compra recibida: se registró el ingreso al inventario' }[action], id);
    } }],
  });
}

// Aprobar: un toque y confirmar.
ACT.cmpApprove = (ds) => openAction(ds.id, { title: 'Aprobar compra', label: 'Aprobar', render: (st, p) => `<p class="cmpq">¿Aprobás esta compra?${p.estimatedCost != null ? ` Costo estimado: ${esc(money(p.estimatedCost))}.` : ''}</p>${lossGoneNote(p) ? `<p class="hint warn">${icon('info', 16)}<span>${esc(lossGoneNote(p))}.</span></p>` : ''}`, build: () => ({ action: 'approve', payload: {} }) });

const REJ_QUICK = ['Hay stock en el depósito', 'Se puede reparar', 'No corresponde', 'Pedir otra cotización'];
ACT.cmpReject = (ds) => openAction(ds.id, {
  title: 'Rechazar compra', label: 'Rechazar', kind: 'danger',
  render: (st) => field('Motivo del rechazo (obligatorio)', `<textarea id="cmp-rej" rows="3" maxlength="${LIM.text}" data-mi="comment" placeholder="Por qué no se compra">${esc(st.comment || '')}</textarea>`, 'cmp-rej') + `<div class="qchips">${REJ_QUICK.map((q) => `<button type="button" class="qchip" data-act="mset" data-k="comment" data-v="${esc(q)}">${esc(q)}</button>`).join('')}</div><p class="muted sm">La alerta queda visible como "compra rechazada" con este motivo.</p>`,
  build: (st) => { const comment = String(st.comment || '').trim(); if (!comment) throw new UErr('Escribí el motivo del rechazo.'); tooLong(comment, LIM.text, 'El motivo'); return { action: 'reject', payload: { comment } }; },
});

const costField = (st) => field('Costo estimado en pesos (opcional)', `<input id="cmp-cost" type="text" inputmode="decimal" maxlength="14" data-mi="cost" value="${esc(st.cost ?? '')}" placeholder="Por ejemplo 15000,50">`, 'cmp-cost');
const supplierField = (st) => field('Proveedor (opcional)', `<input id="cmp-sup" type="text" maxlength="${LIM.name}" data-mi="supplier" value="${esc(st.supplier ?? '')}">`, 'cmp-sup');
const costOf = (st) => { try { return parseCost(st.cost); } catch (e) { throw new UErr(e.message); } };

ACT.cmpPurchase = (ds) => openAction(ds.id, {
  title: 'Marcar como comprada', label: 'Marcar comprada',
  render: (st) => (can('purchases_decide') ? supplierField(st) + costField(st) : '') + field('Nota (opcional)', `<input id="cmp-pn" type="text" maxlength="${LIM.text}" data-mi="note" value="${esc(st.note || '')}" placeholder="Orden de compra, remito">`, 'cmp-pn'),
  build: (st) => { const payload = { note: String(st.note || '').trim() }; if (can('purchases_decide')) { const c = costOf(st); if (c != null) payload.estimatedCost = c; if (String(st.supplier || '').trim()) payload.supplier = String(st.supplier).trim(); } return { action: 'purchase', payload }; },
});

ACT.cmpReceive = (ds) => {
  const p = known(ds.id); if (!p) return;
  const serialized = p.serialized != null ? p.serialized : !!(S.tools[p.toolId] || {}).serialized;
  openAction(ds.id, {
    title: 'Recibir compra', label: 'Recibir',
    render: (st) => (serialized
      ? field('Código de cada unidad recibida (uno por línea)', `<textarea id="cmp-codes" rows="3" data-mi="codes" placeholder="TAL-010">${esc(st.codes || '')}</textarea>`, 'cmp-codes')
      : field('Cantidad recibida', `<input id="cmp-rq" type="number" min="1" inputmode="numeric" data-mi="qty" value="${esc(st.qty ?? p.qty)}">`, 'cmp-rq'))
      + field('Observaciones (opcional)', `<input id="cmp-rn" type="text" maxlength="${LIM.text}" data-mi="note" value="${esc(st.note || '')}" placeholder="Remito, estado">`, 'cmp-rn')
      + `<p class="hint">${icon('info', 16)}<span>Se registra el ingreso al inventario (disponibles), vinculado a esta compra. Después, la reposición al técnico se vincula a esta compra.</span></p>`,
    build: (st) => {
      const payload = { note: String(st.note || '').trim() };
      if (serialized) { const codes = String(st.codes || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean); if (!codes.length) throw new UErr('Ingresá el código de cada unidad recibida.'); for (const c of codes) tooLong(c, LIM.code, 'Cada código'); payload.codes = codes.join('\n'); } else { const q = parseInt(st.qty ?? p.qty, 10); if (!(q >= 1)) throw new UErr('Indicá la cantidad recibida.'); payload.qty = q; }
      return { action: 'receive', payload };
    },
  });
};

ACT.cmpEdit = (ds) => {
  const p = known(ds.id); if (!p) return;
  const a = cmpActions(p, can);
  openModal({
    title: 'Editar solicitud de compra', rec: { get: () => known(ds.id), version: p.version },
    reload: (cur) => ({ cost: cur.estimatedCost ?? '', supplier: cur.supplier || '', observation: cur.observation || '', qty: cur.qty }),
    render: (st) => summaryOf(p) + (a.cost ? costField(st) + supplierField(st) : '') + field('Observación', `<textarea id="cmp-obs" rows="2" maxlength="${LIM.text}" data-mi="observation">${esc(st.observation || '')}</textarea>`, 'cmp-obs') + (a.qty ? field('Cantidad', `<input id="cmp-q" type="number" min="1" inputmode="numeric" data-mi="qty" value="${esc(st.qty)}">`, 'cmp-q') : ''),
    actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar', kind: 'pri', run: async (st, m) => {
      offlineCheck();
      const body = { observation: String(st.observation || '').trim(), ...(a.cost ? { estimatedCost: costOf(st), supplier: String(st.supplier || '').trim() } : {}) };
      tooLong(body.observation, LIM.text, 'La observación');
      if (a.qty) { const q = parseInt(st.qty, 10); if (!(q >= 1)) throw new UErr('Indicá una cantidad válida.'); body.qty = q; }
      const r = await api.updateCompra(ds.id, body, m.rec.version);
      CMP.byId[ds.id] = { ...CMP.byId[ds.id], ...r.compra };
      await done('Solicitud guardada', ds.id);
    } }],
  });
  MOD.st = { cost: p.estimatedCost ?? '', supplier: p.supplier || '', observation: p.observation || '', qty: p.qty }; modalRerender();
};

ACT.cmpNov = (ds) => { const p = known(ds.id); if (p) openNovedad({ purchaseRequestId: p.id, purchaseName: `${p.name} · ${p.toolName}`, techId: p.techId || '' }); };

// ------------------------------------------------------------------ alta manual
// o: { toolId, assignmentId, reason, qty, origin, alertKey }. Desde una alerta llegan la
// asignación, el motivo y la cantidad; desde la ficha, la herramienta.
export function openCompraNew(o = {}) {
  if (!can('purchases_create')) { toast('Tu perfil no tiene permiso para esta acción.', 'err'); return; }
  const fixedAsg = o.origin === 'alert' && o.assignmentId;
  let key = newIdempotencyKey(); let sent = '';
  openModal({
    title: 'Solicitar compra',
    render: (st) => {
      const d = derive();
      const tools = d.tools.filter((t) => t.active !== false).map((t) => [t.id, t.name]);
      const asgs = d.activeAsg.filter((a) => a.toolId === st.toolId);
      const asgLabel = (a) => `${holderName(a)}${a.unitId && S.units[a.unitId] ? ' · ' + S.units[a.unitId].code : ''}${a.qty > 1 ? ` · ${a.qty} unidades` : ''}`;
      let h = `<p class="muted mt0">La solicitud queda pendiente hasta que Gerencia la apruebe o la rechace.</p>`;
      if (fixedAsg) { const a = S.assignments[st.assignmentId]; h += `<p class="sm mt0"><b>${esc(toolName(st.toolId))}</b> · ${esc(a ? asgLabel({ id: st.assignmentId, ...a }) : '')}</p>`; } else {
        h += field('Herramienta', `<select id="cmp-tool" data-mi="toolId" data-mr>${optList(tools, st.toolId, 'Elegí una herramienta')}</select>`, 'cmp-tool');
        if (st.toolId) h += field('Para quién (opcional)', `<select id="cmp-asg" data-mi="assignmentId">${optList(asgs.map((a) => [a.id, asgLabel(a)]), st.assignmentId, 'Sin poseedor (compra para stock)')}</select>`, 'cmp-asg');
      }
      h += field('Motivo', `<div class="opts">${Object.entries(CMP_REASON).map(([k, l]) => `<button type="button" class="opt ${st.reason === k ? 'on' : ''}" aria-pressed="${st.reason === k}" data-act="mset" data-k="reason" data-v="${esc(k)}">${l}</button>`).join('')}</div>`);
      h += field('Cantidad', `<input id="cmp-nq" type="number" min="1" inputmode="numeric" data-mi="qty" value="${esc(st.qty)}">`, 'cmp-nq');
      h += costField(st) + supplierField(st) + field('Observación (opcional)', `<textarea id="cmp-nobs" rows="2" maxlength="${LIM.text}" data-mi="observation" placeholder="Qué pasó con la herramienta">${esc(st.observation || '')}</textarea>`, 'cmp-nobs');
      return h;
    },
    actions: [{ label: 'Cancelar', close: true }, { label: 'Crear solicitud', kind: 'pri', run: async (st) => {
      offlineCheck();
      if (!st.toolId) throw new UErr('Elegí una herramienta.');
      if (!st.reason) throw new UErr('Elegí el motivo: dañada o extraviada.');
      const qty = parseInt(st.qty, 10); if (!(qty >= 1)) throw new UErr('Indicá una cantidad válida.');
      const observation = String(st.observation || '').trim(); tooLong(observation, LIM.text, 'La observación');
      const body = { toolId: st.toolId, assignmentId: st.assignmentId || null, reason: st.reason, qty, estimatedCost: costOf(st), supplier: String(st.supplier || '').trim(), observation, origin: o.origin === 'alert' ? 'alert' : 'tool', ...(o.alertKey ? { alertKey: o.alertKey } : {}) };
      const sig = JSON.stringify(body); if (sent && sent !== sig) key = newIdempotencyKey(); sent = sig;
      const r = await api.createCompra(body, { idempotencyKey: key });
      CMP.byId[r.compra.id] = r.compra;
      await done(`${r.compra.name} creada`, r.compra.id);
    } }],
  });
  MOD.st = { toolId: o.toolId || '', assignmentId: o.assignmentId || '', reason: o.reason || '', qty: o.qty || 1, cost: '', supplier: '', observation: '' };
  modalRerender();
}
ACT.cmpNew = (ds) => openCompraNew({ toolId: ds.t || '' });
ACT.cmpFromAlert = (ds) => { const a = S.assignments[ds.a]; if (a) openCompraNew({ toolId: a.toolId, assignmentId: ds.a, reason: ds.r, qty: parseInt(ds.q, 10) || 1, origin: 'alert', alertKey: ds.k }); };

// ------------------------------------------------------------------ ficha de la herramienta
export function toolComprasCard(toolId) {
  const list = toolPurchases(S.purchases, toolId);
  const add = can('purchases_create') ? `<button class="btn sm" data-act="cmpNew" data-t="${esc(toolId)}">${icon('cart', 14)}Solicitar compra</button>` : '';
  if (!list.length && !add) return '';
  const link = canSeeDetail();
  const rows = list.map((p) => {
    const inner = `<div class="grow"><div class="t">${esc(p.name)}${p.qty > 1 ? ` ×${p.qty}` : ''} · ${esc(CMP_REASON[p.reason])}</div><div class="s">${esc([p.techId || p.cajaId ? p.holderName : 'Stock (sin poseedor)', fdate(p.createdAt)].filter(Boolean).join(' · '))}${p.status === 'rechazada' && p.decisionComment ? ` · Motivo: ${esc(p.decisionComment)}` : ''}</div></div>${stChipCmp(p.status)}`;
    return link ? `<a class="row" href="#compra-${esc(p.id)}">${inner}</a>` : `<div class="row">${inner}</div>`;
  }).join('');
  return `<section class="card cmpcard"><div class="srow"><h2 class="si">Compras</h2>${add}</div>${list.length ? `<div class="list">${rows}</div>` : '<p class="muted sm mt0">No hay compras abiertas de esta herramienta.</p>'}</section>`;
}
