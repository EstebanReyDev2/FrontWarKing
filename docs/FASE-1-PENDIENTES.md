# Fase 1 — Lo que se conservó a propósito

Este documento lista todo lo que la Fase 1 **no** borró, por qué, y en qué fase
se resuelve. Si algo de acá te sorprende, es porque está esperando su fase.

## Estado

Rama: `fase-1-limpieza`, desde `main` (`6b9933ea6`).

| Grupo | Estado | Commit |
| --- | --- | --- |
| 1 · Publicidad, tracking y noticias | Hecho | `45841321e` |
| 2 · Portales (CrazyGames, Poki, Steam) | Hecho | `1cfcedc25`, `3bbd90009` |
| 3 · Pagos y monetización | Hecho | `fb7d7e0a1`, `04f1cd5a6` |
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

### Resultado del Grupo 3

Dos corridas completas consecutivas: **88 fallos por corrida** —los 87 de la
línea base más el flaky conocido `InventoryModal · reacts to all settings keys
changed outside Inventory`—, cero nombres nuevos. Typecheck y lint en 0.

Se borraron 18 archivos de test (10.031 líneas entre código y tests) que cubrían
checkout, suscripciones, creator codes, tienda y nudges, y se podaron casos de
`CosmeticLockerIntegration`, `EquippedCosmetics`, `WinModal` y
`CosmeticsTierListing`. El detalle de qué se quitó de cada archivo está en el
mensaje de `fb7d7e0a1` y en el reporte del grupo.

`@stripe/stripe-js` salió de `package.json` y del lockfile: era la única
dependencia de pago y sólo la importaban `StripeInline.ts` e `InlineCheckout.ts`.
`resources/lang/en.json` perdió 111 claves huérfanas.


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

### `Payments` como fachada inerte

- `src/client/Payments.ts` — sólo cuatro símbolos: `paymentsProvider()` →
  `"stripe"`, `startPurchase()` → outcome `error` con `store.purchase_failed`,
  `purchaseOutcomeMessage()` y `classifyPurchaseReturn()`. Sin Stripe, sin Steam,
  sin llamadas a `Api.ts`.

**Por qué:** `Cosmetics.ts` (Grupo 4) sigue importando esos cuatro símbolos para
los botones de compra con moneda blanda/dura y para el retorno
`#purchase-completed`. Borrarlos ahora obliga a cirugía sobre 1.699 líneas de
cosméticos y mezcla el Grupo 3 con el 4. La fachada no abre ninguna pasarela:
`startPurchase` siempre devuelve el error que el jugador ya veía cuando el
checkout no estaba disponible.

**Cuándo:** Grupo 4, cuando se borren `purchaseCosmetic` y
`handlePurchaseReturn` de `Cosmetics.ts`. Ahí desaparecen `Payments.ts` y sus
tipos.

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
- `src/client/EquippedCosmetics.ts` (`storeRouteFor`) y
  `src/client/components/EquippedCosmeticsRow.ts` siguen armando deep links
  `#modal=store...`; la fila los abre en una pestaña nueva. El router descarta
  un `#modal=` desconocido con `replaceHash("")` y devuelve `true`, así que la
  pestaña aterriza en la home y no hay excepción.
- `src/client/InventoryModal.ts` hace lo mismo al elegir un cosmético no
  poseído (`window.location.hash = "modal=store&tab=cosmetics"`). Es Grupo 4;
  se borra junto con la tienda de cosméticos. La clave `main.store` sigue en
  `en.json` justamente por este botón.
- Los tests `EquippedCosmetics.test.ts`, `EquippedCosmeticsRow.test.ts` e
  `InventoryModal.test.ts` siguen afirmando el string del hash; pasan porque la
  función que lo arma no cambió.

### `SteamNotices` se borró

Sus únicos consumidores (`BootInterrupts.ts` y `Main.ts`) eran Steam puro. Con él
se fue el interrupt `steam-notice` del pipeline de arranque y sus claves de
traducción. `SteamGrantNotices` (meses de Steam Plus) sigue: no es checkout y
está entrelazado con el arranque de sesión. Se va en el Grupo 4, junto con el
resto del copy de suscripciones, o en Fase 2 si el arranque se reescribe antes.
En una instalación sin compras de Steam queda inerte: no hay grants de Steam que
avisar.

### Smoke test del Grupo 2

```
npm run dev
```

Abrí `http://localhost:9000` (Vite; el server de dev arranca al lado). Home →
"Play" → "Single Player" → elegí mapa y bots → empezar.

Qué mirar: la home no muestra wishlist ni botones de portal; el footer no dice
`(Steam v…)`; Ajustes no tiene pestaña Display ni "Open Lobby Links in Steam"; y
la partida contra bots arranca y corre.

### Smoke test del Grupo 3

```
npm run dev
```

Abrí `http://localhost:9000`.

1. **Home y consola.** La barra de navegación no tiene "STORE" ni el punto rojo.
   La consola no muestra errores nuevos al cargar. Probá `#modal=store` en la
   URL: no abre nada, el hash se limpia y no hay excepción.
2. **Single player.** "Play" → "Single Player" → mapa y bots → empezar. La
   partida arranca y corre. Al terminar, el modal de victoria muestra los
   cosméticos promocionados pero **sin** botones de compra.
3. **Host Lobby.** "Play" → "Host Lobby" → configurar y crear. En dev el gate de
   suscripción ya se saltaba; en un build de producción ya no aparece el cartel
   de "subscription required". El flujo de listar público abre el diálogo de
   listado. Si el server rechaza por entitlement, el error viene del server y es
   esperado hasta Fase 2.
4. **Cuenta.** Abrí el menú de cuenta: no hay panel de creator code. La moneda
   sigue visible y el diálogo de moneda insuficiente ya no ofrece "comprar".
5. **Consola del navegador.** No debería haber
   `Failed to fetch dynamically imported module` por `Store`, `StripeInline` o
   `SubscriptionModal`. `steam-link-modal unavailable` sólo puede aparecer si
   tocás un flujo de link de Steam, nunca en el arranque.


### `window.adsEnabled`

- Se eliminó la asignación en `Main.ts` junto con el resto de la publicidad.
- `src/client/Auth.ts` todavía lo menciona en un comentario sobre el flujo de
  sesión.

**Cuándo:** Fase 2, con el login.

## Pagos: qué se conserva

### `SubscriptionPolicy.ts`

- `STEAM_TIER_CHANGE_IN_APP = false`.

**Por qué:** es una constante pura, sin dependencias, que `Cosmetics.ts` lee
para decidir el copy de cambio de tier. No hay lógica de pago.

**Cuándo:** Grupo 4, junto con `Payments.ts`.

### `CurrencyDisplay` e `InsufficientCurrencyDialog`

- `src/client/components/CurrencyDisplay.ts`
- `src/client/components/InsufficientCurrencyDialog.ts`

**Por qué:** son UI de economía interna (plutonio/caps), no checkout.
`CurrencyDisplay` lo usan `AccountModal`, `ClanModal` y cuatro componentes de
clan (Grupo 5); `InsufficientCurrencyDialog` lo usan `HostLobbyModal` y
`TribesPanel` (Grupo 5). Borrarlos en el Grupo 3 obliga a tocar clanes y el
hosting en la misma tarea. El diálogo quedó dismiss-only: ya no enlaza a una
tienda que no existe.

**Cuándo:** Grupo 5, con la economía de clanes y tribus.

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
- `src/client/Api.ts` conserva `createPaymentsCheckout`, `finalizeSteamOrder` y
  sus tipos, ya sin consumidores en el cliente. Se van con el recorte de `Api.ts`
  (Grupo 6) o con la reescritura del netcode.
- `ClientEnv.stripePublishableKey()` y el bloque `stripePublishableKey` de
  `index.html`/`RenderHtml`/`ServerEnv` quedaron sin consumidor al borrar
  `StripeInline`. Son config del bootstrap; se van con el recorte de `Api.ts` o
  con Fase 2.
- `src/server` conserva los endpoints de pago; son server, no entran en la
  limpieza del cliente. Fase 2.
- `Cosmetics.ts` conserva `purchaseCosmetic` y `handlePurchaseReturn` hasta el
  Grupo 4; hoy llaman a la fachada inerte.
