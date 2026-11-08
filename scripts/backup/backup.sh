#!/bin/sh
# Copia de seguridad de la base de Pañol (corre dentro del servicio `backup`).
#   docker compose exec backup backup.sh        -> una copia ahora
# - pg_dump en formato propio (-Fc) en $BACKUP_DIR/daily, verificada con pg_restore --list.
# - Rotación: KEEP_DAILY diarias (7), KEEP_WEEKLY semanales (4, la del domingo) y
#   KEEP_MONTHLY mensuales (6, la del día 1). La primera copia también inaugura las carpetas
#   semanal y mensual.
# - Fuera del VPS (opcional): si BACKUP_REMOTE está definido (p. ej. `offsite:panol-copias`,
#   con el remoto configurado por variables RCLONE_CONFIG_OFFSITE_*), se suben con rclone.
# Conexión por PGHOST, PGUSER, PGPASSWORD y PGDATABASE (el dueño de las tablas).
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
KEEP_DAILY=${KEEP_DAILY:-7}
KEEP_WEEKLY=${KEEP_WEEKLY:-4}
KEEP_MONTHLY=${KEEP_MONTHLY:-6}
: "${PGHOST:?falta PGHOST}" "${PGUSER:?falta PGUSER}" "${PGPASSWORD:?falta PGPASSWORD}" "${PGDATABASE:?falta PGDATABASE}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') backup: $*"; }

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" "$BACKUP_DIR/monthly"
name="panol-$(date +%Y%m%d-%H%M%S).dump"
tmp="$BACKUP_DIR/daily/.$name.partial"
trap 'rm -f "$tmp"' EXIT

pg_dump --format=custom --no-password --file="$tmp"
# Una copia que no se puede leer no cuenta como copia.
pg_restore --list "$tmp" > /dev/null
mv "$tmp" "$BACKUP_DIR/daily/$name"
log "copia diaria $name ($(du -h "$BACKUP_DIR/daily/$name" | cut -f1))"

empty() { [ -z "$(ls -A "$1" 2>/dev/null)" ]; }
if [ "$(date +%u)" = 7 ] || empty "$BACKUP_DIR/weekly"; then
  cp "$BACKUP_DIR/daily/$name" "$BACKUP_DIR/weekly/$name"
  log "copia semanal $name"
fi
if [ "$(date +%d)" = 01 ] || empty "$BACKUP_DIR/monthly"; then
  cp "$BACKUP_DIR/daily/$name" "$BACKUP_DIR/monthly/$name"
  log "copia mensual $name"
fi

# Conserva las N más nuevas de cada carpeta (los nombres llevan fecha y hora, se ordenan solos).
prune() {
  ls -1 "$1"/panol-*.dump 2> /dev/null | sort -r | tail -n +"$(($2 + 1))" | while read -r old; do
    rm -f "$old"
    log "rotación: borrada $(basename "$1")/$(basename "$old")"
  done
}
prune "$BACKUP_DIR/daily" "$KEEP_DAILY"
prune "$BACKUP_DIR/weekly" "$KEEP_WEEKLY"
prune "$BACKUP_DIR/monthly" "$KEEP_MONTHLY"

if [ -n "${BACKUP_REMOTE:-}" ]; then
  # copy (no sync): una copia borrada en el VPS no se borra del bucket; la retención allá la
  # fija una regla de ciclo de vida del bucket.
  if rclone copy "$BACKUP_DIR" "$BACKUP_REMOTE" --include "/daily/panol-*.dump" --include "/weekly/panol-*.dump" --include "/monthly/panol-*.dump"; then
    log "copia fuera del VPS en $BACKUP_REMOTE"
  else
    log "ERROR: no se pudo subir la copia a $BACKUP_REMOTE (la copia local quedó bien)"
    exit 3
  fi
fi
