// "Entregar kit" (etapa 3) desde la ficha del técnico o de la caja: vista previa de lo que se
// entrega (entrega inicial o adicional por herramienta), unidades a elegir de las herramientas
// por código y problemas de stock; una sola confirmación registra un movimiento por herramienta
// (todo o nada en el servidor, con Idempotency-Key).
import { esc } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { ACT } from '../../ui/actions.js';
import { openModal, modalRerender, MOD } from '../../ui/modal.js';
import { toast, UErr } from '../../ui/feedback.js';
import { field, optList } from '../../ui/components.js';
import { api, newIdempotencyKey } from '../../api/index.js';
import { S, derive, can, refresh, holderName } from '../../state/store.js';
import { kitPreview, deliverBody } from '../../state/kits.js';

const holderOfKey = (hk) => (String(hk).startsWith('caja:') ? { cajaId: hk.slice(5) } : { techId: hk });

// Kits que se pueden entregar (con herramientas); primero el de la especialidad del técnico.
export function deliverableKits(hk) {
  const d = derive(); const t = S.techs[hk];
  const list = d.kits.filter((k) => (k.items || []).length);
  const mine = t && t.especialidadId ? list.find((k) => k.especialidadId === t.especialidadId) : null;
  return mine ? [mine, ...list.filter((k) => k !== mine)] : list;
}
export const canDeliverKit = (hk) => can('movements_do') && deliverableKits(hk).length > 0;

function chosenOf(st, kit) {
  const out = {};
  for (const it of kit.items) {
    const ids = Object.keys(st).filter((k) => k.startsWith(`u:${it.toolId}:`) && st[k]).map((k) => k.slice(`u:${it.toolId}:`.length));
    if (ids.length) out[it.toolId] = ids;
  }
  return out;
}
function previewOf(hk, st) {
  const d = derive(); const kit = S.kits[st.kitId] ? { id: st.kitId, ...S.kits[st.kitId] } : null; if (!kit) return { kit: null, pv: null };
  const held = new Set((d.asgByTech[hk] || []).map((a) => a.toolId));
  return { kit, pv: kitPreview(kit, { tools: S.tools, units: d.units, pools: d.pools, held }, chosenOf(st, kit)) };
}

function render(hk) {
  return (st) => {
    const kits = deliverableKits(hk); const { kit, pv } = previewOf(hk, st);
    // Al cambiar de kit se marcan las unidades sugeridas (las primeras disponibles por código).
    if (kit && st._init !== kit.id) {
      for (const k of Object.keys(st)) if (k.startsWith('u:')) delete st[k];
      for (const r of pv.rows) for (const id of r.chosen) st[`u:${r.toolId}:${id}`] = '1';
      st._init = kit.id;
    }
    let h = field('Kit', `<select id="kd-kit" data-mi="kitId" data-mr>${optList(kits.map((k) => [k.id, `${k.name} (${k.items.length} ${k.items.length === 1 ? 'herramienta' : 'herramientas'})`]), st.kitId)}</select>`, 'kd-kit');
    if (!pv) return h;
    h += `<div class="list kitpv">${pv.rows.map((r) => `<div class="row"><div class="grow"><div class="t">${esc(r.name)} ×${r.qty} <span class="chip ${r.kind === 'adicional' ? 'pri' : ''}">${r.kind === 'adicional' ? 'Adicional' : 'Entrega inicial'}</span></div><div class="s">${r.serialized ? `${r.available} ${r.available === 1 ? 'unidad disponible' : 'unidades disponibles'}` : `${r.available} disponibles`}</div>
      ${r.serialized && r.units.length && !r.problem.startsWith('se necesitan') ? `<div class="unitpick" role="group" aria-label="Unidades de ${esc(r.name)}">${r.units.map((u) => `<label class="check"><input type="checkbox" data-mi="u:${esc(r.toolId)}:${esc(u.id)}" data-mr ${st[`u:${r.toolId}:${u.id}`] ? 'checked' : ''}>${esc(u.code)}</label>`).join('')}</div>` : ''}
      ${r.problem ? `<div class="s kitprob">${icon('alert', 12)} ${esc(r.problem)}</div>` : ''}</div>${r.problem ? '<span class="chip bad">Falta stock</span>' : `<span class="chip ok">${icon('ok', 12)}Listo</span>`}</div>`).join('')}</div>`;
    h += pv.ok ? `<p class="hint ok" data-css="margin-top:12px">${icon('ok', 16)}<span>Se registran ${pv.movements} ${pv.movements === 1 ? 'movimiento' : 'movimientos'}, uno por herramienta${pv.rows.some((r) => r.serialized && r.qty > 1) ? ' (y uno por unidad en las de código)' : ''}.</span></p>`
      : `<p class="hint warn" data-css="margin-top:12px">${icon('alert', 16)}<span>No se puede entregar el kit completo: ${esc(pv.problems.join(' '))} No se entrega nada hasta resolverlo.</span></p>`;
    h += field('Motivo', `<input id="kd-reason" type="text" maxlength="2000" data-mi="reason" value="${esc(st.reason || '')}" placeholder="Opcional (por defecto: Entrega del kit)">`, 'kd-reason');
    return h;
  };
}

ACT.kitDeliver = (ds) => {
  const hk = ds.h; if (!can('movements_do')) { toast('Tu perfil no tiene permiso para esta acción.', 'err'); return; }
  const kits = deliverableKits(hk); if (!kits.length) { toast('No hay kits con herramientas. Armalos en Configuración de herramientas › Kits.', 'err'); return; }
  let last = null;
  openModal({ title: `Entregar kit a ${holderName(holderOfKey(hk))}`, render: render(hk), actions: [{ label: 'Cancelar', close: true }, { label: 'Entregar kit', kind: 'pri', run: async (st) => {
    const { kit, pv } = previewOf(hk, st);
    if (!kit) throw new UErr('Elegí un kit.');
    if (!pv.ok) throw new UErr(`No se puede entregar: ${pv.problems.join(' ')}`);
    const body = deliverBody(hk, pv, st.reason || '');
    const sig = JSON.stringify([kit.id, kit.version, body]); if (!last || last.sig !== sig) last = { sig, key: newIdempotencyKey() };
    const r = await api.deliverKit(kit.id, body, kit.version, { idempotencyKey: last.key });
    await refresh(); toast(`Kit entregado: ${r.movements.length} ${r.movements.length === 1 ? 'movimiento' : 'movimientos'}`);
  } }] });
  MOD.st.kitId = kits[0].id; modalRerender();
};
