# Fase 3 — Diseño del render pixel art

**Paso 0. Documento de diseño. Sin código, sin commits.**
Estado: propuesta para aprobación. Fecha: 2026-11-06.
Base: `fase-2-red` @ `e4d04690e` (F2-lobby y F2d cerrados).

Reglas que este documento respeta:

- Cero cambios en `packages/engine`, `packages/engine-api`, `packages/engine-lib`,
  `packages/shared/src/WireSchemas.ts`, `packages/shared/src/CosmeticSchemas.ts`
  y `src/server`.
- `PlayerPalette` y `CosmeticVisibility` son zona protegida: la propuesta **no
  depende** de modificarlos (§4.4).
- Cero archivos de imagen nuevos. Sprites y paletas son texto.
- Baseline de tests: 6499/81/1 (86 fallos preexistentes en Windows). No se
  agregan fallos nuevos.

---

## 1. Qué hay hoy, capa por capa

| Capa | Cómo se dibuja hoy | Evidencia | ¿Reemplazable sin lógica de juego? |
| --- | --- | --- | --- |
| Terreno | Un quad de mapa (6 vértices) que muestrea una textura RGBA8 `mapW×mapH` con `NEAREST`. Un texel = un tile, color plano. | `gl/passes/TerrainPass.ts:2-8,66-77,149-159`; `shaders/terrain/terrain.frag.glsl:9-11` | Sí. Es presentación pura. |
| Colores de terreno | Se cuecen en CPU tile por tile (`encodeTerrainTile`) al construir y en cada `setTerrainColors`. | `gl/utils/ColorUtils.ts:102-197`; `TerrainPass.ts:72,97`; `Renderer.ts:1019-1029` | Sí, y conviene: es trabajo de carga evitable. |
| Bytes de terreno | Ya existe una textura R8UI `mapW×mapH` con el byte crudo, compartida por las capas de mapa. | `Renderer.ts:156,288-297,987-994` | Reutilizable tal cual. |
| Territorio | Un quad de mapa. El shader lee el estado R16UI por tile y busca color/patrón/skin en texturas de paleta. | `gl/passes/TerritoryPass.ts:64,133,421-480`; `shaders/map-overlay/territory.frag.glsl:41-45,66-67,93-114` | Sí, pero no hace falta: los colores ya vienen de la paleta. |
| Bordes | `BorderComputePass` calcula una máscara RGBA8 a resolución de mapa (4 vecinos cardinales + relaciones); `BorderStampPass` la pinta como quad. | `BorderComputePass.ts:27-29,96-117`; `border-compute.frag.glsl:13-46`; `BorderStampPass.ts:110-152` | Sí (estética), pero la máscara es de 1 tile: no hay detalle sub-tile que pixelar. |
| Estructuras | Círculo/hexágono/polígono SDF coloreado por jugador + glifo de un atlas PNG de 6 columnas. `LINEAR` + mipmaps. LOD a puntos por zoom. | `StructurePass.ts:5-8,39,49-58,230-231,281-294,370-386`; `shaders/structure/structure.frag.glsl:116-146,163-165`; `structure.vert.glsl:39-49` | Sí. El buffer de instancias y el mapeo tipo→columna no cambian. |
| Unidades | Atlas PNG de 12 columnas de 13 px. El sprite es gris y el shader lo colorea con relleno/borde del jugador leídos de la paleta. Dos draws instanciados. | `UnitPass.ts:16-33,64-90,342-363,395-404,636,646`; `unit.vert.glsl:6-8,48-59`; `unit.frag.glsl:109-110,143-144,218` | Sí. `updateUnits`, interpolación y suavizado de misiles no se tocan. |
| Efectos | `FxSpritePass`: 12 tiras horizontales apiladas en un atlas PNG animado, con frames/duración en TS y tamaños de mundo en JSON. | `FxSpritePass.ts:2-7,22-75,274-312`; `fx-atlas-meta.json` | Sí. Spawn, lifetimes y radios no se tocan. |
| Nombres | Texto MSDF (`msdf-atlas.png` + JSON bajado en runtime). | `name-pass/AtlasData.ts:29-37`; `TextProgram.ts:17`; `WorldTextPass.ts:26` | No se toca. Es texto escalable y traducible. |
| Banderas | `TEXTURE_2D_ARRAY` de 128×85 por capa, `LINEAR` + mipmaps, imágenes del jugador en runtime. | `name-pass/FlagAtlasArray.ts:19-20,91,134` | No se puede: son imágenes del usuario, no sprites nuestros. |
| HUD de ataques | Canvas 2D: `SpriteLoader` carga 10 PNG sueltos y recolorea por gris→color. | `hud/SpriteLoader.ts:6-15,42-78,121-163` | Fuera del alcance de F3 (HUD, no mapa). |

Atlas existentes hoy: `unit-atlas.png` 156×13, `icon-atlas.png` 384×64,
`fx-atlas.png` 540×242 (dimensiones verificadas leyendo IHDR), más
`status-atlas.png` 768×1024, `emoji-atlas.png` 1280×768 y `msdf-atlas.png`
(estos tres son UI, no sprites de mundo).

**Hallazgo:** el generador de los atlas (`generate-sprite-atlases.mjs`, citado en
`UnitPass.ts:16` y `StructurePass.ts:5`) **no existe en el repo**. Los PNG están
pre-hechos y no se pueden regenerar acá. El atlas en runtime no es sólo estética:
elimina esa dependencia rota.

---

## 2. Formato de sprite definitivo

### 2.1 Archivos

- `src/client/render/pixel/sprites/*.txt` — uno por familia: `structures.txt`,
  `units.txt`, `fx.txt`, `world.txt` (decoración).
- `src/client/render/pixel/palettes/*.txt` — `natural.txt` en F3.
- Se importan con `?raw` / `import.meta.glob(..., { query: "?raw" })`, igual que
  los shaders (`gl/shaders/**/*.glsl?raw`). Quedan dentro del bundle: cero
  requests, cero CORS, cero entradas nuevas en el manifiesto de assets, y el
  parser se testea en Node sin DOM. Hay que agregar una declaración
  `declare module "*.txt?raw"` (mismo patrón que
  `gl/vite-env.d.ts:1-3`).

### 2.2 Gramática

```text
# comentario de línea completa
@sprite house              # obligatorio; [a-z0-9_.]+; único en todos los archivos
@size 16 16                # opcional; default 16 16; cuadrado, 16 o 32
@palette natural           # opcional; default "natural"; debe existir
@fps 0                     # opcional; 0 = estático (default); 1..30 si anima
@loop true                 # opcional; default true
@world 1 1                 # opcional; tamaño en tiles para FX; default 1 1
@anchor center             # opcional; center (default) | bottom
@tags structure,city       # opcional; para el dev page y para elegir variante
@variant house             # opcional; hereda size/palette/anchor/fps/tags de otro
@frame 0                   # obligatorio antes de cada cuadro; 0..n-1 consecutivos
........................   # exactamente h líneas de exactamente w caracteres
```

Reglas duras del parser (todas con error que nombra archivo:línea):

- nombre duplicado; `@sprite` sin `@frame`; frame con filas de largo incorrecto o
  cantidad incorrecta; `@frame` fuera de secuencia; `@size` distinto de 16/32.
- carácter que no existe en la paleta declarada.
- `@variant` que apunta a un sprite inexistente o a una cadena de variantes.
- animación: 1 cuadro por defecto; 2 a 4 en el contenido de F3 (el parser admite
  hasta 8 para no bloquear FX futuros).
- CRLF y BOM tolerados; líneas en blanco ignoradas entre frames.

Ejemplo real (16 columnas exactas):

```text
@sprite house
@size 16 16
@frame 0
................
................
.....rrrrrr.....
....rrrrrrrr....
...rrrrrrrrrr...
..rrrrrrrrrrrr..
..aaaaaaaaaaaa..
..aakkaaaakkaa..
..aakkaaaakkaa..
..aaaaaaaaaaaa..
..aaaaabbaaaaa..
..aaaaabbaaaaa..
..aaaaaaaaaaaa..
................
................
................
```

Variantes y animación no agregan sintaxis: son nombres distintos y varios
`@frame`. Ejemplo de FX:

```text
@sprite nuke
@size 32 32
@fps 12
@loop false
@world 60 60
@frame 0
... 32 líneas de 32 caracteres ...
@frame 1
...
```

### 2.3 Por qué caracteres y no colores

Cada carácter es un **índice** de la paleta activa, no un color. El atlas se
sube como `R8UI` (un byte por píxel, valor 0–15; 255 = transparente) y el color
final se resuelve en el shader con un `texelFetch` a una textura de paleta (§4).
Consecuencias:

- Cambiar de paleta o de color de jugador **no reconstruye el atlas**.
- Se puede validar y testear sin GPU (el atlas es un `Uint8Array`).
- No hace falta `OffscreenCanvas`: no aporta nada cuando lo que se sube son
  índices, agrega dependencia del DOM y no se puede ejecutar en los tests. El
  prototipo lo usaba porque horneaba color (`pixel-kit/src/main.ts:18-22`); ese
  enfoque obliga a reconstruir el atlas por civil, que es justo lo que evitamos.

### 2.4 Constructor de atlas

Entrada: sprites parseados + paleta activa. Salida:
`{ indices: Uint8Array, width, height, rects: Map<name, {x,y,w,h,frames}> }`.

- Empaquetado **shelf**: primero los 32×32, después los 16×16; dentro de cada
  grupo, orden por nombre ascendente. Determinista y testeable con snapshot.
- Atlas potencia de dos: 256², 512² o 1024², el menor que entre. Con ~38 sprites
  (6 estructuras + 12 unidades + 12 FX + decoración) el resultado esperado es
  512² = 256 KB. Sin padding: el muestreo es `texelFetch`, no hay sangrado.
- `MAX_TEXTURE_SIZE`: se valida `atlas.width/height <= MAX_TEXTURE_SIZE` **antes**
  de crear la textura, con error claro. No se agrega un requisito nuevo de
  hardware: `initGL` ya exige `>= 4096` por la paleta (`initGL.ts:26-34,68-70`),
  y el atlas es más chico. La textura de paleta nueva (§4) mide 16×4096, que cabe
  exactamente en ese mismo límite.

### 2.5 Dónde vive cada pieza

| Pieza | Archivo nuevo | Se usa desde |
| --- | --- | --- |
| Parser de sprites | `render/pixel/parseSprites.ts` | tests + builder |
| Parser de paletas | `render/pixel/parsePalette.ts` | tests + builder |
| Atlas (packer + índices) | `render/pixel/buildAtlas.ts` | `GPURenderer` |
| Selección de sprite/LOD/frame | `render/pixel/spriteSelect.ts` | passes |
| Upload GL | `render/pixel/uploadPixelAssets.ts` | `GPURenderer` |
| Flag de estilo | `render/pixel/PixelStyle.ts` | `MapRenderer` / `GPURenderer` |

Nada de esto importa `packages/engine`: son funciones puras + WebGL.

---

## 3. Paleta: 16 colores reales

### 3.1 Corrección a la premisa

El prototipo **no** probó dos paletas completas. `base` tiene 16 colores
(`pixel-kit/src/main.ts:7`), pero el estilo “saturado” sólo cambia **un** color
(`g` → `#21bb72`, `main.ts:21`), y el terreno usa además 5 hex fuera de esa
paleta (`main.ts:29`). En total el prototipo usó **21 colores**. Si F3 quiere 16
de verdad, hay que unificar terreno y sprites en la misma tabla.

Propuesta (12 fijos + 3 dinámicos + transparente = 16):

| # | Símbolo | Hex | Rol |
| --- | --- | --- | --- |
| — | `.` | — | transparente |
| 0 | `k` | `#172022` | tinta/sombra |
| 1 | `d` | `#295d77` | agua profunda |
| 2 | `w` | `#4785b5` | agua somera |
| 3 | `s` | `#c9b98a` | arena |
| 4 | `g` | `#70844b` | pradera |
| 5 | `f` | `#356346` | bosque |
| 6 | `h` | `#999b91` | altiplano/piedra |
| 7 | `m` | `#e8e3d9` | montaña/espuma/nieve |
| 8 | `b` | `#49372c` | madera |
| 9 | `r` | `#a54e3f` | ladrillo/teja |
| 10 | `a` | `#d8c49a` | revoque |
| 11 | `y` | `#e0bd57` | oro |
| 12 | `P` | `@player-fill` | relleno del jugador |
| 13 | `B` | `@player-border` | borde del jugador |
| 14 | `C` | `@player-accent` | acento (borde aclarado en F3; color de civil en F7) |

Formato del archivo de paleta:

```text
# natural.txt — 16 slots exactos
.  -          transparent
k  #172022    ink
d  #295d77    water-deep
w  #4785b5    water-shallow
s  #c9b98a    sand
g  #70844b    grass
f  #356346    forest
h  #999b91    highland
m  #e8e3d9    mountain
b  #49372c    wood
r  #a54e3f    brick
a  #d8c49a    plaster
y  #e0bd57    gold
P  @player-fill
B  @player-border
C  @player-accent
```

Validaciones: 16 líneas, símbolos únicos, exactamente un transparente,
exactamente tres roles `@player-*` (distintos). Cambiar de paleta = otro archivo
con los **mismos símbolos** y otros hex; los `.txt` de sprites no se tocan. Eso
es la “paleta intercambiable” verificable por test.

La decisión de arte ya tomada se cumple: terreno con tonos naturales; lo
saturado entra por los slots dinámicos, que son los colores del tema del jugador
(`resolvePlayerColors`), no por el terreno.

### 3.2 Color por jugador y por civilización

Una sola textura nueva: `RGBA8` de 16×4096 (256 KB), `NEAREST`, fila por
`smallID`.

- Fila 0 = paleta del mundo: los 12 fijos + 3 dinámicos con un valor neutro. La
  usa el terreno.
- Filas 1..4095 = paleta de cada jugador: los 12 fijos iguales, y
  `P/B/C` resueltos desde `paletteData` (la textura que ya existe).
- Construcción: cuando `Renderer.updatePalette(paletteData)` corre
  (`Renderer.ts:722-746`), se recalculan todas las filas desde los pares
  relleno/borde que ya están en `paletteData` (`PlayerPalette.ts:73-92`). 65.536
  escrituras como máximo, una vez por cambio de paleta (jugador nuevo, tema,
  replay), no por frame.
- Civilización: en F3 no existe concepto de civ (es F7). El slot `C` queda
  reservado y hoy vale “borde aclarado”. Cuando F7 agregue civ, se llena con el
  color de la civ sin cambiar ni el atlas ni los shaders.

Ventaja fuerte: el estilo nuevo es **función pura** de datos que el renderer ya
recibe (`paletteData`, bytes de terreno, unidades/estructuras). No requiere
ningún campo nuevo en el wire ni en `CosmeticSchemas`.

### 3.3 Cómo lo leen los shaders

```glsl
uint idx = texelFetch(uSpriteAtlas, cellOrigin + pixelCoord, 0).r;
if (idx > 15u) discard;
vec4 color = texelFetch(uSpritePalette, ivec2(int(idx), ownerSmallID), 0);
```

`texelFetch` con coordenadas enteras: sin filtrado, sin sangrado, sin mipmaps.
El píxel del sprite siempre es un rectángulo duro, aunque el zoom sea
fraccionario.

### 3.4 Zona protegida: qué habría que cambiar y por qué no lo hacemos

**`PlayerPalette`** (`gl/utils/PlayerPalette.ts`). Si en vez de un módulo nuevo
se lo extendiera, habría que: (a) agregar una tercera fila por jugador con 16
slots —la textura pasaría de 4096×2 a 4096×(2+16)—, (b) tocar todos los shaders
que indexan filas (`territory.frag.glsl:67`, `unit.frag.glsl:143`,
`structure.frag.glsl:163`), (c) llenar esa fila desde `WebGLFrameBuilder`,
`ReplayPalette` y sus tests. Es un cambio de contrato compartido por vivo y
replay, para un dato que se puede **derivar** de lo que ya se escribe. Por eso:
módulo nuevo `render/pixel/SpritePalette.ts` que lee `paletteData`, y
`PlayerPalette` queda intacto.

**`CosmeticVisibility`** (`src/client/view/CosmeticVisibility.ts`). Habría que
agregarle una categoría `sprites` para permitir “ocultar sprites ajenos”, o para
elegir estilo por jugador. No hace falta: el pixel art es el render base, no un
cosmético. La visibilidad de cosméticos existente (skins, patrones, banderas,
coronas) sigue exactamente igual.

Ninguna de las dos se toca en F3. Si más adelante se quisiera un cosmético
“sprite”, ahí sí hay que aprobarlo aparte.

---

## 4. Terreno pixelado

### 4.1 El cambio de fondo

Hoy el terreno es una textura RGBA8 de `mapW×mapH` horneada en CPU. En el mapa
más grande (6000×4428) eso son **106 MB de GPU** y un recorrido de 26,5 M de
tiles en cada rebake (`ColorUtils.ts:186-196`, `TerrainPass.ts:72,97`). Al mismo
tiempo el renderer **ya tiene** el byte crudo en una textura R8UI de 26,5 MB
(`Renderer.ts:288-297`) que usan las capas de mapa y que se actualiza en los
positivos de agua (`Renderer.ts:987-994`).

Propuesta: `PixelTerrainPass` muestrea la R8UI y calcula el color en el shader.
Gana detalle sub-tile y **baja** 80 MB de GPU y el costo de carga. `rebuildTerrain`
deja de re-hornear: sólo cambia la paleta (`Renderer.ts:1019-1029`).

Plan B (si preferís no tocar el path de terreno): mantener la textura horneada y
agregar sólo una pasada de decoración instanciada. Es menos riesgo, pero no hay
detalle sub-tile y se conservan los 106 MB y el costo de carga.

### 4.2 Variación determinista

El shader no inventa terreno: lee el byte del engine y deriva **presentación**.

```glsl
uint b = texelFetch(uTerrainBytes, tile, 0).r;   // bit7 land, bit6 shore, bits0-4 magnitud
uint h = hashU(tile.x, tile.y, uSeed);           // hash entero uvec, no fract(sin())
```

- `hashU` es aritmética `uint` de 32 bits (exacta en GLSL ES 3.0), no
  `fract(sin(...))`: el mismo tile da el mismo valor en cualquier GPU.
- `uSeed` es una **constante de proyecto** (`0x46574b53`, "FWKS"). No se deriva
  del engine ni del turno: el estilo no puede afectar la simulación y no debe
  cambiar entre clientes ni entre vivo/replay.
- Cada tile elige entre dos slots adyacentes de la paleta con una matriz de
  Bayer 4×4 + el hash (dither ordenado). Resultado: textura de 4×4 “píxeles” por
  tile, sin memoria extra y sin ruido de alta frecuencia que vibre al mover la
  cámara.
- La decoración (árboles, rocas, chozas) no va en el shader: es una pasada
  instanciada `TerrainScatterPass` con posiciones derivadas del mismo hash y
  filtradas por `isLand` + no-impassable. Se construye **una vez por mapa**
  (~2.000 instancias, 32 KB) y se dibuja con un draw. Sólo aparece por encima de
  un zoom mínimo (como el prototipo, `pixel-kit/src/main.ts:29`).
- Impassable: se conserva exactamente el comportamiento actual (color de fondo =
  `clearColor`), documentado en `ColorUtils.ts:83-91,131-135` y
  `Renderer.ts:1340-1344`. Es lo que hace que el mapa no se vea rectangular.

### 4.3 Costa y transiciones

- El bit `isShoreline` ya viene del engine (`ColorUtils.ts:115-117`). No se
  recalcula ni se “mejora” en el render: es dato de juego.
- Espuma: un borde de 1 sub-píxel sobre el tile de costa, detectando agua en los
  4 vecinos desde la R8UI. Es presentación, no regla.
- Transición tierra/adentro: dither entre `s`/`g` y `g`/`f` según magnitud. Nada
  de blending bilineal.

### 4.4 Lo que NO cambia

`TerritoryPass`, `BorderComputePass` y `BorderStampPass` siguen leyendo el estado
de tile. El territorio se pinta **encima** del terreno con alpha 150/255
(`PlayerPalette.ts:38`), así que el patrón de terreno se sigue viendo teñido. La
legibilidad territorial no depende de que el terreno sea plano; depende de que el
borde sea claro, y eso ya está resuelto.

---

## 5. Zoom y cámara

- Se mantiene el rango 0.2–20 y el zoom continuo (`Camera.ts:20-21,134-142`). No
  se hace snapping de cámara: rompería el pan y la matemática de input
  (`Camera.ts:188-199`).
- Nitidez: cada pass que use sprites calcula `pixel = floor(vLocal * size)` y
  hace `texelFetch`. Aunque el quad mida 37,4 px, los píxeles del sprite son
  bloques duros; a escalas fraccionarias algunas filas salen de 1 px y otras de
  2 (es lo que hace el pixel art con escala no entera). No hay interpolación ni
  mipmaps.
- Niveles de detalle (uniformes, sin branches costosos):
  - Terreno: patrón 4×4 si `zoom * dpr >= 4`; si no, color plano por tile con
    dither macro (1 píxel por tile).
  - Decoración: se dibuja sólo si `zoom * dpr >= 6`.
  - Estructuras: se conserva el LOD actual (punto por debajo de
    `dotsZoomThreshold = 1.2`, crecimiento por encima de `iconGrowZoom = 7`;
    `render-settings.json:124-129`, `structure.vert.glsl:39-49`).
  - Unidades: si el sprite mide menos de 4 px en pantalla, se dibuja una
    silueta de 2×2 o directamente el punto de color del jugador; nunca un
    sprite de 16×16 comprimido a 3 px (eso vibra al mover).
- DPR tope 2 (`utils/Dpr.ts:14-16`): se mantiene. No se toca el canvas.

---

## 6. Rendimiento

### 6.1 Qué se mide y con qué

- Chromium **con aceleración real** (no headless, no SwiftShader). Verificación:
  `readRenderer` no debe matchear `/swiftshader|llvmpipe|software/i`
  (`initGL.ts:37`) y `chrome://gpu` debe decir “Hardware accelerated”.
- Escenario: 1920×1080, DPR 1 (y una corrida extra a DPR 2), mapa curado de
  tamaño normal, partida con 20 jugadores y población visible (unidades +
  estructuras). Tres zooms: **0.5** (vista general), **1** (juego normal),
  **4** (detalle).
- Instrumentos: `requestAnimationFrame` para FPS/p95; DevTools Performance para
  frame time y allocations; Spector.js para draw calls; memoria de GPU por
  `chrome://gpu`.
- El resultado se guarda en `docs/FASE-3-MEDICIONES.md` (tabla por subfase) para
  comparar contra el estilo anterior con `?pixel=off`.

### 6.2 Criterio de aprobado

Se fija en F3a midiendo la baseline en la máquina más modesta de la oficina
(integrada, 8 GB, 1080p). A partir de ahí:

| Métrica | Aprobado |
| --- | --- |
| FPS promedio | ≥ 55 en los 3 zooms, y nunca por debajo de la baseline − 5% |
| Frame time p95 | ≤ 20 ms |
| Frame time máximo en régimen | ≤ 50 ms (sin stutter al panear) |
| Carga hasta el primer frame | ≤ baseline + 100 ms |
| Construcción del atlas | ≤ 20 ms |
| GC en régimen | 0 colecciones mayores en 20 s a zoom 1 |
| Draw calls | ≤ baseline + 1 en cualquier zoom |
| Memoria GPU | no aumentar; el terreno debería bajar ~80 MB en el mapa grande |

Si no se cumple: primero se apaga la decoración por zoom, después se baja el
atlas a 256², y recién entonces se evalúa volver al path viejo de estructuras.

### 6.3 Por qué el presupuesto es alcanzable

- No hay draw por tile ni por sprite: terreno, territorio y bordes ya son quads;
  unidades/estructuras/FX ya son instanciados (`UnitPass.ts:636,646`,
  `StructurePass.ts:431-482`). El estilo nuevo **no agrega draws** salvo la
  decoración (+1).
- El costo nuevo es 2 `texelFetch` por fragmento de sprite (índice + paleta) y
  un hash entero + 4 vecinos por fragmento de terreno. A 1080p es marginal
  frente a los shaders actuales de territorio/bordes.
- Se elimina trabajo de CPU en carga (bake de 26,5 M tiles) y se eliminan 3
  requests de atlas PNG.

---

## 7. Replays y visor

Los replays usan **el mismo** `MapRenderer` y el mismo constructor
(`ReplayViewer.ts:566-582`), con los bytes de terreno y la paleta resueltos por
`ReplayPalette` (`ReplayPalette.ts:44-90`). Consecuencias:

- El estilo nuevo aparece solo en replays, sin tocar `ReplayFrameBuilder`,
  `ReplayViewer` ni `ReplayPalette`.
- La fila de paleta de sprites se construye desde `paletteData` dentro del
  `Renderer`, así que el visor de replay no necesita saber que existe.
- La decoración determinista usa la constante de proyecto, no el turno: el mismo
  mapa se ve igual al inicio y al final del replay.
- El flag `?pixel=off` debe funcionar también en el visor (es el mismo bundle) y
  es parte del criterio de aceptación de cada subfase.

Riesgo específico: un replay viejo no guarda nada de estilo (bien: el estilo no
está en el archivo). Si en el futuro se quiere “ver el replay como se jugó”, eso
sería otra decisión y otro campo; hoy no existe y no se agrega.

---

## 8. Tests

### 8.1 Qué cubre hoy el render

| Test | Qué cubre |
| --- | --- |
| `tests/client/render/gl/UnitPassSmoothing.test.ts` | Suavizado de misiles y `flickerHashByte`; instancia `UnitPass` por prototipo y stubea GL. |
| `tests/client/MapRendererContextLoss.test.ts` | Pérdida/restauración de contexto y `dispose`; mockea `GPURenderer`. |
| `tests/client/render/frame/TrailManager.test.ts` | Filas sucias de la textura de trails. |
| `tests/client/render/frame/derive/terrain-row-spans.test.ts` | Rects de terreno para subidas delta. |
| `tests/WebGLFrameBuilder.cosmetics.test.ts` | Escritura de paleta/efectos/cosméticos con view stubbeada. |
| `tests/WebGLFrameBuilder.effectOverrides.test.ts` | Overrides de efectos. |
| `tests/WebGLFrameBuilder.explosionParams.test.ts` | Parámetros de explosión. |
| `tests/GlUtils.test.ts` | Compilación/link de programas y errores de contexto. |
| `tests/AssetUrls.test.ts` | Resolución de URLs de assets. |
| `tests/client/graphics/SpriteLoaderError.test.ts` | Error claro si falta un sprite del HUD. |
| `tests/client/graphics/GameRendererCreate.test.ts` | Creación del renderer de juego. |

No hay tests directos de `TerrainPass`, `TerritoryPass` ni de los shaders de
borde.

### 8.2 Qué se puede romper y cómo se evita

| Riesgo | Test afectado | Mitigación |
| --- | --- | --- |
| Cambiar el layout de instancias de unidades | `UnitPassSmoothing` (usa `missileBuf`, `smoothSegs`, `tickIntervalMs`) | El layout actual usa 3 bytes de los 4 del último float (`UnitPass.ts:109-126`): `spriteId` en el byte 12, `flags` 13, `flickerHash` 14 y **el byte 15 queda libre para `frame`**. Cero cambio de layout. |
| Tocar la escritura de paleta | `WebGLFrameBuilder.*` | No se toca `PlayerPalette` ni `WebGLFrameBuilder`; el módulo nuevo sólo lee `paletteData`. |
| Texturas nuevas sin recrear en context loss | `MapRendererContextLoss` | Todo recurso nuevo se crea dentro de `GPURenderer`, que ya se reconstruye entero (`MapRenderer.ts` + test). |
| Importar engine desde el render | `LayerBoundaries` | Los archivos nuevos viven en `src/client/render/pixel/` y no importan `@openfront/engine*`. |
| Cambiar flags de assets | `AssetUrls` | No se agregan assets al manifiesto: los `.txt` son `?raw` del bundle. |

### 8.3 Tests nuevos (sin WebGL real)

1. `pixel/parseSprites.test.ts` — válidos, CRLF/BOM, comentarios; errores:
   dimensiones, cantidad de filas, frame fuera de orden, nombre duplicado,
   carácter fuera de paleta, `@variant` inexistente.
2. `pixel/parsePalette.test.ts` — 16 slots, símbolos únicos, un transparente,
   tres roles dinámicos, dos paletas con los mismos símbolos.
3. `pixel/buildAtlas.test.ts` — determinismo (snapshot de rects), sin
   solapamiento, potencia de dos, 32×32 antes que 16×16, cada frame en su celda,
   `.` = 255.
4. `pixel/spriteSelect.test.ts` — hash determinista (mismos valores en dos
   corridas), distribución razonable sobre 10.000 tiles, selección de LOD por
   zoom, frame por tiempo (loop y no-loop), variantes por tag.
5. `pixel/spritePalette.test.ts` — filas derivadas de `paletteData`: relleno,
   borde, acento; fila 0 neutra; independencia entre `smallID`.
6. `pixel/uploadPixelAssets.test.ts` — con GL stubbeado (mismo patrón que
   `UnitPassSmoothing.test.ts:24-58`): formato `R8UI`/`RED_INTEGER`, `NEAREST`,
   `CLAMP_TO_EDGE`, dimensiones, `deleteTexture`, error si el atlas supera
   `MAX_TEXTURE_SIZE`.
7. `pixel/PixelStyle.test.ts` — parseo de `?pixel=off|all|<lista>`, default y
   compatibilidad con `?lobby-preview`/`?realtime-dev`.

Cierre de cada bloque: `oxfmt`, `tsc --noEmit`, `vitest run` **dos veces** y
comparación **por nombre** contra `docs/baseline-failures.txt` +
`docs/baseline-flaky.txt`. Los 86 fallos preexistentes no se tocan.

---

## 9. Plan en subfases

Ajuste sobre la propuesta original: separo estructuras y unidades en dos
subfases. Motivo: son 6 sprites contra 12, y el pipeline de sprites se valida
primero con el caso más chico y con un LOD que ya existe
(`StructurePass.ts:5-8`). Un commit por subfase, capturas en tres zooms + FPS,
revisión tuya antes de seguir.

### F3a — Infraestructura (sin tocar el render principal)

- `parseSprites`, `parsePalette`, `buildAtlas`, `spriteSelect`,
  `SpritePalette`, `PixelStyle` + tests.
- `?pixel-dev`: página de desarrollo montada como `RealtimeDev`
  (`RealtimeDev.ts:22-26`) y ruteada antes del auth (`RouteMode.ts:1-3`,
  `Main.ts:225`). Muestra paleta, sprites a 1×/2×/4×, animación, las tres filas
  de color de jugador y un slider de zoom con LOD. Canvas 2D con
  `imageSmoothingEnabled = false` (como `pixel-kit/src/main.ts:18`).
- 3 sprites de prueba (uno estático, uno de 4 frames, una variante) para ejercer
  el formato.
- Baseline de rendimiento en `docs/FASE-3-MEDICIONES.md`.
- El juego no cambia: la bandera todavía no está conectada a ningún pass.

### F3b — Estructuras

- `PixelStructurePass` (o programa alternativo en `StructurePass`) con sprites
  indexados; se conserva el LOD de puntos y el buffer de instancias.
- Los 6 sprites: ciudad, puerto, fábrica, puesto de defensa, SAM, silo.
- Bandera `?pixel=off` para A/B en la misma sesión.
- Criterio: mismo comportamiento de zoom/hover/construcción/borrado; capturas
  en 0.5/1/4.

### F3c — Unidades

- Atlas de unidades por índice + `frame` en el byte libre; se conserva
  interpolación, suavizado de misiles, glow de la bomba H y tintes de flota/tren.
- Los 12 sprites (3 barcos, 3 bombas, 3 misiles/proyectiles, 3 partes de tren).
- LOD: silueta/punto por debajo de 4 px de tamaño en pantalla.
- Criterio: `UnitPassSmoothing` sigue pasando sin cambios.

### F3d — Terreno, costa y decoración

- `PixelTerrainPass` sobre la R8UI (o plan B si no se aprueba), dither 4×4,
  espuma, impassable.
- `TerrainScatterPass` (1 draw, posiciones por hash, sólo tierra no-impassable).
- Se elimina el bake RGBA8 del terreno y su CPU.
- Criterio: los positivos de agua siguen actualizando el terreno; mapa grande sin
  artefactos; −80 MB medidos.

### F3e — Color de jugador y efectos

- Fila de paleta por jugador desde `paletteData` (estructuras y unidades usan
  `P/B/C`).
- FX: atlas de texto para las 12 animaciones (nuke 32×32 ×4, el resto 16×16
  ×2–4), con `@world`/`@fps` reemplazando `fx-atlas-meta.json`.
- Se mantienen trails, railroads, fallout, anillos y telegráficos (son shaders,
  no sprites) para no ampliar el alcance.

### F3f — Rendimiento, limpieza y comparación

- Tabla final de FPS/carga/draw calls contra `?pixel=off` (que se elimina acá).
- Borrado del código viejo y de los assets que queden sin uso:
  `resources/atlases/unit-atlas.png`, `icon-atlas.png`, `fx-atlas.png`,
  `fx-atlas-meta.json`, y los `resources/sprites/*.png` que sólo alimentaban esos
  atlas. **No** se borran `emoji/status/msdf` (UI), ni las banderas (red), ni los
  `resources/sprites` que usa el HUD (`hud/SpriteLoader.ts:6-15`), salvo que en
  F3g se porte el HUD.
- Medición del peso del build (hoy ~675 MB, con 613,86 MB de mapas y 78,20 MB de
  los 16 mapas curados).
- Cierre de fase: dos corridas completas + comparación por nombre.

### F3g — Opcional: skin de interfaz

Fuente pixel y tokens de color en HUD/modales, sin tocar lógica. Se decide
después de ver F3f. No entra en el presupuesto de F3 salvo que lo pidas.

---

## 10. Riesgos

| Riesgo | Impacto | Mitigación |
| --- | --- | --- |
| Zoom fraccionario → filas de 1/2 px | Estética irregular | `texelFetch` + LOD; se acepta la irregularidad clásica; capturas en 3 zooms para que lo veas |
| Terreno nuevo rompe el update de agua (nuke) | Mapa desincronizado visualmente | La R8UI ya es la fuente que actualizan los nukes; test de rects existente + prueba manual con nuke |
| Atlas de estructuras sin mipmaps vibra al alejar | Peor lectura que hoy | El LOD de puntos ya existe y se dispara a 1.2; validar en zoom 0.5 |
| El mapa China tiene una capa de agua (labels) | El terreno pixel se ve debajo | Es contenido, no estilo; la capa sigue igual. Sólo afecta agua, no tierra |
| Banderas y nombres siguen “no pixel” | Inconsistencia visual | Aceptado explícitamente: son datos del usuario y texto escalable. F3g puede acercar la UI |
| Dos paths (viejo/nuevo) divergen | Bugs arreglados en uno solo | La bandera elige **clase/programa** en el constructor, no ifs dispersos; se borra al final de la fase |
| Costo de mantener 16 colores reales | Menos libertad artística | Es la decisión de arte; el dither y los slots dinámicos dan variedad sin salir de 16 |
| `?pixel=off` se olvida en producción | Estilo viejo visible | Sólo existe hasta F3f; F3f lo elimina junto con el código viejo |

**Archivos protegidos que se tocarían: ninguno.** El diseño no necesita
`packages/engine*`, `WireSchemas`, `CosmeticSchemas`, `src/server`,
`PlayerPalette` ni `CosmeticVisibility`.

---

## 11. Correcciones a las premisas del pedido

1. **`docs/DECISIONES.md` no existe.** `AGENTS.md` lo menciona, pero el archivo
   no está en el repo. No lo creo en este paso; decime si querés que lo genere.
2. **El prototipo no probó dos paletas de 16.** El “saturado” sólo cambia el
   verde de vegetación (`pixel-kit/src/main.ts:21`) y el terreno usa 5 hex extra
   (`:29`): 21 colores en total. Unificar a 16 es una decisión nueva.
3. **El prototipo hornea color en el atlas por civil** (`main.ts:18-22`), lo que
   obliga a reconstruirlo al cambiar de civ. Por eso el diseño usa índices +
   textura de paleta.
4. **El terreno ya es `NEAREST`** (`TerrainPass.ts:66-74`): el problema no es el
   filtro, es que cada tile es un color plano y que el bake cuesta 106 MB / 26,5 M
   de tiles.
5. **La única pasada que hoy no es pixel-nítida es estructuras** (`LINEAR` +
   mipmaps, `StructurePass.ts:230-231,288-294`).
6. **No existe el script que genera los atlas** (`generate-sprite-atlases.mjs`):
   los PNG actuales no se pueden reconstruir desde el repo.
7. **Las banderas no se pueden pixelar**: son imágenes del jugador en runtime
   (`FlagAtlasArray.ts:19-20`).

---

## 12. Aprobación

Si aprobás, el orden de trabajo es F3a → F3b → F3c → F3d → F3e → F3f, un commit
por subfase, con capturas y FPS antes de avanzar. F3g queda opcional.

**Una sola decisión de fondo antes de empezar:** ¿confirmás que unifiquemos a 16
colores reales (12 fijos + 3 dinámicos + transparente), sabiendo que el
prototipo usaba 21 y que el terreno y los sprites van a compartir slots? Es la
base de todo el resto: si preferís 21 (o “16 para sprites + paleta aparte para
terreno”), cambia el formato de paleta y los tests, no el resto del plan.
