// Líneas de producción, sectores y cajas compartidas: catálogo (lineas_edit, bajas lógicas con
// If-Match), ficha de la caja con sus herramientas y controles, y "Asignar herramienta" en un
// solo formulario (técnico o caja, herramienta, cantidad o unidades) por POST /api/assignments.
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT } from '../../ui/actions.js';
import { openModal, modalRerender, MOD, confirmBox } from '../../ui/modal.js';
import { toast, act, UErr } from '../../ui/feedback.js';
import { kpi, pageHead, emptyBox, ctlBadge, stChip, mvList, field, optList, techOptions, weekCells, monthNav, qtyLine, cleanSummary } from '../../ui/components.js';
import { api, newIdempotencyKey } from '../../api/index.js';
import { S, derive, can, who, refresh, toolName, catName } from '../../state/store.js';
import { canDeliverKit } from '../kits/deliver.js';
import { LINEA_KIND } from '../../state/constants.js';
import { ST } from '../../state/constants.js';
import { fdate, fdt, plabel, prevMonth, nextMonth } from '../../state/period.js';
import { validateLinea, validateCaja, validateAssignment } from '../../state/plantillas.js';

const deny = () => toast('Tu perfil no tiene permiso para esta acción.', 'err');
const fail = (v) => { if (!v.ok) throw new UErr(v.error); return v.body; };
const refName = (k) => (k.referenteTechId && S.techs[k.referenteTechId] ? S.techs[k.referenteTechId].name : 'Sin referente');
const lineaName = (id) => (S.lineas[id] || {}).name || 'Sin línea';

VIEWS.lineas = () => {
  const d = derive(); const ed = can('lineas_edit'); const arch = UI.lineasArch;
  const lineas = d.lineas.filter((l) => !!l.archivedAt === arch); const cajas = d.cajas.filter((k) => !!k.archivedAt === arch);
  const acts = ed ? `<button class="btn" data-act="lineaNew">${icon('plus', 16)}Nueva línea o sector</button><button class="btn pri" data-act="cajaNew" ${d.lineas.some((l) => !l.archivedAt) ? '' : 'disabled aria-disabled="true"'}>${icon('plus', 16)}Nueva caja</button>` : '';
  const noLinea = ed && !d.lineas.some((l) => !l.archivedAt) ? '<p class="hint">Para crear una caja, primero creá la línea o el sector donde está.</p>' : '';
  return pageHead('Líneas y cajas', 'Líneas de producción, sectores y cajas compartidas con su referente', { acts }) + noLinea + (!ed ? '<p class="hint">Tu perfil puede consultar esta sección pero no modificarla.</p>' : '') +
  `<div class="fchips" data-css="margin-bottom:12px"><button class="fchip ${arch ? '' : 'on'}" data-act="lineasArch" data-v="0" aria-pressed="${!arch}">Activas</button><button class="fchip ${arch ? 'on' : ''}" data-act="lineasArch" data-v="1" aria-pressed="${arch}">Archivadas</button></div>
  <h2 class="sec" data-css="margin-top:0">Líneas y sectores</h2>${lineas.length ? `<div class="list">${lineas.map((l) => { const n = d.cajas.filter((k) => k.lineaId === l.id && !k.archivedAt).length; return `<div class="row"><div class="grow"><div class="t">${esc(l.name)} <span class="chip pri">${LINEA_KIND[l.kind] || esc(l.kind)}</span></div><div class="s">Orden ${esc(l.order ?? 0)} · ${n} ${n === 1 ? 'caja' : 'cajas'}</div></div>${ed && !l.archivedAt ? `<div class="r"><button class="btn sm" data-act="lineaEdit" data-l="${esc(l.id)}">Editar</button>${n ? '' : `<button class="btn sm danger" data-act="lineaArchive" data-l="${esc(l.id)}">Archivar</button>`}</div>` : ''}</div>`; }).join('')}</div>` : `<div class="list">${emptyBox(arch ? 'No hay líneas archivadas' : 'Todavía no hay líneas ni sectores', arch ? '' : 'Cargá las líneas de producción y los sectores de la planta.', ed && !arch ? '<button class="btn pri" data-act="lineaNew">Nueva línea o sector</button>' : '')}</div>`}
  <h2 class="sec">Cajas compartidas</h2>${cajas.length ? `<div class="list">${cajas.map((k) => { const i = d.cajaInfo[k.id]; return `<a class="row" href="#caja-${esc(k.id)}"><span class="tile sm">${icon('box', 18)}</span><div class="grow"><div class="t ell">${esc(k.name)}</div><div class="s ell">${esc(lineaName(k.lineaId))} · ${esc(refName(k))} · ${i.total} herr.</div></div>${k.archivedAt ? '<span class="chip">Archivada</span>' : ctlBadge(i.curStatus)}${icon('right', 18)}</a>`; }).join('')}</div>` : `<div class="list">${emptyBox(arch ? 'No hay cajas archivadas' : 'Todavía no hay cajas compartidas', arch ? '' : 'Una caja agrupa herramientas de uso común de una línea, con un técnico referente.')}</div>`}`;
};
ACT.lineasArch = (ds) => { UI.lineasArch = ds.v === '1'; render(); };

// ------------------------------------------------------------------ líneas y sectores
const lineaForm = (st) => `${field('Nombre', `<input id="ln-name" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}" placeholder="Ej.: Línea 3, Sector envasado">`, 'ln-name')}${field('Tipo', `<div class="opts">${Object.entries(LINEA_KIND).map(([k, l]) => `<button type="button" class="opt ${st.kind === k ? 'on' : ''}" data-act="mset" data-k="kind" data-v="${esc(k)}">${l}</button>`).join('')}</div>`)}${field('Orden en las listas', `<input id="ln-order" type="number" min="0" max="1000" inputmode="numeric" data-mi="order" value="${esc(st.order ?? '')}">`, 'ln-order')}`;
const orderOf = (st) => { if (st.order === '' || st.order == null) return undefined; const n = Number(st.order); if (!Number.isInteger(n) || n < 0 || n > 1000) throw new UErr('El orden tiene que ser un número entre 0 y 1000.'); return n; };
ACT.lineaNew = () => {
  if (!can('lineas_edit')) return deny();
  openModal({ title: 'Nueva línea o sector', render: lineaForm, actions: [{ label: 'Cancelar', close: true }, { label: 'Crear', kind: 'pri', run: async (st) => {
    const body = fail(validateLinea(st, derive().lineas.filter((l) => !l.archivedAt))); const o = orderOf(st); if (o !== undefined) body.order = o;
    await api.createLinea(body); await refresh(); toast(st.kind === 'sector' ? 'Sector creado' : 'Línea creada');
  } }] });
  MOD.st.kind = 'linea'; modalRerender();
};
ACT.lineaEdit = (ds) => {
  const l = S.lineas[ds.l]; if (!l || !can('lineas_edit')) return deny();
  openModal({ title: 'Editar línea o sector', render: lineaForm, rec: { get: () => S.lineas[ds.l], version: l.version }, reload: (cur) => ({ name: cur.name, kind: cur.kind, order: cur.order }), actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar', kind: 'pri', run: async (st, m) => {
    const body = fail(validateLinea(st, derive().lineas.filter((x) => !x.archivedAt && x.id !== ds.l))); const o = orderOf(st); if (o !== undefined) body.order = o;
    await api.updateLinea(ds.l, body, m.rec.version); await refresh(); toast('Cambios guardados');
  } }] });
  MOD.st = { name: l.name, kind: l.kind, order: l.order }; modalRerender();
};
ACT.lineaArchive = async (ds) => {
  const l = S.lineas[ds.l]; if (!l || !can('lineas_edit')) return deny();
  if (!await confirmBox('Archivar', `${esc(l.name)} deja de aparecer en las listas. Su historial se conserva.`, 'Archivar', 'danger')) return;
  await act(async () => { await api.archiveLinea(ds.l, l.version); await refresh(); }, 'Archivada');
};

// ------------------------------------------------------------------ cajas
const cajaForm = (st) => { const d = derive(); return `${field('Nombre de la caja', `<input id="cj-name" type="text" maxlength="120" data-mi="name" value="${esc(st.name || '')}" placeholder="Ej.: Caja línea 3">`, 'cj-name')}${field('Línea o sector', `<select id="cj-linea" data-mi="lineaId">${optList(d.lineas.filter((l) => !l.archivedAt || l.id === st.lineaId).map((l) => [l.id, `${l.name} (${LINEA_KIND[l.kind] || l.kind})`]), st.lineaId, 'Elegí la línea o el sector')}</select>`, 'cj-linea')}${field('Técnico referente', `<select id="cj-ref" data-mi="referenteTechId">${techOptions(st.referenteTechId || '', 'Sin referente')}</select>`, 'cj-ref')}<p class="muted sm" data-css="margin-top:-6px">El referente es el responsable de la caja: recibe sus alertas en la ficha de la caja.</p>`; };
ACT.cajaNew = () => {
  if (!can('lineas_edit')) return deny();
  openModal({ title: 'Nueva caja compartida', render: cajaForm, actions: [{ label: 'Cancelar', close: true }, { label: 'Crear caja', kind: 'pri', run: async (st) => {
    const body = fail(validateCaja(st, derive().cajas.filter((k) => !k.archivedAt)));
    const r = await api.createCaja(body); await refresh(); toast('Caja creada'); location.hash = '#caja-' + r.caja.id;
  } }] });
  const first = derive().lineas.find((l) => !l.archivedAt); if (first) { MOD.st.lineaId = first.id; modalRerender(); }
};
ACT.cajaEdit = (ds) => {
  const k = S.cajas[ds.k]; if (!k || !can('lineas_edit')) return deny();
  const stOf = (c) => ({ name: c.name, lineaId: c.lineaId, referenteTechId: c.referenteTechId || '' });
  openModal({ title: 'Editar caja', render: cajaForm, rec: { get: () => S.cajas[ds.k], version: k.version }, reload: stOf, actions: [{ label: 'Cancelar', close: true }, { label: 'Guardar', kind: 'pri', run: async (st, m) => {
    const body = fail(validateCaja(st, derive().cajas.filter((x) => !x.archivedAt && x.id !== ds.k)));
    await api.updateCaja(ds.k, body, m.rec.version); await refresh(); toast('Cambios guardados');
  } }] });
  MOD.st = stOf(k); modalRerender();
};
ACT.cajaArchive = async (ds) => {
  const k = S.cajas[ds.k]; if (!k || !can('lineas_edit')) return deny();
  if (!await confirmBox('Archivar caja', `${esc(k.name)} deja de aparecer en las listas y en los controles. Su historial se conserva.`, 'Archivar', 'danger')) return;
  const ok = await act(async () => { await api.archiveCaja(ds.k, k.version); await refresh(); return true; }, 'Caja archivada');
  if (ok) location.hash = '#lineas';
};

VIEWS.caja = (id) => {
  const d = derive(); const k = S.cajas[id]; if (!k) return pageHead('Caja no encontrada', '', { back: '#lineas' });
  const hk = 'caja:' + id; const i = d.cajaInfo[id]; const list = d.asgByTech[hk] || []; const live = !k.archivedAt; const tab = UI.cajaTab;
  if (!UI.techMonth) UI.techMonth = { y: d.cur.y, m: d.cur.m };
  const acts = [can('controls_do') && list.length && live ? `<a class="btn pri" href="#control-${esc(hk)}">${icon('check', 18)}Controlar</a>` : '', can('movements_do') && live ? `<button class="btn" data-act="asgNew" data-h="${esc(hk)}">${icon('plus', 16)}Asignar herramienta</button>${canDeliverKit(hk) ? `<button class="btn" data-act="kitDeliver" data-h="${esc(hk)}">${icon('box', 16)}Entregar kit</button>` : ''}` : '', can('lineas_edit') && live ? `<button class="btn" data-act="cajaEdit" data-k="${esc(id)}">Editar</button>` : ''].join('');
  let body = '';
  if (tab === 'tools') body = list.length ? cleanSummary(hk) + `<div class="list">${list.map((a) => { const s = d.stateOf[a.id]; const st = s ? s.state : 'pendiente'; const u = a.unitId && S.units[a.unitId]; return `<a class="row" href="#herramienta-${esc(a.toolId)}"><span class="light ${ST[st].cls}"></span><div class="grow"><div class="t ell">${esc(toolName(a.toolId))}${a.qty > 1 ? ` ×${a.qty}` : ''}</div><div class="s ell">${[catName((S.tools[a.toolId] || {}).categoryId), u ? 'Código ' + u.code : '', 'desde ' + fdate(a.since)].filter(Boolean).map(esc).join(', ')}</div>${qtyLine(s, a)}${s && s.note ? `<div class="s">${esc(s.note)}</div>` : ''}</div>${stChip(st)}</a>`; }).join('')}</div>` : `<div class="list">${emptyBox('Sin herramientas asignadas', 'Asigná herramientas a la caja para poder controlarla.', can('movements_do') && live ? `<button class="btn pri" data-act="asgNew" data-h="${esc(hk)}">Asignar herramienta</button>` : '')}</div>`;
  else if (tab === 'ctl') {
    const cl = d.ctls.filter((c) => c.cajaId === id).sort((a, b) => (b.finishedAt || b.updatedAt || '').localeCompare(a.finishedAt || a.updatedAt || ''));
    body = `<div class="card" data-css="margin-bottom:12px"><div class="srow"><h2 class="si">Calendario de controles</h2>${monthNav(UI.techMonth.y, UI.techMonth.m, 'cajaMonth')}</div>${weekCells(hk, UI.techMonth.y, UI.techMonth.m)}</div>` + (cl.length ? `<div class="list">${cl.map((c) => `<a class="row" href="#controlver-${esc(c.id)}"><span class="light ${c.status === 'finalizado' ? 'ok' : 'warn'}"></span><div class="grow"><div class="t">${plabel(c.period)}${c.correction ? ' (corrección)' : ''}</div><div class="s">${c.status === 'finalizado' ? 'Finalizado ' + fdt(c.finishedAt) : 'Borrador, guardado ' + fdt(c.updatedAt)}, ${esc(who(c.by))}</div></div></a>`).join('')}</div>` : `<div class="list">${emptyBox('Todavía no tiene controles', '')}</div>`);
  } else body = mvList(d.movs.filter((m) => m.cajaId === id));
  const archBox = can('lineas_edit') && live ? `<section class="card" data-css="margin-top:12px"><h2 class="si">Archivar caja</h2>${list.length ? `<p class="muted sm" data-css="margin:6px 0 10px">Para archivarla, registrá antes la devolución o el retiro de sus ${list.length} ${list.length === 1 ? 'herramienta' : 'herramientas'}.</p><button class="btn danger" disabled aria-disabled="true">Archivar</button>` : `<button class="btn danger" data-css="margin-top:8px" data-act="cajaArchive" data-k="${esc(id)}">Archivar</button>`}</section>` : '';
  return `<a class="backl" href="#lineas">${icon('back', 16)}Líneas y cajas</a><div class="card" data-css="margin-bottom:12px"><div class="prof"><span class="tile">${icon('box', 20)}</span><div class="grow"><h1>${esc(k.name)}</h1><div class="s">${esc(lineaName(k.lineaId))} · Referente: ${esc(refName(k))}</div></div><span class="chip ${live ? 'ok' : 'pend'}">${live ? 'Activa' : 'Archivada'}</span></div>${acts ? `<div class="toolbar" data-css="margin:0">${acts}</div>` : ''}</div>
  <section class="kpis">${kpi(i.total, 'Herramientas asignadas')}${kpi(i.bueno, 'En buen estado', '', 'ok')}${kpi(i.cambio, 'Para cambio', '', 'warn')}${kpi(i.faltante, 'Faltantes', '', 'bad')}</section>
  <div class="tabs" role="tablist">${[['tools', 'Herramientas'], ['ctl', 'Controles'], ['mov', 'Movimientos']].map(([key, l]) => `<button role="tab" aria-selected="${tab === key}" class="${tab === key ? 'on' : ''}" data-act="cajaTab" data-v="${esc(key)}">${l}</button>`).join('')}</div>${body}${archBox}`;
};
ACT.cajaTab = (ds) => { UI.cajaTab = ds.v; render(); };
ACT.cajaMonth = (ds) => { UI.techMonth = +ds.d < 0 ? prevMonth(UI.techMonth.y, UI.techMonth.m) : nextMonth(UI.techMonth.y, UI.techMonth.m); render(); };

// ------------------------------------------------------------------ asignar herramienta
// Un solo formulario: quién recibe (técnico o caja), herramienta, cantidad o unidades.
ACT.asgNew = (ds = {}) => {
  if (!can('movements_do')) return deny();
  let last = null;
  openModal({ title: 'Asignar herramienta',
    render: (st) => {
      const d = derive(); const tool = st.toolId && S.tools[st.toolId] ? { id: st.toolId, ...S.tools[st.toolId] } : null;
      let h = field('Técnico o caja que recibe', `<select id="as-holder" data-mi="holder" data-mr>${techOptions(st.holder || '', 'Elegí un técnico o una caja', true)}</select>`, 'as-holder');
      h += field('Herramienta', `<select id="as-tool" data-mi="toolId" data-mr>${optList(d.tools.filter((t) => t.active !== false).map((t) => [t.id, `${t.name}${t.serialized ? ' (por código)' : ''}`]), st.toolId, 'Elegí una herramienta')}</select>`, 'as-tool');
      if (tool && tool.serialized) {
        const av = (d.unitsByTool[tool.id] || []).filter((u) => u.status === 'disponible');
        h += av.length ? field(`Unidades a asignar <span class="muted">(${av.length} disponibles)</span>`, `<div class="unitpick">${av.map((u) => `<label class="check"><input type="checkbox" data-mi="u:${esc(u.id)}" ${st['u:' + u.id] ? 'checked' : ''}>${esc(u.code)}</label>`).join('')}</div>`) : '<p class="hint warn">No hay unidades disponibles de esta herramienta. Dá de alta unidades nuevas en Inventario.</p>';
      } else if (tool) {
        const disp = (d.pools[tool.id] || {}).disponible || 0;
        h += field(`Cantidad <span class="muted">(disponibles: ${disp})</span>`, `<input id="as-qty" type="number" min="1" ${disp ? `max="${esc(disp)}"` : ''} inputmode="numeric" data-mi="qty" value="${esc(st.qty ?? 1)}">`, 'as-qty');
        if (!disp) h += '<p class="hint warn">No hay stock disponible. Registrá un ingreso en Inventario.</p>';
      }
      const has = st.holder && tool && (d.asgByTech[st.holder] || []).some((a) => a.toolId === tool.id);
      if (has) h += `<p class="hint">${icon('info', 16)}<span>Ya tiene esta herramienta: se registra como entrega adicional.</span></p>`;
      h += field('Motivo', `<input id="as-reason" type="text" maxlength="2000" data-mi="reason" value="${esc(st.reason || '')}" placeholder="Opcional">`, 'as-reason');
      return h;
    },
    actions: [{ label: 'Cancelar', close: true }, { label: 'Asignar', kind: 'pri', run: async (st) => {
      const d = derive(); const tool = st.toolId && S.tools[st.toolId] ? { id: st.toolId, ...S.tools[st.toolId] } : null;
      const unitIds = Object.keys(st).filter((k) => k.startsWith('u:') && st[k]).map((k) => k.slice(2));
      const body = fail(validateAssignment({ holder: st.holder, qty: st.qty ?? 1, unitIds, reason: st.reason }, { tool: tool && tool.active !== false ? tool : null, available: tool ? (d.pools[tool.id] || {}).disponible || 0 : 0, availableUnitIds: tool ? (d.unitsByTool[tool.id] || []).filter((u) => u.status === 'disponible').map((u) => u.id) : [] }));
      const sig = JSON.stringify(body); if (!last || last.sig !== sig) last = { sig, key: newIdempotencyKey() };
      await api.assign(body, { idempotencyKey: last.key });
      await refresh(); toast('Herramienta asignada');
    } }] });
  if (ds.h) { MOD.st.holder = ds.h; modalRerender(); }
};
