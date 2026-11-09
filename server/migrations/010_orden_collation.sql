-- 010: orden inicial independiente de la intercalación (collation) de la base.
-- La 009 cargó sort_order con ORDER BY name, que depende de la intercalación con la que se creó
-- la base (libc del sistema: "C", "en_US", "Spanish_Argentina.1252"...). Acá se recalcula con la
-- intercalación ICU de español (es-x-icu), la misma que usa la app (localeCompare('es')):
-- sin distinguir acentos al comparar letras, la ñ después de la n y, a igual nombre, por id.
-- - Solo los alcances que siguen en su versión inicial: la 009 no crea filas en order_versions
--   (un alcance sin fila vale 1); si el alcance tiene versión mayor a 1 alguien lo reordenó, insertó
--   en una posición o agregó al final, y ese orden se respeta.
-- - Solo cambia sort_order: el trigger touch_row_unless_order (009) no sube la versión ni la fecha
--   de edición, y tools_order no actúa porque la categoría no cambia. No se tocan las versiones de
--   los alcances.
-- - Sin ICU (no pasa con embedded-postgres 16 en Windows ni con la imagen postgres:16.14 de
--   Debian, que traen es-x-icu y und-x-icu): und-x-icu y, si tampoco está, una expresión
--   determinista (minúsculas sin acentos, la ñ entre la n y la o; desempate por nombre en "C").
DO $$
DECLARE
  ord text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'es-x-icu') THEN
    ord := 'name COLLATE "es-x-icu"';
  ELSIF EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu') THEN
    ord := 'name COLLATE "und-x-icu"';
  ELSE
    ord := $o$replace(translate(lower(name), 'áàäâéèëêíìïîóòöôúùüû', 'aaaaeeeeiiiioooouuuu'), 'ñ', 'n{') COLLATE "C", name COLLATE "C"$o$;
  END IF;

  EXECUTE format($q$
    UPDATE categories c SET sort_order = o.n
      FROM (SELECT id, row_number() OVER (ORDER BY %s, id COLLATE "C") AS n FROM categories) o
     WHERE o.id = c.id AND c.sort_order IS DISTINCT FROM o.n
       AND NOT EXISTS (SELECT 1 FROM order_versions v WHERE v.scope = 'categories' AND v.version > 1)
  $q$, ord);

  EXECUTE format($q$
    UPDATE tools t SET sort_order = o.n
      FROM (SELECT id, row_number() OVER (PARTITION BY category_id ORDER BY %s, id COLLATE "C") AS n FROM tools) o
     WHERE o.id = t.id AND t.sort_order IS DISTINCT FROM o.n
       AND NOT EXISTS (SELECT 1 FROM order_versions v WHERE v.scope = 'tools:' || coalesce(t.category_id, '') AND v.version > 1)
  $q$, ord);
END $$;
