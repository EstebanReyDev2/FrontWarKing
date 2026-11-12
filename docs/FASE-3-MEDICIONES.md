# Fase 3 — Mediciones de baseline

Fecha: 2026-11-07
Subfase: F3a (infraestructura de sprites, sin tocar el render del juego)

Este documento fija la **baseline del estilo actual** (`?pixel=off`) antes de
cambiar nada del render. Las mediciones de F3b en adelante se comparan contra
esta tabla, con el mismo escenario e instrumentación.

## 1. Equipo y navegador

| Dato | Valor |
| --- | --- |
| CPU | 8 hilos lógicos (`navigator.hardwareConcurrency = 8`) |
| RAM | 16 GB (`navigator.deviceMemory = 16`) |
| GPU | Intel Iris Xe Graphics (integrada), ANGLE D3D11 |
| Renderer WebGL | `ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| Navegador | Chromium 152 (`OpenCode/2.2.5`, Electron 44.9.1) |
| Pantalla | 1366×768, DPR 1 |
| Ventana / viewport | 1366×720 / 800×574 |

No es SwiftShader ni software: `WEBGL_debug_renderer_info` devuelve la Iris Xe
por D3D11, así que la corrida es con aceleración real.

**Limitación de viewport:** el navegador de la app no permite redimensionar la
ventana. Para la fila de 1080p se forzó el canvas a `1920×1080` CSS px dentro
del viewport de 800×574; el framebuffer real medido fue 1920×1080 con DPR 1
(el compositor recorta lo que no entra en la ventana, pero el costo de
rasterizado es el de 1080p). La fila de 800×574 se incluye como referencia de
la ventana real.

## 2. Escenario

Partida singleplayer local, sin red:

- Mapa: **Europe** (`2904×1672` tiles, tamaño normal).
- Jugadores: **1 humano + 20 bots** (`bots: 20`).
- Naciones: **52** (valor por defecto del mapa).
- Modo: FFA, dificultad Easy, aparición aleatoria.
- Sin modificadores (ni oro/tropas infinitos, ni mapa compacto, ni nukes de
  agua, ni reloj del juicio).
- Momento de la medición: entre los 30 s y los 90 s de partida, con población y
  estructuras ya visibles.

## 3. Instrumentación

Todo se midió desde la propia página, con el juego ya renderizando:

- **FPS y frame time:** timestamps de `requestAnimationFrame` durante 5 s
  (301 frames por ventana). Se reporta promedio, p95 y máximo de los deltas.
- **Draw calls:** parche de `WebGL2RenderingContext.prototype` para
  `drawArrays`, `drawElements`, `drawArraysInstanced` y
  `drawElementsInstanced`, instalado **antes** de crear el renderer. Se
  reporta el promedio por frame (`total / frames`).
- **Memoria de texturas:** parche de `texImage2D`, `texStorage2D` y
  `deleteTexture`, identificando cada textura por `TEXTURE_BINDING_2D` para no
  contar dos veces una re-especificación. Bytes = `ancho × alto × bytes/px`,
  con factor 4/3 cuando hay mips.
- **Zoom:** se fijó con las teclas de zoom del juego (`-` / `=`) en lazo
  cerrado leyendo `__webglView.renderer.camera.zoom`, hasta quedar dentro del
  3 % del objetivo. Los valores finales fueron 0.51, 0.98 y 3.90.

El zoom del juego es píxeles CSS por tile; con DPR 1 coincide con
`camera.zoom`.

## 4. Resultados

### 4.1 Canvas forzado a 1920×1080 (DPR 1)

Corrida principal, partida nueva:

| Zoom | FPS | Frame time prom. | p95 | Máx. | Draw calls/frame |
| --- | --- | --- | --- | --- | --- |
| 0.5 | 60.0 | 16.67 ms | 16.8 ms | 17.1 ms | 13.0 |
| 1 | 60.0 | 16.67 ms | 16.8 ms | 17.2 ms | 13.0 |
| 4 | 60.0 | 16.67 ms | 16.8 ms | 17.2 ms | 15.1 |

Corrida de control (otra instancia, mismo escenario):

| Zoom | FPS | p95 | Máx. | Draw calls/frame |
| --- | --- | --- | --- | --- |
| 0.5 | 60.0 | 16.8 ms | 17.4 ms | 16.1 |
| 1 | 60.0 | 16.8 ms | 17.0 ms | 17.1 |
| 4 | 60.0 | 16.8 ms | 18.4 ms | 17.1 |

### 4.2 Viewport real 800×574 (DPR 1)

| Zoom | FPS | Frame time prom. | p95 | Máx. | Draw calls/frame |
| --- | --- | --- | --- | --- | --- |
| 0.5 | 60.0 | 16.67 ms | 16.8 ms | 16.9 ms | 15.7 |
| 1 | 60.0 | 16.67 ms | 16.8 ms | 16.9 ms | 16.1 |
| 4 | 60.0 | 16.67 ms | 16.8 ms | 17.0 ms | 17.7 |

### 4.3 Memoria de texturas

La asignación de texturas ocurre en carga y **no depende del zoom**. Para el
mapa Europe, con la partida ya iniciada:

| Tamaño / formato | Texturas | Total |
| --- | --- | --- |
| 2904×1672 RGBA8 (4 B/px) | 5 | 92.6 MB |
| 2904×1672 RG8 (2 B/px) | 4 | 37.0 MB |
| 2904×1672 R8 (1 B/px) | 3 | 13.9 MB |
| 1024×1024 RGBA8 | 3 | 12.0 MB |
| 1024×4096 RG8 | 1 | 8.0 MB |
| 768×1024 RGBA8 | 2 | 6.0 MB |
| 1280×768 RGBA8 | 1 | 3.8 MB |
| 4096×48 RGBA16F (16 B/px) | 1 | 3.0 MB |
| Resto (atlas, nombres, glifos, 1×1) | 27 | 6.8 MB |
| **Total** | **47** | **183.1 MB** |

De ese total, **143.5 MB son las tres capas del tamaño del mapa**
(2904×1672: 5 RGBA8 + 4 RG8 + 3 R8). El heap de JS en el mismo momento era
122.9 MB (`performance.memory.usedJSHeapSize`).

## 5. Cómo leer estos números

- **60 FPS es el techo de vsync, no el techo del juego.** A 1080p la baseline
  no muestra caídas, pero la tabla no dice cuánto margen sobra. Para F3b la
  comparación válida es frame time p95/máximo y draw calls, no solo FPS.
- **Los draw calls dependen del estado de la partida.** Entre las dos corridas
  el mismo zoom varió entre 13 y 17 (pasadas que se activan según lo visible).
  F3b debe medirse con el mismo escenario, el mismo tiempo de partida y la
  misma instrumentación; una diferencia de ±2 sin cambio de código no es una
  regresión.
- **La memoria es el footprint de asignaciones, no la del driver.** Se calcula
  desde `texImage2D`/`texStorage2D`; no incluye overhead del driver ni
  framebuffers. No se pudo leer `chrome://gpu` desde la página. Sirve para
  comparar F3a contra F3b con el mismo método, no como cifra absoluta de VRAM.
- **El atlas nuevo no está en esta baseline.** En F3a todavía no se sube al
  render del juego; aparecerá recién cuando F3b conecte los sprites.

## 6. Criterio para F3b

Tomado de `docs/FASE-3-DISENO.md` §6.2, contra esta baseline:

| Métrica | Aprobado |
| --- | --- |
| FPS promedio | ≥ 55 en los 3 zooms |
| Frame time p95 | ≤ 20 ms |
| Frame time máximo en régimen | ≤ 50 ms |
| Draw calls | ≤ baseline + 1 en cualquier zoom |
| Memoria de texturas | no aumentar |

## 7. Pendiente para F3b

- Medir carga hasta el primer frame (click en Iniciar → primer frame WebGL).
- Medir stutter al panear (frame time máximo durante un paneo continuo).
- Confirmar que la construcción del atlas entra en ≤ 20 ms.
- Repetir esta tabla con el estilo nuevo y comparar fila por fila.

## 8. F3b — Estructuras con sprites (2026-11-09)

### 8.1 Método

Misma máquina, navegador y ventana que la baseline (§1). Viewport real
**800×574** con DPR 1, que es el tamaño que la app entrega al canvas en esta
máquina; por eso la comparación válida es contra la tabla §4.2 (15.7 / 16.1 /
17.7 draw calls), no contra la de 1080p.

Escenario: singleplayer Europe, 1 humano + 20 bots, 52 naciones, aparición
aleatoria, sin modificadores. Para que ambos estilos miren la misma escena, la
cámara se centró con el `goTo` del propio juego sobre la primera `City` del
mapa (`build-menu.transformHandler`) y después se fijó el zoom con las teclas
`-` / `=` en lazo cerrado (±2 %). Las 52 ciudades existen desde el inicio de
la partida, así que no hace falta esperar a que los bots construyan.

Instrumentación idéntica a §3: deltas de `requestAnimationFrame` durante 5 s
(301 frames) y parche de `WebGL2RenderingContext.prototype` para
`drawArrays`, `drawElements`, `drawArraysInstanced`, `drawElementsInstanced` y
`drawRangeElements`, contando por frame.

### 8.2 Corrida A/B

Corrida A: `?pixel=off` (`StructurePass` clásico). Corrida B: `?pixel=all`
(`PixelStructurePass`). Partidas distintas, mismo escenario.

| Zoom | Estilo | Zoom real | FPS | Frame time prom. | p95 | Máx. | Draw calls/frame |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.5 | off | 0.502 | 60.2 | 16.61 ms | 16.9 ms | 17.3 ms | 15.2 |
| 0.5 | all | 0.494 | 60.1 | 16.64 ms | 16.9 ms | 17.0 ms | 16.0 |
| 1 | off | 1.005 | 60.2 | 16.62 ms | 16.9 ms | 17.0 ms | 17.0 |
| 1 | all | 1.019 | 60.1 | 16.65 ms | 16.9 ms | 17.1 ms | 16.0 |
| 4 | off | 3.935 | 60.2 | 16.62 ms | 16.9 ms | 17.3 ms | 16.8 |
| 4 | all | 3.958 | 60.0 | 16.66 ms | 16.9 ms | 17.0 ms | 16.8 |

A zoom 4 la corrida B tenía 53 estructuras en pantalla (`instanceCount` del
pase). Los draw calls quedan dentro del rango de la baseline de 800×574 y la
diferencia entre estilos es ≤ 0.8, es decir, el pase nuevo no agrega un draw
call neto: reemplaza al clásico (1 vs 1).

### 8.3 LOD y capturas

Capturas tomadas en la partida real (`?pixel=all`, 52 ciudades), cámara
centrada en una ciudad:

| Zoom | Qué se ve |
| --- | --- |
| 0.5 | mapa completo; las estructuras son puntos de color (LOD por debajo de `dotsZoomThreshold = 1.2`). |
| 1 | puntos de color sobre cada ciudad. |
| 2 | sprites de ciudad a tamaño intermedio, con la bandera del jugador dueño. |
| 4 | sprites de ciudad 32×32 nítidos, con el tejado y la bandera en el color del jugador. |

Las capturas se guardaron fuera del repo (son evidencia de la corrida, no
assets): `%TEMP%\opencode-browser-*\0\screenshot.png` de cada pasada. No se
versionan para no romper la regla de "cero archivos de imagen nuevos".

### 8.4 Memoria de texturas

El atlas de sprites nuevo es una textura **16×4096 RGBA8** = **0.25 MB**
(0.14 % de los 183.1 MB de la baseline). La paleta de sprites se arma en CPU a
partir de `paletteData` y se sube a esa misma textura: no hay una textura por
jugador ni un atlas PNG nuevo. El resto del footprint no cambia.

### 8.5 Veredicto

| Métrica | Aprobado | Medido | Resultado |
| --- | --- | --- | --- |
| FPS promedio | ≥ 55 en los 3 zooms | 60.0–60.2 | ✅ |
| Frame time p95 | ≤ 20 ms | 16.9 ms | ✅ |
| Frame time máximo | ≤ 50 ms | 17.4 ms | ✅ |
| Draw calls | ≤ baseline + 1 | 16.0 / 16.0 / 16.8 vs 15.7 / 16.1 / 17.7 | ✅ |
| Memoria de texturas | no aumentar | +0.25 MB (atlas) | ✅ (0.14 %) |

### 8.6 Bug encontrado: el flag se perdía al iniciar partida

`?pixel=off` se leía con `window.location.search` en el constructor del
renderer, pero el flujo de join reescribe la barra de direcciones antes de
crearlo: `updateJoinUrlForShare` (`Main.ts`) deja la URL de invitación sin
query, y el `#refresh` + `pushState` de `handleJoinLobby` deja
`/<game>?live`. Resultado: la partida siempre arrancaba con el estilo pixel
aunque la página hubiera cargado con `?pixel=off`.

Arreglo: `src/client/PixelFlag.ts` captura el search **una sola vez al cargar
el módulo** (`bootSearch`) y tanto `parsePixelStyle()` como
`pixelQuerySuffix()` lo usan por defecto. El módulo vive fuera de `render/` a
propósito: `Main.ts` lo importa estáticamente para armar la URL del juego y la
regla de `tests/LayerBoundaries.test.ts` prohíbe que el homepage arrastre
código del renderer en su primera descarga. El flag viaja además en la URL de
la partida (`?live&pixel=off`) para que un F5 conserve el estilo. Verificado en
runtime:
la URL queda `.../game/<id>?live&pixel=off` y
`structurePass.constructor.name === "StructurePass"`; con `?pixel=all` queda
`?live&pixel=all` y `PixelStructurePass`. Test de regresión en
`tests/client/render/pixel/PixelStyle.test.ts` (reescribe la URL después de
cargar el módulo y comprueba que el flag sobrevive).

## 9. F3c — Unidades con sprites (2026-11-10)

### 9.1 Método

Misma máquina, navegador y ventana que la baseline (§1). Viewport real
**800×574** con DPR 1, así que la comparación válida sigue siendo contra la
tabla §4.2.

Escenario: singleplayer Europe, 1 humano + 20 bots, 95 jugadores en total,
aparición aleatoria, sin modificadores. A diferencia de §8 no alcanza con el
estado inicial: las unidades aparecen y se mueven con el correr de la partida.
Se dejó correr ~6 minutos y recién entonces se midió, con el jugador humano ya
muerto y la sesión en modo espectador. Eso deja **~510 unidades vivas** (luego
~650 al seguir creciendo). En el reparto por slot de esa escena: 354 mercantes,
25 vagones, 13 transportes, 10 locomotoras y 3 acorazados.

Cámara: centrada sobre la primera instancia del `groundBuf` del propio pase,
usando la misma fórmula que `syncCamera` en `ClientGameRunner.ts`
(`offsetX = x - mapWidth/2 - (canvasW - mapWidth)/(2*scale)`, idéntico en Y) para
que `TransformHandler` y el renderer coincidan. No se usó `goTo` porque su
suavizado tarda varios segundos y la escena cambia mientras tanto.

Instrumentación idéntica a §3: deltas de `requestAnimationFrame` y parche de
`WebGL2RenderingContext.prototype` para `drawArrays`, `drawElements`,
`drawArraysInstanced`, `drawElementsInstanced` y `drawRangeElements`, contando
por frame. Ventanas de 3 s (≈180 frames) por fila.

### 9.2 Costo del pase

Primero la medición directa, envolviendo los dos métodos de dibujo del pase y
contando los draw calls GL emitidos dentro de cada uno (31 frames):

| Método del pase | Draw calls por frame |
| --- | --- |
| `drawGround` | 1 (siempre) |
| `drawMissiles` | 1 (siempre) |
| **Total** | **2** |

Es exactamente lo que emite `UnitPass` clásico, que también dibuja en dos
llamadas instanciadas (una de unidades de tierra, una de proyectiles). El pase
pixel **reemplaza** al clásico, no se suma: `Renderer` asigna
`this.unitPass = this.pixelUnitPass`, y sólo uno de los dos existe.

### 9.3 Corrida A/B

Corrida A: `?pixel=units` (`PixelUnitPass`). Corrida B: la misma partida y el
mismo frame con `drawGround`/`drawMissiles` reemplazados por no-ops, que aísla
el costo del pase sin cambiar la escena.

| Zoom | Pase de unidades | Zoom real | FPS | Frame time prom. | p95 | Máx. | Draw calls/frame |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | pixel | 4.000 | 60.0 | 16.66 ms | 16.9 ms | 17.1 ms | 20.7 |
| 1 | pixel | 1.000 | 60.0 | 16.67 ms | 16.8 ms | 16.9 ms | 19.0 |
| 0.5 | pixel | 0.500 | 60.0 | 16.67 ms | 16.8 ms | 17.5 ms | 18.7 |
| 0.2 | pixel | 0.200 | 60.0 | 16.67 ms | 16.9 ms | 16.9 ms | 18.9 |
| 1 | sin pase | 1.000 | 60.0 | 16.67 ms | 16.9 ms | 17.0 ms | 18.8 |

La banda 18.7–20.7 queda por encima de los 15.7–17.7 de §4.2, pero esa
diferencia **no es del pase**: la fila A/B de zoom 1, medida sobre el mismo
frame, da 19.0 con el pase y 18.8 sin él. El resto del desvío lo explica el
estado de la partida —~510 unidades, 6 minutos de juego y las pasadas de
estelas, barras y nombres activas—, que es justo lo que advierte §5: una
diferencia de ±2 sin cambio de código no es una regresión. Los draw calls
además varían solos entre frames (19–21 en la primera corrida).

### 9.4 LOD y capturas

El LOD se decide en el vertex shader con
`spritePx = uUnitSize * uZoom` (`uUnitSize = 16`), en píxeles de dispositivo:
por debajo de 4 px se dibuja un bloque sólido del color del jugador (2×2 si
`spritePx < 2`, 4×4 si no) en vez del sprite. Con DPR 1 eso corta en zoom 0.25.

Capturas en la partida real (`?pixel=units`), cámara centrada en un grupo de
unidades:

| Zoom | Sprite en pantalla | Qué se ve |
| --- | --- | --- |
| 4 | 64 px | sprites 16×16 nítidos, un texel de arte = 4 px de pantalla. Se distinguen mercantes (vela romboidal) y transportes (casco). |
| 1 | 16 px | un texel de arte = 1 px de pantalla, el caso de nitidez exacta. Sprites legibles en todo el ancho del mapa. |
| 0.5 | 8 px | sprites de 8 px: siguen siendo sprites, se leen como siluetas de color. |
| 0.2 | 3.2 px | LOD activo: bloques sólidos de 2×2 del color del jugador, sin atlas. |

Verificado además por diferencia: con `drawGround`/`drawMissiles` en no-op los
sprites desaparecen y el mapa queda sin unidades, o sea que lo que se ve en las
capturas sale del pase pixel y no de una pasada residual.

Las capturas se guardaron fuera del repo (evidencia de la corrida, no assets):
`%TEMP%\opencode-browser-*\0\screenshot.jpeg`. No se versionan para no romper la
regla de "cero archivos de imagen nuevos".

### 9.5 Memoria de texturas

| Recurso | Formato | Tamaño |
| --- | --- | --- |
| Atlas de unidades (12 sprites, 256×256) | R8UI (1 B/px) | 64 KB |
| Paleta de sprites (16×4096) | RGBA8 (4 B/px) | 0.25 MB |
| **Total F3c** | | **0.31 MB** |

0.17 % de los 183.1 MB de la baseline. El atlas es de 256×256 porque los 12
sprites son 16×16 salvo `nuke` (32×32) y `buildAtlas` empaqueta en una grilla
potencia de dos; no hay atlas PNG ni textura por jugador. Con `?pixel=all`
conviven `PixelStructurePass` y `PixelUnitPass` y cada uno arma su propia
paleta, así que ahí la paleta se duplica (+0.25 MB). Es despreciable, pero queda
anotado por si F3e quiere compartirla.

### 9.6 Veredicto

| Métrica | Aprobado | Medido | Resultado |
| --- | --- | --- | --- |
| FPS promedio | ≥ 55 en los zooms medidos | 60.0 | ✅ |
| Frame time p95 | ≤ 20 ms | 16.9 ms | ✅ |
| Frame time máximo | ≤ 50 ms | 17.5 ms | ✅ |
| Draw calls | ≤ baseline + 1 | 2 por frame, igual que el clásico | ✅ |
| Memoria de texturas | no aumentar | +0.31 MB (0.17 %) | ✅ |

### 9.7 Bug encontrado: el shader no compilaba en ANGLE

La primera corrida en el navegador terminó en `¡Error de conexión!` con
`Shader compile error [PixelUnitPass fragment, GPU: ANGLE (Intel, Intel(R)
Iris(R) Xe Graphics ... Direct3D11)]: ERROR: 0:107: ')' : syntax error`.

Causa: una coma final en los argumentos de `clamp(...)` en
`pixel-unit.frag.glsl`. El driver de ANGLE no acepta la coma antes del paréntesis
de cierre aunque GLSL ES 3.00 la tolere en otras posiciones. Se quitó la coma y
el pase compila. Vale como recordatorio: los tests de CPU no tocan la
compilación de shaders, así que un pase nuevo necesita una corrida real en el
navegador antes de darse por cerrado.

## 10. F3d — Terreno pixel art procedural (2026-11-12)

### 10.1 Método

Misma máquina, navegador y ventana que la baseline (§1). Viewport real
**800×574** con DPR 1. Mapa de la sesión: **2000×1000** (el singleplayer por
defecto de esta corrida; no es el Europe de 2904×1672 de §4, así que el número
absoluto no se compara contra los 183.1 MB, sólo contra la corrida de control
del mismo mapa).

Escenario: singleplayer, 1 humano + 20 bots, 52 naciones, aparición aleatoria,
sin modificadores. La partida se dejó correr ~7 minutos hasta que el jugador
humano murió; las capturas y las mediciones son en modo espectador.

A/B con dos pestañas sobre el **mismo tamaño de mapa**:

- **A** `?pixel=off` → `TerrainPass` clásico (textura RGBA8 horneada en CPU).
- **B** `?pixel=all` → `PixelTerrainPass` + `TerrainScatterPass`.

La cámara se fijó con `__webglView.setCameraState(1000, 500, zoom)` en las dos
pestañas, en vez del `goTo` del juego: su suavizado tarda segundos y las
escenas habrían cambiado entre mediciones. Así las dos miran el mismo punto del
mundo al mismo zoom.

- **Memoria de texturas:** mismo método que §3 (parche de `texStorage2D`,
  `texImage2D` y `deleteTexture`, identificando cada textura por
  `TEXTURE_BINDING_2D` y calculando `ancho × alto × bytes/px`). Como el renderer
  ya existía cuando se instaló el parche, se forzó una reconstrucción completa
  llamando a `MapRenderer.handleContextRestored()`, que vuelve a crear todos los
  recursos. Se clasifica el formato leyendo los enums de GL
  (`R8UI` = 1 B/px, `R8` = 1, `R16UI` = 2, `RGBA8` = 4).
- **Draw calls:** parche de `WebGL2RenderingContext.prototype` para
  `drawArrays`, `drawElements`, `drawArraysInstanced`,
  `drawElementsInstanced` y `drawRangeElements`, y además cada pase se aísla
  apagándolo (`settings.passEnabled.terrain = false`) o colapsando sus
  instancias (`scatterPass.instanceCount = 0`).
- **Costo por frame:** 30 frames de `renderer.draw()` seguidos de
  `readPixels(0, 0, 1, 1)` para forzar el sync de GPU; se reporta el promedio.

**FPS y p95 no se pudieron repetir en esta corrida.** En el momento de medir la
ventana del escritorio quedó oculta y Chromium estranguló `requestAnimationFrame`
(0–3 callbacks por ventana de medición), así que un promedio de FPS habría sido
ficción. En su lugar se usa lo que no depende de vsync: draw calls por frame
(§10.2) y costo de frame con sync forzado, medido en las dos pestañas con la
misma escena (§10.3). Las capturas se tomaron antes de que la ventana quedara
oculta.

### 10.2 Draw calls

Cada pase medido por separado, sobre la misma escena y el mismo frame:

| Pase | Zoom < 6 | Zoom ≥ 6 |
| --- | --- | --- |
| `TerrainPass` (clásico) | 1 | 1 |
| `PixelTerrainPass` | 1 | 1 |
| `TerrainScatterPass` | 0 | 1 |
| **Total del bloque de terreno** | **1** | **2** |

Aislamiento en la corrida B: a zoom 4 el frame da 17 draws y 16 con
`passEnabled.terrain = false` (terreno = 1); a zoom 8 da 18, 16 sin terreno y 17
sin instancias de decoración (terreno = 1, decoración = 1); a zoom 1 da 16 con y
sin instancias (decoración = 0, porque `DECOR_MIN_ZOOM = 6` la saltea). En la
corrida A el mismo aislamiento da 12 con terreno y 11 sin él: el clásico también
es 1 draw.

O sea: **+0 draw calls por debajo de zoom 6 y +1 por encima**, que es el margen
que permite el criterio de §6.

### 10.3 Costo por frame (A/B)

Milisegundos por frame, `draw()` + `readPixels(1×1)`, 30 frames, misma cámara y
mismo zoom en las dos pestañas:

| Zoom | Clásico (`?pixel=off`) | Pixel (`?pixel=all`) | Diferencia |
| --- | --- | --- | --- |
| 0.5 | 14.203 ms | 14.160 ms | −0.04 ms |
| 1 | 11.193 ms | 11.137 ms | −0.06 ms |
| 4 | 10.947 ms | 10.967 ms | +0.02 ms |
| 8 | 9.873 ms | 9.863 ms | −0.01 ms |

El valor absoluto está dominado por el stall de `readPixels`, no por el frame:
lo que importa es que **las dos corridas empatan dentro de 0.06 ms** en los
cuatro zooms. El trabajo nuevo del shader (un `texelFetch` de bytes + hash
entero + Bayer por fragmento) no se distingue del costo de muestrear la textura
RGBA8 horneada.

### 10.4 Memoria de texturas

Mismo mapa (2000×1000) en las dos corridas:

| | Clásico | Pixel | Diferencia |
| --- | --- | --- | --- |
| Texturas totales | 33 | 39 | +6 |
| Del tamaño del mapa | 12 (40.06 MB) | 11 (32.43 MB) | −1 textura, **−7.63 MB** |
| Resto (atlas, paletas, glifos) | 10.05 MB | 10.73 MB | +0.68 MB |
| **Total** | **50.11 MB** | **43.17 MB** | **−6.94 MB (−13.9 %)** |

El desglose de las texturas del tamaño del mapa es idéntico salvo una cosa: el
clásico tiene **2 RGBA8** de 7.63 MB y el pixel **1**. Todo el resto coincide
(`3 R16UI` de 3.81, `4 R8UI` de 1.91, `3 R8` de 1.91). La textura R8UI del
byte crudo **ya existía** en el clásico —la comparten las capas de mapa—, así
que el pase pixel no agrega ninguna: sólo desaparece la RGBA8 horneada.

Los 0.68 MB que se suman son dos paletas `16×4096` RGBA8 (0.25 MB cada una,
terreno y decoración no comparten la textura de paleta, igual que en §9) más un
atlas `256×256` R8UI de 0.06 MB con los sprites de decoración.

La cuenta cierra por tile: se eliminan exactamente **4 bytes por tile**
(`mapW × mapH × 4`). En este mapa son 8.0 MB; en el mapa más grande que
menciona el diseño (6000×4428) son **106 MB**, no los ~80 MB que estimaba §4.1
—esa estimación asumía que además había que crear la R8UI, y no hace falta—.

### 10.5 LOD y capturas

El LOD se decide en el fragment shader con `uZoom` (píxeles de dispositivo por
tile, la cámara ya incluye el DPR):

| Zoom | Patrón | Qué se ve |
| --- | --- | --- |
| 4 | 4×4 sub-píxeles por tile | dither Bayer 4×4 por tile, costa con borde de espuma de 1 sub-píxel sobre el agua, transición ordenada arena→pradera→bosque→altiplano→montaña. |
| 1 | 1 color por tile, dither macro | un tile = un píxel de pantalla; la costa y la espuma siguen leyéndose, sin damero plano. |
| 0.5 | 1 color por tile, dither macro | vista general del mapa; el dither macro mantiene la textura sin ensuciar la silueta. |
| 10 | 4×4 + decoración | árboles 2×2, rocas 1×1 y chozas 2×2 sobre el terreno de bosque (612 instancias en este mapa), 1 solo draw call instanciado. |

La decoración sólo se dibuja con `zoom ≥ 6` (`DECOR_MIN_ZOOM`). Verificado por
diferencia: con `scatterPass.instanceCount = 0` el framebuffer cambia a zoom 10
y no cambia a zoom 1.

Las capturas se guardaron fuera del repo (evidencia de la corrida, no assets):
`%TEMP%\opencode-browser-*\0\`. No se versionan, igual que en §8 y §9.

### 10.6 Nuke de agua en vivo

El punto que el diseño marcaba como riesgo: la R8UI se actualiza por rects y el
shader tiene que verlo. Se aplicó `renderer.applyTerrainRects([{ x: 1045, y: 152,
w: 82, h: 58 }], bytes)` con bytes de agua profunda sobre una zona de bosque
visible y se comparó el framebuffer con y sin el pase de decoración:

| Momento | Con decoración | Sin decoración | ¿La decoración cambia el frame? |
| --- | --- | --- | --- |
| Antes | `428324658` | `214747128` | sí |
| Después del nuke | `3185568914` | `3185568914` | **no** |

Y `off` antes ≠ `off` después (`214747128` vs `3185568914`), o sea que el
terreno sí cambió: el bosque pasó a agua y los árboles desaparecieron **sin
reconstruir el buffer de instancias**. El vertex shader relee la R8UI y colapsa
la instancia sobre agua, que es como se diseñó.

### 10.7 Veredicto

| Métrica | Aprobado | Medido | Resultado |
| --- | --- | --- | --- |
| FPS promedio | ≥ 55 en los 3 zooms | no medible (rAF estrangulado, §10.1) | — |
| Frame time p95 | ≤ 20 ms | no medible | — |
| Costo por frame A/B | sin regresión | ±0.06 ms en los 4 zooms | ✅ |
| Draw calls | ≤ baseline + 1 | +0 con zoom < 6, +1 con zoom ≥ 6 | ✅ |
| Memoria de texturas | no aumentar | −6.94 MB (−13.9 %); −4 B/tile | ✅ |
| `?pixel=off` sigue andando | sí | `TerrainPass` activo, 1 draw, frame distinto con y sin terreno | ✅ |

El criterio de FPS queda **sin verificar** en esta corrida por la ventana
oculta. Si hace falta cerrarlo, se repite la tabla de §10.3 con la ventana
visible y `requestAnimationFrame` corriendo; el A/B de costo por frame ya
muestra que no hay trabajo nuevo perceptible.

### 10.8 Bug encontrado: los defines faltaban en el fragment shader

La primera corrida en el navegador murió con
`Shader compile error [PixelTerrainPass fragment, GPU: ANGLE (Intel, Intel(R)
Iris(R) Xe Graphics ... Direct3D11)]: 'MAP_W' : undeclared identifier`.

Causa: `shaderSrc(vert, { MAP_W, MAP_H })` se aplicaba sólo al vertex shader,
pero el fragment usa `MAP_W`/`MAP_H` para el `clamp` del tile. El vertex
compilaba y el link fallaba. Se pasan los mismos defines a los dos shaders.
Mismo recordatorio que §9.7: los tests de CPU no compilan shaders.
