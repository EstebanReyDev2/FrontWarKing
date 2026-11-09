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
