# Servicio de copias: pg_dump/pg_restore de la misma versión que el servidor (ver
# server/pg-version.json) y rclone para la copia opcional fuera del VPS.
FROM postgres:16.14-alpine
RUN apk add --no-cache rclone tzdata
COPY --chmod=0755 scripts/backup/backup.sh scripts/backup/restore-db.sh scripts/backup/loop.sh /usr/local/bin/
ENV BACKUP_DIR=/backups
# El volumen nuevo hereda este dueño: el usuario postgres puede escribir las copias.
RUN mkdir -p /backups && chown postgres:postgres /backups
VOLUME ["/backups"]
USER postgres
ENTRYPOINT ["/usr/local/bin/loop.sh"]
