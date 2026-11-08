#!/bin/sh
# Restaura una copia (-Fc) en la base PGDATABASE: la borra, la crea vacía y carga la copia
# con sus permisos (el rol panol_app es del servidor y sigue existiendo). Corre dentro del
# servicio `backup` con la app detenida; lo llama scripts/backup/restore.sh desde el VPS.
set -eu

file=${1:?uso: restore-db.sh <copia.dump>}
: "${PGDATABASE:?falta PGDATABASE}"
[ -f "$file" ] || { echo "restore: no existe $file" >&2; exit 2; }
# Antes de borrar nada: la copia tiene que poder leerse.
pg_restore --list "$file" > /dev/null

echo "restore: recreando la base $PGDATABASE"
psql --no-password -v ON_ERROR_STOP=1 -d postgres \
  -c "DROP DATABASE IF EXISTS \"$PGDATABASE\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$PGDATABASE\""
echo "restore: cargando $(basename "$file")"
pg_restore --no-password --exit-on-error --dbname="$PGDATABASE" "$file"
echo "restore: listo"
