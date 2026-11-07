# Decisiones de FrontWars

Registro corto de decisiones de diseño y arquitectura que no son obvias leyendo
el código. Cada entrada dice qué se decidió, por qué, y qué consecuencias tiene
para las fases siguientes.

---

## D-001 — Paleta de 16 colores reales

- **Estado:** aceptada.
- **Fecha:** 2026-11-06.
- **Fase:** F3 (render pixel art), implementada desde F3a.
- **Fuente:** `docs/FASE-3-DISENO.md` §3.

### Contexto

El prototipo `../openfront-spikes/pixel-kit` parecía usar 16 colores, pero en
la práctica usaba **21**:

- 16 colores en `base` (`pixel-kit/src/main.ts:7`);
- 5 hexadecimales de terreno fuera de esa tabla (`pixel-kit/src/main.ts:29`);
- el estilo "saturado" sólo cambiaba el verde de vegetación `g`
  (`pixel-kit/src/main.ts:21`).

Eso no alcanza para decir que el arte está unificado: terreno y sprites tenían
tablas distintas.

### Decisión

Una única paleta de **16 slots**:

- **12 colores fijos** compartidos por terreno y sprites:
  `k`, `d`, `w`, `s`, `g`, `f`, `h`, `m`, `b`, `r`, `a`, `y`.
- **3 slots dinámicos** de jugador:
  `P` (`player-fill`), `B` (`player-border`), `C` (`player-accent`).
- **1 slot transparente** (`.`), que en el atlas vale `255` y nunca se muestrea.

Los sprites se guardan como **índices de paleta** en un atlas `R8UI` (un byte
por píxel). El color final se resuelve en el shader con un `texelFetch` a una
textura de paleta de 16 columnas. Cambiar de paleta o de color de jugador no
reconstruye el atlas.

Los 12 fijos viven en `src/client/render/pixel/palettes/natural.txt`; los 3
dinámicos se derivan de `paletteData` (relleno y borde del jugador; el acento es
el borde aclarado) en `src/client/render/pixel/SpritePalette.ts`. Ni
`PlayerPalette` ni `CosmeticVisibility` se modifican.

### Justificación

> 16 colores fuerzan coherencia estética y permiten el formato R8UI; 21 obligaba
> a R16UI y duplicar el atlas.

En concreto:

- `R8UI` es una textura de un byte por píxel, con índices `0..15` y `255` para
  transparencia. Con 21 colores haría falta `R16UI` (dos bytes por píxel), el
  atlas duplicaría su tamaño en GPU y el shader cambiaría de tipo de muestreo.
- Compartir los 12 fijos entre terreno y sprites evita dos tablas de arte que se
  desincronizan; el terreno entra por los mismos slots en F3d.
- Los 3 slots dinámicos son los únicos que dependen del jugador, así que el
  atlas es idéntico para todos los clientes y para los replays. No hay que
  reconstruirlo por civil ni por tema.
- Un presupuesto fijo de 16 colores es una restricción artística deliberada:
  obliga a resolver profundidad con dither y siluetas, no con degradados.

### Consecuencias

- El formato de sprite sólo puede usar símbolos declarados en la paleta; un
  carácter fuera de tabla es un error de parseo (`parseSprites`).
- El atlas se sube como `R8UI` / `RED_INTEGER` / `UNSIGNED_BYTE`; la paleta como
  `RGBA8` de `16 x 4096` (una fila por `smallID`, fila 0 = mundo).
- F7 (civilizaciones) puede reemplazar el valor de `C` sin tocar el atlas ni
  los shaders.
- El terreno de F3d debe salir de los 12 fijos; no se agregan hexadecimales
  fuera de la paleta.
