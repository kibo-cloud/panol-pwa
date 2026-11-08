// SQL del .txt v2: lee todo el estado con la forma de 2.1 (para exportar y para planear una
// importación) y aplica un plan de importación (llamar dentro de una transacción).
// Plantillas <-> turnos de 2.1: `config.turnos` son las plantillas activas, `techs.shiftId` la
// plantilla actual de cada técnico y `shiftChanges` los cambios del historial de pertenencia.
// Al importar, los turnos crean o actualizan plantillas (un turno borrado archiva la
// plantilla) y los cambios de turno pasan al historial con la misma función que usó la
// migración 005 (plantilla_ranges_from_changes).
import { listRows, TABLES } from './catalog-repo.js';
import { loadControls } from './inventory-repo.js';
import { loadMovementsFull } from './state-repo.js';
import { replaceOverrides, deleteUserSessions } from './auth-repo.js';
import { stamp } from '../../importers/txt-v2/plan.js';
import { readPlantillas } from './state-repo.js';
import { loadHistory, insertRange, closeRange, rangesFromChanges, applyMovePlan, freeRangeId } from './plantilla-repo.js';
import { planMove, effectiveRange } from '../../domain/plantillas.js';
import { DomainError } from '../../domain/errors.js';
import { localDateISO } from '../../domain/period.js';
import { newId } from '../../application/ids.js';

const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const strip = (list) => Object.fromEntries(list.map(({ id, version, ...r }) => [id, r]));
const maxIso = (rows) => rows.reduce((m, r) => (r.updated_at && (!m || r.updated_at > m) ? r.updated_at : m), null);

// Estado con la forma de los datos de 2.1 (colecciones por id). Los usuarios van sin
// credenciales; `creds` las resume aparte (nunca salen del servidor).
export async function loadTxtState(q) {
  const data = {};
  const P = await readPlantillas(q);
  // El .txt v2 no tiene especialidad ni orden personalizado (etapa 3): no salen.
  data.techs = strip(P.techs.map(({ plantillaId, especialidadId, ...t }) => t));
  data.shiftChanges = Object.fromEntries(Object.entries(P.shiftChanges).sort(([a], [b]) => (a < b ? -1 : 1)));
  // El .txt v2 no tiene cajas compartidas (etapa 2): sus asignaciones, controles, movimientos y
  // alertas resueltas no salen, y las unidades salen sin la caja.
  const noCaja = (list) => list.filter((r) => !r.cajaId).map(({ cajaId, ...r }) => r);
  for (const c of ['categories', 'tools', 'units', 'assignments', 'alertRes']) data[c] = strip(noCaja((await listRows(q, c, `ORDER BY ${TABLES[c].key}`)).map(({ order, ...r }) => (c === 'units' ? { ...r, cajaId: null } : r))));
  data.controls = strip(noCaja((await loadControls(q)).sort((a, b) => (a.id < b.id ? -1 : 1))));
  data.movements = strip(noCaja(await loadMovementsFull(q)));
  data.audit = Object.fromEntries((await q.query('SELECT id, action, entity, entity_id, detail, at, actor_id FROM audit_log ORDER BY at, id')).rows.map((r) => [
    r.id, { action: r.action, entity: r.entity, entityId: r.entity_id, detail: r.detail, at: iso(r.at), by: r.actor_id },
  ]));
  const users = (await q.query('SELECT * FROM users ORDER BY id')).rows;
  data.users = Object.fromEntries(users.map((u) => [u.id, {
    name: u.name, role: u.role, active: u.active, username: u.username, createdAt: iso(u.created_at), updatedAt: iso(u.updated_at), by: u.created_by,
  }]));
  const creds = Object.fromEntries(users.map((u) => [u.id, { hasPassword: !!u.password_hash, legacyPinHash: u.legacy_pin_hash }]));
  const shifts = (await q.query('SELECT id, name, sort_order, updated_at FROM plantillas WHERE archived_at IS NULL ORDER BY sort_order, id')).rows;
  const perms = (await q.query('SELECT role, perm, allowed, updated_at FROM role_permissions ORDER BY role, perm')).rows;
  data.config = { turnos: { list: shifts.map((s) => ({ id: s.id, name: s.name, order: s.sort_order })), updatedAt: iso(maxIso(shifts)) } };
  if (perms.length) {
    const p = {};
    for (const r of perms) (p[r.role] ||= {})[r.perm] = r.allowed;
    data.config.permisos = { ...p, updatedAt: iso(maxIso(perms)) };
  }
  const ledger = (await q.query('SELECT (SELECT count(*) FROM movements) AS movements, (SELECT count(*) FROM controls) AS controls')).rows[0];
  return { data, creds, ledger };
}

// ---------------------------------------------------------------- aplicar un plan
const stampIso = (r) => (Number.isFinite(stamp(r)) ? new Date(stamp(r)).toISOString() : null);

// Campos de la 3.0 que el .txt v2 no tiene: una importación no los toca.
// El orden y la especialidad conservan su valor (una herramienta nueva va al final del orden).
const V3_ONLY = new Set(['cajaId', 'especialidadId', 'order']);
const v2Cols = (s) => Object.entries(s.cols).filter(([k]) => !V3_ONLY.has(k));

async function insertGeneric(c, name, id, r) {
  const s = TABLES[name];
  const cols = v2Cols(s).map(([k, col]) => [col, r[k] ?? (k === 'demo' ? false : null)]);
  cols.push(['created_by', r.by ?? null], ['created_at', r.createdAt ?? stampIso(r) ?? new Date()], ['updated_at', stampIso(r) ?? new Date()]);
  await c.query(`INSERT INTO ${s.table} (${[s.key, ...cols.map((x) => x[0])].join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).concat(`$${cols.length + 1}`).join(', ')})`, [id, ...cols.map((x) => x[1])]);
}

async function updateGeneric(c, name, id, r) {
  const s = TABLES[name];
  const cols = v2Cols(s).map(([k, col]) => [col, r[k] ?? (k === 'demo' ? false : null)]);
  await c.query(`UPDATE ${s.table} SET ${cols.map((x, i) => `${x[0]} = $${i + 2}`).join(', ')} WHERE ${s.key} = $1`, [id, ...cols.map((x) => x[1])]);
}

async function insertItems(c, id, items) {
  for (const [aid, it] of Object.entries(items)) {
    await c.query(
      'INSERT INTO control_items (control_id, assignment_id, state, note, tool_id, tool_name, category, unit_id, unit_code, qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, aid, it.state, it.note, it.toolId, it.toolName, it.category, it.unitId, it.unitCode, it.qty ?? 1],
    );
  }
}

// Foto de la plantilla de un control importado: la del historial el día del control (o el
// último día de su semana), o el turno que trae el archivo si es una plantilla.
const SNAPSHOT_SQL = (tech, ref, y, m, w, shift) =>
  `coalesce(plantilla_on(${tech}, least(coalesce(${ref}::timestamptz, now())::date, period_end(${y}, ${m}, ${w}))), (SELECT id FROM plantillas WHERE id = ${shift}))`;

async function insertControl(c, id, r) {
  await c.query(
    `INSERT INTO controls (id, tech_id, tech_name, shift_id, period_y, period_m, period_w, status, count_bueno, count_cambio, count_faltante,
       correction, supersedes_id, started_at, created_by, demo, imported, created_at, updated_at, plantilla_id_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'borrador',$8,$9,$10,$11,$12,$13,$14,$15,true,$16,$17,${SNAPSHOT_SQL('$19::text', '$18', '$5', '$6', '$7', '$20::text')})`,
    [id, r.techId, r.techName, r.shiftId, r.period.y, r.period.m, r.period.w, r.counts.bueno, r.counts.cambio, r.counts.faltante,
      r.correction, r.supersedes, r.startedAt, r.by, r.demo, r.createdAt ?? stampIso(r) ?? new Date(), stampIso(r) ?? new Date(), r.finishedAt ?? null, r.techId, r.shiftId ?? null],
  );
  await insertItems(c, id, r.items);
  if (r.status === 'finalizado') await c.query("UPDATE controls SET status = 'finalizado', finished_at = $2 WHERE id = $1", [id, r.finishedAt]);
}

// Borrador del servidor reemplazado por la versión más nueva del archivo.
async function updateControl(c, id, r) {
  await c.query('DELETE FROM control_items WHERE control_id = $1', [id]);
  await insertItems(c, id, r.items);
  await c.query(
    `UPDATE controls SET tech_name = $2, shift_id = $3, count_bueno = $4, count_cambio = $5, count_faltante = $6, started_at = $7,
       demo = $8, status = $9, finished_at = $10,
       plantilla_id_snapshot = ${SNAPSHOT_SQL('tech_id', '$10', 'period_y', 'period_m', 'period_w', '$3')} WHERE id = $1`,
    [id, r.techName, r.shiftId, r.counts.bueno, r.counts.cambio, r.counts.faltante, r.startedAt, r.demo, r.status, r.status === 'finalizado' ? r.finishedAt : null],
  );
}

async function insertMovement(c, id, m) {
  await c.query(
    `INSERT INTO movements (id, type, tech_id, tool_id, qty, unit_id, new_assignment_id, old_assignment_id, old_unit_id, new_unit_id,
       old_state, returned, old_dest, condition, linked_control_id, resolves_movement_id, reason, notes, at, created_by, demo, imported)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true)`,
    [id, m.type, m.techId, m.toolId, m.qty, m.unitId, m.newAssignmentId, m.oldAssignmentId, m.oldUnitId, m.newUnitId, m.oldState, m.returned,
      m.oldDest, m.condition, m.linkedControlId, m.resolvesMovementId, m.reason, m.notes, m.at, m.by, m.demo],
  );
  for (const [seq, t] of m.transfers.entries()) {
    await c.query('INSERT INTO movement_transfers (movement_id, seq, tool_id, qty, from_pool, to_pool, unit_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, seq, t.toolId, t.qty, t.from, t.to, t.unitId]);
  }
}

// Originales antes que sus correcciones (supersedes_id es clave foránea).
function controlOrder(create) {
  const ids = Object.keys(create);
  const done = new Set();
  const out = [];
  while (out.length < ids.length) {
    const before = out.length;
    for (const id of ids) {
      if (done.has(id)) continue;
      const sup = create[id].supersedes;
      if (!sup || !create[sup] || done.has(sup)) {
        out.push(id);
        done.add(id);
      }
    }
    if (out.length === before) throw new Error('Correcciones de control en ciclo.');
  }
  return out;
}

// Los cambios de turno no van a shift_changes: pasan al historial (reconcileMembership).
const GENERIC = ['categories', 'techs', 'tools', 'units', 'assignments', 'alertRes'];
const DELETE_ORDER = [['assignments', 'assignments'], ['units', 'units'], ['alertRes', 'alert_resolutions'], ['techs', 'techs'], ['tools', 'tools'], ['categories', 'categories']];

const changeDay = (x) => x.effectiveFrom || (x.at ? localDateISO(new Date(x.at)) : null);

// Pertenencia de los técnicos que cambian con el archivo.
// - Sin historial: se arma con los cambios de turno del archivo y su turno actual.
// - Con historial: los cambios nuevos se agregan como movimientos (los que caen antes del
//   último tramo no se pueden aplicar sin reescribir el historial y se cuentan como omitidos);
//   después, si la plantilla de hoy no es la del archivo, se mueve desde hoy (durante una
//   cobertura en curso la cobertura termina hoy; con una cobertura programada no se puede y
//   también se cuenta como omitido).
// Un id de cambio de turno que ya existe en el historial (un rango que no se exporta) entra
// con un id nuevo.
// El historial nunca se borra ni se edita: un cambio de turno modificado o borrado en el
// archivo no cambia nada (los cambios de turno de 2.1 tampoco se editaban).
async function reconcileMembership(c, plan, { actorId, today }) {
  const ch = plan.changes;
  const final = plan.final;
  const newSc = ch.shiftChanges.create;
  const touched = new Set([...Object.keys(ch.techs.create), ...Object.keys(ch.techs.update), ...Object.values(newSc).map((x) => x.techId)]);
  let skipped = 0;
  for (const techId of [...touched].sort()) {
    const t = final.techs[techId];
    if (!t) continue;
    const fileChanges = Object.entries(final.shiftChanges).filter(([, x]) => x.techId === techId)
      .map(([id, x]) => ({ id, from: x.from, to: x.to, effectiveFrom: x.effectiveFrom, at: x.at, note: x.note, by: x.by }));
    let hist = await loadHistory(c, { techIds: [techId] });
    if (!hist.length) {
      for (const r of await rangesFromChanges(c, t.shiftId ?? null, fileChanges)) {
        const range = { id: await freeRangeId(c, r.srcId, newId), techId, plantillaId: r.plantillaId, validFrom: r.validFrom, validTo: r.validTo, reason: r.reason ?? 'Importación del .txt' };
        await insertRange(c, range, { actorId: r.by ?? actorId, demo: !!t.demo, createdAt: r.createdAt });
      }
      continue;
    }
    // Un movimiento que el dominio rechaza (DomainError) se omite y se cuenta.
    const move = async (to, from, reason, firstId = null) => {
      const id0 = firstId ? await freeRangeId(c, firstId, newId) : null;
      let n = 0;
      try {
        const p = planMove(hist, { techId, targetId: to, from, reason, today }, { newId: (pre) => (n++ === 0 && id0 ? id0 : newId(pre)) });
        await applyMovePlan(c, p, { actorId, demo: !!t.demo });
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        skipped++;
        return;
      }
      hist = await loadHistory(c, { techIds: [techId] });
    };
    const news = fileChanges.filter((x) => newSc[x.id] && changeDay(x))
      .sort((a, b) => changeDay(a).localeCompare(changeDay(b)) || (a.at || '').localeCompare(b.at || ''));
    for (const x of news) {
      const exists = x.to && (await c.query('SELECT 1 FROM plantillas WHERE id = $1', [x.to])).rows[0];
      if (!exists) skipped++;
      else await move(x.to, changeDay(x), x.note || 'Cambio de turno (importado)', x.id);
    }
    const cur = effectiveRange(hist, today)?.plantillaId ?? null;
    const want = t.shiftId ?? null;
    if (want === cur) continue;
    if (want) await move(want, today, 'Importación del .txt');
    else {
      const open = hist.find((r) => r.validTo == null);
      if (open) await closeRange(c, open.id, open.validFrom && open.validFrom > today ? open.validFrom : today);
    }
  }
  return { skipped };
}

export async function applyImportPlan(c, plan, { actorId }) {
  const ch = plan.changes;
  // Borrados: de los que dependen hacia arriba.
  const delCtl = ch.controls.delete;
  if (delCtl.length) {
    await c.query('DELETE FROM control_items WHERE control_id = ANY($1)', [delCtl]);
    await c.query('DELETE FROM controls WHERE id = ANY($1)', [delCtl]);
  }
  for (const [name, table] of DELETE_ORDER) {
    const ids = ch[name].delete;
    if (ids.length) await c.query(`DELETE FROM ${table} WHERE ${TABLES[name].key} = ANY($1)`, [ids]);
  }
  const delUsers = ch.users.delete.filter((id) => id !== actorId);
  if (delUsers.length) await c.query('DELETE FROM users WHERE id = ANY($1)', [delUsers]);

  // Turnos = plantillas (antes que los técnicos que los nombran). Una plantilla archivada con
  // el mismo id vuelve a estar activa.
  for (const [id, s] of Object.entries(ch.shifts.create)) {
    await c.query(
      `INSERT INTO plantillas (id, name, current_shift_label, sort_order, created_by) VALUES ($1,$2,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, archived_at = NULL`,
      [id, s.name, s.order, actorId],
    );
  }
  for (const [id, s] of Object.entries(ch.shifts.update)) await c.query('UPDATE plantillas SET name = $2, sort_order = $3 WHERE id = $1', [id, s.name, s.order]);

  for (const name of GENERIC) {
    for (const [id, r] of Object.entries(ch[name].create)) await insertGeneric(c, name, id, r);
    for (const [id, r] of Object.entries(ch[name].update)) await updateGeneric(c, name, id, r);
  }
  const today = localDateISO();
  const membership = await reconcileMembership(c, plan, { actorId, today });
  // Turno borrado: la plantilla se archiva y su gente queda sin plantilla desde hoy (en 2.1 el
  // técnico quedaba sin turno).
  for (const id of ch.shifts.delete) {
    await c.query(
      `UPDATE tech_plantilla_history SET valid_to = CASE WHEN valid_from IS NULL OR valid_from < $2::date THEN $2::date ELSE valid_from END
        WHERE plantilla_id = $1 AND valid_to IS NULL`,
      [id, today],
    );
    await c.query('UPDATE plantillas SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [id]);
  }
  for (const id of controlOrder(ch.controls.create)) await insertControl(c, id, ch.controls.create[id]);
  for (const [id, r] of Object.entries(ch.controls.update)) await updateControl(c, id, r);
  const movs = Object.entries(ch.movements.create).sort((a, b) => (a[1].at < b[1].at ? -1 : a[1].at > b[1].at ? 1 : 0));
  for (const [id, m] of movs) await insertMovement(c, id, m);
  for (const [id, a] of Object.entries(ch.audit.create)) {
    await c.query('INSERT INTO audit_log (id, action, entity, entity_id, detail, at, actor_id, imported) VALUES ($1,$2,$3,$4,$5,$6,$7,true)', [id, a.action, a.entity, a.entityId, a.detail, a.at, a.by]);
  }

  // Usuarios: los de 2.x entran sin contraseña, con su PIN como contraseña temporal.
  for (const [id, u] of Object.entries(ch.users.create)) {
    await c.query(
      `INSERT INTO users (id, username, name, role, active, password_hash, must_change_password, legacy_salt, legacy_pin_hash, created_at, updated_at, created_by)
       VALUES ($1,$2,$3,$4,$5,NULL,true,$6,$7,$8,$9,$10)`,
      [id, u.username, u.name, u.role, u.active, u.pinHash ? u.salt ?? '' : null, u.pinHash || null, u.createdAt ?? stampIso(u) ?? new Date(), stampIso(u) ?? new Date(), u.by],
    );
  }
  for (const [id, u] of Object.entries(ch.users.update)) {
    if (id === actorId) continue;
    await c.query('UPDATE users SET name = $2, role = $3, active = $4 WHERE id = $1', [id, u.name, u.role, u.active]);
    if (u.setPin) await c.query('UPDATE users SET legacy_salt = $2, legacy_pin_hash = $3, must_change_password = true WHERE id = $1 AND password_hash IS NULL', [id, u.setPin.salt ?? '', u.setPin.pinHash]);
    if (!u.active) await deleteUserSessions(c, id);
  }
  if (ch.permisos) await replaceOverrides(c, ch.permisos, actorId);
  return { membershipSkipped: membership.skipped };
}
