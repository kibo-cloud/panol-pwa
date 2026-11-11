// Etapa 8: ajustes de Administración › Configuración que no son de las plantillas. El umbral de
// "Sin control hace N días" se cambia con la versión (If-Match), como la lista de turnos.
import * as repo from '../adapters/pg/catalog-repo.js';
import * as srepo from '../adapters/pg/settings-repo.js';
import { createHash } from 'node:crypto';
import { cleanOverdueDays } from '../domain/existencia.js';
import { cleanCompanyName, checkLogo } from '../domain/empresa.js';
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

// ------------------------------------------------------------------ empresa (etapa 10)
// Nombre y logo del encabezado de la impresión. Una sola versión (If-Match) para los dos; se
// cambian con plantillas_edit (el permiso de Administración › Configuración) y van a auditoría.
const empresaConflict = () => new DomainError('Otra persona modificó los datos de la empresa. Recargá para ver los cambios.', 'conflict', 409);
export const logoUrl = (logo) => (logo ? `/api/empresa/logo?v=${logo.sha256.slice(0, 16)}` : null);
const empresaOut = (e, version = e.version) => ({ name: e.name, logo: e.logo ? { ...e.logo, url: logoUrl(e.logo) } : null, version });

export const getEmpresa = async (db) => empresaOut(await srepo.loadEmpresa(db));

async function changeEmpresa(db, actor, version, fn) {
  return withTransaction(db, async (c) => {
    await repo.lockName(c, 'settings:empresa');
    const cur = await srepo.loadEmpresa(c);
    if (cur.version !== version) throw empresaConflict();
    const { next, detail, action } = await fn(c, cur);
    const v = await srepo.saveEmpresa(c, next, actor.id);
    await record(c, actor, { action, entity: 'app_settings', id: srepo.EMPRESA_KEY, version: v, detail });
    return empresaOut({ ...next }, v);
  });
}

export const setEmpresaName = (db, actor, input, version) => {
  const name = cleanCompanyName(input.name);
  return changeEmpresa(db, actor, version, async (c, cur) => ({ next: { name, logo: cur.logo }, action: 'empresa_settings', detail: `Nombre de la empresa: ${name}` }));
};

export const setLogo = (db, actor, buf, version) => {
  const contentType = checkLogo(buf);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return changeEmpresa(db, actor, version, async (c, cur) => {
    await srepo.writeLogo(c, { contentType, data: buf, sha256 }, actor.id);
    return { next: { name: cur.name, logo: { sha256, contentType, size: buf.length } }, action: 'empresa_logo', detail: `Logo de la empresa actualizado (${contentType === 'image/png' ? 'PNG' : 'JPEG'}, ${Math.ceil(buf.length / 1024)} KB)` };
  });
};

export const removeLogo = (db, actor, version) => changeEmpresa(db, actor, version, async (c, cur) => {
  await srepo.deleteLogo(c);
  return { next: { name: cur.name, logo: null }, action: 'empresa_logo', detail: 'Logo de la empresa quitado' };
});

export const getLogo = (db) => srepo.loadLogo(db);
