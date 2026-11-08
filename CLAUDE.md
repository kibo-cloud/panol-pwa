# Panol 3 — control de herramientas (servidor + PWA)

Contexto del proyecto para Claude Code. Leer antes de trabajar aca; el protocolo general
esta en `../CLAUDE.md`. Pedido completo en `docs/PEDIDO-v3.md` (no se modifica sin consultar).
Guia de diseno obligatoria: `docs/diseno/panol-guia-de-diseno.md`.
Feature en curso: `odd/tasks/v3-servidor.md`.

## Que es

Sistema web multiusuario para controlar herramientas de Mantenimiento (Villa D'agri):
plantillas por supervisor, controles por cantidad con limpieza, entregas y reposiciones,
cajas compartidas por linea, compras aprobadas por Gerencia, novedades, existencia por tecnico,
impresion de auditoria. Corre en un VPS; la PWA sigue instalable. `main` tiene la 2.1.0
(solo correcciones) hasta que la v3 se apruebe.

## Stack (no negociable)

- Backend: Node 22 LTS + Fastify, PostgreSQL 16, migraciones SQL versionadas en
  `server/migrations/` (nunca editar una migracion ya aplicada; agregar una nueva).
- Arquitectura hexagonal: `server/src/domain` (puro, sin I/O), `application` (casos de uso),
  `adapters/{http,pg,sse}`, `importers/{txt-v2,xlsm}`.
- Frontend: Vite + JS en modulos por feature (`web/src/features/*`), sin framework.
  `web/src/api` es el unico acceso a datos. CSP con `script-src 'self'`.
- Dependencias de runtime minimas y fijadas en `package-lock.json`; xlsx y jspdf servidos
  desde el propio servidor con SRI.
- Base local: `embedded-postgres` (misma version mayor y menor que la imagen `postgres` del
  Compose), datos en `.pgdata/` (ignorada). `npm run db:reset` carga datos inventados.
- Despliegue (escrito y validado en CI, todavia sin VPS): Docker Compose (`app`, `postgres`,
  `caddy`, `backup`). Secretos solo en `.env`; al repo va `.env.example`.

## Reglas que no se rompen

- El inventario sale siempre de `movement_transfers`; `movements` y `audit_log` son solo-agregar.
- Un control finalizado no se modifica: se corrige con un registro nuevo (`supersedes`).
- Un control original por poseedor y periodo (indice unico parcial).
- Mover un tecnico de plantilla cierra un rango en `tech_plantilla_history`; no borra nada.
  Cada control guarda `plantilla_id_snapshot`.
- Anular = contramovimiento. Eliminar = baja logica; definitivo solo sin historial.
- Permisos en cada endpoint; validacion por esquema en el servidor (tipos, limites, ISO).
  En importaciones, fecha vacia solo en campos opcionales (se guarda nula); obligatoria vacia
  es un error del informe.
- Edicion concurrente con `version` + `If-Match`; conflicto -> 409 y aviso, nunca pisar.
- Seguridad: CSP estricta, SRI, `esc()` en todo texto de usuario, CSRF, HTTPS + HSTS,
  argon2id, bloqueo progresivo de login en el servidor. Sin correo: el restablecimiento de
  contrasena lo hace un admin y obliga a cambiarla en el siguiente ingreso.
- Zona horaria `America/Argentina/Buenos_Aires` en el servidor y en la base; periodos y
  fechas de control se calculan con la fecha local.
- Una sola solicitud de compra abierta por asignacion o unidad; los controles siguientes se
  vinculan a la existente.
- Gerencia decide compras y ve en modo consulta; por defecto no hace controles, entregas ni
  administracion (configurable en permisos). Basta una aprobacion de cualquier Gerencia.

## Datos reales

`privado/` nunca se sube ni alimenta fixtures. Antes de cada commit, `git status` sin nada de
`privado/`. Las pruebas usan datos inventados (Excel de prueba generado por script).

## Version

- App `3.0.0-dev` en la rama `v3-servidor`. La 2.1.0 queda en `versiones/panol v2.1.0`.
- El importador acepta `.txt` `version: 2` (incluye `data.deleted`); *Descargar .txt* queda
  como copia de seguridad.

## Ramas y PR

- Un PR por etapa contra `v3-servidor`, desde `v3/etapa-N-<tema>`. CI (GitHub Actions) en
  verde antes de pedir revision. El PR dice que se hizo, como probarlo y el resultado de las
  pruebas. `v3-servidor` se integra a `main` solo con aprobacion del usuario.

## Como correr

- `npm install`, `npm run db:reset`, `npm run dev` (servidor + Vite en local).
- Detalle de instalar, actualizar y restaurar en el VPS: `LEEME.md`.

## Como probar

| Comando | Que hace |
|---|---|
| `npm test` | unitarias de dominio y aplicacion (`node --test`) |
| `npm run test:db` | integracion contra PostgreSQL (embedded en local, `postgres:16` en CI) |
| `node tests/e2e/run.mjs [filtro]` | E2E por CDP contra el servidor con base sembrada |

## Convenciones

- Conventional Commits en ingles, sin atribucion de IA.
- Textos de la app en espanol rioplatense; comentarios del codigo en espanol.
- Saltos de linea LF (`.gitattributes`).
- Mobile first, Inter, sin sombras, estados con icono + texto + color (guia de diseno).
