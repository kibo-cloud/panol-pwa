// Resolver y reabrir alertas. La alerta se deriva del estado; al resolverla se guarda una
// copia de su título y texto (como alertRes de 2.1).
import * as repo from '../adapters/pg/catalog-repo.js';
import { readState } from '../adapters/pg/state-repo.js';
import { deriveState } from '../domain/derive.js';
import { deriveAlerts } from '../domain/alerts.js';
import { DomainError } from '../domain/errors.js';
import { cleanText } from '../domain/catalog.js';
import { withTransaction, checkVersion, record } from './common.js';

export async function resolveAlert(db, actor, key, input = {}, { now = new Date() } = {}) {
  const note = cleanText(input.note, 'La nota');
  return withTransaction(db, async (c) => {
    // Un lock por clave: dos resoluciones simultáneas de la misma alerta no se pisan.
    await repo.lockName(c, `alert:${key}`);
    if (await repo.getRow(c, 'alertRes', key)) throw new DomainError('La alerta ya está resuelta.', 'already_resolved', 409);
    const S = await readState(c);
    const d = deriveState(S, { now });
    const a = deriveAlerts({ now, techs: S.techs, cajas: S.cajas, tools: S.tools, units: S.units, assignments: S.assignments, controls: d.ctls, movements: d.movs, alertRes: S.alertRes, controlOverdueDays: S.settings.controlOverdueDays }).find((x) => x.key === key);
    if (!a) throw new DomainError('La alerta ya no está abierta.', 'not_found', 404);
    // E5.V1: alert_resolutions no tiene claves foráneas; el poseedor se toma FOR SHARE para que no
    // se elimine definitivamente entre la revisión de su historial y esta fila.
    const holder = a.cajaId
      ? (await c.query('SELECT 1 FROM cajas WHERE id = $1 FOR SHARE', [a.cajaId])).rows[0]
      : a.techId ? (await c.query('SELECT 1 FROM techs WHERE id = $1 FOR SHARE', [a.techId])).rows[0] : true;
    if (!holder) throw new DomainError('La alerta ya no está abierta.', 'not_found', 404);
    const row = await repo.insertRow(c, 'alertRes', key, { type: a.type, title: a.title, text: a.text, techId: a.techId || null, cajaId: a.cajaId || null, note, at: now, by: actor.id });
    await record(c, actor, { action: 'alert_resolve', entity: 'alert_resolutions', id: key, version: row.version, event: 'create', detail: `Alerta resuelta: ${a.title}, ${a.text}` });
    return row;
  });
}

export async function unresolveAlert(db, actor, key, version) {
  return withTransaction(db, async (c) => {
    const cur = checkVersion(await repo.getRow(c, 'alertRes', key, { lock: true }), version, 'La alerta no está resuelta.');
    await repo.deleteRow(c, 'alertRes', key);
    await record(c, actor, { action: 'alert_unresolve', entity: 'alert_resolutions', id: key, event: 'delete', detail: `Alerta reabierta: ${cur.title}, ${cur.text}` });
    return { ok: true };
  });
}
