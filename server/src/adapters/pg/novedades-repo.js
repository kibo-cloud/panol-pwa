// SQL de las novedades (etapa 6). La lista filtra en el servidor (período local, temas, autor,
// texto, vínculo y eliminadas), más nuevas primero, con cursor. `queryNovedades` es la consulta
// por período que reusa la impresión de auditoría (etapa 10).
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);

const SELECT = `
  SELECT n.*, u.name AS author_name, u.archived_at AS author_archived_at,
         t.name AS tech_name, t.archived_at AS tech_archived_at,
         p.name AS plantilla_name, p.archived_at AS plantilla_archived_at,
         l.name AS linea_name, l.kind AS linea_kind, l.archived_at AS linea_archived_at,
         m.type AS movement_type, m.at AS movement_at, m.qty AS movement_qty, m.tool_id AS movement_tool_id,
         m.tech_id AS movement_tech_id, m.caja_id AS movement_caja_id, tl.name AS movement_tool_name,
         (SELECT v.id FROM movements v WHERE v.voids_movement_id = m.id) AS movement_voided_by,
         to_char(n.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM novedades n
    JOIN users u ON u.id = n.author_id
    LEFT JOIN techs t ON t.id = n.tech_id
    LEFT JOIN plantillas p ON p.id = n.plantilla_id
    LEFT JOIN lineas l ON l.id = n.linea_id
    LEFT JOIN movements m ON m.id = n.movement_id
    LEFT JOIN tools tl ON tl.id = m.tool_id`;

// Fila -> novedad de la API. Los nombres de los temas vienen con su marca de eliminado.
export function toApi(r) {
  if (!r) return null;
  return {
    id: r.id, seq: Number(r.seq), name: r.name, occurredAt: iso(r.occurred_at),
    authorId: r.author_id, authorName: r.author_name ?? null, authorArchived: r.author_archived_at != null,
    comment: r.comment,
    techId: r.tech_id, techName: r.tech_name ?? null, techArchived: r.tech_archived_at != null,
    plantillaId: r.plantilla_id, plantillaName: r.plantilla_name ?? null, plantillaArchived: r.plantilla_archived_at != null,
    lineaId: r.linea_id, lineaName: r.linea_name ?? null, lineaKind: r.linea_kind ?? null, lineaArchived: r.linea_archived_at != null,
    movementId: r.movement_id,
    movement: r.movement_id ? {
      id: r.movement_id, type: r.movement_type, at: iso(r.movement_at), qty: r.movement_qty, toolId: r.movement_tool_id, toolName: r.movement_tool_name ?? null,
      techId: r.movement_tech_id, cajaId: r.movement_caja_id, voided: r.movement_voided_by != null,
    } : null,
    archived: r.archived_at != null, archivedAt: iso(r.archived_at), archivedBy: r.archived_by, archiveReason: r.archive_reason,
    version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), by: r.created_by,
  };
}

export async function getNovedad(q, id) {
  return toApi((await q.query(`${SELECT} WHERE n.id = $1`, [id])).rows[0]);
}

// Fila sola, bloqueada (para editar).
export async function lockNovedad(q, id) {
  return (await q.query('SELECT * FROM novedades WHERE id = $1 FOR UPDATE', [id])).rows[0] || null;
}

export async function insertNovedad(q, v) {
  await q.query(
    `INSERT INTO novedades (id, author_id, comment, tech_id, plantilla_id, linea_id, movement_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [v.id, v.authorId, v.comment, v.techId, v.plantillaId, v.lineaId, v.movementId, v.authorId],
  );
}

const COLS = { comment: 'comment', techId: 'tech_id', plantillaId: 'plantilla_id', lineaId: 'linea_id' };
export async function updateNovedad(q, id, set) {
  const keys = Object.keys(set).filter((k) => COLS[k]);
  if (!keys.length) return;
  await q.query(`UPDATE novedades SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => set[k])]);
}

const likePattern = (s) => '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

// f: filtros de parseNovedadFilters. Devuelve { rows, next, total }.
export async function queryNovedades(q, f) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  // Días locales: la sesión de la base usa la zona horaria de la empresa.
  if (f.from) where.push(`n.occurred_at >= ${p(f.from)}::date`);
  if (f.to) where.push(`n.occurred_at < (${p(f.to)}::date + 1)`);
  if (f.techId) where.push(`n.tech_id = ${p(f.techId)}`);
  if (f.plantillaId) where.push(`n.plantilla_id = ${p(f.plantillaId)}`);
  if (f.lineaId) where.push(`n.linea_id = ${p(f.lineaId)}`);
  if (f.authorId) where.push(`n.author_id = ${p(f.authorId)}`);
  if (f.movementId) where.push(`n.movement_id = ${p(f.movementId)}`);
  if (f.linked === true) where.push('n.movement_id IS NOT NULL');
  if (f.linked === false) where.push('n.movement_id IS NULL');
  if (f.archived === 'exclude') where.push('n.archived_at IS NULL');
  if (f.archived === 'only') where.push('n.archived_at IS NOT NULL');
  if (f.q) where.push(`concat_ws(' ', n.comment, n.name, u.name, t.name, p.name, l.name) ILIKE ${p(likePattern(f.q))}`);
  const base = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await q.query(`SELECT count(*)::int AS n FROM (${SELECT} ${base}) x`, params)).rows[0].n;
  const page = [...where];
  if (f.before) page.push(`(n.occurred_at, n.id) < (${p(f.before.at)}::timestamptz, ${p(f.before.id)})`);
  const limit = f.limit ?? 50;
  const { rows } = await q.query(`${SELECT} ${page.length ? `WHERE ${page.join(' AND ')}` : ''} ORDER BY n.occurred_at DESC, n.id DESC LIMIT ${Number(limit) + 1}`, params);
  const more = rows.length > limit;
  const list = rows.slice(0, limit);
  const last = list[list.length - 1];
  return { rows: list.map(toApi), next: more && last ? `${last.cursor_at}|${last.id}` : null, total };
}
