-- 005: plantillas por supervisor (reemplazan a los turnos fijos de 2.1).
-- - plantillas: nombre, supervisor (usuario), turno actual (rótulo informativo), baja lógica.
-- - tech_plantilla_history: a qué plantilla pertenece cada técnico, por rangos de fechas
--   [valid_from, valid_to) que nunca se superponen (restricción de exclusión). valid_from nulo
--   = desde siempre; valid_to nulo = rango abierto (la plantilla actual). Solo agregar: lo
--   único que se permite es cerrar un rango abierto. Un rango con desde = hasta queda anulado.
-- - plantilla_rotations y plantilla_supervisor_history: solo agregar.
-- - controls.plantilla_id_snapshot: la plantilla del técnico cuando se hizo el control.
-- Migración de datos: cada turno pasa a ser una plantilla con el mismo id; techs.shift_id y
-- shift_changes pasan al historial. Las tablas shifts y shift_changes quedan para lectura y
-- la app ya no escribe en ellas (ni en techs.shift_id).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- permisos nuevos
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_perm_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_perm_check CHECK (perm IN (
  'controls_do', 'movements_do', 'techs_edit', 'shift_change', 'tools_edit', 'inventory_edit', 'alerts_resolve', 'shifts_edit',
  'reports_export', 'demo_manage', 'plantillas_edit', 'plantilla_rotate', 'lineas_edit'));

-- ---------------------------------------------------------------- plantillas
CREATE TABLE plantillas (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  supervisor_user_id panol_id REFERENCES users(id) ON DELETE SET NULL,
  current_shift_label text CHECK (length(current_shift_label) <= 500),
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX plantillas_supervisor_idx ON plantillas (supervisor_user_id) WHERE archived_at IS NULL;
CREATE TRIGGER plantillas_touch BEFORE UPDATE ON plantillas FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE tech_plantilla_history (
  id panol_id PRIMARY KEY,
  -- Sin clave foránea al técnico: el historial sobrevive a las bajas (como el libro).
  tech_id panol_id NOT NULL,
  plantilla_id panol_id NOT NULL REFERENCES plantillas(id),
  valid_from date,
  valid_to date,
  temporary boolean NOT NULL DEFAULT false,
  reason text CHECK (length(reason) <= 20000),
  demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
  CHECK (NOT temporary OR valid_to IS NOT NULL),
  CONSTRAINT tech_plantilla_history_no_overlap EXCLUDE USING gist (tech_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);

-- Solo agregar: se permite cerrar un rango abierto (valid_to de nulo a una fecha) sin tocar
-- nada más, y borrar filas demo durante el borrado de la demostración.
CREATE FUNCTION tech_plantilla_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.demo AND demo_clear_active() THEN RETURN OLD; END IF;
  ELSIF OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL AND NEW.id = OLD.id AND NEW.tech_id = OLD.tech_id
     AND NEW.plantilla_id = OLD.plantilla_id AND NEW.valid_from IS NOT DISTINCT FROM OLD.valid_from
     AND NEW.temporary = OLD.temporary AND NEW.reason IS NOT DISTINCT FROM OLD.reason AND NEW.demo = OLD.demo
     AND NEW.created_at = OLD.created_at AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tech_plantilla_history es de solo agregar: solo se cierra un rango abierto (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER tech_plantilla_history_append_only BEFORE UPDATE OR DELETE ON tech_plantilla_history FOR EACH ROW EXECUTE FUNCTION tech_plantilla_history_guard();
CREATE TRIGGER tech_plantilla_history_no_truncate BEFORE TRUNCATE ON tech_plantilla_history FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

CREATE TABLE plantilla_rotations (
  id panol_id PRIMARY KEY,
  plantilla_id panol_id NOT NULL REFERENCES plantillas(id),
  from_label text CHECK (length(from_label) <= 500),
  shift_label text NOT NULL CHECK (length(shift_label) BETWEEN 1 AND 500),
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX plantilla_rotations_idx ON plantilla_rotations (plantilla_id, effective_from);

CREATE TABLE plantilla_supervisor_history (
  id panol_id PRIMARY KEY,
  plantilla_id panol_id NOT NULL REFERENCES plantillas(id),
  -- Sin clave foránea: el usuario puede darse de baja y el historial queda.
  from_user_id panol_id,
  supervisor_user_id panol_id,
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX plantilla_supervisor_history_idx ON plantilla_supervisor_history (plantilla_id, effective_from);

CREATE TRIGGER plantilla_rotations_append_only BEFORE UPDATE OR DELETE ON plantilla_rotations FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER plantilla_rotations_no_truncate BEFORE TRUNCATE ON plantilla_rotations FOR EACH STATEMENT EXECUTE FUNCTION reject_change();
CREATE TRIGGER plantilla_supervisor_history_append_only BEFORE UPDATE OR DELETE ON plantilla_supervisor_history FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER plantilla_supervisor_history_no_truncate BEFORE TRUNCATE ON plantilla_supervisor_history FOR EACH STATEMENT EXECUTE FUNCTION reject_change();

-- Rol de la app: las tablas nuevas tienen los permisos por defecto de 003; las de solo
-- agregar no se modifican ni se borran (el historial de pertenencia sí se cierra: UPDATE,
-- limitado por el trigger; DELETE solo de filas demo, también por el trigger).
REVOKE UPDATE, DELETE, TRUNCATE ON plantilla_rotations, plantilla_supervisor_history FROM panol_app;
REVOKE TRUNCATE ON tech_plantilla_history FROM panol_app;

-- ---------------------------------------------------------------- funciones de fecha
-- Último día de la semana de un período (la semana 4 llega a fin de mes).
CREATE FUNCTION period_end(y int, m int, w int) RETURNS date LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN w < 4 THEN make_date(y, m, w * 7) ELSE (make_date(y, m, 1) + interval '1 month' - interval '1 day')::date END
$$;

-- Plantilla de un técnico en una fecha: el único rango que la cubre.
CREATE FUNCTION plantilla_on(p_tech text, p_day date) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT plantilla_id FROM tech_plantilla_history
   WHERE tech_id = p_tech AND daterange(valid_from, valid_to, '[)') @> p_day LIMIT 1
$$;

-- Rangos de pertenencia a partir de los cambios de turno de 2.1 (los usa esta migración y el
-- importador del .txt). p_changes: [{id, from, to, effectiveFrom, at, note, by}].
-- - Orden por fecha desde (si falta, la fecha de `at`), luego `at` e id.
-- - Primer rango: la plantilla de origen del primer cambio, desde siempre.
-- - Dos cambios el mismo día: queda el último. Un cambio a la misma plantilla no corta el rango.
-- - El último rango (abierto) es la plantilla actual del técnico (p_current) si viene.
-- - Una plantilla que no existe deja un hueco (el técnico no pertenece a ninguna en ese tramo).
CREATE FUNCTION plantilla_ranges_from_changes(p_current text, p_changes jsonb)
RETURNS TABLE (src_id text, plantilla_id text, valid_from date, valid_to date, reason text, created_at timestamptz, created_by text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  ch record;
  started boolean := false;
  c_pl text := NULL;
  c_from date := NULL;
  c_src text := NULL;
  c_reason text := NULL;
  c_at timestamptz := NULL;
  c_by text := NULL;
  ok_pl text;
BEGIN
  FOR ch IN
    SELECT x->>'id' AS id, nullif(x->>'from', '') AS f, nullif(x->>'to', '') AS t,
           coalesce(nullif(x->>'effectiveFrom', '')::date, (nullif(x->>'at', '')::timestamptz)::date) AS d,
           nullif(x->>'at', '')::timestamptz AS ts, nullif(x->>'note', '') AS note, nullif(x->>'by', '') AS actor
      FROM jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) x
     ORDER BY 4 NULLS FIRST, 5 NULLS FIRST, 1
  LOOP
    CONTINUE WHEN ch.d IS NULL;
    SELECT p.id INTO ok_pl FROM plantillas p WHERE p.id = ch.t;
    IF NOT started THEN
      SELECT p.id INTO c_pl FROM plantillas p WHERE p.id = ch.f;
      started := true;
    END IF;
    IF c_from IS NOT NULL AND ch.d <= c_from THEN
      -- Mismo día (o anterior) que el cambio que abrió el tramo: lo reemplaza.
      c_pl := ok_pl; c_src := ch.id; c_reason := ch.note; c_at := ch.ts; c_by := ch.actor;
      CONTINUE;
    END IF;
    CONTINUE WHEN ok_pl IS NOT DISTINCT FROM c_pl;
    IF c_pl IS NOT NULL THEN
      src_id := c_src; plantilla_id := c_pl; valid_from := c_from; valid_to := ch.d;
      reason := c_reason; created_at := c_at; created_by := c_by;
      RETURN NEXT;
    END IF;
    c_pl := ok_pl; c_from := ch.d; c_src := ch.id; c_reason := ch.note; c_at := ch.ts; c_by := ch.actor;
  END LOOP;
  IF p_current IS NOT NULL THEN
    SELECT p.id INTO ok_pl FROM plantillas p WHERE p.id = p_current;
    IF ok_pl IS NOT NULL THEN c_pl := ok_pl; END IF;
  END IF;
  IF c_pl IS NOT NULL THEN
    src_id := c_src; plantilla_id := c_pl; valid_from := c_from; valid_to := NULL;
    reason := c_reason; created_at := c_at; created_by := c_by;
    RETURN NEXT;
  END IF;
END $$;

-- ---------------------------------------------------------------- turnos configurables
INSERT INTO app_settings (key, value) VALUES ('plantillas.shift_labels', '["Mañana", "Tarde", "Noche"]'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- controles
ALTER TABLE controls ADD COLUMN plantilla_id_snapshot panol_id;
CREATE INDEX controls_plantilla_idx ON controls (plantilla_id_snapshot);

-- ---------------------------------------------------------------- migración de datos
INSERT INTO plantillas (id, name, current_shift_label, sort_order, created_at, updated_at, created_by)
  SELECT id, name, left(name, 500), sort_order, created_at, updated_at, created_by FROM shifts;

INSERT INTO tech_plantilla_history (id, tech_id, plantilla_id, valid_from, valid_to, reason, demo, created_at, created_by)
  SELECT coalesce(r.src_id, 'ph-' || replace(gen_random_uuid()::text, '-', '')), t.id, r.plantilla_id, r.valid_from, r.valid_to,
         coalesce(r.reason, CASE WHEN r.src_id IS NULL THEN 'Migración de turnos' END), t.demo, coalesce(r.created_at, t.created_at), r.created_by
    FROM techs t
    CROSS JOIN LATERAL plantilla_ranges_from_changes(t.shift_id, (
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'from', s.from_shift_id, 'to', s.to_shift_id, 'effectiveFrom', s.effective_from,
                                          'at', s.at, 'note', s.note, 'by', s.created_by))
        FROM shift_changes s WHERE s.tech_id = t.id)) r;

-- Foto de la plantilla en los controles existentes (también los finalizados: se desactiva el
-- trigger de inmutabilidad solo para esta actualización, dentro de la migración).
ALTER TABLE controls DISABLE TRIGGER controls_immutable;
UPDATE controls c SET plantilla_id_snapshot = coalesce(
    plantilla_on(c.tech_id, least(coalesce(c.finished_at, c.updated_at)::date, period_end(c.period_y, c.period_m, c.period_w))),
    (SELECT p.id FROM plantillas p WHERE p.id = c.shift_id));
ALTER TABLE controls ENABLE TRIGGER controls_immutable;
