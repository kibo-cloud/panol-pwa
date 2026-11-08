-- 003: correcciones de seguridad (E1.V1).
-- - Ítems de control: el guard lee el estado del control con FOR SHARE, así espera a una
--   finalización en curso de otra transacción y no deja entrar un ítem en un control finalizado.
-- - Un borrador no cambia de técnico, de período ni de tipo (original/corrección).
-- - Rol `panol_app` para la aplicación: no es dueño de las tablas, no puede borrar ni modificar
--   el libro ni la auditoría, ni tocar `schema_migrations`. Las migraciones las corre el dueño.
--   La contraseña y el permiso de ingreso los fija el aprovisionamiento (no van en el SQL).
-- - El borrado de la demostración en el libro pasa por una función SECURITY DEFINER del dueño,
--   limitada a las filas demo.

CREATE OR REPLACE FUNCTION control_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cid text := CASE WHEN TG_OP = 'DELETE' THEN OLD.control_id ELSE NEW.control_id END;
  st text;
  is_demo boolean;
BEGIN
  SELECT status, demo INTO st, is_demo FROM controls WHERE id = cid FOR SHARE;
  IF TG_OP = 'DELETE' AND is_demo AND demo_clear_active() THEN RETURN OLD; END IF;
  IF st = 'finalizado' THEN
    RAISE EXCEPTION 'El control % está finalizado: sus ítems no se modifican', cid
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.control_id <> NEW.control_id THEN
    SELECT status INTO st FROM controls WHERE id = OLD.control_id FOR SHARE;
    IF st = 'finalizado' THEN
      RAISE EXCEPTION 'El control % está finalizado: sus ítems no se modifican', OLD.control_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION controls_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.demo AND demo_clear_active() THEN RETURN OLD; END IF;
  IF OLD.status = 'finalizado' THEN
    RAISE EXCEPTION 'El control % está finalizado: se corrige con un registro nuevo', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.id <> OLD.id OR NEW.tech_id <> OLD.tech_id OR NEW.period_y <> OLD.period_y OR NEW.period_m <> OLD.period_m
     OR NEW.period_w <> OLD.period_w OR NEW.correction <> OLD.correction
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id THEN
    RAISE EXCEPTION 'El control %: no se cambia el técnico, el período ni si es corrección', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- rol de la aplicación
-- Los roles son del cluster: si ya existe (otra base del mismo servidor), se reutiliza.
DO $$
BEGIN
  CREATE ROLE panol_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END $$;

GRANT USAGE ON SCHEMA public TO panol_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO panol_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO panol_app;
REVOKE ALL ON schema_migrations FROM panol_app;
REVOKE UPDATE, DELETE, TRUNCATE ON movements, movement_transfers, audit_log FROM panol_app;
-- Tablas futuras creadas por el dueño: mismos permisos por defecto (las de solo agregar
-- tienen que revocar UPDATE/DELETE en su migración).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO panol_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO panol_app;

-- Borra del libro solo los movimientos de demostración (y sus transferencias).
CREATE FUNCTION demo_clear_ledger() RETURNS int LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  n int;
BEGIN
  PERFORM set_config('panol.demo_clear', 'on', true);
  DELETE FROM movement_transfers WHERE movement_id IN (SELECT id FROM movements WHERE demo);
  DELETE FROM movements WHERE demo;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION demo_clear_ledger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_clear_ledger() TO panol_app;
