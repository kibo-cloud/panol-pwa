-- 006: líneas de producción, sectores y cajas compartidas (etapa 2).
-- - lineas: catálogo configurable (línea o sector), baja lógica.
-- - cajas: caja compartida de una línea o sector, con un técnico referente, baja lógica.
-- - El poseedor de una asignación, un control (y su alerta) es un técnico o una caja, nunca los
--   dos (CHECK). Un movimiento nombra a lo sumo uno (los de inventario no tienen poseedor).
--   Una unidad asignada está en manos de un técnico o de una caja.
-- - Un solo control original por poseedor y período: un índice único parcial por técnico y
--   otro por caja.

CREATE TABLE lineas (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  kind text NOT NULL CHECK (kind IN ('linea', 'sector')),
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE TRIGGER lineas_touch BEFORE UPDATE ON lineas FOR EACH ROW EXECUTE FUNCTION touch_row();

CREATE TABLE cajas (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  linea_id panol_id NOT NULL REFERENCES lineas(id),
  referente_tech_id panol_id REFERENCES techs(id),
  archived_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX cajas_linea_idx ON cajas (linea_id);
CREATE TRIGGER cajas_touch BEFORE UPDATE ON cajas FOR EACH ROW EXECUTE FUNCTION touch_row();

-- ---------------------------------------------------------------- poseedor: técnico o caja
ALTER TABLE assignments ALTER COLUMN tech_id DROP NOT NULL;
ALTER TABLE assignments ADD COLUMN caja_id panol_id REFERENCES cajas(id);
ALTER TABLE assignments ADD CONSTRAINT assignments_holder_check CHECK (num_nonnulls(tech_id, caja_id) = 1);
CREATE INDEX assignments_caja_idx ON assignments (caja_id) WHERE active;

ALTER TABLE units ADD COLUMN caja_id panol_id REFERENCES cajas(id);
ALTER TABLE units ADD CONSTRAINT units_holder_check CHECK (num_nonnulls(tech_id, caja_id) <= 1);

-- El libro no tiene claves foráneas (sobrevive a las bajas).
ALTER TABLE movements ADD COLUMN caja_id panol_id;
ALTER TABLE movements ADD CONSTRAINT movements_holder_check CHECK (num_nonnulls(tech_id, caja_id) <= 1);
CREATE INDEX movements_caja_idx ON movements (caja_id) WHERE caja_id IS NOT NULL;

ALTER TABLE alert_resolutions ADD COLUMN caja_id panol_id;

ALTER TABLE controls ALTER COLUMN tech_id DROP NOT NULL;
ALTER TABLE controls ADD COLUMN caja_id panol_id REFERENCES cajas(id);
ALTER TABLE controls ADD CONSTRAINT controls_holder_check CHECK (num_nonnulls(tech_id, caja_id) = 1);
DROP INDEX controls_original_key;
CREATE UNIQUE INDEX controls_original_tech_key ON controls (tech_id, period_y, period_m, period_w) WHERE NOT correction AND tech_id IS NOT NULL;
CREATE UNIQUE INDEX controls_original_caja_key ON controls (caja_id, period_y, period_m, period_w) WHERE NOT correction AND caja_id IS NOT NULL;

-- Un borrador no cambia de poseedor (técnico o caja), de período ni de tipo.
CREATE OR REPLACE FUNCTION controls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.demo AND demo_clear_active() THEN RETURN OLD; END IF;
  IF OLD.status = 'finalizado' THEN
    RAISE EXCEPTION 'El control % está finalizado: se corrige con un registro nuevo', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.id <> OLD.id OR NEW.tech_id IS DISTINCT FROM OLD.tech_id OR NEW.caja_id IS DISTINCT FROM OLD.caja_id
     OR NEW.period_y <> OLD.period_y OR NEW.period_m <> OLD.period_m OR NEW.period_w <> OLD.period_w
     OR NEW.correction <> OLD.correction OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'El control %: no se cambia el técnico o la caja, el período ni si es corrección', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
