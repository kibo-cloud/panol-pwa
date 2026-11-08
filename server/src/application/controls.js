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

// Técnico, asignaciones activas (bloqueadas en modo compartido) y catálogos para armar el documento.
// La plantilla es la del técnico el día del control (o el último día de un período ya pasado).
async function controlContext(c, techId, period, now = new Date()) {
  const t = (await c.query('SELECT id, name, active FROM techs WHERE id = $1', [techId])).rows[0];
  const plantillaId = t && period ? await plantillaOn(c, techId, controlRefDate(period, localDateISO(now))) : null;
  const asgs = (await c.query('SELECT id, tool_id, unit_id, qty FROM assignments WHERE tech_id = $1 AND active ORDER BY id FOR SHARE', [techId])).rows
    .map((r) => ({ id: r.id, techId, toolId: r.tool_id, unitId: r.unit_id, qty: r.qty }));
  const tools = Object.fromEntries((await c.query('SELECT id, name, category_id FROM tools WHERE id = ANY($1)', [asgs.map((a) => a.toolId)])).rows.map((r) => [r.id, { name: r.name, categoryId: r.category_id }]));
  const units = Object.fromEntries((await c.query('SELECT id, code FROM units WHERE id = ANY($1)', [asgs.map((a) => a.unitId).filter(Boolean)])).rows.map((r) => [r.id, { code: r.code }]));
  const categories = Object.fromEntries((await c.query('SELECT id, name FROM categories')).rows.map((r) => [r.id, { name: r.name }]));
  return { tech: t ? { id: t.id, name: t.name, plantillaId, active: t.active } : null, assignments: asgs, tools, units, categories };
}

const docOf = (ctx, period, items, status, correctionOf) =>
  buildControlDoc({ tech: ctx.tech, period, assignments: ctx.assignments, items, tools: ctx.tools, units: ctx.units, categories: ctx.categories, status, correctionOf });

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

// Crea el borrador original de un técnico y período, o el de una corrección (correctionOf).
export async function createControl(db, actor, input, { idempotencyKey, path, now = new Date(), demo = false } = {}) {
  return idempotent(db, { userId: actor.id, key: idempotencyKey, method: 'POST', path, body: input }, async (c) => {
    let techId;
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
      techId = src.techId;
      period = src.period;
      items = input.items ? mergeItems(plainItems(src.items), input.items) : plainItems(src.items);
      id = newId('k');
    } else {
      if (!input.techId || !input.period) throw rule('Elegí el técnico y el período.', 'invalid_input', 400);
      techId = input.techId;
      period = input.period;
      if (pnumOf(period) > pnumOf(periodOf(now))) throw rule('No se puede controlar un período futuro.', 'future_period');
      const ex = (await c.query('SELECT id, status FROM controls WHERE tech_id = $1 AND period_y = $2 AND period_m = $3 AND period_w = $4 AND NOT correction', [techId, period.y, period.m, period.w])).rows[0];
      if (ex) {
        const msg = ex.status === 'finalizado' ? 'Ya existe un control finalizado para ese período. Registrá una corrección.' : 'Ya hay un borrador de este control.';
        throw rule(msg, 'control_exists', 409, { current: await getOne(c, ex.id) });
      }
      items = mergeItems({}, input.items);
      const det = `c-${techId}-${pkeyOf(period)}`;
      id = validId(det) ? det : newId('c');
    }
    const ctx = await controlContext(c, techId, period, now);
    if (!ctx.tech || (!correctionOf && ctx.tech.active === false)) throw rule('Elegí un técnico activo.', 'inactive_tech');
    const doc = docOf(ctx, period, items, 'borrador', correctionOf);
    await saveControl(c, id, doc, { actorId: actor.id, startedAt: now, demo }).catch((e) => {
      if (e.code === '23505') throw rule('Ya hay un control original para ese técnico y período.', 'control_exists', 409);
      throw e;
    });
    const r = await response(c, id, 201);
    await record(c, actor, {
      action: correctionOf ? 'control_correct_start' : 'control_start', entity: 'controls', id, version: r.body.control.version, event: 'create',
      detail: `${correctionOf ? 'Inicio de corrección de control' : 'Inicio de control'}: ${ctx.tech.name}, ${plabel(period).toLowerCase()}`,
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
    const ctx = await controlContext(c, cur.techId, cur.period);
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
    const ctx = await controlContext(c, cur.techId, cur.period, now);
    if (!ctx.assignments.length) throw rule('Este técnico no tiene herramientas asignadas.', 'no_assignments');
    const v = validateFinalize(ctx.assignments, cur.items);
    if (!v.ok) throw rule(why(v), 'control_incomplete', 422, { pending: v.pending, missingNote: v.missingNote });
    const doc = docOf(ctx, cur.period, plainItems(cur.items), 'finalizado', cur.supersedes);
    await rewriteControl(c, id, doc, { finishedAt: now });
    const r = await response(c, id, 200);
    await record(c, actor, {
      action: cur.correction ? 'control_correct' : 'control_finish', entity: 'controls', id, version: r.body.control.version, event: 'finalize',
      detail: `${cur.correction ? 'Corrección de control' : 'Control finalizado'}: ${ctx.tech.name}, ${plabel(cur.period).toLowerCase()} (${doc.counts.cambio} para cambio, ${doc.counts.faltante} faltantes)`,
    });
    return r;
  });
}
