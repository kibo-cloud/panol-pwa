// Vista previa de "Entregar kit" (etapa 3), pura: qué se entrega a cada poseedor, si es entrega
// inicial o adicional, las unidades a elegir de las herramientas por código y los problemas de
// stock. El servidor vuelve a controlar todo al confirmar (todo o nada).
//
// kit: { items: [{ toolId, qty }] }. ctx: { tools: {id: herramienta}, units: [unidades],
// pools: {toolId: {disponible}}, held: Set de toolIds que el poseedor ya tiene }.
// chosen: { toolId: [unitId] } elegidas por el usuario. opts.autoPick (solo al abrir la vista
// previa): si no hay ninguna elegida se sugieren las primeras por código. Después de que el
// usuario tocó las casillas, ninguna marcada es un problema ("elegí N unidades"), nunca "Listo".
const byCode = (a, b) => (a.code || '').localeCompare(b.code || '', 'es', { numeric: true });

export function kitPreview(kit, ctx, chosen = {}, { autoPick = true } = {}) {
  const rows = [];
  for (const it of (kit && kit.items) || []) {
    const tool = ctx.tools[it.toolId];
    const row = { toolId: it.toolId, name: tool ? tool.name : 'Herramienta eliminada', qty: it.qty, serialized: !!(tool && tool.serialized), kind: ctx.held.has(it.toolId) ? 'adicional' : 'entrega_inicial', units: [], chosen: [], available: 0, problem: '' };
    if (!tool) row.problem = 'ya no existe.';
    else if (tool.active === false) row.problem = 'está inactiva.';
    else if (tool.serialized) {
      row.units = ctx.units.filter((u) => u.toolId === it.toolId && u.status === 'disponible').sort(byCode);
      row.available = row.units.length;
      const ids = new Set(row.units.map((u) => u.id));
      const pick = (chosen[it.toolId] || []).filter((id) => ids.has(id));
      row.chosen = pick.length || !autoPick ? pick : row.units.slice(0, it.qty).map((u) => u.id);
      if (row.available < it.qty) row.problem = `se necesitan ${it.qty} ${it.qty === 1 ? 'unidad' : 'unidades'} y hay ${row.available} ${row.available === 1 ? 'disponible' : 'disponibles'}.`;
      else if (row.chosen.length !== it.qty) row.problem = `elegí ${it.qty} ${it.qty === 1 ? 'unidad' : 'unidades'}.`;
    } else {
      row.available = (ctx.pools[it.toolId] || {}).disponible || 0;
      if (row.available < it.qty) row.problem = `se necesitan ${it.qty} y hay ${row.available} disponibles.`;
    }
    rows.push(row);
  }
  const problems = rows.filter((r) => r.problem).map((r) => `${r.name}: ${r.problem}`);
  return { rows, problems, ok: rows.length > 0 && !problems.length, movements: rows.reduce((a, r) => a + (r.serialized ? r.qty : 1), 0) };
}

// Cuerpo del pedido: solo las unidades de las herramientas por código.
export function deliverBody(holderKey, preview, reason = '') {
  const holder = String(holderKey).startsWith('caja:') ? { cajaId: holderKey.slice(5) } : { techId: holderKey };
  const unitIds = {};
  for (const r of preview.rows) if (r.serialized && r.chosen.length) unitIds[r.toolId] = r.chosen;
  return { holder, ...(Object.keys(unitIds).length ? { unitIds } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) };
}
