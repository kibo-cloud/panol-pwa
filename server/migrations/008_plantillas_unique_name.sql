-- 008: nombre único (sin distinguir mayúsculas) entre las plantillas activas.
-- La API ya lo controlaba al crear y renombrar, pero la importación del .txt podía reactivar
-- una plantilla archivada con el nombre de otra activa. Las archivadas pueden repetir nombre.
-- Si ya hay repetidos, la primera de cada grupo (por orden y id) conserva el nombre y las demás
-- reciben un sufijo " (2)", " (3)"... libre; queda en la auditoría.

CREATE OR REPLACE FUNCTION plantillas_dedupe_active_names() RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  r record;
  n int;
  candidate text;
  fixed int := 0;
BEGIN
  FOR r IN
    SELECT id, name FROM (
      SELECT id, name, row_number() OVER (PARTITION BY lower(name) ORDER BY sort_order, id) AS rn
        FROM plantillas WHERE archived_at IS NULL
    ) d WHERE rn > 1 ORDER BY lower(name), rn
  LOOP
    n := 2;
    LOOP
      candidate := left(r.name, 480) || ' (' || n || ')';
      EXIT WHEN NOT EXISTS (SELECT 1 FROM plantillas WHERE archived_at IS NULL AND lower(name) = lower(candidate));
      n := n + 1;
    END LOOP;
    UPDATE plantillas SET name = candidate WHERE id = r.id;
    INSERT INTO audit_log (id, action, entity, entity_id, detail)
      VALUES ('l-m008-' || md5(r.id || clock_timestamp()::text), 'plantilla_rename', 'plantillas', r.id,
              'Plantilla renombrada por nombre repetido (migración 008): ' || r.name || ' a ' || candidate);
    fixed := fixed + 1;
  END LOOP;
  RETURN fixed;
END $$;

SELECT plantillas_dedupe_active_names();

CREATE UNIQUE INDEX plantillas_active_name_key ON plantillas (lower(name)) WHERE archived_at IS NULL;
