#!/bin/sh
# Prueba de copia y restauración (CI, con el Compose levantado): crea un dato, hace una copia,
# lo borra, restaura la copia con restore.sh y verifica que el dato volvió y que la app lo lee
# con su rol (permisos restaurados).
# Necesita POSTGRES_USER, POSTGRES_DB y APP_DB_PASSWORD (los mismos del .env).
set -eu
cd "$(dirname "$0")/../.."
COMPOSE=${COMPOSE:-docker compose}
: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${APP_DB_PASSWORD:?}"

owner() { $COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"; }
as_app() { $COMPOSE exec -T postgres psql -v ON_ERROR_STOP=1 "postgres://panol_app:$APP_DB_PASSWORD@127.0.0.1:5432/$POSTGRES_DB" -tAc "$1"; }
fail() { echo "ci-test: FALLA: $*" >&2; exit 1; }

owner "INSERT INTO categories (id, name) VALUES ('ci-restore', 'Prueba de restauración')"
[ "$(as_app "SELECT name FROM categories WHERE id = 'ci-restore'")" = "Prueba de restauración" ] || fail "el dato no se ve con el rol de la app"

$COMPOSE exec -T backup backup.sh
dump=$($COMPOSE exec -T backup sh -c 'ls -1 /backups/daily/panol-*.dump | sort | tail -n 1' | tr -d '\r')
[ -n "$dump" ] || fail "no se generó la copia"
$COMPOSE exec -T backup test -s "/backups/weekly/$(basename "$dump")" || fail "falta la primera copia semanal"
$COMPOSE exec -T backup test -s "/backups/monthly/$(basename "$dump")" || fail "falta la primera copia mensual"

owner "DELETE FROM categories WHERE id = 'ci-restore'"
[ "$(owner "SELECT count(*) FROM categories WHERE id = 'ci-restore'")" = 0 ] || fail "no se borró el dato"

# Sin --yes no hace nada.
if scripts/backup/restore.sh "${dump#/backups/}" > /dev/null; then fail "restore.sh sin --yes no tiene que restaurar"; fi
[ "$(owner "SELECT count(*) FROM categories WHERE id = 'ci-restore'")" = 0 ] || fail "restore.sh sin --yes cambió la base"

scripts/backup/restore.sh --yes "${dump#/backups/}"
[ "$(owner "SELECT count(*) FROM categories WHERE id = 'ci-restore'")" = 1 ] || fail "el dato no volvió con la copia"
[ "$(as_app "SELECT name FROM categories WHERE id = 'ci-restore'")" = "Prueba de restauración" ] || fail "la app no puede leer la base restaurada"
[ "$(owner "SELECT count(*) FROM schema_migrations")" -ge 4 ] || fail "faltan migraciones después de restaurar"
echo "ci-test: copia y restauración OK ($dump)"
