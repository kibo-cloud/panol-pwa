#!/bin/sh
# Programa del servicio `backup`: una copia por día a la hora local BACKUP_HOUR (0-23).
# Con BACKUP_ON_START=1 hace además una copia al arrancar.
set -eu

HOUR=${BACKUP_HOUR:-3}
case "$HOUR" in
  [0-9] | 1[0-9] | 2[0-3]) ;;
  *) echo "backup: BACKUP_HOUR inválida ($HOUR): tiene que ser una hora de 0 a 23" >&2; exit 2 ;;
esac

run() { backup.sh || echo "$(date '+%Y-%m-%d %H:%M:%S') backup: ERROR, la copia falló (se reintenta en la próxima vuelta)" >&2; }

[ "${BACKUP_ON_START:-0}" = 1 ] && run
echo "backup: copia diaria a las $HOUR:00 ($(date +%Z)), en ${BACKUP_DIR:-/backups}"
while :; do
  now=$(date +%s)
  next=$(date -d "$(date +%Y-%m-%d) $HOUR:00:00" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run
done
