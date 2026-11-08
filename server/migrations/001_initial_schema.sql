-- 001: modelo equivalente a Pañol 2.1 en PostgreSQL.
-- Los ids de texto de 2.1 se mantienen como claves primarias (el importador del .txt los
-- copia 1:1). Límites de texto del esquema de 2.1 (SCHEMA): nombres 500, legajo y código 200,
-- textos libres 20000. La API aplica además los límites de carga de la interfaz (LIM).

-- Id de 2.1: caracteres seguros y sin nombres especiales.
CREATE DOMAIN panol_id AS text
  CHECK (VALUE ~ '^[A-Za-z0-9_.~:@+-]{1,200}$' AND VALUE NOT IN ('.', '..', '__proto__', 'constructor', 'prototype'));

-- Lugares del inventario (POOL_K de 2.1).
CREATE DOMAIN pool_key AS text
  CHECK (VALUE IN ('disponible', 'asignado', 'reparacion', 'retirado', 'pendiente', 'baja', 'externo'));

CREATE DOMAIN app_role AS text
  CHECK (VALUE IN ('admin', 'gerencia', 'supervisor', 'responsable', 'consulta'));

-- Edición concurrente: cada UPDATE sube `version` y renueva `updated_at`.
CREATE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Tablas de solo agregar: rechazan UPDATE y DELETE.
CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es de solo agregar: no se permite %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------- usuarios y sesiones
CREATE TABLE users (
  id panol_id PRIMARY KEY,
  username text NOT NULL CHECK (username ~ '^[a-z0-9._-]{3,60}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  role app_role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  password_hash text CHECK (length(password_hash) <= 400),
  must_change_password boolean NOT NULL DEFAULT true,
  -- PIN de 2.1 migrado (etapa 1, importador): sirve una sola vez como contraseña temporal.
  legacy_salt text CHECK (length(legacy_salt) <= 200),
  legacy_pin_hash text CHECK (length(legacy_pin_hash) <= 400),
  last_login_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Overrides de permisos por rol (admin siempre puede todo, no se configura).
CREATE TABLE role_permissions (
  role app_role NOT NULL CHECK (role <> 'admin'),
  perm text NOT NULL CHECK (perm IN ('controls_do', 'movements_do', 'techs_edit', 'shift_change', 'tools_edit', 'inventory_edit', 'alerts_resolve', 'shifts_edit', 'reports_export', 'demo_manage')),
  allowed boolean NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  PRIMARY KEY (role, perm)
);
CREATE TRIGGER role_permissions_touch BEFORE UPDATE ON role_permissions FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Sesiones: solo se guarda el sha256 del identificador de la cookie.
CREATE TABLE sessions (
  id_hash bytea PRIMARY KEY CHECK (length(id_hash) = 32),
  user_id panol_id NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  remember boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text CHECK (length(user_agent) <= 500)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Bloqueo progresivo, por nombre de usuario (exista o no, para no revelar cuáles existen).
CREATE TABLE login_locks (
  username text PRIMARY KEY CHECK (length(username) <= 200),
  fails int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_ip text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  username text NOT NULL CHECK (length(username) <= 200),
  ip text,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'fail', 'locked')),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_username_idx ON login_attempts (lower(username), at);

-- ---------------------------------------------------------------- turnos y técnicos
CREATE TABLE shifts (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  sort_order int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE TRIGGER shifts_touch BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE techs (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  legajo text CHECK (length(legajo) BETWEEN 1 AND 200),
  shift_id panol_id REFERENCES shifts(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  alta date,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE UNIQUE INDEX techs_legajo_key ON techs (legajo) WHERE legajo IS NOT NULL;
CREATE TRIGGER techs_touch BEFORE UPDATE ON techs FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Historial de cambios de turno (se guardan los nombres del momento).
CREATE TABLE shift_changes (
  id panol_id PRIMARY KEY,
  tech_id panol_id NOT NULL REFERENCES techs(id),
  from_shift_id panol_id,
  to_shift_id panol_id,
  from_name text CHECK (length(from_name) <= 20000),
  to_name text CHECK (length(to_name) <= 20000),
  effective_from date,
  note text CHECK (length(note) <= 20000),
  at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX shift_changes_tech_idx ON shift_changes (tech_id, at);
CREATE TRIGGER shift_changes_touch BEFORE UPDATE ON shift_changes FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------------------------------------------------------------- herramientas
CREATE TABLE categories (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE TRIGGER categories_touch BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE tools (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  description text CHECK (length(description) <= 20000),
  category_id panol_id REFERENCES categories(id) ON DELETE SET NULL,
  serialized boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE TRIGGER tools_touch BEFORE UPDATE ON tools FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Unidades de herramientas serializadas. Código único sin distinguir mayúsculas (como 2.1).
CREATE TABLE units (
  id panol_id PRIMARY KEY,
  tool_id panol_id NOT NULL REFERENCES tools(id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 200),
  status pool_key NOT NULL,
  tech_id panol_id REFERENCES techs(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE UNIQUE INDEX units_code_key ON units (lower(code));
CREATE INDEX units_tool_idx ON units (tool_id);
CREATE TRIGGER units_touch BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE assignments (
  id panol_id PRIMARY KEY,
  tech_id panol_id NOT NULL REFERENCES techs(id),
  tool_id panol_id NOT NULL REFERENCES tools(id),
  unit_id panol_id REFERENCES units(id),
  qty int NOT NULL DEFAULT 1 CHECK (qty >= 1),
  active boolean NOT NULL DEFAULT true,
  since timestamptz,
  until timestamptz,
  movement_id panol_id,
  replaces panol_id,
  end_reason text CHECK (length(end_reason) <= 20000),
  replaced_by panol_id,
  end_movement_id panol_id,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX assignments_tech_idx ON assignments (tech_id) WHERE active;
CREATE TRIGGER assignments_touch BEFORE UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------------------------------------------------------------- libro de movimientos
-- Solo agregar. Anular un movimiento es registrar el contramovimiento.
-- Sin claves foráneas: el libro conserva referencias aunque el registro se dé de baja.
CREATE TABLE movements (
  id panol_id PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('entrega_inicial', 'reposicion', 'adicional', 'devolucion', 'retiro', 'ingreso', 'reparado', 'baja', 'recupero', 'recepcion')),
  tech_id panol_id,
  tool_id panol_id,
  qty int,
  unit_id panol_id,
  new_assignment_id panol_id,
  old_assignment_id panol_id,
  old_unit_id panol_id,
  new_unit_id panol_id,
  old_state text CHECK (old_state IN ('bueno', 'cambio', 'faltante', 'pendiente')),
  returned boolean,
  old_dest pool_key,
  condition pool_key,
  linked_control_id panol_id,
  resolves_movement_id panol_id,
  reason text CHECK (length(reason) <= 20000),
  notes text CHECK (length(notes) <= 20000),
  at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX movements_at_idx ON movements (at);
CREATE INDEX movements_tech_idx ON movements (tech_id);
-- Una devolución pendiente se recibe una sola vez.
CREATE UNIQUE INDEX movements_resolves_key ON movements (resolves_movement_id) WHERE type = 'recepcion';

CREATE TABLE movement_transfers (
  movement_id panol_id NOT NULL REFERENCES movements(id),
  seq int NOT NULL CHECK (seq >= 0),
  tool_id panol_id NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  from_pool pool_key NOT NULL,
  to_pool pool_key NOT NULL,
  unit_id panol_id,
  PRIMARY KEY (movement_id, seq)
);
CREATE INDEX movement_transfers_tool_idx ON movement_transfers (tool_id);

CREATE TRIGGER movements_append_only BEFORE UPDATE OR DELETE ON movements FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER movement_transfers_append_only BEFORE UPDATE OR DELETE ON movement_transfers FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER movements_no_truncate BEFORE TRUNCATE ON movements FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER movement_transfers_no_truncate BEFORE TRUNCATE ON movement_transfers FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- ---------------------------------------------------------------- controles
CREATE TABLE controls (
  id panol_id PRIMARY KEY,
  tech_id panol_id NOT NULL REFERENCES techs(id),
  tech_name text CHECK (length(tech_name) <= 20000),
  shift_id panol_id,
  period_y int NOT NULL CHECK (period_y BETWEEN 1900 AND 9999),
  period_m int NOT NULL CHECK (period_m BETWEEN 1 AND 12),
  period_w int NOT NULL CHECK (period_w BETWEEN 1 AND 4),
  status text NOT NULL CHECK (status IN ('borrador', 'finalizado')),
  count_bueno int NOT NULL DEFAULT 0,
  count_cambio int NOT NULL DEFAULT 0,
  count_faltante int NOT NULL DEFAULT 0,
  correction boolean NOT NULL DEFAULT false,
  supersedes_id panol_id REFERENCES controls(id),
  started_at timestamptz,
  finished_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CHECK (status = 'borrador' OR finished_at IS NOT NULL),
  CHECK (NOT correction OR supersedes_id IS NOT NULL)
);
-- Un solo control original por técnico y período.
CREATE UNIQUE INDEX controls_original_key ON controls (tech_id, period_y, period_m, period_w) WHERE NOT correction;
CREATE INDEX controls_period_idx ON controls (period_y, period_m, period_w);

CREATE TABLE control_items (
  control_id panol_id NOT NULL REFERENCES controls(id) ON DELETE CASCADE,
  assignment_id panol_id NOT NULL,
  state text NOT NULL CHECK (state IN ('bueno', 'cambio', 'faltante')),
  note text CHECK (length(note) <= 20000),
  tool_id panol_id,
  tool_name text CHECK (length(tool_name) <= 20000),
  category text CHECK (length(category) <= 20000),
  unit_id panol_id,
  unit_code text CHECK (length(unit_code) <= 20000),
  qty int NOT NULL DEFAULT 1,
  PRIMARY KEY (control_id, assignment_id)
);

-- Un control finalizado no se modifica ni se borra: se corrige con un registro nuevo.
CREATE FUNCTION controls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'finalizado' THEN
    RAISE EXCEPTION 'El control % está finalizado: se corrige con un registro nuevo', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER controls_immutable BEFORE UPDATE OR DELETE ON controls FOR EACH ROW EXECUTE FUNCTION controls_guard();

-- Ítems: solo se cambian mientras el control es borrador.
CREATE FUNCTION control_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cid text := CASE WHEN TG_OP = 'DELETE' THEN OLD.control_id ELSE NEW.control_id END;
  st text;
BEGIN
  SELECT status INTO st FROM controls WHERE id = cid;
  IF st = 'finalizado' THEN
    RAISE EXCEPTION 'El control % está finalizado: sus ítems no se modifican', cid
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.control_id <> NEW.control_id THEN
    SELECT status INTO st FROM controls WHERE id = OLD.control_id;
    IF st = 'finalizado' THEN
      RAISE EXCEPTION 'El control % está finalizado: sus ítems no se modifican', OLD.control_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER control_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON control_items FOR EACH ROW EXECUTE FUNCTION control_items_guard();
CREATE TRIGGER controls_no_truncate BEFORE TRUNCATE ON controls FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER control_items_no_truncate BEFORE TRUNCATE ON control_items FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- ---------------------------------------------------------------- alertas, auditoría, ajustes
-- La clave es la de la alerta derivada (p. ej. falt-<asignación>-<control>).
CREATE TABLE alert_resolutions (
  key panol_id PRIMARY KEY,
  type text CHECK (length(type) <= 20000),
  title text CHECK (length(title) <= 20000),
  text text CHECK (length(text) <= 20000),
  tech_id panol_id,
  note text CHECK (length(note) <= 20000),
  at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE TRIGGER alert_resolutions_touch BEFORE UPDATE ON alert_resolutions FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE audit_log (
  id panol_id PRIMARY KEY,
  action text NOT NULL CHECK (length(action) <= 200),
  entity text CHECK (length(entity) <= 200),
  entity_id text CHECK (length(entity_id) <= 20000),
  detail text CHECK (length(detail) <= 20000),
  at timestamptz NOT NULL DEFAULT now(),
  actor_id text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_at_idx ON audit_log (at);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TABLE app_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9_.-]{1,100}$'),
  value jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE TRIGGER app_settings_touch BEFORE UPDATE ON app_settings FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Turnos por defecto de 2.1.
INSERT INTO shifts (id, name, sort_order) VALUES
  ('manana', 'Turno mañana', 1),
  ('tarde', 'Turno tarde', 2),
  ('noche', 'Turno noche', 3);
