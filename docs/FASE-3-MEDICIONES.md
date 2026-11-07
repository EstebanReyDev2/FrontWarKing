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
