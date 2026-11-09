-- 011: conteo por cantidad y limpieza en el control (etapa 4).
-- - control_items: qty_expected (unidades a controlar), qty_good (en buen estado), qty_change
--   (requieren recambio) y qty_missing (faltan), todas >= 0 y good + change + missing = expected.
--   `qty` (columna de 2.1) queda igual a qty_expected.
-- - control_items.state se conserva como estado derivado (lo leen el historial, las alertas y el
--   .txt v2): faltante si falta alguna unidad, si no cambio si alguna requiere recambio, si no
--   bueno. Lo exige un CHECK. Excepción: un ítem de 2.1 con qty 0 (solo puede venir de un .txt)
--   no tiene unidades de donde derivarlo y conserva el estado registrado.
-- - control_items.linea_id: línea o sector donde se estaba trabajando (opcional) en un ítem con
--   faltantes o recambios. Las líneas no se borran (baja lógica), así que la referencia es segura.
-- - controls.cleaning_status: 'limpio', 'requiere_limpieza' o NULL (sin dato: controles viejos e
--   importados); cleaning_note, la nota (obligatoria para finalizar si requiere limpieza; la
--   exige la aplicación, no la base, porque los borradores pueden estar a medio cargar).
-- - Datos existentes: bueno -> good = qty; cambio -> change = qty; faltante -> missing = qty
--   (las notas no cambian). Los ítems de un control finalizado no se modifican (trigger
--   control_items_immutable). Para escribir las columnas nuevas se desactiva ese trigger solo
--   alrededor del UPDATE de abajo, dentro de la transacción de esta migración (como la 005 hizo
--   con controls_immutable) y se vuelve a activar enseguida en la misma transacción: si algo
--   falla, el ROLLBACK deja el trigger como estaba. Ninguna otra escritura pasa por ese camino.
--   Los totales de los controles (count_*) ya estaban en unidades (2.1 sumaba qty), no cambian.

ALTER TABLE control_items
  ADD COLUMN qty_expected int,
  ADD COLUMN qty_good int,
  ADD COLUMN qty_change int,
  ADD COLUMN qty_missing int,
  ADD COLUMN linea_id panol_id REFERENCES lineas(id);

ALTER TABLE control_items DISABLE TRIGGER control_items_immutable;
UPDATE control_items SET
  qty_expected = qty,
  qty_good = CASE WHEN state = 'bueno' THEN qty ELSE 0 END,
  qty_change = CASE WHEN state = 'cambio' THEN qty ELSE 0 END,
  qty_missing = CASE WHEN state = 'faltante' THEN qty ELSE 0 END;
ALTER TABLE control_items ENABLE TRIGGER control_items_immutable;

ALTER TABLE control_items
  ALTER COLUMN qty_expected SET NOT NULL,
  ALTER COLUMN qty_good SET NOT NULL,
  ALTER COLUMN qty_change SET NOT NULL,
  ALTER COLUMN qty_missing SET NOT NULL,
  ADD CONSTRAINT control_items_qty_check CHECK (
    qty_expected >= 0 AND qty_good >= 0 AND qty_change >= 0 AND qty_missing >= 0
    AND qty_good + qty_change + qty_missing = qty_expected
  ),
  ADD CONSTRAINT control_items_qty_legacy_check CHECK (qty = qty_expected),
  ADD CONSTRAINT control_items_state_derived_check CHECK (
    qty_expected = 0
    OR state = CASE WHEN qty_missing > 0 THEN 'faltante' WHEN qty_change > 0 THEN 'cambio' ELSE 'bueno' END
  );
CREATE INDEX control_items_linea_idx ON control_items (linea_id) WHERE linea_id IS NOT NULL;

ALTER TABLE controls
  ADD COLUMN cleaning_status text CHECK (cleaning_status IN ('limpio', 'requiere_limpieza')),
  ADD COLUMN cleaning_note text CHECK (length(cleaning_note) <= 20000);
