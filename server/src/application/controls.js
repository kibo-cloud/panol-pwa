// Controles semanales: borrador (uno original por técnico y período), guardado automático de
// ítems con If-Match, finalización (después no se modifica) y corrección (registro nuevo que
// reemplaza al anterior, con los ítems copiados). Equivale a initCheck/saveDraft/ckFinish de 2.1.
import { loadControls, saveControl, rewriteControl } from '../adapters/pg/inventory-repo.js';
import { buildControlDoc, validateFinalize } from '../domain/controls.js';
import { DomainError, notFoundError } from '../domain/errors.js';
import { periodOf, pnumOf, pkeyOf, plabel, localDateISO } from '../domain/period.js';
import { controlRefDate } from '../domain/plantillas.js';
import { plantillaOn } from '../adapters/pg/plantilla-repo.js';
import { validId } from '../domain/constants.js';
import { newId } from './ids.js';
import { checkVersion, record, notifyChange } from './common.js';
import { idempotent } from './idempotency.js';

const rule = (msg, code = 'rule_violation', status = 422, extra) => Object.assign(new DomainError(msg, code, status), extra ? { extra } : {});
const getOne = async (c, id, lock = false) => (await loadControls(c, { id, lock }))[0] || null;
const finalizedError = (cur) => rule('El control ya está finalizado: se corrige con un registro nuevo.', 'control_finalized', 409, { current: cur });

// Poseedor (técnico o caja compartida), asignaciones activas (bloqueadas en modo compartido) y
// catálogos para armar el documento. La plantilla es la del técnico el día del control (o el
// último día de un período ya pasado); una caja no tiene plantilla.
async function controlContext(c, h, period, now = new Date()) {
  let tech = null;
  let caja = null;
  if (h.cajaId) {
    const k = (await c.query('SELECT id, name, archived_at FROM cajas WHERE id = $1', [h.cajaId])).rows[0];
    caja = k ? { id: k.id, name: k.name, active: !k.archived_at } : null;
  } else {
    const t = (await c.query('SELECT id, name, active FROM techs WHERE id = $1', [h.techId])).rows[0];
    const plantillaId = t && period ? await plantillaOn(c, h.techId, controlRefDate(period, localDateISO(now))) : null;
    tech = t ? { id: t.id, name: t.name, plantillaId, active: t.active } : null;
  }
  const col = h.cajaId ? 'caja_id' : 'tech_id';
  const asgs = (await c.query(`SELECT id, tool_id, unit_id, qty FROM assignments WHERE ${col} = $1 AND active ORDER BY id FOR SHARE`, [h.cajaId || h.techId])).rows
    .map((r) => ({ id: r.id, techId: h.techId ?? null, cajaId: h.cajaId ?? null, toolId: r.tool_id, unitId: r.unit_id, qty: r.qty }));
  const tools = Object.fromEntries((await c.query('SELECT id, name, category_id FROM tools WHERE id = ANY($1)', [asgs.map((a) => a.toolId)])).rows.map((r) => [r.id, { name: r.name, categoryId: r.category_id }]));
  const units = Object.fromEntries((await c.query('SELECT id, code FROM units WHERE id = ANY($1)', [asgs.map((a) => a.unitId).filter(Boolean)])).rows.map((r) => [r.id, { code: r.code }]));
  const categories = Object.fromEntries((await c.query('SELECT id, name FROM categories')).rows.map((r) => [r.id, { name: r.name }]));
  return { tech, caja, holder: tech || caja, assignments: asgs, tools, units, categories };
}

const docOf = (ctx, period, items, status, correctionOf) =>
  buildControlDoc({ tech: ctx.tech, caja: ctx.caja, period, assignments: ctx.assignments, items, tools: ctx.tools, units: ctx.units, categories: ctx.categories, status, correctionOf });

const plainItems = (items) => Object.fromEntries(Object.entries(items || {}).map(([k, v]) => [k, { state: v.state, note: v.note || '' }]));

function mergeItems(base, patch) {
  const out = { ...base };
  for (const [aid, v] of Object.entries(patch || {})) {
    if (v == null) delete out[aid];
    else out[aid] = { state: v.state, note: v.note || '' };
  }
  return out;
}

const response = async (c, id, status) => ({ status, body: { control: await getOne(c, id) } });

// Crea el borrador original de un poseedor (técnico o caja) y período, o el de una corrección
// (correctionOf).
export async function createControl(db, actor, input, { idempotencyKey, path, now = new Date(), demo = false } = {}) {
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: input }, async (c) => {
    let holder;
    let period;
    let items;
    let id;
    const correctionOf = input.correctionOf || null;
    if (correctionOf) {
      const src = await getOne(c, correctionOf);
      if (!src) throw notFoundError('No se encontró el control a corregir.');
      if (src.status !== 'finalizado') throw rule('Solo se corrige un control finalizado.', 'not_finalized');
      const ex = (await c.query("SELECT id FROM controls WHERE supersedes_id = $1 AND status = 'borrador' ORDER BY updated_at DESC LIMIT 1", [correctionOf])).rows[0];
      if (ex) throw rule('Ya hay una corrección en curso de este control.', 'control_exists', 409, { current: await getOne(c, ex.id) });
      holder = { techId: src.techId, cajaId: src.cajaId };
      period = src.period;
      items = input.items ? mergeItems(plainItems(src.items), input.items) : plainItems(src.items);
      id = newId('k');
    } else {
      if ((!input.techId && !input.cajaId) || !input.period) throw rule('Elegí el técnico o la caja y el período.', 'invalid_input', 400);
      if (input.techId && input.cajaId) throw rule('Elegí un técnico o una caja, no los dos.', 'invalid_input');
      holder = input.cajaId ? { cajaId: input.cajaId } : { techId: input.techId };
      period = input.period;
      if (pnumOf(period) > pnumOf(periodOf(now))) throw rule('No se puede controlar un período futuro.', 'future_period');
      const col = holder.cajaId ? 'caja_id' : 'tech_id';
      const ex = (await c.query(`SELECT id, status FROM controls WHERE ${col} = $1 AND period_y = $2 AND period_m = $3 AND period_w = $4 AND NOT correction`, [holder.cajaId || holder.techId, period.y, period.m, period.w])).rows[0];
      if (ex) {
        const msg = ex.status === 'finalizado' ? 'Ya existe un control finalizado para ese período. Registrá una corrección.' : 'Ya hay un borrador de este control.';
        throw rule(msg, 'control_exists', 409, { current: await getOne(c, ex.id) });
      }
      items = mergeItems({}, input.items);
      const det = holder.cajaId ? `c-caja-${holder.cajaId}-${pkeyOf(period)}` : `c-${holder.techId}-${pkeyOf(period)}`;
      id = validId(det) ? det : newId('c');
    }
    const ctx = await controlContext(c, holder, period, now);
    if (!ctx.holder || (!correctionOf && ctx.holder.active === false)) throw rule(holder.cajaId ? 'Elegí una caja activa.' : 'Elegí un técnico activo.', 'inactive_tech');
    const doc = docOf(ctx, period, items, 'borrador', correctionOf);
    await saveControl(c, id, doc, { actorId: actor.id, startedAt: now, demo }).catch((e) => {
      if (e.code === '23505') throw rule(`Ya hay un control original para ${holder.cajaId ? 'esa caja' : 'ese técnico'} y período.`, 'control_exists', 409);
      throw e;
    });
    const r = await response(c, id, 201);
    await record(c, actor, {
      action: correctionOf ? 'control_correct_start' : 'control_start', entity: 'controls', id, version: r.body.control.version, event: 'create',
      detail: `${correctionOf ? 'Inicio de corrección de control' : 'Inicio de control'}: ${ctx.holder.name}, ${plabel(period).toLowerCase()}`,
    });
    return r;
  });
}

// Guardado del borrador: combina los ítems enviados (null quita uno) con los guardados.
export async function saveDraft(db, actor, id, input, version, { idempotencyKey, path } = {}) {
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'PATCH', path, body: { input, version } }, async (c) => {
    const cur = await getOne(c, id, true);
    if (cur && cur.status === 'finalizado') throw finalizedError(cur);
    checkVersion(cur, version, 'No se encontró el control.');
    const ctx = await controlContext(c, { techId: cur.techId, cajaId: cur.cajaId }, cur.period);
    const doc = docOf(ctx, cur.period, mergeItems(plainItems(cur.items), input.items), 'borrador', cur.supersedes);
    await rewriteControl(c, id, doc);
    const r = await response(c, id, 200);
    await notifyChange(c, { entity: 'controls', id, version: r.body.control.version, action: 'update' });
    return r;
  });
}

const why = (v) => {
  const n = v.pending.length;
  if (n) return `Falta${n === 1 ? '' : 'n'} ${n} ${n === 1 ? 'herramienta' : 'herramientas'} por controlar.`;
  const k = v.missingNote.length;
  return `Completá el motivo de ${k === 1 ? '1 faltante' : k + ' faltantes'}.`;
};

export async function finalizeControl(db, actor, id, version, { idempotencyKey, path, now = new Date() } = {}) {
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: { version } }, async (c) => {
    const cur = await getOne(c, id, true);
    if (cur && cur.status === 'finalizado') throw finalizedError(cur);
    checkVersion(cur, version, 'No se encontró el control.');
    const ctx = await controlContext(c, { techId: cur.techId, cajaId: cur.cajaId }, cur.period, now);
    if (!ctx.assignments.length) throw rule(cur.cajaId ? 'Esta caja no tiene herramientas asignadas.' : 'Este técnico no tiene herramientas asignadas.', 'no_assignments');
    const v = validateFinalize(ctx.assignments, cur.items);
    if (!v.ok) throw rule(why(v), 'control_incomplete', 422, { pending: v.pending, missingNote: v.missingNote });
    const doc = docOf(ctx, cur.period, plainItems(cur.items), 'finalizado', cur.supersedes);
    await rewriteControl(c, id, doc, { finishedAt: now });
    const r = await response(c, id, 200);
    await record(c, actor, {
      action: cur.correction ? 'control_correct' : 'control_finish', entity: 'controls', id, version: r.body.control.version, event: 'finalize',
      detail: `${cur.correction ? 'Corrección de control' : 'Control finalizado'}: ${ctx.holder.name}, ${plabel(cur.period).toLowerCase()} (${doc.counts.cambio} para cambio, ${doc.counts.faltante} faltantes)`,
    });
    return r;
  });
}
