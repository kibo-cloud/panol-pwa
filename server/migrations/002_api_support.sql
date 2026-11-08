-- 002: soporte de la API de la etapa 1.
-- - Claves de idempotencia (Idempotency-Key): la respuesta de un pedido que ya se aplicó se
--   devuelve igual si el cliente lo reintenta.
-- - Marca `demo` (como el campo `demo` de 2.1) para cargar y borrar datos de demostración.
--   El libro (movimientos y transferencias) y los controles finalizados siguen siendo de solo
--   agregar; la única excepción es borrar filas marcadas como demo, y solo dentro de una
--   transacción que activa `panol.demo_clear` (lo hace el caso de uso "Borrar datos de
--   demostración"). La auditoría nunca se borra.

CREATE TABLE idempotency_keys (
  user_id panol_id NOT NULL,
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_.:-]{8,200}$'),
  method text NOT NULL CHECK (length(method) <= 10),
  path text NOT NULL CHECK (length(path) <= 2000),
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  status int,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

ALTER TABLE techs ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE shift_changes ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE categories ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE tools ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE units ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE assignments ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE movements ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE controls ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE alert_resolutions ADD COLUMN demo boolean NOT NULL DEFAULT false;

CREATE FUNCTION demo_clear_active() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('panol.demo_clear', true), '') = 'on'
$$;

-- Movimientos: solo agregar, salvo borrar uno de demostración durante el borrado de demo.
CREATE FUNCTION movements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.demo AND demo_clear_active() THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% es de solo agregar: no se permite %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE FUNCTION movement_transfers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND demo_clear_active()
     AND EXISTS (SELECT 1 FROM movements WHERE id = OLD.movement_id AND demo) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es de solo agregar: no se permite %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

DROP TRIGGER movements_append_only ON movements;
DROP TRIGGER movement_transfers_append_only ON movement_transfers;
CREATE TRIGGER movements_append_only BEFORE UPDATE OR DELETE ON movements FOR EACH ROW EXECUTE FUNCTION movements_guard();
CREATE TRIGGER movement_transfers_append_only BEFORE UPDATE OR DELETE ON movement_transfers FOR EACH ROW EXECUTE FUNCTION movement_transfers_guard();

-- Controles finalizados: inmutables, salvo borrar uno de demostración durante el borrado de demo.
CREATE OR REPLACE FUNCTION controls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.demo AND demo_clear_active() THEN RETURN OLD; END IF;
  IF OLD.status = 'finalizado' THEN
    RAISE EXCEPTION 'El control % está finalizado: se corrige con un registro nuevo', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION control_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cid text := CASE WHEN TG_OP = 'DELETE' THEN OLD.control_id ELSE NEW.control_id END;
  st text;
  is_demo boolean;
BEGIN
  SELECT status, demo INTO st, is_demo FROM controls WHERE id = cid;
  IF TG_OP = 'DELETE' AND is_demo AND demo_clear_active() THEN RETURN OLD; END IF;
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
