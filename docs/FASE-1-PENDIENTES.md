# Fase 1 — Lo que se conservó a propósito

Este documento lista todo lo que la Fase 1 **no** borró, por qué, y en qué fase
se resuelve. Si algo de acá te sorprende, es porque está esperando su fase.

## Estado

Rama: `fase-1-limpieza`, desde `main` (`6b9933ea6`).

| Grupo | Estado | Commit |
| --- | --- | --- |
| 1 · Publicidad, tracking y noticias | Hecho | `45841321e` |
| 2 · Portales (CrazyGames, Poki, Steam) | Hecho | `1cfcedc25`, `3bbd90009` |
| 3 · Pagos y monetización | Pendiente | — |
| 4 · Progresión comercial y cosméticos | Pendiente | — |
| 5 · Social (clanes, ranked, leaderboards, Twitch, amigos) | Pendiente | — |
| 6 · Recorte de `Api.ts` | Pendiente | — |

### Cómo se verifica cada grupo

La línea base no son "86 fallos": son **87 fallos con nombre y apellido**, más
4 flaky. Están en `docs/baseline-failures.txt` y `docs/baseline-flaky.txt`,
medidos con dos corridas consecutivas de la suite completa sobre `main`.

Para cerrar un grupo:

1. `npm run typecheck` y `npm run lint` en 0.
2. Dos corridas completas de la suite, una por vez, sin nada más corriendo.
3. Comparar por nombre contra esos dos archivos.
4. Una regresión es un test que falla en las **dos** corridas y no está en
   ninguno de los dos archivos. Si falla en una sola, se corre ese archivo
   aislado antes de decidir.

### Resultado del Grupo 2

Dos corridas completas consecutivas: **86 fallos, todos en la línea base, cero
nuevos por nombre**. El fallo 87 (`InventoryModal · explains guest access…`) no
se reprodujo en ninguna de las dos; el archivo pasa aislado (30/30), así que se
deja como estaba y no se "arregla".

La suite bajó de tamaño a propósito: se borraron tests de features que ya no
existen (shell de escritorio, portales, wishlist, handoff, link modal, avisos de
Steam) y se podaron los casos de otros archivos que simulaban el shell o los
portales. El detalle está en el mensaje de `1cfcedc25`.

## Contratos del engine y del netcode

### `clanTag` en el contrato del engine

Los clanes desaparecen del cliente (Grupo 5), pero `clanTag` sigue viajando en
el estado del juego:

- `packages/engine-api/src/game/GameTypes.ts` — `public readonly clanTag`
- `packages/engine-api/src/game/GameUpdates.ts` — `clanTag?`
- `packages/engine-api/src/Schemas.ts` — `ClanTagSchema`
- `packages/engine/src/game/PlayerImpl.ts` — `clanTag()`
- `packages/engine/src/game/Game.ts`, `GameUpdateUtils.ts`
- `packages/engine/src/snapshot/CommonSchemas.ts`
- `packages/engine/src/GameRunner.ts`

**Por qué:** es parte del estado determinista y de los snapshots. Tocarlo obliga
a cambiar `packages/engine`, y AGENTS.md prohíbe esa fase.

**Cuándo:** Fase 2, junto con el reemplazo del netcode. Queda como campo inerte
(siempre `null`).

### `RankedType.ClanWars` y `RankedType.TwoVTwo`

- `packages/engine-api/src/game/GameTypes.ts`
- `packages/engine/src/execution/WinCheckExecution.ts`

**Por qué:** el check de victoria lee `rankedType` para anular partidas ranked.
El enum vive en el engine-api.

**Cuándo:** Fase 2. Mientras tanto, ningún lobby del cliente puede pedir ranked.

### `PlayerCosmetics` en `WireSchemas`

- `packages/shared/src/WireSchemas.ts`
- `packages/shared/src/CosmeticSchemas.ts`
- `packages/shared/src/CloseCodes.ts` (`CosmeticsForbidden`)
- `packages/shared/src/ApiSchemas.ts` (secciones de cosméticos, XP y flares)

**Por qué:** es el contrato de red que consume `GameServer`. Borrarlo obliga a
tocar el netcode.

**Cuándo:** Fase 2.

### `LobbyQueuePayment.ts` y `RankedCheckin.ts`

- `src/server/LobbyQueuePayment.ts`
- `src/server/RankedCheckin.ts`

**Por qué:** son netcode del servidor actual. Se van con `GameServer` en Fase 2.

**Cuándo:** Fase 2.

## Renderer

### `PlayerPalette` y `CosmeticVisibility`

- `src/client/render/gl/utils/PlayerPalette.ts`
- `src/client/view/CosmeticVisibility.ts`
- `src/client/WebGLFrameBuilder.ts`, `src/client/replay/ReplayEffects.ts`

**Por qué:** `PlayerPalette` llena las texturas de paleta con **color de
territorio, borde, patrón y efectos**. Sin cosméticos comprados, el color de
territorio sigue saliendo de esta misma ruta: el jugador se sigue viendo con su
color. Borrarla dejaría el mapa sin colores.

**Cuándo:** Fase 3, cuando el renderer WebGL se reemplace por el de pixel-art.
Ahí sí desaparecen patrones y efectos, dejando solo color por jugador.

## Fachadas y stubs

### `GamePortal` como no-op

- `src/client/GamePortal.ts`

**Por qué:** 33 archivos llaman a `gamePortal.*` desde el gameplay
(`gameplayStart/Stop`, `loadingStart/Stop`, `happytime`, `createInviteLink`).
La Fase 1 borra los SDK de CrazyGames y Poki, y deja la fachada respondiendo
siempre "no hay portal". Así no hay que tocar los 33 call-sites de una vez.

**Cuándo:** Fase 2. Los call-sites se borran cuando se reescriba el arranque de
partida sobre Supabase.

### `DesktopShell`, `SteamSDK` y `ClientPlatform` reducidos

- `src/client/DesktopShell.ts` — `isDesktopShell() === false`, todos los bridges
  devuelven `null`, `multiplayerAllowed*()` devuelven `true`. Se conservan los
  tipos y `composeVersionDisplay` (formateador puro, sin bridge).
- `src/client/SteamSDK.ts` — `isOnSteam() === false`,
  `getTicket() === { ok: false, reason: "unavailable" }`, `getUser() === null`.
- `src/client/ClientPlatform.ts` — `clientPlatform() === "web"` (valor válido en
  `ClientPlatformSchema`); `clientDevice()` queda intacto.

**Por qué:** 29 archivos consumen `DesktopShell` y 33 `gamePortal`. Cambiarlos
todos en esta fase mezcla la limpieza con la reescritura de red. Cada valor de
retorno es el que el código ya producía en la web abierta, así que el
comportamiento observable no cambia.

**Cuándo:** Fase 2, tarea "limpiar ramas muertas de DesktopShell/GamePortal/
SteamSDK" (las ramas `if (isDesktopShell())` y los `gamePortal.*` sin efecto).

### Referencias muertas que quedan a propósito

- `src/client/GameModeSelector.ts` consulta `<desktop-status-bar>`, que ya no
  existe en `index.html`; `querySelector` devuelve `null` y no hace nada.
- `src/client/LinkResult.ts` pide `steam-link-modal` a `LazyModals`, donde ya no
  está; el `.catch()` degrada con `console.warn` y el `querySelector` no
  encuentra el elemento.
- `src/client/DesktopSessionRecovery.ts` queda entero para Fase 2: su auto-retry
  sólo se registra dentro del shell, así que en web es inerte. Sus tests de
  auto-retry se quitaron porque simulaban un shell que ya no existe.
- `src/client/SteamLink.ts` y `LinkResult.ts` quedan por ser parte del login
  (Fase 2), aunque la UI que los abría ya no exista.

### `SteamNotices` se borró

Sus únicos consumidores (`BootInterrupts.ts` y `Main.ts`) eran Steam puro. Con él
se fue el interrupt `steam-notice` del pipeline de arranque y sus claves de
traducción. `SteamGrantNotices` (meses de Steam Plus) sigue: es monetización y se
va en el Grupo 3 junto con el resto de ese pipeline.

### Smoke test del Grupo 2

```
npm run dev
```

Abrí `http://localhost:9000` (Vite; el server de dev arranca al lado). Home →
"Play" → "Single Player" → elegí mapa y bots → empezar.

Qué mirar: la home no muestra wishlist ni botones de portal; el footer no dice
`(Steam v…)`; Ajustes no tiene pestaña Display ni "Open Lobby Links in Steam"; y
la partida contra bots arranca y corre.


### `window.adsEnabled`

- Se eliminó la asignación en `Main.ts` junto con el resto de la publicidad.
- `src/client/Auth.ts` todavía lo menciona en un comentario sobre el flujo de
  sesión.

**Cuándo:** Fase 2, con el login.

## Terceros que se quedan

### Cloudflare Turnstile

- `index.html` (`https://challenges.cloudflare.com/turnstile/v0/api.js`)
- `src/client/TurnstileToken.ts`

**Por qué:** protege el login/cuentas, que es Fase 2. El usuario pidió
explícitamente no tocarlo ahora.

**Cuándo:** Fase 2, junto con el reemplazo del login.

### Login y cuentas

- `src/client/Auth.ts`, `UsernameInput.ts`, `AccountModal.ts`,
  `AccountSettingsModal.ts`, `components/AccountSettingsPanel.ts`,
  `components/IdentityTokenCard.ts`, `components/DeleteAccountDialog.ts`,
  `AccountIdentity.ts`, `NavAccountButton.ts`
- Todo el flujo de JWT/refresh de `Api.ts`

**Por qué:** Fase 2 lo reemplaza con identidad de Supabase. Borrarlo ahora deja
el juego sin arranque (el boot consulta la sesión antes de mostrar nada).

**Cuándo:** Fase 2.

## Deuda conocida que la Fase 1 no toca

- Metadatos de marca original en `index.html` (canonical, Open Graph, JSON-LD,
  links a Discord y Reddit). No son publicidad ni tracking, pero son branding
  del proyecto original.
- Los `window.PageOS` / analytics de terceros que aparezcan dentro de
  `src/client` (revisar en Fase 2).
