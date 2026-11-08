# Pañol — Guía de diseño para implementar la app

Esta guía describe la estética y el comportamiento de **Pañol**, una app para controlar las herramientas asignadas a cada técnico. Está pensada para que otra sesión la use como referencia al construir la app funcional (React + TypeScript + Tailwind).

El ZIP que acompaña esta guía trae una carpeta `pantallas/` con el HTML de referencia de cada pantalla. Esos archivos usan un formato de diseño con plantillas: `{{variable}}` inserta un dato, `<sc-for>` repite un bloque, `<sc-if>` lo muestra según una condición, y la lógica está en `renderVals()`. **No se ejecutan tal cual.** Sirven para copiar con exactitud la estructura, los estilos en línea, los textos y los datos de ejemplo.

---

## 1. Principios

1. **Mobile first.** El celular es el dispositivo principal: un ancho de 390 px, botones grandes y menú inferior. En computadora se agrega un menú lateral fijo y tablas completas. Es un solo sistema responsive, no dos apps.
2. **Cero fricción.** El estado de una herramienta se marca con un toque. Las notas aparecen solo cuando hacen falta. El botón "Marcar pendientes como Buen estado" resuelve el caso más común en un paso.
3. **Trazabilidad visible.** Cada registro muestra fecha, hora y responsable. Las correcciones nunca borran el registro original, y la interfaz lo muestra (ver Historial).
4. **El estado nunca depende solo del color.** Cada estado lleva siempre ícono + texto + color.
5. **Datos locales.** Todo se guarda en el teléfono: no hay nube ni servidor. Ver la sección 9.
6. **Sin códigos QR.** Cada unidad se identifica con un código de inventario escrito (por ejemplo `HT-0142`) y se busca por nombre o código.

---

## 2. Design tokens

### Colores base

| Token | Hex | Uso |
|---|---|---|
| `bg` | `#F4F5F7` | Fondo de la app |
| `surface` | `#FFFFFF` | Tarjetas, barras, paneles |
| `surface-alt` | `#F9FAFB` | Encabezado de tablas |
| `ink` | `#101828` | Texto principal, botón oscuro, logo |
| `ink-2` | `#344054` | Etiquetas de formulario, texto de botón secundario |
| `muted` | `#5D6676` | Texto secundario (contraste AA sobre blanco y sobre `bg`) |
| `subtle` | `#98A1B0` | Chevrons, puntos neutros (solo decoración) |
| `line` | `#E3E6EB` | Bordes de tarjeta y separadores principales |
| `line-soft` | `#EEF0F3` | Separadores de filas, fondos de barras |
| `field` | `#D0D5DD` | Bordes de inputs y botones secundarios |
| `accent` | `#2447C8` | Acción primaria, selección, enlaces |
| `accent-hover` | `#1A3599` | Hover de enlaces |
| `accent-soft` | `#EEF1FB` | Avatares, chips de tipo, ítem de menú activo |
| `accent-soft-2` | `#F5F7FE` | Fila seleccionada, fondo de opción elegida |

### Colores de estado (los cuatro estados de una herramienta)

| Estado | Texto (`fg`) | Fondo (`bg`) | Borde de selección / línea | Punto / barra |
|---|---|---|---|---|
| **Buen estado** (verde) | `#12703A` | `#E3F5E9` | `#22A559` | `#22A559` |
| **Para cambio** (naranja) | `#A8410A` | `#FFF0E0` | `#F08A24` | `#F08A24` |
| **Faltante** (rojo) | `#B42318` | `#FDE8E7` | `#D92D20` | `#D92D20` (gráficos: `#B42318`) |
| **Pendiente** (gris) | `#4A5261` | `#EEF0F3` | `#D0D5DD` | `#C3C8D1` / `#98A1B0` |

Fondos suaves extra: nota de faltante `#FDF2F1`, nota de cambio `#FFF7EE`, éxito `#F3FBF6` con borde `#9ED8B1`, advertencia con borde `#F7C08A` y texto `#7A2E05`.

Todos los pares de texto sobre fondo cumplen un contraste de 4.5:1 o más. Los tres puntos del semáforo además se distinguen por luminosidad: el naranja es el más claro, el verde queda en el medio y el rojo es el más oscuro.

### Tipografía

- Familia: **Inter** (400, 500, 600, 700) desde Google Fonts, con `system-ui, sans-serif` de respaldo.
- `font-variant-numeric: tabular-nums` en toda la app, para que las cifras queden alineadas.

| Rol | Tamaño / peso |
|---|---|
| Número grande del héroe | 40 px / 700, tracking −0.02em |
| KPI de escritorio | 28 px / 700 |
| KPI de móvil | 22 px / 700 |
| Título de página (escritorio) | 22 px / 700 |
| Título de pantalla (móvil) | 18–20 px / 700 |
| Título de sección | 15–16 px / 600 |
| Cuerpo / ítem de lista | 14–15 px / 500–600 |
| Secundario | 13 px / 400, `muted` |
| Meta / pill / etiqueta | 11–12 px / 600 |
| Encabezado de grupo | 12 px / 600, MAYÚSCULAS, tracking 0.05em, `muted` |

### Espaciado, radios y alturas

- Escala de espaciado: 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 32.
- Margen lateral en móvil: **16 px**. Padding del contenido en escritorio: **24 px vertical / 32 px horizontal**.
- Separación entre tarjetas: 10 px en listas móviles, 12 px en grillas de KPI, 20 px entre bloques de escritorio.
- Radios: tarjeta 16 px · tarjeta grande o héroe 20 px · botón grande 12–14 px · input 10–12 px · pill 999 px · bottom sheet 24 px arriba.
- Alturas táctiles: botón de estado **48 px**, botón principal **52 px**, botón secundario o ícono **44 px**. Nunca menos de 44 px en móvil.
- Sin sombras ni degradados: la jerarquía se arma con bordes de 1 px (`line`) y fondos.

### Íconos

Estilo de trazo tipo Lucide: `viewBox 0 0 24 24`, `stroke-width 2`, `stroke-linecap/linejoin round`, sin relleno, color `currentColor`. Tamaños: 16 en botones, 18–20 en barras, 22 en el menú inferior. Recomendado: el paquete `lucide-react`.

Íconos usados: wrench (logo y "Para cambio"), check (Buen estado), x (Faltante), clipboard-check (Controlar), home, users, arrow-left-right (Entregas), menu, bell, sun / sunset / moon (los tres turnos), alert-triangle, calendar, search, chevron-left/right/down, plus, download, history, pencil, database (copia de seguridad), shield (admin), bar-chart, sliders, package.

---

## 3. Tailwind (sugerido)

```js
// tailwind.config.js → theme.extend
colors: {
  bg: '#F4F5F7', surface: '#FFFFFF', 'surface-alt': '#F9FAFB',
  ink: '#101828', 'ink-2': '#344054', muted: '#5D6676', subtle: '#98A1B0',
  line: '#E3E6EB', 'line-soft': '#EEF0F3', field: '#D0D5DD',
  accent: { DEFAULT: '#2447C8', hover: '#1A3599', soft: '#EEF1FB', soft2: '#F5F7FE' },
  ok:      { fg: '#12703A', bg: '#E3F5E9', line: '#22A559' },
  cambio:  { fg: '#A8410A', bg: '#FFF0E0', line: '#F08A24' },
  falta:   { fg: '#B42318', bg: '#FDE8E7', line: '#D92D20' },
  pend:    { fg: '#4A5261', bg: '#EEF0F3', line: '#C3C8D1' },
},
fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
borderRadius: { card: '16px', hero: '20px', btn: '12px', sheet: '24px' },
```

Breakpoints: el diseño base es para celular. A partir de `lg` (1024 px) aparece el menú lateral fijo de 232 px y el contenido usa grillas `repeat(auto-fit, minmax(170px, 1fr))` para los KPI. Las tablas anchas van dentro de un contenedor con `overflow-x: auto`. En celular, las listas son tarjetas, no tablas.

---

## 4. Componentes

**Botón primario.** Fondo `accent`, texto blanco 15 px/700, alto 52 px (móvil) o 40–44 px (escritorio), radio 12–14 px. Deshabilitado: fondo `line`, texto `muted`, y arriba una línea que explica por qué ("Faltan 4 herramientas por controlar").

**Botón secundario.** Fondo blanco, borde 1 px `field`, texto `ink` 600.

**Botón oscuro.** Fondo `ink`, texto blanco. Se usa para acciones de cierre ("Marcar resuelta", "Registrar reposición").

**Tarjeta.** Fondo `surface`, borde 1 px `line`, radio 16 px, padding 14 px (móvil) o 16–20 px (escritorio).

**KPI.** Tarjeta con: etiqueta 12–13 px (con punto de color si es un estado), valor grande y una línea de contexto ("+7 vs. oct").

**Pill de estado.** Texto 12 px/600, padding 4×10, radio 999, `fg` sobre `bg` del estado. Opcional: punto de 7 px antes del texto.

**Semáforo del técnico.** Punto de 14 px con borde blanco de 2.5 px sobre la esquina del avatar. Rojo si tiene algún faltante, naranja si tiene algo para cambio, gris si está pendiente y verde si está todo bien. Debajo va una barra apilada de 8 px (verde, naranja, rojo) con los conteos al lado.

**Selector de estado (el componente clave).** Grilla de 3 columnas con gap de 6 px y botones de 48 px de alto, cada uno con ícono + texto: "Bueno" (check), "Cambio" (wrench), "Faltante" (x).
- Sin seleccionar: fondo blanco, borde 1 px `field`, texto `ink-2` 500.
- Seleccionado: fondo `bg` del estado, borde **2 px** del color de línea del estado, texto `fg` 700.
- El borde de la tarjeta de la herramienta toma el color de línea del estado elegido.
- Semántica: `role="radiogroup"` / `role="radio"` con `aria-checked`.

**Bloque de nota.** Aparece debajo del selector solo si el estado es Cambio o Faltante.
- Cambio: fondo `#FFF7EE`, etiqueta "Observación (opcional)".
- Faltante: fondo `#FDF2F1`, etiqueta "Motivo del faltante (obligatorio)", borde rojo y mensaje "La nota es obligatoria para registrar un faltante." mientras esté vacía.
- Incluye **chips de frase rápida** (alto 32 px, borde `field`) que completan la nota con un toque.
  - Cambio: No funciona · Cable deteriorado · Carcasa dañada · Desgaste por uso.
  - Faltante: No está en el pañol · Extraviada en el trabajo · Entregada a otro sector · Pendiente de devolución.

**Barra de progreso del control.** Un segmento por herramienta (flex, gap 3 px, 8 px de alto), pintado con el color de su estado o `#DDE1E7` si está pendiente. Debajo, la leyenda con los conteos.

**Pestañas.**
- Control segmentado: fondo `#E6E8EC` con padding 4 px; la pestaña activa es blanca.
- Pills de filtro: la activa es negra (`ink`) con texto blanco.
- Pestañas con subrayado (Administración): línea de 2 px `accent`.

**Menú inferior (móvil).** 5 ítems: Inicio · Turnos · **Controlar** · Entregas · Más. "Controlar" es un botón de 52×52 px en `accent`, radio 16 px y elevado 20 px sobre la barra. El ítem activo usa `accent`; los demás, `muted`.

**Menú lateral (escritorio).** 232 px, blanco con borde derecho. Arriba el logo (cuadrado `ink` de 36 px con wrench) y abajo la tarjeta de usuario. Las 10 secciones llevan un punto de 6 px. La sección activa tiene fondo `accent-soft` y texto `accent` 600. "Control de herramientas" muestra un contador rojo de pendientes.

**Tabla.** Encabezado 12 px/600 en `muted` sobre `surface-alt`, filas con borde inferior `line-soft` y padding 12 px. Las acciones van a la derecha como botones pequeños de 32–34 px.

**Bottom sheet de confirmación.** Overlay `rgba(16,24,40,0.5)`, hoja blanca con radio 24 px arriba y una manija de 40×4 px. Tiene un título, una explicación, tres tarjetas de conteo por estado, la lista Responsable / Fecha y hora / Alertas, y los botones "Revisar" y "Confirmar y guardar". Al confirmar, la misma hoja muestra el éxito: círculo verde con check, código del registro y la acción siguiente ("Siguiente: Valentina Ruiz").

**Calendario semanal.** 4 celdas (Sem 1–4) con rango de fechas y estado.
- Realizado: fondo `#F3FBF6` y borde `#9ED8B1`.
- Incompleto: fondo `#FFF7EE` y borde `#F7C08A`.
- Pendiente: fondo blanco y borde discontinuo.
- Próximo: fondo `#F7F8FA`.

**Avisos.**
- Información: fondo `accent-soft` con texto `#1E3A9E` e ícono history.
- Advertencia de duplicado: fondo `#FFF7EE` con texto `#7A2E05`.

**Chip "Datos de demostración".** 12 px/600 sobre `#E6E8EC`. Se muestra siempre que haya datos de ejemplo cargados.

---

## 5. Pantallas (el archivo de referencia está en `pantallas/`)

### Móvil (390 × 844)

| Archivo | Pantalla | Contenido |
|---|---|---|
| `Login.dc.html` | Ingreso | Logo, usuario, contraseña con mostrar/ocultar, "Mantener la sesión", Ingresar, aviso "Instalá la app". |
| `Main.dc.html` | Inicio | Saludo y semana, campana de alertas. Héroe oscuro "Controles de la semana 18 de 42" con barra y botón "Continuar controles". 3 KPI de estado y 3 KPI generales. Los tres turnos con avance. "Requieren atención". Últimos movimientos. Menú inferior. |
| `Turno.dc.html` | Turno | Resumen (controlados, herramientas, % en condiciones), buscador, filtros Todos / Pendientes / Con novedades y tarjetas de técnico con semáforo. |
| `Control.dc.html` | **Control semanal** | Encabezado con técnico y "Nov · Sem 1". Barra por segmentos. Tarjetas de herramienta con el estado del control anterior y el selector de 3 estados. Notas condicionales. Pie con "Guardar borrador" y "FINALIZAR CONTROL". Hoja de confirmación y de éxito. |
| `Tecnico.dc.html` | Ficha del técnico | Datos y estado Activo, turno actual con "Cambiar turno", conteos por estado, calendario por mes y pestañas Herramientas / Controles (con transiciones del tipo "Buen estado → Faltante") / Movimientos. |
| `CambioTurno.dc.html` | Cambio de turno | Opción de turno (el actual deshabilitado), fecha desde, motivo, bloque "Se conserva todo", confirmación e historial de turnos. |
| `Reposicion.dc.html` | Nuevo movimiento | Tipos (Entrega inicial, Reposición, Adicional, Devolución, Retiro). En Reposición: tarjeta Sale / Entra, pregunta "¿Devolvió la dañada?", código de la unidad nueva y aviso de vinculación. Cantidad con stepper y observaciones. |
| `Alertas.dc.html` | Alertas | Pestañas Abiertas / Resueltas. Cada alerta tiene una acción directa y "Marcar resuelta"; al resolverse guarda quién y cuándo. |
| `Mas.dc.html` | Menú | Tarjeta de usuario y grupos Operación / Gestión / Análisis / Configuración, con **Copia de seguridad**. Cerrar sesión. |

### Escritorio (1440 de ancho, fluido)

| Archivo | Pantalla | Contenido |
|---|---|---|
| `Escritorio.dc.html` | Dashboard | 8 KPI, gráfico de barras de 6 meses (Para cambio en naranja, Faltantes en rojo oscuro), turnos de la semana, tabla de controles pendientes y alertas con "Resolver". |
| `Tecnicos.dc.html` | Técnicos y turnos | 3 tarjetas de turno que también filtran, pestañas por turno, tabla de técnicos (estado de herramientas, último control, Activo/Inactivo, Ficha, Cambiar turno) y panel "Alta de técnico". |
| `Historial.dc.html` | Historial de controles | Selector de mes y matriz técnicos × 4 semanas con estado por celda ("C" marca una corrección). El panel de detalle muestra el registro con sus herramientas, la corrección de auditoría con el valor original tachado y el aviso de duplicado. |
| `Inventario.dc.html` | Inventario general | 6 totales (registradas, asignadas, disponibles, en reparación, retiradas, de baja), buscador con filtros, tabla por unidad y ficha de la unidad con historial. Exportar a Excel y PDF. |
| `Reportes.dc.html` | Reportes | Pestañas Por técnico / Por turno / Por período, filtros, 5 KPI con su variación, tablas y barras. Exportar a Excel y PDF. |
| `Configuracion.dc.html` | Configuración de herramientas | Categorías, tabla de tipos con interruptor Activa, editor (nombre, descripción, unidades individuales con código), y "Asignar a técnico" con cantidad. |
| `Administracion.dc.html` | Administración | Pestañas Usuarios / Roles y permisos / Auditoría. La matriz de permisos tiene las columnas Administrador (bloqueado), Responsable de control y Consulta, con un contador de "cambios sin guardar". |

Navegación móvil: Inicio → Turno → Control → Finalizar. Desde la ficha se llega a Cambio de turno, y desde "Más" al resto de las secciones.

---

## 6. Reglas de comportamiento que el diseño asume

- **Buen estado** no pide nada más. **Cambio** permite una nota opcional. **Faltante** exige una nota y bloquea Finalizar hasta que esté completa.
- **Finalizar** queda deshabilitado mientras haya herramientas sin controlar o faltantes sin nota, y siempre explica el motivo.
- El borrador se puede guardar en cualquier momento; el encabezado muestra "Borrador guardado HH:MM".
- Al finalizar se registran técnico, turno, fecha y hora, responsable, estado y observación de cada herramienta, y se generan alertas por cada Cambio o Faltante.
- Hay un control por técnico, mes y semana (4 por mes). Si ya existe uno, se avisa y el nuevo queda como **corrección** que no reemplaza al original.
- Cambiar de turno conserva las herramientas, los controles y el historial, y registra turno anterior, turno nuevo, fecha y responsable.
- Una reposición vincula la unidad que sale con la que entra. Si no se devolvió la dañada, se crea una alerta de devolución pendiente.
- Cada acción importante queda en **Auditoría** con fecha, hora, responsable y detalle.

---

## 7. Movimiento

Transiciones discretas: 150–200 ms con `ease-out` en el color de fondo y el borde al elegir un estado, y en el cambio de pestaña. El bottom sheet entra deslizándose desde abajo en 220 ms. Hay que respetar `prefers-reduced-motion`.

## 8. Tono de los textos

Español rioplatense con voseo ("Ingresá", "Completá", "Describí el problema"). Frases cortas y concretas. Los botones dicen la acción ("Registrar reposición", "Confirmar cambio a Tarde"). Las fechas van en formato corto ("6 nov 2026 · 14:32").

## 9. Datos: todo en el teléfono

- Sin nube ni backend: la información se guarda en el almacenamiento local del dispositivo (por ejemplo IndexedDB, mediante Dexie o similar) y se pide almacenamiento persistente (`navigator.storage.persist()`).
- La app funciona sin conexión (PWA instalable con service worker).
- **Copia de seguridad** (en Menú): permite exportar todos los datos a un archivo y restaurarlos desde ese archivo. Hace falta para cambiar de teléfono o recuperarse si se borran los datos del navegador.
- Los usuarios, roles y permisos viven en ese mismo teléfono.

## 10. Lo que no lleva

- Códigos QR ni escáner. La identificación es solo con el código de inventario escrito.
- Degradados, sombras decorativas, emojis y tarjetas con borde lateral de color.
