-- 004: importación del .txt v2 de Pañol 2.x.
-- Marca `imported` en lo que entra desde un archivo y no se puede editar después (libro de
-- movimientos, controles y auditoría), así se distingue de lo registrado en el servidor.
-- Los movimientos importados conservan su fecha original (`at`).
ALTER TABLE movements ADD COLUMN imported boolean NOT NULL DEFAULT false;
ALTER TABLE controls ADD COLUMN imported boolean NOT NULL DEFAULT false;
ALTER TABLE audit_log ADD COLUMN imported boolean NOT NULL DEFAULT false;
