# Panol — control de herramientas (PWA)

Contexto del proyecto para Claude Code. Leer antes de trabajar aca; el protocolo general
esta en `../CLAUDE.md`. Detalle funcional para el usuario en `LEEME.md`.

## Que es

PWA estatica para controlar herramientas por tecnico: controles semanales, entregas,
reposiciones, inventario, alertas, reportes y usuarios con PIN (admin, responsable, consulta).
Todo se guarda en el dispositivo (IndexedDB, base `panol`, clave `data`) y se comparte entre
equipos con un archivo `.txt` (Combinar o Reemplazar todo).

## Stack (no negociable)

- Un solo `index.html` con todo el CSS y el JS en linea (estilo denso, sin build, sin
  dependencias en tiempo de ejecucion), `sw.js`, `manifest.webmanifest` e `icons/`.
- Excel y PDF: `xlsx 0.18.5` y `jspdf 2.5.1` desde cdnjs, cargados a demanda con SRI
  (`SRI` junto a `loadScript`). Si se cambia una version, recalcular el sha512 del archivo.
- CSP en un `<meta>` de `index.html`: el script en linea se permite por su sha256.
  **Despues de editar el `<script>`, correr `node tests/csp-hash.mjs`** (o la app queda en blanco).
- Texto de usuario siempre con `esc()`; ids y numeros que vienen de un archivo se validan con
  el esquema (`SCHEMA`, `checkData`) antes de tocar `S`.

## Version

- App `2.1.0`: `VERSION` en `sw.js` (`panol-v2.1.0`) y el texto "Pañol 2.1.0" de la vista Mas.
- Formato del `.txt`: `version: 2` (compatible con 2.0.0). Los borrados viajan en
  `data.deleted` (`'coleccion/id' -> fecha`), que 2.0.0 ignora.
- Copias de cada version entregada en `versiones/` (no se editan).

## Datos y reglas clave

- `put`/`patch` sellan `updatedAt`; `del` deja marca en `DEL`. Combinar (`mergeInto`): gana la
  fecha mas nueva, empate queda lo local, un borrado mas nuevo elimina.
- Abrir un `.txt` exige admin con sesion iniciada, salvo primer uso sin usuarios (`canImport`).
  Reemplazar nunca deja el equipo sin admin activo. Limite 20 MB.
- PIN: `pbkdf2$210000$<hex>`; `sha256:` y `fnv:` de 2.0.0 se aceptan y se actualizan al ingresar.
  Bloqueo progresivo por equipo en IndexedDB `pinLocks` (no viaja en el `.txt`).
- Guardado: en la tarea siguiente, flush en `pagehide`, copia de seguridad `panol-unsaved` en
  localStorage si una escritura pudo quedar cortada (se combina al arrancar).

## Como correr

`python -m http.server 8080` en la carpeta y abrir `http://localhost:8080` (el SW necesita
`http(s)`; con doble clic funciona pero sin instalacion ni modo sin conexion).

## Como probar

| Comando | Que hace |
|---|---|
| `node tests/e2e/run.mjs` | E2E completo: servidor propio + Edge/Chrome headless por CDP, sin npm (Node 22+) |
| `node tests/e2e/run.mjs <filtro>` | solo specs cuyo nombre contiene el filtro (p. ej. `t3`) |
| `node tests/csp-hash.mjs --check` | verifica que la CSP coincide con el script en linea |
| `node tests/e2e/make-fixtures.mjs` | regenera `tests/e2e/fixtures/` (la de 2.0.0 sale del commit `11296b1`) |

- `PANOL_BROWSER=<ruta>` fuerza el navegador. Cada spec usa un contexto nuevo (IndexedDB vacio).
- Specs en `tests/e2e/specs/` (una por tarea de `odd/tasks/security-hardening.md`); helpers en
  `tests/e2e/app.mjs`. Capturas y archivos temporales en `tests/e2e/out/` (ignorado).
- La spec de Excel/PDF se salta sin conexion. El archivo de 21 MB hace lenta la spec `t1`.
- Headless no responde `showOpenFilePicker`: el harness lo anula y usa el `<input type=file>`.

## Convenciones

- Commits Conventional Commits en ingles, sin atribucion de IA. Rama por feature.
- Textos de la app en espanol rioplatense; comentarios del codigo en espanol.
- Saltos de linea LF (`.gitattributes`); los fixtures `.txt` se guardan tal cual.
