# Proyecto: juego de estrategia pixel-art para jugar entre compañeros de oficina

## Qué estamos construyendo
Un juego de navegador tipo Age of Empires (gestión de recursos, territorios, edificios, mejoras por eras, civilizaciones distintas), en estilo pixel art. Es un fork de OpenFront.io. Se juega entre 2 y 20 compañeros de oficina. NO hay plan de escalar, NO hay monetización, NO hay cuentas públicas ni ranking.

## Stack objetivo
- Frontend: Vite + TypeScript + Lit + Tailwind, render WebGL2 propio (ya existe en el repo). Se despliega en Vercel como sitio estático.
- Multijugador: Supabase Realtime (canales broadcast) en reemplazo del GameServer de Express/ws. Supabase también guarda partidas y jugadores.
- NO existe un servidor Node persistente en producción (Vercel no lo soporta).

## Arquitectura que NO se puede romper
- La simulación corre en cada cliente (Web Worker). El servidor solo retransmite "intents" y arma turnos. Todos los clientes deben llegar al mismo resultado bit a bit (lockstep determinista).
- `packages/engine` es la simulación. No debe importar `shared`, ni `Math.random()`, `Date.now()`, `Math.sin/pow/exp`: usar `DetMath` y el RNG determinista del engine.
- `tests/LayerBoundaries.test.ts` debe seguir pasando siempre. Si falla, tu cambio está mal; no modifiques el test para que pase.
- `engine-api` es el contrato entre engine, cliente y servidor (solo tipos y schemas zod).
- Nueva mecánica de juego = va en el engine, con test. La UI nunca calcula reglas del juego.

## Reglas de trabajo (obligatorias)
1. Trabajá en tareas chicas. Una tarea = un commit con mensaje claro en inglés.
2. Después de cada tarea corré: typecheck, lint y tests. Si algo que antes pasaba ahora falla, arreglalo antes de seguir.
3. Línea base conocida: hay 86 tests que ya fallaban antes de tocar nada en Windows (81 por `spawnSync bash ENOENT` y 5 por formato de locale). No son tu problema; no los arregles ni los borres, pero no agregues fallos nuevos.
4. No hagas refactors que no estén pedidos. No renombres ni muevas archivos por prolijidad.
5. Si borrás una feature, borrá también sus imports, estilos, claves de traducción y tests asociados. No dejes código muerto ni comentado.
6. Si una tarea es ambigua o tiene riesgo de romper el determinismo, frená y preguntame antes de seguir.
7. Respondeme siempre en español. El código, los comentarios y los commits van en inglés.
8. Mantené los archivos de licencia (AGPL-3.0 para código, CC BY-SA 4.0 para assets) y los créditos.

## Pixel art (para fases de render)
- Cero archivos de imagen nuevos. Los sprites se definen como matrices de caracteres + paleta, en archivos de texto, y se pintan en un atlas en runtime.
- Paleta global fija de 16 colores como máximo. Sprites de 16x16 o 32x32. Filtro nearest-neighbor, sin suavizado.

## Hoja de ruta (cada fase deja el juego funcionando)
- F1 Limpieza: borrar todo lo comercial/social.
- F2 Red: reemplazar GameServer por Supabase Realtime (con punto de control de sincronización).
- F3 Render pixel: terreno procedural + sprites en código.
- F4 Economía: recursos y recolección, edificios productores.
- F5 Mejoras: eras y árbol de tecnología.
- F6 Unidades: órdenes y tareas independientes, fortificaciones.
- F7 Civilizaciones y alianzas: facciones distintas, tipos de alianzas.
Solo trabajá en la fase que te pida explícitamente en cada prompt.