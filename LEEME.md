# Pañol 2.0 — app instalable (PWA)

Control de herramientas por técnico. Funciona sin conexión y guarda todo en el dispositivo.
Los datos se comparten entre equipos con un archivo `.txt`.

## Qué hay en esta carpeta

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La app completa |
| `manifest.webmanifest` | Nombre, ícono y colores para instalarla como app |
| `sw.js` | Hace que funcione sin conexión |
| `icons/` | Íconos de la app |

## 1. Publicarla (una sola vez)

Para instalarse como app, Chrome exige que la página se abra desde `https://` o desde `localhost`. Al abrir `index.html` con doble clic, la app funciona, pero no se puede instalar ni usar sin conexión.

**Opción A: Netlify Drop (gratis, 2 minutos, sin programar)**
1. Entrá a https://app.netlify.com/drop
2. Arrastrá esta carpeta completa (`panol-pwa`).
3. Te da un link `https://algo.netlify.app`. Ese link es la app: abrilo en cada celular o PC.

**Opción B: GitHub Pages.** Subí la carpeta a un repositorio y activá Pages en *Settings › Pages*.

**Opción C: solo en una PC.** Con Python instalado, abrí una terminal en esta carpeta y ejecutá
`python -m http.server 8080`. Después abrí `http://localhost:8080` en Chrome.

## 2. Instalarla como app

- **Chrome o Edge en PC:** tocá el ícono de instalar en la barra de direcciones, o *Menú ⋮ › Transmitir, guardar y compartir › Instalar Pañol*. Queda en el menú Inicio o en el Dock, con ventana propia.
- **Android (Chrome):** *Menú ⋮ › Instalar app* (o *Agregar a pantalla principal*).
- **iPhone (Safari):** *Compartir › Agregar a inicio*.

La app también muestra un botón *Instalar* en Inicio y en *Más* cuando el navegador lo permite.

## 3. Primer uso

1. Creá el usuario administrador, con nombre y un PIN de 4 a 8 números.
2. En *Administración › Usuarios* sumá a los responsables y a los usuarios de consulta, cada uno con su PIN.
3. Cargá herramientas y técnicos, o probá con *Cargar datos de demostración*.

## 4. El archivo .txt (Más › Archivo de datos)

| Acción | Qué hace | Dónde funciona |
|---|---|---|
| **Vincular archivo .txt** | Elegís dónde guardarlo y cada cambio se escribe solo en ese archivo. Si está en una carpeta de Drive, OneDrive o Dropbox, se sincroniza. | Chrome y Edge en PC |
| **Compartir .txt** | Lo manda por WhatsApp, correo, Drive o cualquier app del menú compartir. | Android, iPhone y algunas PC |
| **Descargar .txt** | Guarda una copia en Descargas. | Todos |
| **Abrir archivo .txt** | Trae los datos de otro equipo. Podés **Combinar** (suma lo nuevo y se queda con la versión más reciente de cada registro) o **Reemplazar todo** (el equipo queda igual al archivo). Solo lo puede hacer un administrador con la sesión iniciada, salvo en un equipo nuevo sin usuarios. | Todos |

Con la app instalada en PC, también podés abrir un `.txt` de Pañol con *Abrir con › Pañol*.

**Para trabajar entre varios equipos:** un equipo comparte su `.txt` y el otro lo abre con *Combinar*. Si trabajan en paralelo sobre los mismos datos, combinen seguido. Combinar compara la fecha de cada registro: gana el cambio más reciente y, si las fechas son iguales, queda lo del equipo. Lo que se borró en un equipo también se borra al combinar en el otro (si nadie lo modificó después). Para que un equipo quede idéntico a otro, usá *Reemplazar todo*.

## 5. Cosas a tener en cuenta

- Los datos viven en el navegador del dispositivo. Si se borran los datos del sitio o se desinstala la app, se pierden: mantené un `.txt` vinculado o descargá copias seguido.
- El PIN ordena quién hace cada cosa y queda en la auditoría, pero **no cifra los datos**. Quien tenga el archivo `.txt` puede leer su contenido, incluidos los usuarios y una versión protegida (hash PBKDF2) de cada PIN: con un PIN de 4 números, alguien con el archivo y tiempo podría adivinarlo. Usá PIN largos (hasta 8 números) y compartí el `.txt` solo con quien corresponde.
- Después de 5 PIN incorrectos seguidos, ese usuario tiene que esperar 30 segundos en ese equipo, y el doble con cada nuevo error (hasta 15 minutos).
- Los PIN creados con la versión 2.0 siguen funcionando y se protegen con el formato nuevo la primera vez que el usuario ingresa.
- La exportación a Excel y PDF descarga sus librerías la primera vez que se usa. Después funciona sin conexión.
- Para actualizar la app, reemplazá los archivos publicados y cambiá `VERSION` en `sw.js`.
