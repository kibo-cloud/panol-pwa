// Conteo por cantidad y limpieza del control (etapa 4), con las mismas reglas que el servidor
// (server/src/domain/controls.js). Puro: se prueba con node --test.
// - Con 1 unidad el ítem es { state } (Bueno / Cambio / Faltante).
// - Con más de 1 es { good, change, expected }: en buen estado, para recambio y la cantidad con
//   la que se contó; las que faltan son el resto. "Para recambio" nunca cuenta como faltante.
// - Estado derivado: faltante si falta alguna, si no cambio si alguna requiere recambio, si no bueno.

export const CLEAN = { limpio: { label: 'Limpio', cls: 'ok' }, requiere_limpieza: { label: 'Requiere limpieza', cls: 'warn' } };
export const CLEAN_QUICK = ['Herramientas con grasa', 'Caja sucia', 'Restos de material', 'Polvo y viruta'];

export const itemState = ({ good = 0, change = 0, missing = 0 } = {}) => (missing > 0 ? 'faltante' : change > 0 ? 'cambio' : 'bueno');
export const quantitiesOfState = (state, qty) => ({ good: state === 'bueno' ? qty : 0, change: state === 'cambio' ? qty : 0, missing: state === 'faltante' ? qty : 0 });
const isCount = (v) => Number.isInteger(v) && v >= 0;

// Cantidades de un ítem del checklist para una asignación de `expected` unidades, o null si está
// pendiente (sin contar, contado con otra cantidad asignada o con números que no cierran).
export function itemQty(it, expected) {
  if (!it) return null;
  if (it.expected != null && it.expected !== expected) return null;
  if (it.good != null || it.change != null) {
    if (!isCount(it.good) || !isCount(it.change) || it.good + it.change > expected) return null;
    return { good: it.good, change: it.change, missing: expected - it.good - it.change };
  }
  return it.state && ['bueno', 'cambio', 'faltante'].includes(it.state) ? quantitiesOfState(it.state, expected) : null;
}

// Falta o requiere recambio alguna unidad (un ítem guardado sin cantidades usa su estado).
export const hasMissing = (it) => !!it && (it.missing > 0 || (!it.expected && it.state === 'faltante'));
export const hasChange = (it) => !!it && (it.change > 0 || (!it.expected && it.state === 'cambio'));

// Unidades de una asignación activa según su último control efectivo (como el servidor): si la
// cantidad asignada cambió desde ese control, todas las unidades toman el estado del ítem.
export function asgUnits(s, qty) {
  if (!s || !s.state) return { bueno: 0, cambio: 0, faltante: 0, pendiente: qty };
  const q = s.expected === qty && s.good != null ? s : quantitiesOfState(s.state, qty);
  return { bueno: q.good, cambio: q.change, faltante: q.missing, pendiente: 0 };
}

// Ítem guardado en el servidor -> ítem del checklist.
export function checklistItem(v, expected) {
  if (!v || !v.state) return null;
  const base = { note: v.note || '', lineaId: v.lineaId || null };
  if (expected > 1 && v.good != null) return { ...base, good: v.good, change: v.change, expected: v.expected ?? expected };
  return { ...base, state: v.state, ...(v.expected != null ? { expected: v.expected } : {}) };
}

// Ítem del checklist -> cuerpo del pedido (sin campos vacíos; la línea solo con faltantes o recambios).
export function apiItem(it, expected) {
  const q = itemQty(it, expected);
  const lineaId = q && q.missing + q.change > 0 ? it.lineaId || null : null;
  const out = it.good != null || it.change != null ? { good: it.good, change: it.change, expected: it.expected ?? expected } : { state: it.state, ...(it.expected != null ? { expected: it.expected } : {}) };
  return { ...out, note: it.note || '', lineaId };
}

// Resumen del checklist: unidades por estado, herramientas pendientes, faltantes sin motivo y
// la limpieza (null = bien, 'pending' = sin indicar, 'note' = requiere limpieza sin nota).
// list: asignaciones activas [{ id, qty }]; items: por asignación; cleaning: { status, note }.
export function ckSummary(list, items, cleaning) {
  const c = { bueno: 0, cambio: 0, faltante: 0, pendiente: 0, pendUnits: 0, noNote: 0, alerts: 0, n: list.length, first: null };
  for (const a of list) {
    const exp = a.qty || 1;
    const it = items[a.id];
    const q = itemQty(it, exp);
    if (!q) { c.pendiente++; c.pendUnits += exp; if (!c.first) c.first = a.id; continue; }
    c.bueno += q.good; c.cambio += q.change; c.faltante += q.missing;
    if (q.missing > 0) c.alerts++;
    if (q.change > 0) c.alerts++;
    if (q.missing > 0 && !String(it.note || '').trim()) { c.noNote++; if (!c.first) c.first = a.id; }
  }
  const st = cleaning && CLEAN[cleaning.status] ? cleaning.status : null;
  c.cleaning = !st ? 'pending' : st === 'requiere_limpieza' && !String(cleaning.note || '').trim() ? 'note' : null;
  return c;
}

// Por qué no se puede finalizar (vacío si se puede), con el orden del servidor.
export function ckWhy(c, offline = false) {
  if (c.pendiente) return `Falta${c.pendiente === 1 ? '' : 'n'} ${c.pendiente} ${c.pendiente === 1 ? 'herramienta' : 'herramientas'} por controlar`;
  if (c.noNote) return `Completá el motivo de ${c.noNote === 1 ? '1 faltante' : c.noNote + ' faltantes'}`;
  if (c.cleaning === 'pending') return 'Indicá la limpieza de herramientas y caja';
  if (c.cleaning === 'note') return 'Completá la nota de limpieza';
  return offline ? 'Sin conexión: el control se finaliza cuando vuelva la conexión' : '';
}

// Limpieza de controles efectivos: limpios, que requieren limpieza y % limpio (null sin datos).
export function cleaningStats(cs) {
  const limpio = cs.filter((c) => c.cleaning && c.cleaning.status === 'limpio').length;
  const sucio = cs.filter((c) => c.cleaning && c.cleaning.status === 'requiere_limpieza').length;
  return { limpio, sucio, pctLimpio: limpio + sucio ? Math.round((limpio / (limpio + sucio)) * 100) : null };
}

// Faltantes y recambios (unidades) por línea de los controles dados, como el servidor: las líneas
// en su orden, después las que ya no existen y al final "Sin línea" (id null).
export function lossesByLinea(controls, lineas) {
  const by = {};
  for (const c of controls) for (const it of Object.values(c.items || {})) {
    if (!hasMissing(it) && !hasChange(it)) continue;
    const g = (by[it.lineaId || ''] ||= { faltante: 0, cambio: 0 });
    g.faltante += it.missing ?? (it.state === 'faltante' ? it.qty || 1 : 0);
    g.cambio += it.change ?? (it.state === 'cambio' ? it.qty || 1 : 0);
  }
  return [
    ...lineas.filter((l) => by[l.id]).map((l) => ({ id: l.id, name: l.name, kind: l.kind, ...by[l.id] })),
    ...Object.keys(by).filter((k) => k && !lineas.some((l) => l.id === k)).map((k) => ({ id: k, name: k, kind: null, ...by[k] })),
    ...(by[''] ? [{ id: null, name: 'Sin línea', kind: null, ...by[''] }] : []),
  ];
}

// Texto de cantidades de un ítem guardado con más de 1 unidad ("3 bien · 1 para recambio · 1 faltan").
export function qtyText(it) {
  if (!it || !(it.expected > 1) || it.good == null) return '';
  return [it.good ? `${it.good} bien` : '', it.change ? `${it.change} para recambio` : '', it.missing ? `${it.missing} ${it.missing === 1 ? 'falta' : 'faltan'}` : ''].filter(Boolean).join(' · ');
}
