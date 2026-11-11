// Entregas y reposiciones (igual que 2.1). El servidor valida stock y arma las
// transferencias; cada envío lleva su Idempotency-Key. Etapa 2: el poseedor puede ser un
// técnico o una caja compartida (valor `caja:<id>` en el formulario).
import { $, esc, setHTML } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render, freshMv } from '../../ui/registry.js';
import { ACT, IN, CH } from '../../ui/actions.js';
import { openModal, modalRerender, MOD } from '../../ui/modal.js';
import { act, toast, UErr } from '../../ui/feedback.js';
import { pageHead, field, optList, techOptions, stChip, mvList } from '../../ui/components.js';
import { gateUI } from '../tecnicos/view.js';
import { api, newIdempotencyKey } from '../../api/index.js';
import { S, derive, can, refresh, toolName, holderName } from '../../state/store.js';
import { holderKey, holderBody } from '../../state/plantillas.js';
import { ST, REASONS } from '../../state/constants.js';
import { fdate } from '../../state/period.js';
import { receivableFor } from '../../state/compras.js';

const MV_HELP = { entrega_inicial: 'El técnico recibe una herramienta por primera vez. Se crea la asignación y se descuenta del inventario disponible.', reposicion: 'El técnico recibe una herramienta nueva a cambio de una dañada o faltante. Ambos movimientos quedan vinculados.', adicional: 'El técnico recibe otra unidad de una herramienta que ya tiene.', devolucion: 'El técnico devuelve una herramienta asignada. Vuelve al inventario según su condición.', retiro: 'Se retira una herramienta de la asignación del técnico.' };
const SUBMIT = { entrega_inicial: 'Registrar entrega', reposicion: 'Registrar reposición', adicional: 'Registrar entrega adicional', devolucion: 'Registrar devolución', retiro: 'Registrar retiro' };
function optBtns(k, v, opts) { return `<div class="opts">${opts.map(([val, l]) => `<button type="button" class="opt ${String(v) === String(val) ? 'on' : ''}" data-act="mvSet" data-k="${esc(k)}" data-v="${esc(val)}">${l}</button>`).join('')}</div>`; }
function stepper(v, max) { return `<div class="stepper"><button type="button" data-act="mvStep" data-d="-1" aria-label="Restar uno">${icon('minus', 18)}</button><input id="mvqty" type="number" min="1" ${max ? `max="${esc(max)}"` : ''} inputmode="numeric" data-in="mvQty" value="${esc(v)}" aria-label="Cantidad"><button type="button" data-act="mvStep" data-d="1" aria-label="Sumar uno">${icon('plus', 18)}</button></div>`; }

function mvForm() {
  const d = derive(); const m = UI.mv;
  let h = `<div class="seg" role="tablist" data-css="margin-bottom:10px">${[['entrega_inicial', 'Entrega inicial'], ['reposicion', 'Reposición'], ['adicional', 'Adicional'], ['devolucion', 'Devolución'], ['retiro', 'Retiro']].map(([k, l]) => `<button role="tab" aria-selected="${m.type === k}" class="${m.type === k ? 'on' : ''}" data-act="mvType" data-v="${esc(k)}">${l}</button>`).join('')}</div><p class="muted sm" data-css="margin:0 0 14px">${MV_HELP[m.type]}</p>`;
  h += field('Técnico o caja que recibe o devuelve', `<select id="mvtech" data-ch="mvTech">${techOptions(m.techId, 'Elegí un técnico o una caja', true)}</select>`, 'mvtech');
  if (m.type === 'entrega_inicial' || m.type === 'adicional') {
    const tools = d.tools.filter((t) => t.active !== false);
    h += field('Herramienta', `<select id="mvtool" data-ch="mvTool">${optList(tools.map((t) => [t.id, `${t.name}${t.serialized ? ' (por código)' : ''}`]), m.toolId, 'Elegí una herramienta')}</select>`, 'mvtool');
    const tool = S.tools[m.toolId];
    if (tool) {
      if (tool.serialized) { const av = (d.unitsByTool[m.toolId] || []).filter((u) => u.status === 'disponible'); h += av.length ? field(`Unidad a entregar <span class="muted">(${av.length} disponibles)</span>`, `<select id="mvunit" data-ch="mvUnit">${optList(av.map((u) => [u.id, u.code]), m.unitId, 'Elegí el código')}</select>`, 'mvunit') : '<p class="hint warn">No hay unidades disponibles de esta herramienta. Dá de alta unidades nuevas en Inventario.</p>'; } else { const disp = (d.pools[m.toolId] || {}).disponible || 0; h += field(`Cantidad <span class="muted">(disponibles: ${disp})</span>`, stepper(m.qty || 1), 'mvqty'); if (!disp) h += '<p class="hint warn">No hay stock disponible. Registrá un ingreso en Inventario.</p>'; }
    }
  } else if (m.techId) {
    const list = d.asgByTech[m.techId] || [];
    if (!list.length) h += `<p class="hint">${String(m.techId).startsWith('caja:') ? 'Esta caja' : 'Este técnico'} no tiene herramientas asignadas.</p>`;
    else {
      const lab = (a) => { const s = d.stateOf[a.id]; const u = a.unitId && S.units[a.unitId]; return `${toolName(a.toolId)}${u ? ' ' + u.code : ''}${a.qty > 1 ? ' ×' + a.qty : ''}, ${(ST[s ? s.state : 'pendiente']).label.toLowerCase()}`; };
      const sorted = m.type === 'reposicion' ? list.slice().sort((a, b) => { const r = (x) => ({ faltante: 0, cambio: 1 }[(d.stateOf[x.id] || {}).state] ?? 2); return r(a) - r(b); }) : list;
      h += field('Herramienta asignada', `<select id="mvasg" data-ch="mvAsg">${optList(sorted.map((a) => [a.id, lab(a)]), m.asgId, 'Elegí la herramienta')}</select>`, 'mvasg');
      const a = S.assignments[m.asgId];
      if (a && a.active && holderKey(a) === m.techId) {
        const s = d.stateOf[m.asgId]; const tool = S.tools[a.toolId] || {};
        if (m.type === 'reposicion') {
          const u = a.unitId && S.units[a.unitId]; let entra = '';
          if (tool.serialized) { const av = (d.unitsByTool[a.toolId] || []).filter((x) => x.status === 'disponible'); entra = av.length ? field('Código de la unidad nueva', `<select id="mvnew" data-ch="mvNewUnit">${optList(av.map((x) => [x.id, x.code]), m.newUnitId, 'Elegí el código')}</select>`, 'mvnew') : '<p class="hint warn" data-css="margin:0">No hay unidades disponibles para reponer. Dá de alta unidades en Inventario.</p>'; } else { const disp = (d.pools[a.toolId] || {}).disponible || 0; entra = `<div><span class="t" data-css="display:block">${esc(tool.name || '')}${(a.qty || 1) > 1 ? ' ×' + (a.qty || 1) : ''}</span><span class="s">Disponibles en inventario: ${disp}</span></div>${disp < (a.qty || 1) ? '<p class="hint warn" data-css="margin:0">No hay stock suficiente. Registrá un ingreso en Inventario.</p>' : ''}`; }
          h += `<div class="swapc"><div class="part"><span class="cap">Sale</span><div data-css="display:flex;align-items:center;gap:10px"><span class="grow"><span class="t" data-css="display:block">${esc(tool.name || 'Herramienta')}</span><span class="s">${[u ? u.code : '', (a.qty || 1) > 1 ? (a.qty) + ' unidades' : '', s && s.at ? 'marcado en control del ' + fdate(s.at) : 'sin control previo'].filter(Boolean).map(esc).join(' · ')}</span></span>${stChip(s ? s.state : 'pendiente')}</div>${s && s.note ? `<span class="s">${esc(s.note)}</span>` : ''}</div><div class="part"><span class="cap">Entra</span>${entra}</div></div>`;
          // Etapa 7: la herramienta que entra puede venir de una compra recibida de este poseedor.
          const rec = receivableFor(S.purchases, m.techId, a.toolId);
          if (rec.length) h += field('Compra recibida que se entrega (opcional)', `<select id="mvpr" data-ch="mvPurchase">${optList(rec.map((p) => [p.id, `${p.name}, recibida el ${fdate(p.receivedAt)}`]), m.purchaseRequestId, 'Sin vincular a una compra')}</select>`, 'mvpr');
          h += field('¿Devolvió la herramienta dañada?', `<div class="two-btn">${[['1', 'Sí, la devolvió'], ['0', 'No, queda pendiente']].map(([v, l]) => { const on = (m.returned ? '1' : '0') === v; return `<button type="button" class="opt2 ${on ? 'on' : ''}" aria-pressed="${on}" data-act="mvSet" data-k="returned" data-v="${esc(v)}">${l}</button>`; }).join('')}</div>`);
          if (m.returned) h += field('Destino de la herramienta dañada', optBtns('oldDest', m.oldDest, [['reparacion', 'Enviar a reparación'], ['baja', 'Dar de baja']]));
          else h += `<p class="hint warn">${icon('alert', 16)}<span>Se crea una alerta de devolución pendiente.</span></p>`;
          h += `<p class="hint">${icon('hist', 16)}<span>La unidad que sale y la que entra quedan vinculadas en el historial, junto con el control donde se marcó.</span></p>`;
        }
        if (m.type === 'devolucion') {
          if (!a.unitId && (a.qty || 1) > 1) h += field(`Cantidad que devuelve <span class="muted">(tiene ${a.qty})</span>`, stepper(m.qty || a.qty, a.qty), 'mvqty');
          h += field('Condición de lo devuelto', optBtns('cond', m.cond, [['disponible', 'Buen estado, vuelve a disponible'], ['reparacion', 'Necesita reparación'], ['baja', 'Para dar de baja']]));
        }
      }
    }
  }
  h += field('Motivo', `<input id="mvreason" type="text" maxlength="2000" data-in="mvReason" value="${esc(m.reason || '')}" placeholder="Motivo de la ${m.type === 'devolucion' ? 'devolución' : m.type === 'retiro' ? 'baja de asignación' : 'entrega'}"><div class="quick">${(REASONS[m.type] || []).map((r) => `<button type="button" class="qchip" data-act="mvReasonQ" data-q="${esc(r)}">${esc(r)}</button>`).join('')}</div>`, 'mvreason');
  h += field('Observaciones', `<textarea id="mvnotes" maxlength="2000" data-in="mvNotes" rows="2" placeholder="Opcional">${esc(m.notes || '')}</textarea>`, 'mvnotes');
  h += `<button class="btn ${m.type === 'reposicion' ? 'dark' : 'pri'} lg block" data-act="mvSubmit">${SUBMIT[m.type]}</button>`;
  return h;
}

VIEWS.entregas = () => {
  const d = derive(); const f = UI.mvFilter;
  const movs = d.movs.filter((m) => f === 'all' || m.type === f || (f === 'inv' && ['ingreso', 'reparado', 'baja', 'recupero', 'recepcion'].includes(m.type)));
  const pend = d.pendingReturns;
  return pageHead('Entregas y reposiciones', 'Cada movimiento actualiza asignaciones e inventario sin borrar el historial', { acts: can('movements_do') ? `<button class="btn pri" data-act="asgNew">${icon('plus', 16)}Asignar herramienta</button>` : '' }) +
  `<div class="two" data-css="margin-top:0">${can('movements_do') ? `<section class="card" id="mvform">${mvForm()}</section>` : '<section class="card"><p class="muted" data-css="margin:0">Tu perfil no puede registrar movimientos. Podés consultar el historial.</p></section>'}
  <section><div class="card" data-css="margin-bottom:12px"><div class="srow"><h2 class="si">Pendientes de devolución</h2><span class="chip ${pend.length ? 'bad' : ''}">${pend.length}</span></div>${pend.length ? `<div class="list">${pend.map((m) => `<div class="row"><div class="grow"><div class="t">${esc(toolName(m.toolId))}${m.oldUnitId && S.units[m.oldUnitId] ? ' ' + esc(S.units[m.oldUnitId].code) : ''}${m.qty > 1 ? ' ×' + m.qty : ''}</div><div class="s">${esc(holderName(m))}, repuesta el ${fdate(m.at)}</div></div>${can('movements_do') ? `<button class="btn sm" data-act="recvPending" data-m="${esc(m.id)}">Recibir</button>` : ''}</div>`).join('')}</div>` : '<p class="muted sm" data-css="margin:0">No hay herramientas pendientes de devolución.</p>'}</div>
  <div class="srow"><h2 class="si">Historial de movimientos</h2></div>
  <div class="fchips" data-css="margin-bottom:10px">${[['all', 'Todos'], ['entrega_inicial', 'Iniciales'], ['reposicion', 'Reposiciones'], ['adicional', 'Adicionales'], ['devolucion', 'Devoluciones'], ['retiro', 'Retiros'], ['inv', 'Inventario']].map(([k, l]) => `<button class="fchip ${f === k ? 'on' : ''}" data-act="mvFilter" data-v="${esc(k)}">${l}</button>`).join('')}</div>
  ${mvList(movs.slice(0, 80))}${movs.length > 80 ? `<p class="muted sm">Mostrando los 80 más recientes de ${movs.length}.</p>` : ''}</section></div>`;
};

function mvRerender() { const el = $('#mvform'); if (el) setHTML(el, mvForm()); }
ACT.mvFilter = (ds) => { UI.mvFilter = ds.v; render(); };
ACT.goEntrega = (ds) => { UI.mv = freshMv({ techId: ds.t }); location.hash = '#entregas'; };
ACT.goRepo = (ds) => { UI.mv = freshMv({ type: 'reposicion', techId: ds.t, asgId: ds.a }); if (location.hash === '#entregas') render(); else location.hash = '#entregas'; };
ACT.mvType = (ds) => { UI.mv = freshMv({ type: ds.v, techId: UI.mv.techId }); mvRerender(); };
ACT.mvSet = (ds) => { UI.mv[ds.k] = ds.k === 'returned' ? ds.v === '1' : ds.v; mvRerender(); };
ACT.mvReasonQ = (ds) => { UI.mv.reason = ds.q; const el = $('#mvreason'); if (el) el.value = ds.q; };
ACT.mvStep = (ds) => { const el = $('#mvqty'); if (!el) return; let v = (parseInt(el.value, 10) || 1) + (+ds.d); v = Math.max(1, v); if (el.max) v = Math.min(+el.max, v); el.value = v; UI.mv.qty = v; };
CH.mvTech = (v) => { UI.mv.techId = v; UI.mv.asgId = ''; mvRerender(); };
CH.mvTool = (v) => { UI.mv.toolId = v; UI.mv.unitId = ''; UI.mv.qty = 1; mvRerender(); };
CH.mvUnit = (v) => { UI.mv.unitId = v; };
CH.mvNewUnit = (v) => { UI.mv.newUnitId = v; };
CH.mvPurchase = (v) => { UI.mv.purchaseRequestId = v; };
CH.mvAsg = (v) => { UI.mv.asgId = v; UI.mv.newUnitId = ''; UI.mv.purchaseRequestId = ''; const a = S.assignments[v]; UI.mv.qty = a ? a.qty : 1; mvRerender(); };
IN.mvQty = (v) => { UI.mv.qty = v; }; IN.mvReason = (v) => { UI.mv.reason = v; }; IN.mvNotes = (v) => { UI.mv.notes = v; };

// Arma el pedido para POST /api/movements a partir del formulario (sin campos vacíos).
export function movementBody(m) {
  const isCaja = String(m.techId || '').startsWith('caja:');
  const holder = isCaja ? S.cajas[m.techId.slice(5)] : S.techs[m.techId];
  if (!holder || holder.active === false || holder.archivedAt) throw new UErr('Elegí un técnico activo o una caja.');
  const b = { type: m.type, ...holderBody(m.techId), reason: (m.reason || '').trim(), notes: (m.notes || '').trim() };
  const qty = () => { const q = parseInt(m.qty, 10); if (!(q >= 1)) throw new UErr('Indicá una cantidad válida.'); return q; };
  if (m.type === 'entrega_inicial' || m.type === 'adicional') {
    const tool = S.tools[m.toolId]; if (!tool || tool.active === false) throw new UErr('Elegí una herramienta activa.');
    b.toolId = m.toolId;
    if (tool.serialized) { if (!m.unitId) throw new UErr('Elegí una unidad disponible.'); b.unitId = m.unitId; } else b.qty = qty();
    return b;
  }
  const a = S.assignments[m.asgId]; if (!a || !a.active || holderKey(a) !== m.techId) throw new UErr(`Elegí una herramienta asignada ${isCaja ? 'a la caja' : 'al técnico'}.`);
  b.asgId = m.asgId;
  if (m.type === 'reposicion' && m.purchaseRequestId) b.purchaseRequestId = m.purchaseRequestId;
  if (m.type === 'reposicion') { b.returned = !!m.returned; if (m.returned) b.oldDest = m.oldDest || 'reparacion'; if ((S.tools[a.toolId] || {}).serialized) { if (!m.newUnitId) throw new UErr('Elegí la unidad nueva que recibe.'); b.newUnitId = m.newUnitId; } }
  if (m.type === 'devolucion') { b.cond = m.cond || 'disponible'; if (!a.unitId && (a.qty || 1) > 1) b.qty = qty(); }
  return b;
}

// La misma clave mientras el formulario no cambie: un doble toque o un reintento no duplica.
let pendingKey = null;
ACT.mvSubmit = async () => {
  if (!gateUI('movements_do')) return;
  const m = { ...UI.mv };
  const ok = await act(async () => {
    const body = movementBody(m); const sig = JSON.stringify(body);
    if (!pendingKey || pendingKey.sig !== sig) pendingKey = { sig, key: newIdempotencyKey() };
    await api.movement(body, { idempotencyKey: pendingKey.key }); pendingKey = null;
    await refresh(); return true;
  }, 'Movimiento registrado');
  if (ok) { UI.mv = freshMv({ type: m.type, techId: m.techId }); render(); }
};

ACT.recvPending = (ds) => {
  const mv = S.movements[ds.m]; if (!mv || !gateUI('movements_do')) return;
  let last = null;
  openModal({ title: 'Recibir herramienta pendiente', render: (st) => `<p class="muted" data-css="margin-top:0">${esc(toolName(mv.toolId))}${mv.oldUnitId && S.units[mv.oldUnitId] ? ' ' + esc(S.units[mv.oldUnitId].code) : ''}, de ${esc(holderName(mv))}.</p>${field('¿En qué condición vuelve?', `<div class="opts">${[['reparacion', 'Necesita reparación'], ['disponible', 'Buen estado, vuelve a disponible'], ['baja', 'Dar de baja (perdida o inservible)']].map(([v, l]) => `<button type="button" class="opt ${st.dest === v ? 'on' : ''}" data-act="mset" data-k="dest" data-v="${esc(v)}">${l}</button>`).join('')}</div>`)}${field('Observaciones', `<input id="f-rn" type="text" maxlength="2000" data-mi="notes" value="${esc(st.notes || '')}">`, 'f-rn')}`,
    actions: [{ label: 'Cancelar', close: true }, { label: 'Registrar', kind: 'pri', run: async (st) => {
      if (derive().pendingReturns.every((x) => x.id !== ds.m)) throw new UErr('Ya fue registrada.');
      const body = { type: 'recepcion', resolvesMovementId: ds.m, cond: st.dest || 'reparacion', notes: (st.notes || '').trim() }; const sig = JSON.stringify(body);
      if (!last || last.sig !== sig) last = { sig, key: newIdempotencyKey() };
      await api.movement(body, { idempotencyKey: last.key });
      await refresh(); toast('Devolución registrada');
    } }] });
  MOD.st.dest = 'reparacion'; modalRerender();
};
