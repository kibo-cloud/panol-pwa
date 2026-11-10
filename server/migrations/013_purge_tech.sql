-- 013: eliminación definitiva de un técnico solo por una función del dueño (E5.V1).
-- La migración 012 dejaba borrar el rango de pertenencia del alta a cualquier transacción que
-- activara `panol.purge = techs:<id>`, y el rol de la app la puede activar. Ahora:
-- - `purge_tech_ranges(id)` (SECURITY DEFINER, del dueño) vuelve a revisar que el técnico no
--   tenga historial operativo y recién ahí borra su rango; es el único camino.
-- - El guard de `tech_plantilla_history` acepta ese DELETE solo dentro de esa función (el usuario
--   efectivo es el dueño de la función), con la marca activa y sin historial.

-- Historial operativo de un técnico (lo mismo que revisa la app con la fila bloqueada, sin la
-- auditoría): movimientos, asignaciones, controles, unidades, cambios de turno, referente de una
-- caja, alertas resueltas o más de un rango de pertenencia.
CREATE FUNCTION tech_has_history(p_tech panol_id) RETURNS boolean LANGUAGE sql STABLE
  SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM movements WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM assignments WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM controls WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM units WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM shift_changes WHERE tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM cajas WHERE referente_tech_id = p_tech)
      OR EXISTS (SELECT 1 FROM alert_resolutions WHERE tech_id = p_tech)
      OR (SELECT count(*) FROM tech_plantilla_history WHERE tech_id = p_tech) > 1
$$;

CREATE FUNCTION purge_tech_ranges(p_tech panol_id) RETURNS int LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE
  n int;
BEGIN
  IF tech_has_history(p_tech) THEN
    RAISE EXCEPTION 'El técnico % tiene historial: no se elimina definitivamente', p_tech
      USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM set_config('panol.purge', 'techs:' || p_tech, true);
  DELETE FROM tech_plantilla_history WHERE tech_id = p_tech;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('panol.purge', '', true);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION purge_tech_ranges(panol_id) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tech_ranges(panol_id) TO panol_app;

-- Mismo guard que la migración 012; el borrado del rango exige además estar dentro de
-- purge_tech_ranges (usuario efectivo = su dueño) y que el técnico no tenga historial.
CREATE OR REPLACE FUNCTION tech_plantilla_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.demo AND demo_clear_active() THEN RETURN OLD; END IF;
    IF coalesce(current_setting('panol.purge', true), '') = 'techs:' || OLD.tech_id
       AND current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'purge_tech_ranges(panol_id)'::regprocedure)
       AND NOT tech_has_history(OLD.tech_id) THEN
      RETURN OLD;
    END IF;
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
