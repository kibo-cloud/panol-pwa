-- 014: novedades (etapa 6).
-- - Una novedad es una entrada fechada del diario del pañol: `occurred_at` lo pone el servidor
--   (no se edita), el autor es el usuario que la carga, el comentario es obligatorio y los temas
--   (técnico, plantilla, línea o sector) son opcionales e independientes.
-- - Vínculo opcional a un movimiento (entrega o reposición); la solicitud de compra se agrega en
--   la etapa 7 con su propia columna.
-- - `seq` numera las novedades y `name` (Novedad N) es la etiqueta corta que usa el modelo
--   genérico de eliminar (Registros eliminados, confirmación de la eliminación definitiva).
-- - Baja lógica uniforme (archived_at, archived_by, archive_reason) y versión para If-Match.
-- - Permisos nuevos: novedades_view, novedades_create (quien opera el pañol, por defecto) y
--   novedades_edit (solo admin por defecto).

CREATE TABLE novedades (
  id panol_id PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  name text GENERATED ALWAYS AS ('Novedad ' || seq::text) STORED,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  author_id panol_id NOT NULL REFERENCES users(id),
  comment text NOT NULL CHECK (length(comment) BETWEEN 1 AND 2000),
  -- Temas: claves foráneas simples. Un tema nombrado en una novedad tiene historial (no se
  -- elimina definitivamente); archivarlo conserva la referencia.
  tech_id panol_id REFERENCES techs(id),
  plantilla_id panol_id REFERENCES plantillas(id),
  linea_id panol_id REFERENCES lineas(id),
  movement_id panol_id REFERENCES movements(id),
  archived_at timestamptz,
  archived_by text,
  archive_reason text CHECK (length(archive_reason) <= 20000),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE TRIGGER novedades_touch BEFORE UPDATE ON novedades FOR EACH ROW EXECUTE FUNCTION touch_row();

-- La fecha, el autor y el vínculo no cambian después del alta.
CREATE FUNCTION novedades_fixed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.movement_id IS DISTINCT FROM OLD.movement_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'La fecha, el autor y el vínculo de una novedad no se modifican' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER novedades_fixed_guard BEFORE UPDATE ON novedades FOR EACH ROW EXECUTE FUNCTION novedades_fixed_guard();

-- Lista: más nuevas primero (con el id para el cursor) y los filtros por tema, autor y vínculo.
CREATE INDEX novedades_occurred_idx ON novedades (occurred_at DESC, id DESC);
CREATE INDEX novedades_tech_idx ON novedades (tech_id, occurred_at DESC) WHERE tech_id IS NOT NULL;
CREATE INDEX novedades_plantilla_idx ON novedades (plantilla_id, occurred_at DESC) WHERE plantilla_id IS NOT NULL;
CREATE INDEX novedades_linea_idx ON novedades (linea_id, occurred_at DESC) WHERE linea_id IS NOT NULL;
CREATE INDEX novedades_author_idx ON novedades (author_id, occurred_at DESC);
CREATE INDEX novedades_movement_idx ON novedades (movement_id) WHERE movement_id IS NOT NULL;
CREATE INDEX novedades_archived_idx ON novedades (archived_at) WHERE archived_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON novedades TO panol_app;
GRANT USAGE, SELECT ON SEQUENCE novedades_seq_seq TO panol_app;

-- ---------------------------------------------------------------- permisos nuevos
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_perm_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_perm_check CHECK (perm IN (
  'controls_do', 'movements_do', 'techs_edit', 'shift_change', 'tools_edit', 'inventory_edit', 'alerts_resolve', 'shifts_edit',
  'reports_export', 'demo_manage', 'plantillas_edit', 'plantilla_rotate', 'lineas_edit', 'kits_edit', 'records_delete', 'movements_void',
  'novedades_view', 'novedades_create', 'novedades_edit'));

-- ---------------------------------------------------------------- historial de un técnico
-- Una novedad que nombra al técnico es historial: la eliminación definitiva (migración 013)
-- vuelve a revisarlo antes de borrar su rango de pertenencia.
CREATE OR REPLACE FUNCTION tech_has_history(p_tech panol_id) RETURNS boolean LANGUAGE sql STABLE
  SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM movements WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM assignments WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM controls WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM units WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM shift_changes WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM cajas WHERE referente_tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM alert_resolutions WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM novedades WHERE tech_id = p_tech)
      OR (SELECT count(*) FROM tech_plantilla_history WHERE tech_id = p_tech) > 1
$$;
