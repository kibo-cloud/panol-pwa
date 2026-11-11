-- 015: solicitudes de compra y apartado de Gerencia (etapa 7).
-- - Una solicitud nombra la herramienta (y la unidad, si se controla por unidad), la asignación
--   cuando viene de un poseedor, el técnico o la caja y su plantilla (foto al crearla), el motivo
--   (cambio = dañada, faltante = extraviada), la observación del control (foto), la cantidad, el
--   costo estimado y el proveedor (opcionales), el origen (control, herramienta o alerta) y quién
--   y cuándo la generó.
-- - Estados: pendiente -> aprobada | rechazada; aprobada -> comprada (opcional) -> recibida
--   (también aprobada -> recibida). Cada transición guarda quién y cuándo; rechazar pide comentario.
--   Un trigger impide los saltos de estado y que cambien los datos de origen.
-- - Una sola solicitud abierta (pendiente, aprobada o comprada, no eliminada) por asignación y
--   motivo, y por unidad y motivo (índices únicos parciales). Los controles siguientes se vinculan
--   a la existente (purchase_request_controls).
-- - Recibir crea el ingreso al inventario (movimiento `ingreso`) vinculado a la solicitud; una
--   reposición posterior al poseedor se vincula a esa solicitud recibida.
-- - Eliminar (cancelar) = baja lógica, solo mientras está pendiente; nunca eliminación definitiva:
--   las solicitudes son historial (la app no tiene DELETE sobre estas tablas).
-- - Novedades: vínculo opcional a una solicitud (columna nueva), fijo después del alta.
-- - Permisos nuevos: purchases_view, purchases_decide (Gerencia), purchases_create (quien opera el
--   pañol) y purchases_receive (responsable).

CREATE TABLE purchase_requests (
  id panol_id PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  name text GENERATED ALWAYS AS ('Compra ' || seq::text) STORED,
  tool_id panol_id NOT NULL REFERENCES tools(id),
  unit_id panol_id REFERENCES units(id),
  assignment_id panol_id REFERENCES assignments(id),
  tech_id panol_id REFERENCES techs(id),
  caja_id panol_id REFERENCES cajas(id),
  plantilla_id panol_id REFERENCES plantillas(id),
  -- Fotos al crearla (el nombre del poseedor, la herramienta y la unidad de ese momento).
  holder_name text CHECK (length(holder_name) <= 20000),
  tool_name text CHECK (length(tool_name) <= 20000),
  unit_code text CHECK (length(unit_code) <= 20000),
  reason text NOT NULL CHECK (reason IN ('cambio', 'faltante')),
  observation text CHECK (length(observation) <= 20000),
  qty int NOT NULL CHECK (qty > 0),
  estimated_cost numeric(12,2) CHECK (estimated_cost >= 0),
  supplier text CHECK (length(supplier) <= 500),
  origin text NOT NULL CHECK (origin IN ('control', 'tool', 'alert')),
  origin_control_id panol_id REFERENCES controls(id),
  alert_key text CHECK (length(alert_key) <= 500),
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aprobada', 'rechazada', 'comprada', 'recibida')),
  decided_by panol_id REFERENCES users(id),
  decided_at timestamptz,
  decision_comment text CHECK (length(decision_comment) <= 20000),
  purchased_by panol_id REFERENCES users(id),
  purchased_at timestamptz,
  purchase_note text CHECK (length(purchase_note) <= 20000),
  received_by panol_id REFERENCES users(id),
  received_at timestamptz,
  received_qty int CHECK (received_qty > 0),
  reception_note text CHECK (length(reception_note) <= 20000),
  ingreso_movement_id panol_id REFERENCES movements(id),
  reposicion_movement_id panol_id REFERENCES movements(id),
  -- Una rechazada deja de frenar la creación automática cuando un control muestra la pérdida resuelta.
  loss_resolved_at timestamptz,
  loss_resolved_control_id panol_id REFERENCES controls(id),
  archived_at timestamptz,
  archived_by text,
  archive_reason text CHECK (length(archive_reason) <= 20000),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CHECK (tech_id IS NULL OR caja_id IS NULL),
  CHECK (assignment_id IS NULL OR tech_id IS NOT NULL OR caja_id IS NOT NULL),
  CHECK ((origin = 'control') = (origin_control_id IS NOT NULL)),
  CHECK (status = 'pendiente' OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (status <> 'rechazada' OR (decision_comment IS NOT NULL AND length(trim(decision_comment)) > 0)),
  CHECK (status <> 'comprada' OR purchased_at IS NOT NULL),
  CHECK (status <> 'recibida' OR (received_at IS NOT NULL AND ingreso_movement_id IS NOT NULL)),
  CHECK (reposicion_movement_id IS NULL OR status = 'recibida'),
  CHECK (archived_at IS NULL OR status = 'pendiente')
);
CREATE TRIGGER purchase_requests_touch BEFORE UPDATE ON purchase_requests FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Solo las transiciones válidas; los datos de origen y las marcas de cada paso no cambian.
CREATE FUNCTION purchase_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tool_id IS DISTINCT FROM OLD.tool_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id
     OR NEW.tech_id IS DISTINCT FROM OLD.tech_id OR NEW.caja_id IS DISTINCT FROM OLD.caja_id OR NEW.plantilla_id IS DISTINCT FROM OLD.plantilla_id
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.origin_control_id IS DISTINCT FROM OLD.origin_control_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Los datos de origen de una solicitud de compra no se modifican' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pendiente' AND NEW.status IN ('aprobada', 'rechazada'))
    OR (OLD.status = 'aprobada' AND NEW.status IN ('comprada', 'recibida'))
    OR (OLD.status = 'comprada' AND NEW.status = 'recibida')) THEN
    RAISE EXCEPTION 'Transición de compra inválida: % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.decided_at IS NOT NULL AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decided_by IS DISTINCT FROM OLD.decided_by OR NEW.decision_comment IS DISTINCT FROM OLD.decision_comment))
     OR (OLD.purchased_at IS NOT NULL AND (NEW.purchased_at IS DISTINCT FROM OLD.purchased_at OR NEW.purchased_by IS DISTINCT FROM OLD.purchased_by))
     OR (OLD.received_at IS NOT NULL AND (NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.ingreso_movement_id IS DISTINCT FROM OLD.ingreso_movement_id))
     OR (OLD.reposicion_movement_id IS NOT NULL AND NEW.reposicion_movement_id IS DISTINCT FROM OLD.reposicion_movement_id) THEN
    RAISE EXCEPTION 'Una decisión, compra o recepción registrada no se modifica' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Cerradas (rechazada o recibida): solo la marca de pérdida resuelta y el vínculo a la reposición.
  IF OLD.status IN ('rechazada', 'recibida') AND (NEW.qty IS DISTINCT FROM OLD.qty OR NEW.estimated_cost IS DISTINCT FROM OLD.estimated_cost OR NEW.supplier IS DISTINCT FROM OLD.supplier) THEN
    RAISE EXCEPTION 'Una solicitud cerrada no se modifica' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_requests_guard BEFORE UPDATE ON purchase_requests FOR EACH ROW EXECUTE FUNCTION purchase_requests_guard();

-- Una abierta por asignación y motivo, y por unidad y motivo (las eliminadas no cuentan).
CREATE UNIQUE INDEX purchase_open_assignment_key ON purchase_requests (assignment_id, reason)
  WHERE assignment_id IS NOT NULL AND archived_at IS NULL AND status IN ('pendiente', 'aprobada', 'comprada');
CREATE UNIQUE INDEX purchase_open_unit_key ON purchase_requests (unit_id, reason)
  WHERE unit_id IS NOT NULL AND archived_at IS NULL AND status IN ('pendiente', 'aprobada', 'comprada');
-- Un ingreso y una reposición se vinculan a una sola solicitud.
CREATE UNIQUE INDEX purchase_ingreso_key ON purchase_requests (ingreso_movement_id) WHERE ingreso_movement_id IS NOT NULL;
CREATE UNIQUE INDEX purchase_reposicion_key ON purchase_requests (reposicion_movement_id) WHERE reposicion_movement_id IS NOT NULL;

-- Lista (más nuevas primero, con el id para el cursor), filtros y totales por mes de la decisión.
CREATE INDEX purchase_created_idx ON purchase_requests (created_at DESC, id DESC);
CREATE INDEX purchase_status_idx ON purchase_requests (status) WHERE archived_at IS NULL;
CREATE INDEX purchase_decided_idx ON purchase_requests (decided_at) WHERE decided_at IS NOT NULL;
CREATE INDEX purchase_tool_idx ON purchase_requests (tool_id);
CREATE INDEX purchase_tech_idx ON purchase_requests (tech_id) WHERE tech_id IS NOT NULL;
CREATE INDEX purchase_caja_idx ON purchase_requests (caja_id) WHERE caja_id IS NOT NULL;
CREATE INDEX purchase_plantilla_idx ON purchase_requests (plantilla_id) WHERE plantilla_id IS NOT NULL;
CREATE INDEX purchase_assignment_idx ON purchase_requests (assignment_id) WHERE assignment_id IS NOT NULL;
CREATE INDEX purchase_unit_idx ON purchase_requests (unit_id) WHERE unit_id IS NOT NULL;

-- Controles vinculados a una solicitud (el que la creó y los siguientes con la misma pérdida).
CREATE TABLE purchase_request_controls (
  request_id panol_id NOT NULL REFERENCES purchase_requests(id),
  control_id panol_id NOT NULL REFERENCES controls(id),
  qty int NOT NULL CHECK (qty > 0),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, control_id)
);
CREATE INDEX purchase_request_controls_control_idx ON purchase_request_controls (control_id);

GRANT SELECT, INSERT, UPDATE ON purchase_requests TO panol_app;
GRANT SELECT, INSERT ON purchase_request_controls TO panol_app;
REVOKE DELETE, TRUNCATE ON purchase_requests, purchase_request_controls FROM panol_app;
GRANT USAGE, SELECT ON SEQUENCE purchase_requests_seq_seq TO panol_app;

-- ---------------------------------------------------------------- novedades
ALTER TABLE novedades ADD COLUMN purchase_request_id panol_id REFERENCES purchase_requests(id);
CREATE INDEX novedades_purchase_idx ON novedades (purchase_request_id) WHERE purchase_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION novedades_fixed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.occurred_at IS DISTINCT FROM OLD.occurred_at OR NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.movement_id IS DISTINCT FROM OLD.movement_id OR NEW.purchase_request_id IS DISTINCT FROM OLD.purchase_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'La fecha, el autor y el vínculo de una novedad no se modifican' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- permisos nuevos
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_perm_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_perm_check CHECK (perm IN (
  'controls_do', 'movements_do', 'techs_edit', 'shift_change', 'tools_edit', 'inventory_edit', 'alerts_resolve', 'shifts_edit',
  'reports_export', 'demo_manage', 'plantillas_edit', 'plantilla_rotate', 'lineas_edit', 'kits_edit', 'records_delete', 'movements_void',
  'novedades_view', 'novedades_create', 'novedades_edit', 'purchases_view', 'purchases_decide', 'purchases_create', 'purchases_receive'));

-- ---------------------------------------------------------------- historial de un técnico
-- Una solicitud de compra que nombra al técnico es historial (como en la migración 014).
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
      OR EXISTS (SELECT 1 FROM purchase_requests WHERE tech_id = p_tech)
      OR (SELECT count(*) FROM tech_plantilla_history WHERE tech_id = p_tech) > 1
$$;
