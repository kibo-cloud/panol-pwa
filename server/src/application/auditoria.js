// Etapa 10: informe para auditoría (GET /api/audit-report, permiso reports_export). Todo se lee
// en UNA instantánea (REPEATABLE READ, solo lectura): el estado, las novedades y las compras del
// período, los vínculos compra ↔ control y los datos de la empresa, así las secciones son
// coherentes entre sí aunque alguien esté cargando datos al mismo tiempo. El armado es del dominio.
import { readState, withSnapshot } from '../adapters/pg/state-repo.js';
import { loadOverrides } from '../adapters/pg/auth-repo.js';
import { loadEmpresa } from '../adapters/pg/settings-repo.js';
import { loadControlLinks } from '../adapters/pg/compras-repo.js';
import { deriveState } from '../domain/derive.js';
import { can } from '../domain/permissions.js';
import { parseNovedadFilters } from '../domain/novedades.js';
import { parsePurchaseFilters } from '../domain/compras.js';
import { buildAuditReport, parseAuditSelection, selectionDays } from '../domain/auditoria.js';
import { collectNovedades } from './novedades.js';
import { collectDecided } from './compras.js';
import { logoUrl } from './settings.js';

export async function getAuditReport(db, actor, query = {}, { now = new Date() } = {}) {
  const sel = parseAuditSelection(query, { now });
  const days = selectionDays(sel);
  return withSnapshot(db, async (c) => {
    const ov = await loadOverrides(c);
    const perms = { purchasesView: can(actor.role, 'purchases_view', ov), novedadesView: can(actor.role, 'novedades_view', ov) };
    const S = await readState(c);
    const wantNov = perms.novedadesView && sel.sections.includes('novedades');
    const novedades = wantNov ? await collectNovedades(c, parseNovedadFilters({ from: days.from, to: days.to })) : [];
    const purchases = sel.sections.includes('compras') ? await collectDecided(c, { ...parsePurchaseFilters({}), from: days.from, to: days.to }) : [];
    const purchaseLinks = sel.sections.includes('faltantes') ? await loadControlLinks(c) : [];
    const e = await loadEmpresa(c);
    const empresa = { name: e.name, logo: e.logo ? { sha256: e.logo.sha256, url: logoUrl(e.logo) } : null };
    const me = (S.users || {})[actor.id];
    const R = buildAuditReport(deriveState(S, { now }), { S, now, actor: { id: actor.id, name: me ? me.name : '' }, perms, empresa, novedades, purchases, purchaseLinks }, sel);
    if (!sel.sections.includes('poseedores')) for (const h of R.holders) { h.rows = []; h.notes = []; h.planilla = { blocks: [], rows: [] }; }
    return R;
  });
}
