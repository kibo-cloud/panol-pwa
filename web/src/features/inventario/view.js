// Inventario general y ficha de herramienta (igual que 2.1). Los ajustes (ingreso, reparación,
// baja, recupero, alta de unidades) son movimientos del servidor.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN } from '../../ui/actions.js';
import { openModal, modalRerender, MOD } from '../../ui/modal.js';
import { toast, UErr, tooLong } from '../../ui/feedback.js';
import { kpi, pageHead, emptyBox, demoChip, stChip, mvList, field, optList } from '../../ui/components.js';
import { gateUI } from '../tecnicos/view.js';
import { api, newIdempotencyKey } from '../../api/index.js';
import { S, derive, can, refresh, toolName, catName, holderName } from '../../state/store.js';
import { POOL, UNIT_ST, POOL_CLS, LIM } from '../../state/constants.js';
import { fdate, plabel } from '../../state/period.js';

VIEWS.inventario = () => {
  const d = derive(); const q = UI.invQ.trim().toLowerCase();
  const tot = { disponible: 0, asignado: 0, reparacion: 0, retirado: 0, pendiente: 0, baja: 0 };
  for (const t of d.tools) { const p = d.pools[t.id]; for (const k in tot) tot[k] += Math.max(0, p[k] || 0); }
  const registered = tot.disponible + tot.asignado + tot.reparacion + tot.retirado + tot.pendiente;
  let tools = d.tools.filter((t) => UI.invCat === 'all' || t.categoryId === UI.invCat);
  let unitHits = [];
  if (q) { unitHits = d.units.filter((u) => (u.code || '').toLowerCase().includes(q)).slice(0, 20); tools = tools.filter((t) => (t.name || '').toLowerCase().includes(q) || catName(t.categoryId).toLowerCase().includes(q) || (d.unitsByTool[t.id] || []).some((u) => (u.code || '').toLowerCase().includes(q))); }
  return pageHead('Inventario general', 'Se actualiza con cada entrega, devolución y reposición', { acts: can('inventory_edit') && d.tools.length ? `<button class="btn pri" data-act="invAdjust">${icon('plus', 18)}Ajustar inventario</button>` : '' }) +
  `<section class="kpis k7" data-css="margin-bottom:14px">${kpi(registered, 'Registradas', '', '', 'sin contar bajas')}${kpi(tot.asignado, 'Asignadas')}${kpi(tot.disponible, 'Disponibles', '', 'ok')}${kpi(tot.reparacion, 'En reparación', '', 'warn')}${kpi(tot.pendiente, 'Pendientes de devolución', '', 'bad')}${kpi(tot.retirado, 'Retiradas', '', 'pend')}${kpi(tot.baja, 'Dadas de baja', '', 'pend')}</section>
  <div class="toolbar"><div class="search">${icon('search', 18)}<input id="invq" type="search" placeholder="Buscar por nombre, categoría o código" value="${esc(UI.invQ)}" data-in="invQ" aria-label="Buscar herramienta"></div></div>
  <div class="fchips" data-css="margin-bottom:12px"><button class="fchip ${UI.invCat === 'all' ? 'on' : ''}" data-act="invCat" data-v="all">Todas</button>${d.cats.map((c) => `<button class="fchip ${UI.invCat === c.id ? 'on' : ''}" data-act="invCat" data-v="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</div>
  ${unitHits.length ? `<h2 class="sec" data-css="margin-top:6px">Unidades por código</h2><div class="list" data-css="margin-bottom:14px">${unitHits.map((u) => `<a class="row" href="#herramienta-${esc(u.toolId)}"><div class="grow"><div class="t">${esc(u.code)}</div><div class="s">${esc(toolName(u.toolId))}${u.techId && holderName(u) ? ', ' + esc(holderName(u)) : ''}</div></div><span class="chip ${POOL_CLS[u.status] || ''}">${UNIT_ST[u.status] || esc(u.status)}</span></a>`).join('')}</div>` : ''}
  ${tools.length ? `<div class="twrap"><table class="tbl cards"><thead><tr><th>Herramienta</th><th>Categoría</th><th class="n">Asignadas</th><th class="n">Disponibles</th><th class="n">Reparación</th><th class="n">Pend. devol.</th><th class="n">Retiradas</th><th class="n">Bajas</th></tr></thead><tbody>${tools.map((t) => { const p = d.pools[t.id]; return `<tr><td class="lead" data-l="Herramienta"><a href="#herramienta-${esc(t.id)}" data-css="font-weight:640">${esc(t.name)}</a> ${t.active === false ? '<span class="chip">Inactiva</span>' : ''} ${demoChip(t)}<div class="muted xs">${t.serialized ? 'Por código individual' : 'Por cantidad'}</div></td><td data-l="Categoría">${esc(catName(t.categoryId))}</td><td class="n" data-l="Asignadas">${p.asignado}</td><td class="n" data-l="Disponibles">${p.disponible}</td><td class="n" data-l="En reparación">${p.reparacion}</td><td class="n" data-l="Pendientes de devolución">${p.pendiente}</td><td class="n" data-l="Retiradas">${p.retirado}</td><td class="n" data-l="Dadas de baja">${p.baja}</td></tr>`; }).join('')}</tbody></table></div>` : `<div class="list">${emptyBox(q ? 'Sin resultados' : 'No hay herramientas cargadas', q ? 'Probá con otro término.' : 'Crealas desde Configuración de herramientas.', !q && can('tools_edit') ? '<a class="btn pri" href="#config">Crear herramientas</a>' : '')}</div>`}`;
};

VIEWS.herramienta = (id) => {
  const d = derive(); const t = S.tools[id]; if (!t) return pageHead('Herramienta no encontrada', '', { back: '#inventario' });
  const p = d.pools[id]; const units = d.unitsByTool[id] || []; const holders = d.activeAsg.filter((a) => a.toolId === id);
  const movs = d.movs.filter((m) => m.toolId === id || (m.transfers || []).some((x) => x.toolId === id));
  const ctlHist = []; for (const c of d.effList.slice().reverse()) for (const [aid, it] of Object.entries(c.items || {})) if (it.toolId === id) ctlHist.push({ c, it, aid });
  return pageHead(`${esc(t.name)} ${demoChip(t)}`, `${esc(catName(t.categoryId))}, ${t.serialized ? 'seguimiento por código individual' : 'seguimiento por cantidad'}${t.active === false ? ', inactiva' : ''}`, { back: '#inventario', acts: [can('inventory_edit') ? `<button class="btn pri" data-act="invAdjust" data-t="${esc(id)}">Ajustar inventario</button>` : '', can('tools_edit') ? `<button class="btn" data-act="toolEdit" data-t="${esc(id)}">Editar</button>` : ''].join('') }) +
  `${t.description ? `<p class="muted" data-css="margin-top:-8px">${esc(t.description)}</p>` : ''}
  <section class="kpis">${['asignado', 'disponible', 'reparacion', 'pendiente', 'retirado', 'baja'].map((k) => kpi(p[k], POOL[k], '', k === 'disponible' ? 'ok' : k === 'reparacion' ? 'warn' : k === 'pendiente' ? 'bad' : '')).join('')}</section>
  <div class="two"><section><h2 class="sec" data-css="margin-top:6px">Quién la tiene</h2>${holders.length ? `<div class="list">${holders.map((a) => { const s = d.stateOf[a.id]; const u = a.unitId && S.units[a.unitId]; return `<a class="row" href="${a.cajaId ? '#caja-' + esc(a.cajaId) : '#tecnico-' + esc(a.techId)}"><div class="grow"><div class="t">${esc(holderName(a) || 'Técnico')}</div><div class="s">${u ? 'Código ' + esc(u.code) + ', ' : ''}${a.qty > 1 ? a.qty + ' unidades, ' : ''}desde ${fdate(a.since)}</div></div>${stChip(s ? s.state : 'pendiente')}</a>`; }).join('')}</div>` : `<div class="list">${emptyBox('No está asignada a nadie', '')}</div>`}
  ${t.serialized ? `<h2 class="sec">Unidades (${units.length})</h2>${units.length ? `<div class="list">${units.map((u) => `<div class="row"><div class="grow"><div class="t">${esc(u.code)}</div><div class="s">${u.techId && holderName(u) ? esc(holderName(u)) + ', ' : ''}alta ${fdate(u.createdAt)}</div></div><span class="chip ${POOL_CLS[u.status] || ''}">${UNIT_ST[u.status] || esc(u.status)}</span></div>`).join('')}</div>` : `<div class="list">${emptyBox('Sin unidades', 'Dá de alta códigos desde Ajustar inventario.')}</div>`}` : ''}</section>
  <section><h2 class="sec" data-css="margin-top:6px">Estado en controles</h2>${ctlHist.length ? `<div class="list">${ctlHist.slice(0, 40).map(({ c, it }) => `<a class="row" href="#controlver-${esc(c.id)}"><div class="grow"><div class="t">${esc(holderName(c) || c.techName)}${it.unitCode ? ', ' + esc(it.unitCode) : ''}</div><div class="s">${plabel(c.period)}${it.note ? '. ' + esc(it.note) : ''}</div></div>${stChip(it.state)}</a>`).join('')}</div>` : `<div class="list">${emptyBox('Sin controles registrados', '')}</div>`}
  <h2 class="sec">Movimientos</h2>${mvList(movs.slice(0, 60))}</section></div>`;
};

ACT.invCat = (ds) => { UI.invCat = ds.v; render(); };
IN.invQ = (v) => { UI.invQ = v; render(); };

ACT.invAdjust = (ds) => {
  if (!gateUI('inventory_edit')) return;
  let last = null;
  openModal({ title: 'Ajustar inventario', render: (st) => {
    const d = derive(); const tool = S.tools[st.toolId] ? { id: st.toolId, ...S.tools[st.toolId] } : null; let h = field('Herramienta', `<select id="f-it" data-mi="toolId" data-mr>${optList(d.tools.map((t) => [t.id, t.name]), st.toolId, 'Elegí una herramienta')}</select>`, 'f-it');
    if (!tool) return h; const p = d.pools[tool.id];
    h += field('Acción', `<div class="opts">${[['ingreso', tool.serialized ? 'Alta de unidades nuevas' : 'Ingreso de stock'], ['reparado', `Reparación terminada (${p.reparacion} en reparación)`], ['baja', 'Dar de baja'], ['recupero', `Recuperar retirada (${p.retirado} retiradas)`]].map(([v, l]) => `<button type="button" class="opt ${st.op === v ? 'on' : ''}" data-act="mset" data-k="op" data-v="${esc(v)}">${l}</button>`).join('')}</div>`);
    if (st.op === 'baja') h += field('Desde', `<div class="opts">${[['disponible', `Disponibles (${p.disponible})`], ['reparacion', `En reparación (${p.reparacion})`]].map(([v, l]) => `<button type="button" class="opt ${st.from === v ? 'on' : ''}" data-act="mset" data-k="from" data-v="${esc(v)}">${l}</button>`).join('')}</div>`);
    if (tool.serialized) {
      if (st.op === 'ingreso') h += field('Códigos nuevos (uno por línea)', `<textarea id="f-codes" data-mi="codes" rows="4" placeholder="TAL-004&#10;TAL-005">${esc(st.codes || '')}</textarea>`, 'f-codes');
      else { const from = st.op === 'reparado' ? 'reparacion' : st.op === 'recupero' ? 'retirado' : st.from; const us = (d.unitsByTool[tool.id] || []).filter((u) => u.status === from); h += us.length ? field('Unidad', `<select id="f-u" data-mi="unitId">${optList(us.map((u) => [u.id, u.code]), st.unitId, 'Elegí el código')}</select>`, 'f-u') : '<p class="hint">No hay unidades en ese estado.</p>'; }
    } else h += field('Cantidad', `<input id="f-q" type="number" min="1" inputmode="numeric" data-mi="qty" value="${esc(st.qty || 1)}">`, 'f-q');
    h += field('Observaciones', `<input id="f-n" type="text" maxlength="2000" data-mi="notes" value="${esc(st.notes || '')}" placeholder="Proveedor, remito, motivo">`, 'f-n');
    return h;
  }, actions: [{ label: 'Cancelar', close: true }, { label: 'Registrar', kind: 'pri', run: async (st) => {
    const body = inventoryBody(st); const sig = JSON.stringify(body);
    if (!last || last.sig !== sig) last = { sig, key: newIdempotencyKey() };
    await api.movement(body, { idempotencyKey: last.key }); await refresh(); toast('Inventario actualizado');
  } }] });
  MOD.st = { toolId: ds.t || '', op: 'ingreso', from: 'disponible', qty: 1 }; modalRerender();
};

function inventoryBody(st) {
  const tool = S.tools[st.toolId]; if (!tool) throw new UErr('Elegí una herramienta.');
  const b = { type: st.op, toolId: st.toolId, notes: (st.notes || '').trim() };
  if (st.op === 'baja') b.from = st.from || 'disponible';
  if (tool.serialized) {
    if (st.op === 'ingreso') { const codes = String(st.codes || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean); if (!codes.length) throw new UErr('Ingresá al menos un código.'); for (const c of codes) tooLong(c, LIM.code, 'Cada código'); b.codes = codes.join('\n'); } else { if (!st.unitId) throw new UErr('Elegí una unidad válida.'); b.unitId = st.unitId; }
    return b;
  }
  const qty = parseInt(st.qty, 10); if (!(qty >= 1)) throw new UErr('Indicá una cantidad válida.'); b.qty = qty;
  return b;
}
