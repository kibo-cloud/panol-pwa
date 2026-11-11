-- 016: importador del Excel anterior (etapa 9).
-- - import_batches: un lote por archivo importado (hash sha256 del archivo, nombre, quién y
--   cuándo, el token del plan confirmado y los totales). Solo agregar: un lote no se edita ni
--   se borra. El mismo archivo (mismo hash) no se importa dos veces (índice único).
-- - import_batch_id: marca de importación en lo que crea el lote (técnicos, herramientas,
--   movimientos, controles y novedades). Los movimientos y controles también llevan
--   `imported = true` (la marca de lo que entra desde un archivo, migración 004).
-- - Permiso nuevo: import_excel (solo admin por defecto).

CREATE TABLE import_batches (
  id panol_id PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('excel_v1')),
  file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 500),
  plan_token text NOT NULL CHECK (plan_token ~ '^[0-9a-f]{64}$'),
  counts jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_batches_file_key ON import_batches (kind, file_hash);
CREATE TRIGGER import_batches_append_only BEFORE UPDATE OR DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER import_batches_no_truncate BEFORE TRUNCATE ON import_batches FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
GRANT SELECT, INSERT ON import_batches TO panol_app;
REVOKE UPDATE, DELETE, TRUNCATE ON import_batches FROM panol_app;

ALTER TABLE techs ADD COLUMN import_batch_id panol_id REFERENCES import_batches(id);
ALTER TABLE tools ADD COLUMN import_batch_id panol_id REFERENCES import_batches(id);
ALTER TABLE movements ADD COLUMN import_batch_id panol_id REFERENCES import_batches(id);
ALTER TABLE controls ADD COLUMN import_batch_id panol_id REFERENCES import_batches(id);
ALTER TABLE novedades ADD COLUMN import_batch_id panol_id REFERENCES import_batches(id);
CREATE INDEX movements_import_batch_idx ON movements (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX controls_import_batch_idx ON controls (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- La marca de importación de una novedad tampoco cambia después del alta.
CREATE OR REPLACE FUNCTION novedades_fixed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.movement_id IS DISTINCT FROM OLD.movement_id OR NEW.purchase_request_id IS DISTINCT FROM OLD.purchase_request_id
     OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'La fecha, el autor y el vínculo de una novedad no se modifican' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- permisos nuevos
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_perm_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_perm_check CHECK (perm IN (
  'controls_do', 'movements_do', 'techs_edit', 'shift_change', 'tools_edit', 'inventory_edit', 'alerts_resolve', 'shifts_edit',
  'reports_export', 'demo_manage', 'plantillas_edit', 'plantilla_rotate', 'lineas_edit', 'kits_edit', 'records_delete', 'movements_void',
  'novedades_view', 'novedades_create', 'novedades_edit', 'purchases_view', 'purchases_decide', 'purchases_create', 'purchases_receive',
  'import_excel'));
