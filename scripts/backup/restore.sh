#!/bin/sh
# Restaura una copia de seguridad en el VPS (desde la carpeta del proyecto):
#   scripts/backup/restore.sh daily/panol-20261108-030000.dump          -> solo muestra qué haría
#   scripts/backup/restore.sh --yes daily/panol-20261108-030000.dump    -> restaura
# La copia puede ser una ruta dentro del volumen de copias (daily/…, weekly/…, monthly/…) o un
# archivo de este equipo (p. ej. bajado del bucket fuera del VPS).
# Pasos: detiene la app, borra y recrea la base con la copia, arranca la app (que aplica las
# migraciones pendientes y vuelve a habilitar el rol panol_app) y espera /api/health.
# COMPOSE cambia el comando de Docker Compose (p. ej. con un archivo extra en CI).
set -eu
cd "$(dirname "$0")/../.."
COMPOSE=${COMPOSE:-docker compose}

usage() {
  echo "Uso: scripts/backup/restore.sh [--yes] <copia>"
  echo "  <copia>: daily/…, weekly/…, monthly/… (volumen de copias) o un archivo local .dump"
  echo "  Copias disponibles: $COMPOSE exec backup ls -R /backups"
  exit 2
}

yes=0
file=
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    -h | --help) usage ;;
    -*) echo "Opción desconocida: $arg" >&2; usage ;;
    *) file=$arg ;;
  esac
done
[ -n "$file" ] || usage

if [ -f "$file" ]; then
  target=/tmp/restore.dump
  src="archivo local $file"
else
  target=/backups/${file#/backups/}
  $COMPOSE exec -T backup test -f "$target" || { echo "No existe $target en el volumen de copias." >&2; exit 2; }
  src="$target (volumen de copias)"
fi

if [ "$yes" != 1 ]; then
  echo "Se va a REEMPLAZAR toda la base de Pañol con: $src"
  echo "Los datos cargados después de esa copia se pierden. La app queda detenida unos segundos."
  echo "Para hacerlo, repetí el comando con --yes."
  exit 1
fi

[ "$target" = /tmp/restore.dump ] && $COMPOSE cp "$file" backup:/tmp/restore.dump

echo "1/4 Deteniendo la app…"
$COMPOSE stop app
echo "2/4 Restaurando $src…"
if ! $COMPOSE exec -T backup restore-db.sh "$target"; then
  echo "La restauración falló. La app queda detenida: revisá el error y volvé a intentar." >&2
  exit 1
fi
echo "3/4 Arrancando la app (aplica migraciones pendientes)…"
$COMPOSE start app
echo "4/4 Esperando que la app responda…"
i=0
until $COMPOSE exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))" 2> /dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "La app no respondió en 2 minutos: $COMPOSE logs app" >&2
    exit 1
  fi
  sleep 2
done
echo "Restauración terminada."
