// Compras (etapa 7): piezas puras del apartado de Gerencia (se prueban con node --test).

// Estado de una solicitud: texto, clase de color e ícono (nunca solo el color).
export const CMP_ST = {
  pendiente: { label: 'Pendiente', cls: 'warn', ic: 'clock' },
  aprobada: { label: 'Aprobada', cls: 'pri', ic: 'ok' },
  rechazada: { label: 'Rechazada', cls: 'bad', ic: 'x' },
  comprada: { label: 'Comprada', cls: 'pri', ic: 'box' },
  recibida: { label: 'Recibida', cls: 'ok', ic: 'ok' },
};
export const CMP_REASON = { cambio: 'Dañada (cambio)', faltante: 'Extraviada (faltante)' };
export const CMP_ORIGIN = { control: 'Control', tool: 'Ficha de la herramienta', alert: 'Alerta' };
export const OPEN = ['pendiente', 'aprobada', 'comprada'];

// Línea de tiempo (acciones de la auditoría de la solicitud).
export const TL_LABEL = {
  purchase_create: 'Alta', purchase_link: 'Vinculada a un control', purchase_approve: 'Aprobada', purchase_reject: 'Rechazada',
  purchase_purchase: 'Comprada', purchase_receive: 'Recibida', purchase_reposicion: 'Reposición vinculada', purchase_edit: 'Editada',
  purchase_archive: 'Eliminada (cancelada)', purchase_restore: 'Restaurada', purchase_resolved: 'Pérdida resuelta en un control',
  purchase_loss_gone: 'La pérdida ya no figura en un control', purchase_loss_back: 'La pérdida vuelve a figurar en un control',
};

// Filtros vacíos de la lista (holder: id de técnico o `caja:<id>`).
export const CMP_EMPTY = Object.freeze({ status: '', month: '', plantillaId: '', toolId: '', reason: '', q: '', holder: '', archived: false });
const KEYS = ['status', 'month', 'plantillaId', 'toolId', 'reason', 'q'];

export const activeCmpFilters = (f) => [...KEYS, 'holder'].filter((k) => String(f[k] || '').trim()).length + (f.archived ? 1 : 0);

// Query string de GET /api/compras; page = { limit, before, scope }.
export function cmpQuery(f, page = {}) {
  const parts = [];
  const add = (k, v) => parts.push(`${k}=${encodeURIComponent(v)}`);
  for (const k of KEYS) { const v = String(f[k] || '').trim(); if (v) add(k, v); }
  const h = String(f.holder || '');
  if (h.startsWith('caja:')) add('cajaId', h.slice(5)); else if (h) add('techId', h);
  if (f.archived) add('archived', 'include');
  if (page.scope) add('scope', page.scope);
  if (page.limit) add('limit', page.limit);
  if (page.before) add('before', page.before);
  return parts.join('&');
}

// Importe en pesos con dos decimales; sin dato, "Sin costo".
export const money = (n) => (n == null ? 'Sin costo' : '$ ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Costo estimado escrito en la hoja: vacío = sin dato; coma o punto decimal, hasta dos decimales.
export function parseCost(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{1,10}([.,]\d{1,2})?$/.test(s)) throw new Error('El costo estimado es un importe en pesos, con hasta dos decimales (por ejemplo 1500,50).');
  return s.replace(',', '.');
}

export const pendingCount = (summary) => (summary || []).filter((p) => p.status === 'pendiente').length;
export const toolPurchases = (summary, toolId) => (summary || []).filter((p) => p.toolId === toolId);

// Compras recibidas, sin reposición, de esa misma asignación (E7.V1: el servidor solo vincula la
// reposición de la asignación de la compra; una compra para stock no se ofrece).
export function receivableFor(summary, asgId) {
  if (!asgId) return [];
  return (summary || []).filter((p) => p.status === 'recibida' && p.assignmentId === asgId);
}

// E7.V1: una pendiente cuyo control más nuevo ya no muestra la pérdida (Gerencia lo ve antes de decidir).
export const lossGoneNote = (p) => (p && p.status === 'pendiente' && p.lossResolvedAt ? 'La pérdida ya no figura en el último control' : '');

// Marca de compra en una alerta de faltante o cambio.
export function alertPurchase(p) {
  if (!p) return null;
  const st = CMP_ST[p.status] || CMP_ST.pendiente;
  return { cls: st.cls, ic: st.ic, label: `Compra ${st.label.toLowerCase()}`, detail: p.status === 'rechazada' && p.decisionComment ? `Motivo: ${p.decisionComment}` : '', href: `#compra-${p.id}` };
}

// Acciones posibles sobre una solicitud (el servidor vuelve a revisar todo).
export function cmpActions(p, can) {
  const live = !!p && !p.archived;
  const st = p && p.status;
  return {
    approve: live && st === 'pendiente' && can('purchases_decide'),
    reject: live && st === 'pendiente' && can('purchases_decide'),
    purchase: live && st === 'aprobada' && (can('purchases_decide') || can('purchases_receive')),
    receive: live && (st === 'aprobada' || st === 'comprada') && can('purchases_receive'),
    edit: live && OPEN.includes(st) && (can('purchases_create') || can('purchases_decide')),
    qty: live && st === 'pendiente' && (can('purchases_create') || can('purchases_decide')),
    // E7.V1: costo y proveedor, solo quien los ve; después de la decisión, solo quien decide.
    cost: live && OPEN.includes(st) && can('purchases_view') && (st === 'pendiente' ? can('purchases_create') || can('purchases_decide') : can('purchases_decide')),
  };
}
