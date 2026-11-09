-- 009: especialidad del técnico, kits y orden personalizado (etapa 3).
-- - especialidades: catálogo configurable (baja lógica), con los 9 valores por defecto.
--   techs.especialidad_id es opcional.
-- - kits: el kit base (único, sin especialidad) y kits opcionales por especialidad (uno por
--   especialidad); kit_items es la lista ordenada de herramientas con su cantidad.
-- - Orden: sort_order en categorías y herramientas (las herramientas, dentro de su categoría),
--   cargado con el orden alfabético de hoy. order_versions guarda la versión de cada alcance
--   ('categories', 'tools:<categoría>', 'tools:' sin categoría) para el If-Match del reordenar.
--   Cambiar solo el orden no sube la versión de la herramienta o la categoría (así nadie ve un
--   aviso de conflicto en una edición por un reordenamiento).
-- - Permiso nuevo kits_edit (solo admin por defecto).

ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_perm_check;
ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_perm_check CHECK (perm IN (
  'controls_do', 'movements_do', 'techs_edit', 'shift_change', 'tools_edit', 'inventory_edit', 'alerts_resolve', 'shifts_edit',
  'reports_export', 'demo_manage', 'plantillas_edit', 'plantilla_rotate', 'lineas_edit', 'kits_edit'));

-- ---------------------------------------------------------------- especialidades
CREATE TABLE especialidades (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE UNIQUE INDEX especialidades_active_name_key ON especialidades (lower(name)) WHERE archived_at IS NULL;
CREATE TRIGGER especialidades_touch BEFORE UPDATE ON especialidades FOR EACH ROW EXECUTE FUNCTION touch_row();

INSERT INTO especialidades (id, name, sort_order) VALUES
  ('esp-mecanico', 'Mecánico', 1),
  ('esp-electricista', 'Electricista', 2),
  ('esp-electromecanico', 'Electro-mecánico', 3),
  ('esp-refrigeracion', 'Refrigeración', 4),
  ('esp-soldador', 'Soldador', 5),
  ('esp-edilicio', 'Edilicio', 6),
  ('esp-servicios-generales', 'Servicios Generales', 7),
  ('esp-ingenieria', 'Ingeniería', 8),
  ('esp-panolero', 'Pañolero', 9);

ALTER TABLE techs ADD COLUMN especialidad_id panol_id REFERENCES especialidades(id);
CREATE INDEX techs_especialidad_idx ON techs (especialidad_id) WHERE especialidad_id IS NOT NULL;

-- ---------------------------------------------------------------- orden
-- Solo cambió el orden: no se toca la versión ni la fecha de edición del registro.
CREATE FUNCTION touch_row_unless_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'sort_order' - 'version' - 'updated_at') = (to_jsonb(OLD) - 'sort_order' - 'version' - 'updated_at') THEN
    NEW.version := OLD.version;
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER categories_touch ON categories;
CREATE TRIGGER categories_touch BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION touch_row_unless_order();
DROP TRIGGER tools_touch ON tools;
CREATE TRIGGER tools_touch BEFORE UPDATE ON tools FOR EACH ROW EXECUTE FUNCTION touch_row_unless_order();

-- Orden inicial = el alfabético de hoy (las versiones no cambian).
ALTER TABLE categories ADD COLUMN sort_order int;
UPDATE categories c SET sort_order = o.n FROM (SELECT id, row_number() OVER (ORDER BY name, id) AS n FROM categories) o WHERE o.id = c.id;
ALTER TABLE tools ADD COLUMN sort_order int;
UPDATE tools t SET sort_order = o.n FROM (SELECT id, row_number() OVER (PARTITION BY category_id ORDER BY name, id) AS n FROM tools) o WHERE o.id = t.id;

-- Sin posición, una categoría o herramienta nueva va al final (también la que crea una
-- importación del .txt, que no conoce el orden). Una herramienta que cambia de categoría va al
-- final de la nueva. Los triggers "order" corren antes que "touch" (orden alfabético).
CREATE FUNCTION categories_order_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sort_order IS NULL THEN
    NEW.sort_order := (SELECT coalesce(max(sort_order), 0) + 1 FROM categories);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER categories_order BEFORE INSERT ON categories FOR EACH ROW EXECUTE FUNCTION categories_order_default();

CREATE FUNCTION tools_order_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.sort_order IS NULL THEN
    NEW.sort_order := (SELECT coalesce(max(sort_order), 0) + 1 FROM tools WHERE category_id IS NOT DISTINCT FROM NEW.category_id);
  ELSIF TG_OP = 'UPDATE' AND NEW.category_id IS DISTINCT FROM OLD.category_id AND NEW.sort_order IS NOT DISTINCT FROM OLD.sort_order THEN
    NEW.sort_order := (SELECT coalesce(max(sort_order), 0) + 1 FROM tools WHERE category_id IS NOT DISTINCT FROM NEW.category_id AND id <> NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tools_order BEFORE INSERT OR UPDATE ON tools FOR EACH ROW EXECUTE FUNCTION tools_order_default();

ALTER TABLE categories ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE tools ALTER COLUMN sort_order SET NOT NULL;
CREATE INDEX tools_category_order_idx ON tools (category_id, sort_order);

CREATE TABLE order_versions (
  scope text PRIMARY KEY CHECK (scope ~ '^(categories|tools:[A-Za-z0-9_.~:@+-]{0,200})$'),
  version int NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------- kits
CREATE TABLE kits (
  id panol_id PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  especialidad_id panol_id REFERENCES especialidades(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
-- Un solo kit base (sin especialidad) y a lo sumo un kit por especialidad.
CREATE UNIQUE INDEX kits_base_key ON kits ((especialidad_id IS NULL)) WHERE especialidad_id IS NULL;
CREATE UNIQUE INDEX kits_especialidad_key ON kits (especialidad_id) WHERE especialidad_id IS NOT NULL;
CREATE TRIGGER kits_touch BEFORE UPDATE ON kits FOR EACH ROW EXECUTE FUNCTION touch_row();

-- Las herramientas no se borran (baja lógica), salvo las de demostración: su ítem se va con ellas.
CREATE TABLE kit_items (
  kit_id panol_id NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
  tool_id panol_id NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  qty int NOT NULL CHECK (qty BETWEEN 1 AND 10000),
  sort_order int NOT NULL,
  PRIMARY KEY (kit_id, tool_id)
);
CREATE INDEX kit_items_tool_idx ON kit_items (tool_id);

INSERT INTO kits (id, name) VALUES ('kit-base', 'Kit base');

GRANT SELECT, INSERT, UPDATE, DELETE ON especialidades, order_versions, kits, kit_items TO panol_app;
