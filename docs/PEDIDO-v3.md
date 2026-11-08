# Pañol 3.0: pedido completo de desarrollo

Este archivo es el pedido de la versión 3.0. Usalo como referencia durante todo el trabajo y no lo modifiques sin consultarme.

## 0. Antes de empezar

### Estado actual y cómo trabajar con el repo
- **Repo:** `kibo-cloud/panol-pwa` es **público**.
- **`main` tiene la PWA 2.1.0** que ya hiciste: estática, IndexedDB más `.txt`, PIN con PBKDF2 y bloqueo progresivo, CSP con hash, SRI, validación por esquema con cuarentena, borrados en `data.deleted` y pruebas E2E.
  - Se usa mientras se desarrolla lo nuevo, así que **`main` solo recibe correcciones**.
- **La versión 3.0 va en una rama nueva, `v3-servidor`.** Se integra a `main` cuando esté terminada y yo la apruebe. Guardá la 2.1.0 en `versiones/`, como hasta ahora.
- **`CLAUDE.md`:** en la rama `v3-servidor`, la sección "Stack (no negociable)" se reemplaza por el stack nuevo, una vez que yo lo apruebe. Se mantienen las convenciones:
  - Conventional Commits en inglés, sin atribución de IA.
  - Textos de la app en español rioplatense.
  - `esc()` para todo texto de usuario.
  - Validación por esquema.
  - Saltos de línea LF.
- **Archivos que agregué al proyecto:**
  - `.gitignore` en la raíz: ignora `privado/`, `.env`, `node_modules/`, `dist/` y `tests/e2e/out/`. Antes de cualquier commit, verificá con `git status` que nada de `privado/` aparezca para subir.
  - `docs/PEDIDO-v3.md`: este pedido.
  - `docs/diseno/panol-guia-de-diseno.md`: la guía de diseño.
  - `docs/diseno/pantallas/*.dc.html`: maquetas de referencia de cada pantalla.
  - `privado/`: el Excel anterior y su instructivo, con datos reales de la empresa.
- **Datos reales:** lo que está en `privado/` **nunca** se sube al repo ni se usa para generar fixtures. Las pruebas usan datos inventados.
- **Secretos:** van en `.env`, que no se sube. Al repo va un `.env.example`.

### Primera entrega: sin código
Prepará y mandame lo siguiente, y esperá mi confirmación antes de programar:
1. Las tareas de `odd/tasks/` con su estado, y el resultado completo de `node tests/e2e/run.mjs`, incluidas las specs que se saltean.
2. El plan, el modelo de datos (tablas, campos, relaciones) y la arquitectura propuesta.
3. El `CLAUDE.md` propuesto para la rama `v3-servidor`.
4. Las preguntas de la sección 4.

## 1. Contexto

### La empresa
Sector **Mantenimiento de Villa D'agri**, una fábrica con varias líneas de producción.
- Los técnicos trabajan en **plantillas**, y cada plantilla está a cargo de un supervisor.
- La plantilla rota de turno completa y, en su turno, cubre **toda la fábrica y todas las líneas**. No está ligada a una línea ni a un sector.
- Un técnico también puede **pasar de una plantilla a otra** cuando cambia de turno de forma individual.

### Archivos de referencia
- **El código actual del repo.** Es la base: no se pierde ninguna funcionalidad ni ninguna de las protecciones de seguridad ya hechas.
- **`docs/diseno/panol-guia-de-diseno.md`:** guía de diseño **obligatoria** para todo lo nuevo. Mobile first, tipografía Inter, sin sombras, estados con ícono más texto más color.
- **`docs/diseno/pantallas/`:** maquetas HTML de referencia.
  - Están hechas con el modelo anterior de turnos: `Turno.dc.html` y `CambioTurno.dc.html` sirven de base visual para la vista de Plantilla y para Cambiar de plantilla.
  - Las pantallas nuevas (Gerencia, Novedades, Existencia por técnico, Impresión) siguen el mismo lenguaje visual.
- **`privado/HERRAMIENTAS_ASIGNADAS_A_TÉCNICOS_LIMPIEZA.xlsm`:** el Excel que se usaba antes.
- **`privado/Elementos_enviados__Mantenimiento_-_Outlook.pdf`:** el instructivo del Excel, escrito por su autor.

### Cómo funcionaba el Excel (ver el instructivo)
- **Una hoja por legajo,** de un técnico o de un referente de sector (por ejemplo, Producción).
- **Lista fija de 57 herramientas,** tomada de la hoja `BLANCO`. Se agregaban o quitaban desde RESUMEN con los botones + y −, en la posición elegida.
- **Cada control era un bloque de 3 columnas bajo una fecha:** ENTREGA, DEVOLUCIÓN y CONTEO.
- **Primer bloque:** la existencia inicial se cargaba como entrega y con el mismo valor en el conteo.
- **Valores del conteo:**
  - 1 = buen estado.
  - 0,5 = requiere recambio. Además se sumaba 0,5 en DEVOLUCIÓN para que no figurara como faltante.
  - 0 = falta.
- **Bajas y devoluciones:** se cargaban en DEVOLUCIÓN con el valor del conteo previo.
- **Saldo:** `SALDO = último conteo − (entregas − devoluciones)`.
- **RESUMEN:** existencia de cada herramienta por técnico, más especialidad, último control, días desde ese control, faltantes y mal estado.
- **NOVEDADES:** fecha, hora, legajo y comentario, usada para recordatorios y seguimiento de compras.
- **El Excel quedó incompleto por la fricción de cargarlo.** Muchas hojas no tienen la entrega inicial ni el 0,5 en devolución, y por eso hay saldos que no son faltantes reales. La app tiene que eliminar esa fricción.

### Reglas que no se pueden romper
- Un control finalizado nunca se sobrescribe: se corrige con un registro nuevo.
- El inventario siempre sale del libro de movimientos.
- Toda acción importante queda en auditoría con fecha, hora y responsable.
- Mover a un técnico de plantilla no pierde nada de su historial.
- No se pierde ninguna funcionalidad ni protección de la 2.1.0.

## 2. Cambios a implementar

### 2.1 Servidor en VPS y usuarios
El sistema corre en un VPS propio y se usa desde el navegador en distintos lugares al mismo tiempo, con los mismos datos.

- **Backend:** API con base de datos. Propuesta: Node.js LTS con Fastify o Express, PostgreSQL y migraciones versionadas. Si proponés otra opción, justificala.
- **Usuarios:**
  - Usuario y contraseña, hasheada con argon2 o bcrypt.
  - Sesión con cookie httpOnly y opción *Mantener la sesión*.
  - Bloqueo progresivo ante intentos fallidos, ahora controlado en el servidor.
  - El administrador crea usuarios, los desactiva y restablece contraseñas.
- **Roles:** Administrador, **Gerencia**, **Supervisor**, Responsable de control y Consulta. Los permisos se pueden configurar, como hoy.
- **Validaciones en el servidor:**
  - Las mismas reglas del esquema actual: tipos, límites y fechas ISO.
  - Stock suficiente.
  - Legajo y código de unidad únicos.
  - Un solo control original por técnico y período, como restricción en la base.
  - Permisos en cada endpoint.
- **Seguridad:** se mantienen la CSP, el SRI y `esc()`. Se suma protección CSRF y se aplica HTTPS siempre.
- **Varios usuarios a la vez:** los cambios de otros se ven sin recargar (SSE, WebSocket o polling). Si dos personas editan lo mismo, avisar en lugar de pisar el cambio.
- **Frontend:** reemplazar la capa de almacenamiento por un cliente de la API, manteniendo vistas y lógica. Se puede modularizar con Vite si ayuda, sin cambiar el diseño.
- **PWA:** sigue siendo instalable. Sin conexión muestra un aviso y guarda localmente el borrador del control en curso, para enviarlo al volver la conexión.
- **Migración desde la 2.1:**
  - Importador del `.txt` versión 2, incluidos los borrados de `data.deleted`, para no perder lo cargado mientras tanto.
  - Los usuarios con PIN se migran. En el primer ingreso usan su PIN como contraseña temporal y tienen que crear una contraseña nueva.
  - *Descargar .txt* queda como copia de seguridad.
- **Despliegue:**
  - Docker Compose con la app, PostgreSQL y Caddy o Nginx con HTTPS automático.
  - Copia de seguridad diaria de la base, con rotación.
  - Un `LEEME` con los pasos exactos para instalar, actualizar y restaurar en el VPS.

### 2.2 Plantillas por supervisor, en lugar de turnos
Los turnos fijos (mañana, tarde, noche) no reflejan la realidad, porque son rotativos.

- **Módulo Plantillas:** reemplaza al módulo Turnos.
  - Cada plantilla tiene un nombre (por defecto "Plantilla de [supervisor]") y un supervisor, que es un usuario con rol Supervisor.
  - Cada técnico pertenece a una plantilla.
- **Rotación de la plantilla completa:**
  - El turno actual de la plantilla es un dato informativo.
  - Al rotar, se cambia una vez para toda la plantilla y queda en el historial, para saber qué plantilla estaba de turno en cada fecha.
- **Mover técnicos de forma individual.** Es un punto importante: cuando un técnico cambia de turno por su cuenta, se lo pasa a otra plantilla.
  - Desde la ficha del técnico: *Cambiar de plantilla*, con plantilla destino, fecha desde y motivo.
  - Desde la vista de una plantilla: seleccionar uno o varios técnicos y *Mover seleccionados* a otra plantilla, en un solo paso.
  - Opcional, para confirmar: *Cobertura temporal* con fecha hasta. El técnico vuelve solo a su plantilla al terminar.
  - El técnico conserva sus herramientas, sus controles y todo su historial.
  - Se registra la fecha, la plantilla anterior, la nueva, el motivo y el responsable.
  - Cada control guarda la plantilla vigente al momento de hacerse, para que los reportes históricos por plantilla sigan siendo correctos.
- **Agrupación:** el panel, los filtros, los reportes y la impresión se agrupan por plantilla.
- **Vista del supervisor:** ve primero *Mi plantilla* y recibe las alertas de su gente.
- **Migración:** los turnos existentes se convierten en plantillas.

### 2.3 Líneas de producción y cajas compartidas
- **Catálogo configurable** de líneas de producción y sectores.
- **Asignaciones:** una herramienta se asigna a un técnico o a una caja compartida de una línea o sector, con un referente responsable. El alta es un solo formulario. Hoy en el Excel lleva unos diez pasos manuales.
- **Opcional, para confirmar:** al marcar una herramienta como faltante o para cambio, indicar en qué línea se estaba trabajando, para ver dónde se concentran las roturas y las pérdidas.

### 2.4 Especialidad del técnico
- Campo configurable: Mecánico, Electricista, Electro-mecánico, Refrigeración, Soldador, Edilicio, Servicios Generales, Ingeniería, Pañolero.
- Se puede filtrar y aparece en reportes e impresión.

### 2.5 Kit base y orden personalizado de herramientas
- **Kit base:** lista de herramientas equivalente a `BLANCO`, editable.
  - Opcionalmente, kits por especialidad.
  - Se puede entregar un kit completo en un paso, que genera un movimiento por herramienta.
- **Orden personalizado:**
  - Se ordenan las categorías y las herramientas, por ejemplo según el orden físico de la caja.
  - En la computadora, arrastrando y soltando. En el celular, con flechas subir y bajar.
  - Se puede insertar una herramienta en una posición elegida, como el + y − del Excel.
  - El orden se aplica en el control, la ficha, el inventario, los reportes, el Excel y la impresión.
  - Opcional: un orden propio por técnico.

### 2.6 Conteo por cantidad y limpieza en el control
- **Conteo por cantidad:**
  - En herramientas con más de 1 unidad, el control carga cuántas hay y cuántas requieren recambio.
  - Las que no aparecen son faltantes, con motivo obligatorio.
  - Con 1 unidad se mantienen los botones Bueno, Cambio y Faltante.
  - "Requiere recambio" **nunca** cuenta como faltante. No hacen falta trucos como el 0,5 en devolución.
- **Limpieza:** el Excel no la registra, aunque el archivo se llama "LIMPIEZA".
  - Propuesta: un ítem por control, *Limpieza de herramientas y caja*, con las opciones *Limpio* o *Requiere limpieza*. Esta última exige nota.
  - Se ve en la ficha, los reportes, las alertas (por ejemplo, dos controles seguidos que requieren limpieza) y la impresión.
  - **Confirmar conmigo antes de implementar.**

### 2.7 Apartado de Gerencia: aprobación de compras
- **Sección propia,** visible para Gerencia y Administración.
- **Solicitudes de compra:**
  - Se crean automáticamente cuando una herramienta queda para cambio o faltante.
  - También se pueden crear a mano desde la ficha de la herramienta o desde una alerta.
  - Datos: herramienta, código, técnico o caja, plantilla, motivo (dañada o extraviada), observación del control, cantidad, fecha y quién la generó.
  - Campos opcionales: costo estimado y proveedor.
- **Decisión:** aprobar o rechazar. El comentario es obligatorio al rechazar. Se registra quién decidió y cuándo.
- **Estados:** pendiente, aprobada, rechazada, comprada o recibida.
  - La recepción genera el ingreso al inventario, vinculado a la solicitud.
  - La reposición al técnico queda vinculada a ese ingreso.
  - Las rechazadas quedan en el historial con su motivo.
- **Pantalla:** bandeja de pendientes con aprobación rápida desde el celular, filtros, totales aprobados por mes y alerta de solicitudes pendientes.

### 2.8 Novedades
- **Botón *Nueva novedad*:** fecha y hora automáticas, técnico, plantilla o línea opcional, comentario y autor.
- **Vínculos:** una novedad se puede vincular a una solicitud de compra o a una entrega.
- **Lista** filtrable, incluida en la impresión de auditoría.

### 2.9 Existencia por técnico y días sin control
- **Vista equivalente a RESUMEN:** herramientas en filas, técnicos y cajas en columnas, con totales, recambio y faltantes. Se puede filtrar por plantilla, exportar a Excel e imprimir.
- **Días desde el último control:** visible en fichas y plantillas, con una alerta configurable (por ejemplo, más de 14 días).

### 2.10 Eliminar técnicos y otros registros
- **Eliminar:** para técnicos, cajas, herramientas, categorías, plantillas, líneas y usuarios.
- **Anular:** para movimientos cargados por error.
- **Baja lógica por defecto:**
  - El registro queda archivado y oculto en listas y selectores.
  - Su historial sigue en reportes, auditoría e impresiones.
  - Se puede restaurar desde *Administración › Registros eliminados*.
- **Eliminación definitiva:** solo para registros sin historial, con doble confirmación escribiendo el nombre.
- **Con herramientas asignadas:** antes de eliminar, resolver la devolución o el retiro, o hacerlo en el mismo paso.
- **Anular un movimiento:** genera un contramovimiento que revierte el inventario. El original nunca se borra.
- **Permisos y auditoría:** solo Administración puede eliminar, salvo que los permisos digan otra cosa. Todo queda en auditoría con motivo.

### 2.11 Imprimir para auditoría
Un botón **Imprimir para auditoría** en Reportes, también accesible desde *Más*. Tiene que demostrar que las herramientas y su limpieza estuvieron controladas y en condiciones.

- **Selección antes de imprimir:**
  - Meses a incluir: un rango, o meses sueltos con casillas.
  - Plantillas, técnicos y cajas: todos o algunos.
  - Secciones a incluir, con casillas.
- **Formato general:**
  - Vista A4 con `@media print`, que también permite *Guardar como PDF*.
  - Encabezado con nombre de empresa y logo, configurables en *Administración › Empresa*. Por defecto: Villa D'agri · Mantenimiento. Además: período, fecha de emisión y quién emitió.
  - Número de página. Cada técnico empieza en página nueva.
  - Legible en blanco y negro, con símbolos además del color: ✓ Bueno, C Cambio, F Faltante, con referencia al pie.
- **Contenido:**
  1. **Resumen:** técnicos, herramientas, controles realizados frente a esperados, % en condiciones, faltantes, reposiciones y limpieza.
  2. **Por técnico o caja:** tabla con herramientas en filas (en el orden personalizado y con código) y una columna por control del período. Debajo: observaciones, limpieza, quién controló y cuándo, y las correcciones marcadas.
  3. **Faltantes y su resolución.**
  4. **Entregas, reposiciones, devoluciones y retiros.**
  5. **Compras aprobadas y rechazadas.**
  6. **Novedades.**
  7. **Cambios de plantilla del período.**
  8. **Espacio de firmas** para el responsable del pañol y el auditor.
- **Opción *Formato planilla*:** el mismo diseño del Excel anterior, porque el auditor ya lo conoce.
- **Datos:** solo controles finalizados vigentes.
- **Descarga:** también en Excel.

### 2.12 Importador del Excel anterior
Importar el `.xlsm` siguiendo el instructivo:

- **Técnicos y referentes:** legajo, nombre y especialidad, desde RESUMEN. Los legajos sin hoja o sin controles se importan sin herramientas.
- **Herramientas:** por cantidad, en el orden del Excel. `BLANCO` pasa a ser el kit base.
- **Primer bloque de cada hoja:** existencia inicial, como entrega inicial. Si hay conteo sin entrega (saldo positivo), generar una *entrega inicial de ajuste* marcada como importada.
- **Cada bloque fechado:** un control finalizado en esa fecha, marcado "importado del Excel".
  - Conteo 1 = bueno.
  - Conteo 0,5 = recambio, tenga o no el 0,5 en devolución.
  - Conteo menor a lo asignado = faltante, con nota "Conteo 0 en Excel".
- **Columna DEVOLUCIÓN:**
  - Un 0,5 junto a un conteo de 0,5 no es un movimiento real: ignorarlo.
  - Una devolución igual al conteo previo es una devolución o una baja.
- **Columna ENTREGA en bloques posteriores:** entrega adicional o reposición.
- **Dos bloques en la misma semana:** el último queda vigente y el anterior como historial.
- **NOVEDADES:** se importan como novedades.
- **Plantilla:** los técnicos se importan sin plantilla, para asignarlos después con *Mover seleccionados*.
- **Antes de confirmar:** mostrar un resumen de todo lo asumido (ajustes, faltantes, duplicados) para revisarlo caso por caso.
- **El archivo se lee desde `privado/`.** No se sube al repo ni se copia a fixtures.

## 3. Descartado
- **Cronograma de pañoleros:** cada control queda registrado con el usuario que lo hizo.
- **Turnos fijos:** se reemplazan por plantillas.

## 4. Para confirmar conmigo antes de implementar
- Proveedor y tamaño del VPS, y dominio.
- **Limpieza:** si "LIMPIEZA" es el sector o la limpieza de herramientas, y si se registra por control o por herramienta.
- **Semanas:** 4 controles fijos por mes o semanas del año (el Excel usaba fechas libres, más o menos semanales).
- **Cobertura temporal:** si hace falta poder mover técnicos con fecha de vuelta.
- **Línea en faltantes y roturas:** si suma o es fricción de más.
- **Compras:** si llevan costo y proveedor, y si Gerencia es una persona o varias.
- **Logo:** archivo del logo de Villa D'agri en buena resolución, para cargarlo en *Administración › Empresa*.

## 5. Forma de trabajo
1. **Primera entrega sin código:** la de la sección 0. Esperá mi confirmación.
2. **Orden de implementación, en la rama `v3-servidor`:**
   1. Servidor, usuarios y migración desde el `.txt`.
   2. Plantillas, movimiento de técnicos y líneas.
   3. Especialidad, kit base y orden.
   4. Conteo por cantidad y limpieza.
   5. Eliminar y anular.
   6. Novedades.
   7. Gerencia.
   8. Existencia por técnico y alertas.
   9. Importador del Excel.
   10. Impresión de auditoría.
3. **En cada etapa:**
   - Mantener las funciones y protecciones actuales, y respetar la guía de diseño.
   - Sumar pruebas E2E de los flujos nuevos: login, control, corrección, entrega, reposición, mover técnicos de plantilla (uno y varios), compra aprobada y rechazada, eliminar y restaurar, migración del `.txt`, importación del Excel con un archivo de prueba inventado, impresión.
   - Las pruebas existentes tienen que seguir pasando o adaptarse.
   - Un commit por etapa, con un resumen de lo hecho.
4. **Al terminar:**
   - Importar el Excel real desde `privado/` en un entorno local, revisar el informe de inconsistencias y verificar que la impresión de auditoría de varios meses salga correcta y legible.
   - Después, integrar a `main` con mi aprobación, guardar la versión en `versiones/` y actualizar `LEEME.md` y `CLAUDE.md`.
