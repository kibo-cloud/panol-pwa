// Etapa 9: importar el Excel anterior de herramientas (.xlsx / .xlsm), con el permiso
// `import_excel` (solo admin por defecto).
// - Vista previa: lee el libro como datos (sin macros), arma el plan contra el estado del
//   servidor SIN escribir nada y devuelve cada caso con su id estable (aceptar u omitir donde
//   tiene sentido) y un token = hash del archivo + versión del plan (las operaciones y las
//   decisiones que resultan).
// - Confirmar: el mismo archivo, el token y las mismas decisiones. En UNA transacción
//   (SERIALIZABLE) se vuelve a armar el plan con el estado actual; si el token no coincide
//   (cambió el servidor o las decisiones) se pide volver a previsualizar. El mismo archivo
//   (mismo hash) no se importa dos veces.
// - Lo importado lleva `import_batch_id` (técnicos y herramientas creados, movimientos,
//   controles y novedades) y los movimientos y controles `imported`. El lote queda en
//   `import_batches` y en la auditoría solo con cantidades.
// - Los controles importados se escriben ya finalizados, sin pasar por finalizeControl: no
//   crean solicitudes de compra (la creación automática de la etapa 7 es de los controles hechos
//   en la app) ni auditan cada movimiento (el lote se audita una vez).
import crypto from 'node:crypto';
import { withSnapshot } from '../adapters/pg/state-repo.js';
import { loadInventoryContext, applyMovementPlan, saveControl } from '../adapters/pg/inventory-repo.js';
import { loadKits } from '../adapters/pg/kits-repo.js';
import { lockName } from '../adapters/pg/catalog-repo.js';
import { readExcelBook, planExcelImport, caseCounts, WorkbookError, PLAN_VERSION, MISSING_NOTE, NOTES } from '../importers/excel-v1/index.js';
import { planMovement } from '../domain/movements.js';
import { buildControlDoc } from '../domain/controls.js';
import { localDateISO } from '../domain/period.js';
import { DomainError } from '../domain/errors.js';
import { toolScope } from '../domain/orden.js';
import { lockScope, bumpScope } from './orden.js';
import { record } from './common.js';
import { newId } from './ids.js';

const KIND = 'excel_v1';
const rule = (msg, code, status = 422) => new DomainError(msg, code, status);
const withExtra = (err, extra) => Object.assign(err, { extra });
export const FILE_NAME_RE = /\.(xlsx|xlsm)$/i;

function readFile(fileName, buf) {
  if (!FILE_NAME_RE.test(String(fileName || ''))) throw rule('Elegí el archivo de Excel (.xlsx o .xlsm).', 'invalid_file_name');
  try {
    return readExcelBook(buf);
  } catch (err) {
    if (err instanceof WorkbookError) throw rule(err.message, err.code === 'too_large' ? 'too_large' : 'invalid_workbook', err.code === 'too_large' ? 413 : 422);
    throw err;
  }
}

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');

// Estado del servidor que necesita el plan.
async function loadServer(q) {
  const techs = (await q.query(
    `SELECT id, legajo, name, active, archived_at IS NOT NULL AS archived, tech_has_history(id) AS has_history
       FROM techs WHERE legajo IS NOT NULL ORDER BY id`,
  )).rows.map((r) => ({ id: r.id, legajo: r.legajo, name: r.name, active: r.active, archived: r.archived, hasHistory: r.has_history }));
  const tools = (await q.query('SELECT id, name, serialized, active, archived_at IS NOT NULL AS archived FROM tools ORDER BY id')).rows;
  const especialidades = (await q.query('SELECT id, name, archived_at IS NOT NULL AS archived FROM especialidades ORDER BY sort_order, id')).rows;
  const base = (await loadKits(q)).find((k) => !k.especialidadId && !k.archivedAt) || null;
  return { techs, tools, especialidades, baseKit: base ? { id: base.id, items: base.items } : null };
}

async function batchOf(q, hash) {
  return (await q.query('SELECT b.id, b.created_at, u.name AS by_name FROM import_batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.kind = $1 AND b.file_hash = $2', [KIND, hash])).rows[0] || null;
}
function alreadyImported(b) {
  const day = localDateISO(b.created_at).split('-').reverse().join('/');
  return rule(`Este archivo ya se importó el ${day}${b.by_name ? ` (${b.by_name})` : ''}. No se importa dos veces.`, 'already_imported', 409);
}

// Token: el hash del archivo y la versión del plan (operaciones, casos con su decisión, errores).
function tokenOf(hash, p) {
  return sha256(JSON.stringify({ v: PLAN_VERSION, hash, ops: p.ops, cases: p.cases.map((c) => [c.id, c.decision]), errors: p.errors }));
}

function reportOf(p, { fileName, hash, bytes, token }) {
  return {
    fileName, fileHash: hash, bytes, token, planVersion: PLAN_VERSION,
    canApply: !p.errors.length, errors: p.errors, totals: p.totals, caseCounts: caseCounts(p.cases), cases: p.cases,
    effectiveDecisions: p.effectiveDecisions, staleDecisions: p.staleDecisions,
  };
}

export async function previewExcel(db, actor, { fileName, file, decisions = {} }) {
  const book = readFile(fileName, file);
  const hash = sha256(file);
  return withSnapshot(db, async (q) => {
    const done = await batchOf(q, hash);
    if (done) throw alreadyImported(done);
    const p = planExcelImport(book, await loadServer(q), { decisions, today: localDateISO() });
    return reportOf(p, { fileName, hash, bytes: file.length, token: tokenOf(hash, p) });
  });
}

async function withSerializable(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    if (err.code === '40001' || err.code === '40P01') throw rule('Otra persona modificó datos mientras se importaba. Volvé a previsualizar.', 'import_retry', 409);
    if (err.code === '23505' && err.constraint === 'import_batches_file_key') throw rule('Este archivo ya se importó. No se importa dos veces.', 'already_imported', 409);
    if (err.code === '23505' || err.code === '23503') throw rule('La importación choca con datos del servidor (registro repetido o referencia rota). Volvé a previsualizar.', 'import_conflict', 409);
    throw err;
  } finally {
    c.release();
  }
}

// Contexto de inventario actualizado con un plan ya guardado (para planificar el siguiente).
function applyToCtx(ctx, plan) {
  for (const u of plan.assignmentUpdates) {
    const a = ctx.assignments[u.id];
    if (!a) continue;
    if (u.set.active === false) delete ctx.assignments[u.id];
    else ctx.assignments[u.id] = { ...a, ...u.set };
  }
  for (const a of plan.newAssignments) ctx.assignments[a.id] = { techId: a.techId, cajaId: a.cajaId ?? null, toolId: a.toolId, unitId: a.unitId, qty: a.qty, active: true };
  for (const t of plan.transfers) {
    const p = (ctx.pools[t.toolId] = { ...(ctx.pools[t.toolId] || {}) });
    p[t.from] = (p[t.from] || 0) - t.qty;
    p[t.to] = (p[t.to] || 0) + t.qty;
  }
}

export async function applyExcel(db, actor, { fileName, file, token, decisions = {} }) {
  const book = readFile(fileName, file);
  const hash = sha256(file);
  return withSerializable(db, async (c) => {
    // Orden de bloqueos: nombres (importación, legajos, herramientas) -> alcance de orden ->
    // kit -> técnicos -> herramientas (como alta de técnico/herramienta, entregar kit y movimientos).
    await lockName(c, 'import:excel');
    const done = await batchOf(c, hash);
    if (done) throw alreadyImported(done);
    await lockName(c, 'techs.legajo');
    await lockName(c, 'tools.name');
    const server = await loadServer(c);
    const p = planExcelImport(book, server, { decisions, today: localDateISO() });
    const report = reportOf(p, { fileName, hash, bytes: file.length, token: tokenOf(hash, p) });
    if (p.errors.length) throw withExtra(rule('El archivo no se puede importar así: revisá la vista previa.', 'import_invalid'), { report });
    if (!token || token !== report.token) throw withExtra(rule('Los datos o las decisiones cambiaron desde la vista previa: volvé a previsualizar antes de confirmar.', 'import_changed', 409), { report });

    const newTools = p.ops.filter((o) => o.kind === 'tool');
    if (newTools.length) await lockScope(c, toolScope(null));
    const kitOp = p.ops.find((o) => o.kind === 'kit');
    if (kitOp) await c.query('SELECT id FROM kits WHERE id = $1 FOR UPDATE', [kitOp.kitId]);
    const espIds = [...new Set(p.ops.filter((o) => o.kind === 'tech' && o.especialidadId).map((o) => o.especialidadId))].sort();
    if (espIds.length) await c.query('SELECT id FROM especialidades WHERE id = ANY($1) AND archived_at IS NULL ORDER BY id FOR SHARE', [espIds]);
    const attachIds = p.ops.filter((o) => o.kind === 'attach').map((o) => o.techId).sort();
    if (attachIds.length) await c.query('SELECT id FROM techs WHERE id = ANY($1) ORDER BY id FOR UPDATE', [attachIds]);
    const matched = p.tools.filter((t) => t.serverId).map((t) => t.serverId).sort();
    if (matched.length) await c.query('SELECT id FROM tools WHERE id = ANY($1) ORDER BY id FOR UPDATE', [matched]);

    const batchId = newId('ib');
    const counts = { ...p.totals, cases: caseCounts(p.cases) };
    await c.query('INSERT INTO import_batches (id, kind, file_hash, file_name, plan_token, counts, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [batchId, KIND, hash, String(fileName).slice(0, 500), report.token, JSON.stringify(counts), actor.id]);

    // Herramientas nuevas: al final del orden de "sin categoría", en el orden del Excel.
    const toolId = {};
    for (const t of p.tools) if (t.serverId) toolId[t.idx] = t.serverId;
    for (const op of newTools) {
      const id = newId('h');
      await c.query('INSERT INTO tools (id, name, category_id, serialized, active, created_by, import_batch_id) VALUES ($1,$2,NULL,false,true,$3,$4)', [id, op.name, actor.id, batchId]);
      toolId[op.tool] = id;
    }
    if (newTools.length) await bumpScope(c, toolScope(null));

    // Técnicos: nuevos sin plantilla; los existentes sin historial reciben los datos.
    const tech = {};
    for (const op of p.ops) {
      if (op.kind === 'attach') {
        const r = (await c.query('SELECT id, name FROM techs WHERE id = $1', [op.techId])).rows[0];
        tech[op.legajo] = { id: r.id, name: r.name, attached: true };
      } else if (op.kind === 'tech') {
        const id = newId('t');
        await c.query('INSERT INTO techs (id, name, legajo, active, alta, especialidad_id, created_by, import_batch_id) VALUES ($1,$2,$3,true,$4,$5,$6,$7)', [id, op.name, op.legajoText, op.alta || localDateISO(), op.especialidadId, actor.id, batchId]);
        tech[op.legajo] = { id, name: op.name, attached: false };
      }
    }

    // Kit base = BLANCO (1 de cada herramienta, en ese orden).
    if (kitOp) {
      await c.query('DELETE FROM kit_items WHERE kit_id = $1', [kitOp.kitId]);
      for (const [i, it] of kitOp.items.entries()) await c.query('INSERT INTO kit_items (kit_id, tool_id, qty, sort_order) VALUES ($1,$2,$3,$4)', [kitOp.kitId, toolId[it.tool], it.qty, i + 1]);
      await c.query('UPDATE kits SET name = name WHERE id = $1', [kitOp.kitId]);
    }

    // Movimientos, controles y novedades en orden de fecha, con el planificador del dominio.
    const ctx = await loadInventoryContext(c);
    const categories = Object.fromEntries((await c.query('SELECT id, name FROM categories')).rows.map((r) => [r.id, { name: r.name }]));
    const slot = {};
    const ctlId = {};
    const slotKey = (op, s, tool = op.tool) => `${op.legajo}/${tool}/${s}`;
    const move = async (op, input) => {
      let plan;
      try {
        plan = planMovement(ctx, input, { at: op.at, newId });
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        throw rule(`No se pudo aplicar un movimiento importado (${err.message}). No se importó nada.`, 'import_failed');
      }
      await applyMovementPlan(c, plan, { actorId: actor.id, importBatchId: batchId });
      applyToCtx(ctx, plan);
      return plan;
    };
    for (const op of p.ops) {
      const h = op.legajo ? tech[op.legajo] : null;
      if (op.kind === 'ingreso') {
        await move(op, { type: 'ingreso', toolId: toolId[op.tool], qty: op.qty, notes: NOTES.ingreso });
      } else if (op.kind === 'entrega') {
        const plan = await move(op, { type: op.type, techId: h.id, toolId: toolId[op.tool], qty: op.qty, reason: op.adjust ? NOTES.ajuste : NOTES.entrega });
        slot[slotKey(op, op.slot)] = plan.newAssignments[0].id;
      } else if (op.kind === 'reposicion') {
        const plan = await move(op, { type: 'reposicion', techId: h.id, asgId: slot[slotKey(op, op.slot)], returned: true, oldDest: 'baja', reason: NOTES.reposicion });
        slot[slotKey(op, op.newSlot)] = plan.newAssignments[0].id;
      } else if (op.kind === 'devolucion') {
        await move(op, { type: 'devolucion', techId: h.id, asgId: slot[slotKey(op, op.slot)], qty: op.qty, cond: op.cond, reason: op.cond === 'baja' ? NOTES.baja : NOTES.devolucion });
      } else if (op.kind === 'control') {
        const assignments = [];
        const items = {};
        for (const it of op.items) {
          const id = slot[slotKey(op, it.slot, it.tool)];
          assignments.push({ id, toolId: toolId[it.tool], qty: it.expected, unitId: null });
          items[id] = { good: it.good, change: it.change, note: it.missing > 0 ? MISSING_NOTE : '' };
        }
        const plantillaId = h.attached ? (await c.query('SELECT plantilla_on($1, $2::date) AS p', [h.id, op.day])).rows[0].p : null;
        const doc = buildControlDoc({
          tech: { id: h.id, name: h.name, plantillaId }, period: op.period, assignments, items, tools: ctx.tools, units: {}, categories,
          status: 'finalizado', correctionOf: op.correctionOf ? ctlId[op.correctionOf] : null, cleaning: null,
        });
        const id = newId('c');
        await saveControl(c, id, doc, { actorId: actor.id, startedAt: op.at, finishedAt: op.at, importBatchId: batchId });
        ctlId[op.ref] = id;
        for (const [aid, it] of Object.entries(doc.items)) ctx.stateOf[aid] = { state: it.state, expected: it.expected, good: it.good, change: it.change, missing: it.missing, note: it.note, controlId: id, at: op.at };
      } else if (op.kind === 'novedad') {
        await c.query('INSERT INTO novedades (id, occurred_at, author_id, comment, tech_id, created_by, import_batch_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [newId('n'), op.at, actor.id, op.comment, h ? h.id : null, actor.id, batchId]);
      }
    }

    const t = p.totals;
    await record(c, actor, {
      action: 'import_excel', entity: 'system', id: batchId, event: 'reload',
      detail: `Importación del Excel (lote ${batchId}): ${t.techsCreate} técnicos nuevos, ${t.techsAttach} existentes, ${t.toolsCreate} herramientas nuevas, ${t.controls} controles (${t.corrections} correcciones), ${t.entregas} entregas, ${t.ajustes} entregas de ajuste, ${t.reposiciones} reposiciones, ${t.devoluciones} devoluciones, ${t.bajas} bajas, ${t.novedades} novedades, ${p.cases.length} casos revisados`,
    });
    return { applied: true, batch: { id: batchId, fileHash: hash }, totals: p.totals, caseCounts: report.caseCounts };
  });
}

export async function listBatches(db) {
  const rows = (await db.query('SELECT b.id, b.file_name, b.file_hash, b.counts, b.created_at, b.created_by, u.name AS by_name FROM import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.created_at DESC, b.id DESC LIMIT 50')).rows;
  return { batches: rows.map((r) => ({ id: r.id, fileName: r.file_name, fileHash: r.file_hash, counts: r.counts, createdAt: r.created_at.toISOString(), by: r.created_by, byName: r.by_name })) };
}
