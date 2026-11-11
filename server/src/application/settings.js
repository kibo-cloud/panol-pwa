// Etapa 8: ajustes de Administración › Configuración que no son de las plantillas. El umbral de
// "Sin control hace N días" se cambia con la versión (If-Match), como la lista de turnos.
import * as repo from '../adapters/pg/catalog-repo.js';
import * as srepo from '../adapters/pg/settings-repo.js';
import { cleanOverdueDays } from '../domain/existencia.js';
import { DomainError } from '../domain/errors.js';
import { withTransaction, record } from './common.js';

export const getAlertSettings = (db) => srepo.loadAlertSettings(db);

export async function setAlertSettings(db, actor, input, version) {
  const days = cleanOverdueDays(input.controlOverdueDays);
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'settings:alerts');
    const cur = await srepo.loadAlertSettings(c);
    if (cur.version !== version) throw new DomainError('Otra persona modificó la configuración de alertas. Recargá para ver los cambios.', 'conflict', 409);
    const out = await srepo.saveAlertSettings(c, days, actor.id);
    await record(c, actor, { action: 'alert_settings', entity: 'app_settings', id: srepo.ALERT_SETTINGS_KEY, version: out.version, detail: days ? `Alerta de días sin control: más de ${days} días` : 'Alerta de días sin control: desactivada' });
    return out;
  });
}
