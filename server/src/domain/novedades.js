// Novedades (etapa 6): reglas puras. Una novedad es una entrada fechada del diario del pañol:
// la fecha y hora las pone el servidor, el autor es quien la carga, el comentario es obligatorio
// y los temas (técnico, plantilla, línea o sector) son opcionales e independientes. Se puede
// vincular a una entrega o una reposición (la solicitud de compra llega en la etapa 7).
import { DomainError, notFoundError, tooLong } from './errors.js';
import { LIM } from './constants.js';

// Movimientos que se pueden vincular: las entregas (inicial y adicional) y las reposiciones.
export const LINKABLE_TYPES = ['entrega_inicial', 'adicional', 'reposicion'];
export const SUBJECTS = ['techId', 'plantillaId', 'lineaId'];

const rule = (msg, code, status = 422) => new DomainError(msg, code, status);

function cleanComment(v) {
  const c = String(v ?? '').trim();
  if (!c) throw rule('Escribí el comentario de la novedad.', 'comment_required');
  tooLong(c, LIM.text, 'El comentario');
  return c;
}

/**
 * Datos de una novedad nueva o de una edición (partial: solo lo que viene; null quita un tema).
 * Los ids se validan contra la base en el caso de uso.
 */
export function cleanNovedad(input = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || input.comment !== undefined) out.comment = cleanComment(input.comment);
  for (const k of SUBJECTS) {
    if (!partial) out[k] = input[k] || null;
    else if (input[k] !== undefined) out[k] = input[k] || null;
  }
  return out;
}

// El movimiento a vincular: una entrega o reposición que no sea una anulación ni esté anulada.
export function checkLinkable(mv, voidedBy) {
  if (!mv) throw notFoundError('No se encontró el movimiento a vincular.');
  if (!LINKABLE_TYPES.includes(mv.type)) throw rule('Solo se puede vincular una entrega o una reposición.', 'invalid_movement');
  if (voidedBy) throw rule('Ese movimiento está anulado: no se puede vincular.', 'movement_voided', 409);
}

// perms: { create, edit } del actor. El autor edita la suya si puede cargar novedades.
export const canEditNovedad = (actor, n, perms) => !!perms.edit || (!!perms.create && !!actor && n.authorId === actor.id);

// Campos que cambian en una edición, con el valor anterior (para la auditoría).
export function editChanges(cur, next) {
  const out = {};
  for (const k of ['comment', ...SUBJECTS]) {
    if (next[k] === undefined) continue;
    const from = cur[k] ?? null;
    const to = next[k] ?? null;
    if (from !== to) out[k] = { from, to };
  }
  return out;
}

// Etiqueta corta (la que se escribe para eliminar definitivamente).
export const novedadLabel = (seq) => `Novedad ${seq}`;

// ---------------------------------------------------------------- filtros de la lista
// La consulta por período es la que reusa la impresión de auditoría (etapa 10).
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([A-Za-z0-9_.~:@+-]{1,200})$/;

function day(v, what) {
  if (v == null || v === '') return null;
  const m = DAY_RE.exec(String(v));
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw rule(`La fecha ${what} no es válida.`, 'invalid_date', 400);
  return String(v);
}

/**
 * Filtros de GET /api/novedades: from/to (días locales, inclusive), temas, autor, movimiento,
 * texto (q), linked (true: vinculadas, false: sin vínculo), archived (exclude | include | only),
 * limit (1..200) y before (cursor `<occurredAt ISO>|<id>` de la página anterior).
 */
export function parseNovedadFilters(q = {}) {
  const from = day(q.from, 'desde');
  const to = day(q.to, 'hasta');
  if (from && to && from > to) throw rule('La fecha desde es posterior a la fecha hasta.', 'invalid_range', 400);
  let before = null;
  if (q.before) {
    const m = CURSOR_RE.exec(String(q.before));
    if (!m) throw rule('Cursor de novedades inválido.', 'invalid_cursor', 400);
    before = { at: m[1], id: m[2] };
  }
  const n = Number(q.limit || 50);
  return {
    from, to,
    techId: q.techId || null, plantillaId: q.plantillaId || null, lineaId: q.lineaId || null, authorId: q.authorId || null, movementId: q.movementId || null,
    q: String(q.q || '').trim(),
    linked: q.linked === 'yes' ? true : q.linked === 'no' ? false : null,
    archived: ['include', 'only'].includes(q.archived) ? q.archived : 'exclude',
    limit: Math.max(1, Math.min(200, Number.isFinite(n) ? Math.floor(n) : 50)),
    before,
  };
}
