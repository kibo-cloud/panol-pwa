// Etapa 6: Novedades. Pantalla con la lista filtrada en el servidor (período, técnico, plantilla,
// línea, autor, texto, vínculo y eliminadas), hoja Nueva/Editar novedad, las últimas del técnico
// en su ficha y "Agregar novedad" en una entrega o reposición. Solo con conexión: sin conexión la
// hoja lo avisa y conserva el texto. Eliminar, restaurar y eliminar definitivamente usan el modelo
// genérico de registros (records/view.js, tipo `novedades`). Los cambios de otros llegan por SSE
// (la recarga del estado vuelve a pedir la lista abierta).
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { VIEWS, UI, render } from '../../ui/registry.js';
import { ACT, IN, CH } from '../../ui/actions.js';
import { openModal, modalRerender, MOD } from '../../ui/modal.js';
import { toast, UErr, tooLong, errMsg } from '../../ui/feedback.js';
import { pageHead, emptyBox, field, optList, mvRow } from '../../ui/components.js';
import { deleteBtn, canDelete } from '../records/view.js';
import { hooks } from '../../ui/app.js';
import { api, newIdempotencyKey } from '../../api/index.js';
import { net } from '../../api/net.js';
import { S, derive, can, ME, who, markArchived } from '../../state/store.js';
import { LIM, mvLabel } from '../../state/constants.js';
import { fdt } from '../../state/period.js';
import { parseRoute } from '../../ui/router.js';
import { NOV_EMPTY, novQuery, canEditNov, novSubjects, activeFilters } from '../../state/novedades.js';

const PAGE = 30;
const OFFLINE_TXT = 'Sin conexión con el servidor: las novedades se ven y se cargan cuando vuelve la conexión.';
// Lista abierta (key = filtros pedidos), últimas por técnico y las novedades conocidas por id.
const NOV = { list: null, next: null, total: 0, key: null, errKey: null, error: '', loading: false, again: false, byId: {}, tech: {} };
UI.nov = { ...NOV_EMPTY };

const failText = (e) => (e && (e.kind === 'network' || e.kind === 'offline') ? OFFLINE_TXT : errMsg(e));
const remember = (list) => { for (const n of list) NOV.byId[n.id] = n; };

async function loadList({ force = false, more = false } = {}) {
  const key = novQuery(UI.nov);
  if (NOV.loading) { NOV.again = NOV.again || force || key !== NOV.key; return; }
  if (!force && !more && (NOV.key === key || NOV.errKey === key)) return;
  NOV.loading = true;
  try {
    // Al recargar la misma lista se piden las que ya se veían (hasta 200).
    const limit = more ? PAGE : force && NOV.key === key && NOV.list ? Math.min(200, Math.max(PAGE, NOV.list.length)) : PAGE;
    const r = await api.novedades(novQuery(UI.nov, { limit, before: more ? NOV.next : '' }));
    remember(r.novedades);
    if (key === novQuery(UI.nov)) {
      NOV.list = more && NOV.list ? [...NOV.list, ...r.novedades] : r.novedades;
      NOV.next = r.next; NOV.total = r.total; NOV.key = key; NOV.errKey = null; NOV.error = '';
    } else NOV.again = true;
  } catch (e) {
    console.warn(e);
    NOV.error = failText(e); NOV.errKey = key;
    if (NOV.key !== key) NOV.list = null;
  } finally {
    NOV.loading = false;
    if (NOV.again) { NOV.again = false; loadList({ force: true }); } else render();
  }
}

// Últimas novedades de un técnico (ficha).
async function loadTech(id, force = false) {
  const cur = NOV.tech[id];
  if (cur && (cur.loading || (!force && (cur.list || cur.err)))) return;
  NOV.tech[id] = { ...(cur || {}), loading: true };
  try {
    const r = await api.novedades(novQuery({ ...NOV_EMPTY, techId: id }, { limit: 5 }));
    remember(r.novedades);
    NOV.tech[id] = { list: r.novedades, total: r.total, err: '', loading: false };
  } catch (e) {
    NOV.tech[id] = { ...(NOV.tech[id] || {}), err: failText(e), loading: false };
  }
  render();
}

// Después de guardar o de un cambio en vivo: se vuelven a pedir las listas que se están viendo.
function reloadVisible() {
  if (!can('novedades_view')) return;
  const r = parseRoute(location.hash);
  if (r.name === 'novedades' && (NOV.list || NOV.errKey)) loadList({ force: true });
  else NOV.key = null;
  if (r.name === 'tecnico' && NOV.tech[r.id]) loadTech(r.id, true);
  for (const id of Object.keys(NOV.tech)) if (!(r.name === 'tecnico' && r.id === id)) delete NOV.tech[id];
}
hooks.afterState.push(reloadVisible);
// Al entrar a la pantalla se vuelve a pedir la lista (pudo cambiar mientras no se veía).
hooks.beforeRoute.push((r) => { if (r.name === 'novedades') { NOV.key = null; NOV.errKey = null; } });

// ------------------------------------------------------------------ fila
const authorOf = (n) => (n.authorId === ME.id ? who(n.authorId) : markArchived({ archived: n.authorArchived }, n.authorName || who(n.authorId)));
const SUB_IC = { tech: 'users', plantilla: 'clock', linea: 'box' };

export function novRow(n) {
  const subs = novSubjects(n).map((s) => `<a class="chip pri novsub" href="${esc(s.href)}">${icon(SUB_IC[s.kind], 12)}${esc(s.label)}</a>`).join('');
  const m = n.movement;
  const mv = m ? `<div class="s novmv">${icon('swap', 12)}<span>${esc(`${mvLabel(m.type)}: ${m.toolName || 'Herramienta'}${m.qty > 1 ? ' ×' + m.qty : ''}, ${fdt(m.at)}`)}</span>${m.voided ? `<span class="chip bad">${icon('x', 12)}Anulado</span>` : ''}</div>` : '';
  const acts = [
    canEditNov(n, ME.id, can) ? `<button class="btn sm" data-act="novEdit" data-id="${esc(n.id)}">${icon('pencil', 14)}Editar</button>` : '',
    !n.archived ? deleteBtn('novedades', n.id, { sm: true }) : '',
  ].join('');
  return `<div class="row novrow${n.archived ? ' novarch' : ''}" data-nov="${esc(n.id)}"><span class="tile novic">${icon('note', 18)}</span><div class="grow"><div class="s">${esc(`${fdt(n.occurredAt)} · ${authorOf(n)}`)}${n.archived ? ` <span class="chip pend">Eliminada</span>` : ''}</div><div class="t novtxt">${esc(n.comment)}</div>${subs ? `<div class="novsubs">${subs}</div>` : ''}${mv}</div>${acts ? `<span class="mvacts novacts">${acts}</span>` : ''}</div>`;
}

// ------------------------------------------------------------------ pantalla
const sel = (k, label, items, ph) => `<label class="novf" for="novf-${k}"><span>${label}</span><select id="novf-${k}" data-ch="novF" data-k="${k}">${optList(items, UI.nov[k], ph)}</select></label>`;

function filterBar() {
  const f = UI.nov; const d = derive();
  const techs = d.allTechs.map((t) => [t.id, markArchived(t, t.name)]);
  const pls = [...d.shifts, ...d.archivedPlantillas].map((p) => [p.id, markArchived(p, p.name)]);
  const lns = Object.entries(S.lineas || {}).map(([id, l]) => [id, markArchived(l, l.name)]).sort((a, b) => a[1].localeCompare(b[1]));
  const users = Object.entries(S.users || {}).map(([id, u]) => [id, markArchived(u, u.name)]).sort((a, b) => a[1].localeCompare(b[1]));
  const n = activeFilters(f);
  return `<div class="toolbar"><div class="search">${icon('search', 18)}<input id="novq" type="search" placeholder="Buscar en el comentario o los nombres" value="${esc(f.q)}" data-in="novQ" aria-label="Buscar novedades"></div></div>
  <div class="novfil">
    <label class="novf" for="novf-from"><span>Desde</span><input id="novf-from" type="date" value="${esc(f.from)}" data-ch="novF" data-k="from"></label>
    <label class="novf" for="novf-to"><span>Hasta</span><input id="novf-to" type="date" value="${esc(f.to)}" data-ch="novF" data-k="to"></label>
    ${sel('techId', 'Técnico', techs, 'Todos')}${sel('plantillaId', 'Plantilla', pls, 'Todas')}${sel('lineaId', 'Línea o sector', lns, 'Todas')}${sel('authorId', 'Autor', users, 'Todos')}
    ${sel('linked', 'Vínculo', [['yes', 'Vinculadas a un movimiento'], ['no', 'Sin vínculo']], 'Todas')}
  </div>
  <div class="fchips novchips">${canDelete('novedades') ? `<button class="fchip ${f.archived ? 'on' : ''}" data-act="novArch" aria-pressed="${f.archived}">Incluir eliminadas</button>` : ''}${n ? `<button class="btn sm" data-act="novClear">${icon('x', 14)}Limpiar filtros (${n})</button>` : ''}</div>`;
}

VIEWS.novedades = () => {
  if (!can('novedades_view')) return pageHead('Novedades', '') + `<p class="hint">${icon('info', 16)}<span>Tu perfil no puede ver las novedades.</span></p>`;
  loadList();
  const filtered = activeFilters(UI.nov) > 0;
  const sub = NOV.list ? `${NOV.total} ${NOV.total === 1 ? 'novedad' : 'novedades'}${filtered ? ' con estos filtros' : ''}` : 'Diario del pañol';
  const acts = can('novedades_create') ? `<button class="btn pri" data-act="novNew">${icon('plus', 16)}Nueva novedad</button>` : '';
  let body;
  if (!NOV.list && NOV.error) body = `<div class="banner warn" role="alert"><div><b>No se pudieron cargar las novedades.</b><div class="sm">${esc(NOV.error)}</div></div><div class="acts"><button class="btn sm" data-act="novRetry">Reintentar</button></div></div>`;
  else if (!NOV.list) body = '<div class="loading"><div class="spin"></div>Cargando novedades…</div>';
  else if (!NOV.list.length) body = `<div class="list">${emptyBox(filtered ? 'Ninguna novedad coincide' : 'Todavía no hay novedades', filtered ? 'Probá con otros filtros o limpialos.' : can('novedades_create') ? 'Cargá la primera con Nueva novedad.' : '')}</div>`;
  else body = `${NOV.error ? `<p class="hint warn">${icon('alert', 16)}<span>${esc(NOV.error)}</span></p>` : ''}<div class="list novlist">${NOV.list.map(novRow).join('')}</div>${NOV.next ? `<button class="btn block novmore" data-act="novMore">Ver más</button>` : ''}`;
  return pageHead('Novedades', esc(sub), { acts }) + filterBar() + body;
};

let qTimer = null;
IN.novQ = (v) => { UI.nov.q = v; clearTimeout(qTimer); qTimer = setTimeout(() => loadList(), 300); };
CH.novF = (v, el) => { UI.nov[el.dataset.k] = v; loadList(); render(); };
ACT.novArch = () => { UI.nov.archived = !UI.nov.archived; loadList(); render(); };
ACT.novClear = () => { UI.nov = { ...NOV_EMPTY }; loadList(); render(); };
ACT.novMore = () => loadList({ more: true });
ACT.novRetry = () => { NOV.errKey = null; loadList({ force: true }); render(); };

// ------------------------------------------------------------------ ficha del técnico
export function techNovCard(techId, archived) {
  if (!can('novedades_view')) return '';
  loadTech(techId);
  const st = NOV.tech[techId];
  const add = can('novedades_create') && !archived ? `<button class="btn sm" data-act="novNew" data-tech="${esc(techId)}">${icon('plus', 14)}Nueva novedad</button>` : '';
  const all = st && st.list && st.total > st.list.length ? `<button class="btn sm" data-act="novAllTech" data-tech="${esc(techId)}">Ver todas (${st.total})</button>` : '';
  let body;
  if (!st || (!st.list && !st.err)) body = '<div class="loading"><div class="spin"></div>Cargando…</div>';
  else if (!st.list) body = `<p class="muted sm mt0">${esc(st.err)}</p>`;
  else body = st.list.length ? `<div class="list">${st.list.map(novRow).join('')}</div>` : '<p class="muted sm mt0">Todavía no hay novedades sobre este técnico.</p>';
  return `<section class="card novcard"><div class="srow"><h2 class="si">Novedades registradas</h2><span class="novacts">${add}${all}</span></div>${body}</section>`;
}
ACT.novAllTech = (ds) => { UI.nov = { ...NOV_EMPTY, techId: ds.tech }; location.hash = '#novedades'; };

// ------------------------------------------------------------------ hoja Nueva / Editar
const stOf = (n) => ({ comment: n.comment || '', techId: n.techId || '', plantillaId: n.plantillaId || '', lineaId: n.lineaId || '' });

// Opciones activas, más el valor actual si ya no lo está (queda con la marca de eliminado).
function subjectOptions(k, cur) {
  const d = derive();
  let items;
  if (k === 'techId') items = d.activeTechs.map((t) => [t.id, t.name]);
  else if (k === 'plantillaId') items = d.shifts.map((p) => [p.id, p.name]);
  else items = Object.entries(S.lineas || {}).filter(([, l]) => !l.archived && !l.archivedAt).map(([id, l]) => [id, l.name]).sort((a, b) => a[1].localeCompare(b[1]));
  if (cur && cur[k] && !items.some(([id]) => id === cur[k])) {
    const name = k === 'techId' ? cur.techName : k === 'plantillaId' ? cur.plantillaName : cur.lineaName;
    items.unshift([cur[k], markArchived({ archived: cur[k.replace('Id', 'Archived')] }, name || cur[k])]);
  }
  return items;
}

function novForm(st, cur, mv, movementId) {
  const head = cur
    ? `<p class="muted mt0">${esc(`Registrada el ${fdt(cur.occurredAt)} por ${authorOf(cur)}. La fecha, el autor y el vínculo no cambian.`)}</p>`
    : `<p class="muted mt0">${esc(`La fecha y la hora se registran al guardar. Autor: ${who(ME.id)}.`)}</p>`;
  const off = net.offline ? `<div class="banner warn" role="status"><div><b>Sin conexión con el servidor.</b><div class="sm">La novedad se guarda cuando vuelva la conexión. El texto queda en esta hoja mientras no la cierres.</div></div></div>` : '';
  const link = mv ? `<div class="field"><label>Vinculada a</label><div class="list">${mvRow({ id: movementId, ...mv }, { plain: true })}</div></div>`
    : cur && cur.movement ? `<div class="field"><label>Vinculada a</label><p class="muted sm mt0">${esc(`${mvLabel(cur.movement.type)}: ${cur.movement.toolName || 'Herramienta'}, ${fdt(cur.movement.at)}`)}${cur.movement.voided ? ' (anulado)' : ''}</p></div>` : '';
  const s = (k, label, ph) => field(label, `<select id="nov-${k}" data-mi="${k}">${optList(subjectOptions(k, cur), st[k], ph)}</select>`, `nov-${k}`);
  return off + head + link + field('Comentario (obligatorio)', `<textarea id="nov-comment" rows="4" maxlength="${LIM.text}" data-mi="comment" placeholder="Qué pasó, a quién afecta, qué se hizo">${esc(st.comment || '')}</textarea>`, 'nov-comment') +
    `<p class="muted sm mt0">Técnico, plantilla y línea son opcionales: elegí los que correspondan.</p><div class="novsubjects">${s('techId', 'Técnico', 'Sin técnico')}${s('plantillaId', 'Plantilla', 'Sin plantilla')}${s('lineaId', 'Línea o sector', 'Sin línea ni sector')}</div>`;
}

export function openNovedad(o = {}) {
  const cur = o.id ? NOV.byId[o.id] : null;
  if (o.id && !cur) return;
  if (cur ? !canEditNov(cur, ME.id, can) : !can('novedades_create')) { toast('Tu perfil no tiene permiso para esta acción.', 'err'); return; }
  const mv = !cur && o.movementId ? S.movements[o.movementId] : null;
  // La misma clave mientras no cambie lo que se manda: un reintento no duplica la novedad.
  let key = newIdempotencyKey(); let sent = '';
  openModal({
    title: cur ? 'Editar novedad' : 'Nueva novedad',
    rec: cur ? { get: () => NOV.byId[o.id], version: cur.version } : undefined,
    reload: stOf,
    render: (st) => novForm(st, cur, mv, o.movementId),
    actions: [{ label: 'Cancelar', close: true }, { label: cur ? 'Guardar cambios' : 'Guardar novedad', kind: 'pri', run: async (st, m) => {
      const comment = String(st.comment || '').trim();
      if (!comment) throw new UErr('Escribí el comentario de la novedad.');
      tooLong(comment, LIM.text, 'El comentario');
      if (net.offline) throw new UErr('Sin conexión con el servidor: la novedad se guarda cuando vuelva la conexión. El texto queda en esta hoja.');
      const body = { comment, techId: st.techId || null, plantillaId: st.plantillaId || null, lineaId: st.lineaId || null };
      if (cur) {
        const r = await api.updateNovedad(cur.id, body, m.rec.version);
        NOV.byId[cur.id] = r.novedad;
      } else {
        const full = { ...body, ...(o.movementId ? { movementId: o.movementId } : {}) };
        const sig = JSON.stringify(full); if (sent && sent !== sig) key = newIdempotencyKey(); sent = sig;
        const r = await api.createNovedad(full, { idempotencyKey: key });
        NOV.byId[r.novedad.id] = r.novedad;
      }
      toast(cur ? 'Novedad guardada' : 'Novedad cargada');
      reloadVisible(); render();
    } }],
  });
  MOD.st = cur ? stOf(cur) : { comment: '', techId: o.techId || '', plantillaId: o.plantillaId || '', lineaId: o.lineaId || '' };
  modalRerender();
}
ACT.novNew = (ds) => openNovedad({ techId: ds.tech || '', plantillaId: ds.pl || '', movementId: ds.mv || '' });
ACT.novEdit = (ds) => openNovedad({ id: ds.id });
