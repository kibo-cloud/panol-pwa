# Pañol 3 — control de herramientas (servidor + PWA)

Sistema web para controlar las herramientas de Mantenimiento: controles semanales por técnico,
entregas y reposiciones, inventario, alertas, reportes y auditoría. Corre en un servidor propio
(VPS) y se usa desde el navegador en varios lugares a la vez, con los mismos datos. Sigue siendo
instalable como app (PWA).

- **Servidor:** Node 22 + Fastify, base PostgreSQL 16, migraciones en `server/migrations/`.
- **App web:** Vite, en `web/` (se compila a `web/dist` y la sirve el mismo servidor).
- **Despliegue:** Docker Compose con la app, PostgreSQL, Caddy (HTTPS automático) y un servicio
  de copias de seguridad diarias.

> La versión 2.1 (app de un solo archivo, datos en el dispositivo) queda en la rama `main` y en
> `versiones/`. Para pasar sus datos a la 3, ver [Migrar desde Pañol 2.1](#7-migrar-desde-pañol-21).

---

## 1. Desarrollo local

Necesitás Node 22 o más nuevo. No hace falta instalar PostgreSQL ni Docker: `npm install` trae
un PostgreSQL de la misma versión que el del servidor (paquete `embedded-postgres`) y los datos
quedan en `.pgdata/` (fuera del repositorio).

```sh
npm install
cp .env.example .env        # configuración local (NODE_ENV=development, base local)
npm run db:start            # deja corriendo el PostgreSQL local
npm run db:reset            # borra la base, aplica migraciones y carga datos inventados
npm run dev                 # servidor + Vite: abrí http://127.0.0.1:5173
```

- Usuarios de desarrollo (solo locales): `admin`, `gerencia`, `supervisor`, `responsable`,
  `responsable2` y `consulta`, todos con la contraseña `panol-dev-1234`.
- `npm run db:stop` detiene el PostgreSQL local. `npm run db:migrate` aplica migraciones nuevas
  sin borrar datos.
- `npm run build` compila la app web; `npm start` arranca solo el servidor, que sirve
  `web/dist`.
- `npm run db:reset` y los datos inventados solo funcionan con `NODE_ENV=development` o `test`:
  nunca en producción.

### Pruebas

| Comando | Qué prueba |
|---|---|
| `npm test` | Unitarias del dominio, la aplicación y la app web (`node --test`). |
| `npm run test:db` | Integración contra PostgreSQL (uno temporal por archivo; en CI, el servicio `postgres:16.14` con `TEST_DATABASE_URL`). |
| `npm run test:e2e` | De punta a punta con Edge o Chrome sin ventana: compila la app si hace falta, arranca el servidor con una base sembrada (una base limpia por prueba) y recorre la app. `node tests/e2e/run.mjs <filtro>` corre solo las que coinciden. `PANOL_BROWSER=<ruta>` elige el navegador. Las capturas quedan en `tests/e2e/out/`. |

GitHub Actions (`.github/workflows/ci.yml`) corre las tres en cada push o pull request a
`v3-servidor` y `v3/**`, y además arma el Compose, verifica `/api/health` por HTTPS y prueba la
copia y la restauración.

---

## 2. Instalación en el VPS

Lo que necesitás:

- Un VPS con Linux (Ubuntu 24.04 o Debian 12), 2 GB de RAM y 20 GB de disco alcanzan.
- Un dominio o subdominio, p. ej. `panol.ejemplo.com.ar`.
- Los puertos 80 y 443 abiertos hacia el VPS (Caddy los usa para el certificado y para la app).

### 2.1 Docker

Con un usuario con `sudo`, instalá Docker Engine y el plugin de Compose siguiendo la guía oficial
(https://docs.docker.com/engine/install/). Comprobalo con:

```sh
docker --version
docker compose version
```

### 2.2 DNS

En el proveedor del dominio, creá un registro **A** (y **AAAA** si el VPS tiene IPv6) que apunte
el dominio a la IP del VPS. Esperá a que resuelva antes de seguir:

```sh
getent hosts panol.ejemplo.com.ar
```

### 2.3 Código y configuración

```sh
git clone https://github.com/<cuenta>/<repo>.git panol
cd panol
git checkout v3-servidor          # o la rama/etiqueta que se vaya a instalar
```

Creá el archivo `.env` en esa carpeta (nunca se sube al repositorio) con estas variables:

| Variable | Obligatoria | Para qué |
|---|---|---|
| `DOMAIN` | sí | Dominio público, p. ej. `panol.ejemplo.com.ar`. |
| `ACME_EMAIL` | sí | Correo para Let's Encrypt (avisos del certificado). |
| `POSTGRES_PASSWORD` | sí | Contraseña del dueño de las tablas (migraciones y copias). |
| `APP_DB_PASSWORD` | sí | Contraseña del rol `panol_app`, con el que atiende la app. Distinta de la anterior. |
| `POSTGRES_DB` | no | Nombre de la base (`panol`). |
| `POSTGRES_USER` | no | Usuario dueño (`panol_owner`). |
| `BACKUP_HOUR` | no | Hora local de la copia diaria, 0 a 23 (`3`). |
| `KEEP_DAILY`, `KEEP_WEEKLY`, `KEEP_MONTHLY` | no | Copias que se conservan (`7`, `4`, `6`). |

Las contraseñas van dentro de una URL de conexión: usá solo letras y números. Para generarlas:

```sh
openssl rand -hex 24
```

Ejemplo de `.env`:

```sh
DOMAIN=panol.ejemplo.com.ar
ACME_EMAIL=sistemas@ejemplo.com.ar
POSTGRES_PASSWORD=<resultado de openssl rand -hex 24>
APP_DB_PASSWORD=<otro resultado de openssl rand -hex 24>
```

```sh
chmod 600 .env
```

### 2.4 Arrancar

```sh
docker compose up -d --build
docker compose ps                 # app, postgres, caddy y backup en "running"/"healthy"
curl https://panol.ejemplo.com.ar/api/health     # {"ok":true,"db":true}
```

Al arrancar, la app aplica las migraciones con el usuario dueño y habilita el rol `panol_app`;
después atiende conectada como `panol_app`, sin permisos de dueño (si se la configura con un
superusuario o con el dueño de las tablas, no arranca). Caddy obtiene el certificado HTTPS la
primera vez que alguien entra al dominio, redirige HTTP a HTTPS y agrega HSTS.

### 2.5 Primer administrador

La instalación nueva no tiene usuarios. Creá el primer administrador:

```sh
docker compose exec app npm run admin:create -- admin "Nombre Apellido"
```

Muestra una contraseña temporal **una sola vez**. Entrá a `https://<dominio>` con ese usuario y
esa contraseña: la app pide elegir una contraseña nueva. Desde *Administración › Usuarios y
permisos* se crean los demás usuarios (cada uno recibe su contraseña temporal) y, si alguien la
olvida, *Restablecer contraseña* genera otra. El mismo comando sirve para recuperar el acceso si
no queda ningún administrador que pueda entrar.

### 2.6 Instalar la app en los equipos

Con el sitio en `https://`, Chrome y Edge muestran *Instalar* en la barra de direcciones (en
Android, *Menú ⋮ › Instalar app*; en iPhone, Safari › *Compartir › Agregar a inicio*). La app
también muestra *Instalar Pañol* en *Más*.

---

## 3. Actualizar

```sh
cd panol
docker compose exec backup backup.sh     # copia antes de actualizar
git pull
docker compose up -d --build             # reconstruye y reinicia; las migraciones se aplican solas
docker compose ps
curl https://<dominio>/api/health
```

Los navegadores toman la versión nueva al recargar (el `index.html` y el service worker no se
guardan en caché). Si una actualización sale mal, volvé a la versión anterior con
`git checkout <versión anterior>` y `docker compose up -d --build`; si la versión nueva ya migró
la base, restaurá la copia del paso 1 (ver 4.3).

---

## 4. Copias de seguridad

### 4.1 Cómo funcionan

El servicio `backup` hace todos los días, a la hora `BACKUP_HOUR`, un `pg_dump` en formato
propio (`-Fc`), verifica que se pueda leer y lo guarda en el volumen `backups`:

- `daily/`: las últimas 7 (`KEEP_DAILY`).
- `weekly/`: la del domingo, las últimas 4 (`KEEP_WEEKLY`).
- `monthly/`: la del día 1, las últimas 6 (`KEEP_MONTHLY`).

La primera copia también inaugura `weekly/` y `monthly/`. Los archivos se llaman
`panol-AAAAMMDD-HHMMSS.dump`.

### 4.2 Comandos

```sh
docker compose exec backup backup.sh                    # copia ahora
docker compose exec backup ls -lR /backups              # ver las copias
docker compose logs backup                              # resultado de las copias diarias
docker compose cp backup:/backups/daily/panol-20261108-030000.dump .   # bajar una al VPS
```

El *Descargar .txt* de la app (*Más › Copia de seguridad*) sigue disponible como copia manual,
pero no guarda contraseñas: la copia que restaura todo es la de este servicio.

### 4.3 Restaurar

```sh
scripts/backup/restore.sh daily/panol-20261108-030000.dump          # muestra qué va a hacer
scripts/backup/restore.sh --yes daily/panol-20261108-030000.dump    # restaura
```

La copia puede ser una ruta dentro del volumen (`daily/…`, `weekly/…`, `monthly/…`) o un archivo
`.dump` del VPS (p. ej. bajado del bucket). El script detiene la app, borra y recrea la base con
la copia, vuelve a arrancar la app (que aplica las migraciones pendientes) y espera a que
`/api/health` responda. **Todo lo cargado después de esa copia se pierde.** Los usuarios vuelven
con las contraseñas que tenían en ese momento.

### 4.4 Copia fuera del VPS (opcional, recomendada)

Si el VPS se pierde, se pierden también sus copias. Para mandar cada copia a un bucket
compatible con S3, creá el archivo `.env.offsite` (tampoco va al repositorio) y reiniciá el
servicio con `docker compose up -d backup`. Sin ese archivo, la copia queda solo en el VPS.

**Cloudflare R2:** creá un bucket (p. ej. `panol-copias`) y un token de API de R2 con permiso de
escritura en ese bucket.

```sh
BACKUP_REMOTE=offsite:panol-copias
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Cloudflare
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://<id de la cuenta>.r2.cloudflarestorage.com
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=<access key id del token>
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=<secret access key del token>
```

**Backblaze B2:** creá un bucket privado y una *Application Key* limitada a ese bucket.

```sh
BACKUP_REMOTE=offsite:panol-copias
RCLONE_CONFIG_OFFSITE_TYPE=b2
RCLONE_CONFIG_OFFSITE_ACCOUNT=<keyID>
RCLONE_CONFIG_OFFSITE_KEY=<applicationKey>
```

```sh
chmod 600 .env.offsite
docker compose up -d backup
docker compose exec backup backup.sh        # prueba: tiene que decir "copia fuera del VPS"
```

Las copias se suben con `rclone copy`: borrar una en el VPS no la borra del bucket. Para no
acumular para siempre, configurá en el bucket una regla de ciclo de vida (p. ej. borrar a los
180 días). Para restaurar desde el bucket, bajá el archivo al VPS (panel del proveedor o
`docker compose exec backup rclone copy offsite:panol-copias/daily/<archivo> /tmp/`) y usá
`restore.sh --yes <archivo>`.

---

## 5. Seguridad, en corto

- HTTPS siempre (Caddy) con HSTS; la cookie de sesión es `__Host-`, `Secure` y `httpOnly`.
- Contraseñas con argon2id; después de 5 intentos fallidos el usuario espera 30 s, el doble con
  cada error nuevo (hasta 15 min). El bloqueo lo controla el servidor.
- Sin correo: un administrador restablece contraseñas y el usuario la cambia al entrar.
- CSP estricta como cabecera (`script-src 'self'`), xlsx y jspdf servidos por la app con SRI.
- La app se conecta a la base con un rol sin permisos de dueño; movimientos y auditoría son de
  solo agregar.
- Los secretos viven solo en `.env` y `.env.offsite` del VPS.

---

## 6. Problemas frecuentes

| Síntoma | Qué revisar |
|---|---|
| `docker compose up` dice `Falta ... en .env` | Falta esa variable en `.env` (ver 2.3). |
| El navegador no conecta o el certificado falla | `docker compose logs caddy`. El DNS tiene que apuntar al VPS y los puertos 80 y 443 tienen que estar abiertos. Let's Encrypt limita los reintentos: corregí y esperá unos minutos. |
| `/api/health` responde `{"ok":false,"db":false}` | `docker compose ps postgres` y `docker compose logs postgres`. |
| La app se reinicia sola | `docker compose logs app`. Con `DATABASE_URL tiene que usar el usuario panol_app` o `no puede conectarse como superusuario` la configuración de credenciales está mal; con un error de migración, no se editó una migración ya aplicada (siempre se agrega una nueva). |
| Cambié `APP_DB_PASSWORD` | `docker compose up -d app`: al arrancar, la app vuelve a fijar la contraseña del rol. |
| Cambié `POSTGRES_PASSWORD` | PostgreSQL la toma solo al crear el volumen. Cambiala también adentro: `docker compose exec postgres psql -U panol_owner -d panol -c "ALTER ROLE panol_owner PASSWORD '<nueva>'"` y después `docker compose up -d`. |
| "Tu sesión terminó" seguido | La sesión vence a las 12 h sin uso (24 h como máximo); con *Mantener la sesión en este dispositivo*, a los 30 días. |
| Nadie puede entrar como administrador | `docker compose exec app npm run admin:create -- otro.admin "Nombre"` (ver 2.5). |
| Una copia diaria falló | `docker compose logs backup`. Si falló la subida al bucket, la copia local quedó bien: revisá `.env.offsite`. |
| Sin conexión en un equipo | La app muestra un aviso; el borrador del control en curso se guarda en el equipo y se envía al volver la conexión. Las demás acciones esperan a la conexión. |

---

## 7. Migrar desde Pañol 2.1

1. En la 2.1, en cada equipo que tenga datos: *Más › Archivo de datos › Descargar .txt*.
2. En la 3, entrá como administrador: *Más › Copia de seguridad (.txt) › Importar .txt* y elegí
   el archivo. Primero se muestra un informe: cantidades, cambios, errores, conflictos, usuarios
   nuevos y supuestos. Nada se escribe hasta *Confirmar importación*.
   - **Reemplazar todo:** para la primera migración, en un servidor sin movimientos ni
     controles. El servidor queda igual al archivo (el archivo tiene que traer un administrador
     activo; tu usuario se conserva).
   - **Combinar:** para sumar otro equipo. Gana la versión más reciente de cada registro, los
     borrados del archivo (`data.deleted`) se aplican y el libro de movimientos, la auditoría y
     los controles finalizados nunca se modifican (las diferencias se informan como conflictos).
3. Los usuarios de la 2.x reciben un nombre de usuario armado con su nombre (`ana.admin`, se
   ve en el informe y se puede editar). En el primer ingreso usan **su PIN como contraseña
   temporal** y eligen una contraseña nueva.
4. Un archivo con errores (fechas que no son ISO, fecha obligatoria vacía, referencias rotas,
   legajos o códigos repetidos) no se puede importar hasta corregirlo; el informe dice
   colección, registro y campo.

El *Descargar .txt* de la 3 sirve como copia manual en el mismo formato, sin contraseñas ni PIN.
