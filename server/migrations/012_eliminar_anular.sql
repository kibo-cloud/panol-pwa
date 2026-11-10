-- 012: eliminar (baja lógica), restaurar, eliminación definitiva y anular movimientos (etapa 5).
-- - Columnas uniformes de baja lógica: archived_at, archived_by, archive_reason en técnicos,
--   cajas, herramientas (y sus unidades), categorías, plantillas, líneas, especialidades, kits y
--   usuarios. Un registro archivado queda oculto en listas y selectores, pero sigue en el
--   historial, los informes y la auditoría.
-- - Kits: un kit archivado no ocupa el lugar del kit de su especialidad.
-- - Anular: el contramovimiento es un movimiento nuevo de tipo `anulacion` con
--   `voids_movement_id` (único: un movimiento se anula una sola vez). El original nunca se borra
--   ni se modifica; una anulación no se anula (lo controla un trigger al insertar).
-- - Permisos nuevos: records_delete (eliminar, restaurar, eliminación definitiva) y
--   movements_void (anular movimientos), solo admin por defecto.
-- - Eliminación definitiva de un técnico sin historial: su primer rango de pertenencia (el del
--   alta) se borra junto con él; el historial de plantillas permite ese DELETE solo dentro de la
--   transacción que activa `panol.purge` con ese técnico.

ALTER TABLE techs ADD COLUMN archived_at timestamptz, ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE categories ADD COLUMN archived_at timestamptz, ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE tools ADD COLUMN archived_at timestamptz, ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE units ADD COLUMN archived_at timestamptz, ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE kits ADD COLUMN archived_at timestamptz, ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE users ADD COLUMN archived_at timestamptz, ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE plantillas ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE lineas ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE cajas ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);
ALTER TABLE especialidades ADD COLUMN archived_by text, ADD COLUMN archive_reason text CHECK (length(archive_reason) <= 20000);

-- Un registro archivado no está activo (las herramientas, técnicos y usuarios usan `active`).
ALTER TABLE techs ADD CONSTRAINT techs_archived_inactive CHECK (archived_at IS NULL OR NOT active);
ALTER TABLE tools ADD CONSTRAINT tools_archived_inactive CHECK (archived_at IS NULL OR NOT active);
ALTER TABLE users ADD CONSTRAINT users_archived_inactive CHECK (archived_at IS NULL OR NOT active);

-- Un kit por especialidad entre los activos (el archivado queda en el historial).
DROP INDEX kits_especialidad_key;
CREATE UNIQUE INDEX kits_especialidad_key ON kits (especialidad_id) WHERE especialidad_id IS NOT NULL AND archived_at IS NULL;

-- ---------------------------------------------------------------- permisos nuevos
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_perm_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_perm_check CHECK (perm IN (
  'controls_do', 'movements_do', 'techs_edit', 'shift_change', 'tools_edit', 'inventory_edit', 'alerts_resolve', 'shifts_edit',
  'reports_export', 'demo_manage', 'plantillas_edit', 'plantilla_rotate', 'lineas_edit', 'kits_edit', 'records_delete', 'movements_void'));

-- ---------------------------------------------------------------- anular movimientos
ALTER TABLE movements DROP CONSTRAINT movements_type_check;
ALTER TABLE movements ADD CONSTRAINT movements_type_check CHECK (type IN (
  'entrega_inicial', 'reposicion', 'adicional', 'devolucion', 'retiro', 'ingreso', 'reparado', 'baja', 'recupero', 'recepcion', 'anulacion'));
ALTER TABLE movements ADD COLUMN voids_movement_id panol_id;
ALTER TABLE movements ADD CONSTRAINT movements_void_check CHECK ((type = 'anulacion') = (voids_movement_id IS NOT NULL));
CREATE UNIQUE INDEX movements_voids_key ON movements (voids_movement_id) WHERE voids_movement_id IS NOT NULL;

-- La anulación nombra un movimiento que existe y que no es otra anulación.
CREATE FUNCTION movements_void_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t text;
BEGIN
  IF NEW.voids_movement_id IS NULL THEN RETURN NEW; END IF;
  SELECT type INTO t FROM movements WHERE id = NEW.voids_movement_id;
  IF t IS NULL THEN
    RAISE EXCEPTION 'La anulación nombra un movimiento que no existe (%)', NEW.voids_movement_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF t = 'anulacion' THEN
    RAISE EXCEPTION 'Una anulación no se anula (%)', NEW.voids_movement_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER movements_void_guard BEFORE INSERT ON movements FOR EACH ROW EXECUTE FUNCTION movements_void_guard();

-- ---------------------------------------------------------------- eliminación definitiva
-- Mismo guard que la migración 007, más el borrado del rango de un técnico que se elimina
-- definitivamente (sin historial) en la transacción que activa `panol.purge = techs:<id>`.
CREATE OR REPLACE FUNCTION tech_plantilla_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.demo AND demo_clear_active() THEN RETURN OLD; END IF;
    IF coalesce(current_setting('panol.purge', true), '') = 'techs:' || OLD.tech_id THEN RETURN OLD; END IF;
  ELSIF NEW.id = OLD.id AND NEW.tech_id = OLD.tech_id
     AND NEW.plantilla_id = OLD.plantilla_id AND NEW.valid_from IS NOT DISTINCT FROM OLD.valid_from
     AND NEW.temporary = OLD.temporary AND NEW.reason IS NOT DISTINCT FROM OLD.reason AND NEW.demo = OLD.demo
     AND NEW.created_at = OLD.created_at AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.valid_to IS NOT NULL
     AND (OLD.valid_to IS NULL
          OR (OLD.temporary AND NEW.valid_to < OLD.valid_to AND NEW.valid_to >= OLD.valid_from)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tech_plantilla_history es de solo agregar: solo se cierra un rango abierto o se acorta una cobertura (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE INDEX techs_archived_idx ON techs (archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX tools_archived_idx ON tools (archived_at) WHERE archived_at IS NOT NULL;
