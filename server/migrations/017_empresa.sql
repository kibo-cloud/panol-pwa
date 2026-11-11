-- 017: datos de la empresa para la impresión de auditoría (etapa 10).
-- - El nombre va en app_settings (clave 'empresa.profile', con su versión para If-Match); la misma
--   fila guarda el hash del logo, así subir o quitar el logo también cambia la versión.
-- - El logo (PNG o JPEG, hasta 512 KB) se guarda en la base, en una sola fila. La app revisa el
--   tipo por los primeros bytes; la base repite los límites.

CREATE TABLE company_logo (
  id smallint PRIMARY KEY CHECK (id = 1),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 12 AND 524288),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON company_logo TO panol_app;
