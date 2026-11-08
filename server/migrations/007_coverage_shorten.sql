-- 007: un cambio definitivo durante una cobertura temporal termina la cobertura antes.
-- Además de cerrar un rango abierto, el historial de pertenencia permite acortar un rango
-- temporal (cobertura): solo baja `valid_to`, nunca por debajo de `valid_from`, sin tocar nada
-- más. Los rangos cerrados que no son coberturas siguen sin poder modificarse.

CREATE OR REPLACE FUNCTION tech_plantilla_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.demo AND demo_clear_active() THEN RETURN OLD; END IF;
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
