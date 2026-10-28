# Fase 1 — Lo que se conservó a propósito

Este documento lista todo lo que la Fase 1 **no** borró, por qué, y en qué fase
se resuelve. Si algo de acá te sorprende, es porque está esperando su fase.

## Estado

Rama: `fase-1-limpieza`, desde `main` (`6b9933ea6`).

| Grupo                                                     | Estado              | Commit                                                                                                 |
| --------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| 1 · Publicidad, tracking y noticias                       | Hecho               | `45841321e`                                                                                            |
| 2 · Portales (CrazyGames, Poki, Steam)                    | Hecho               | `1cfcedc25`, `3bbd90009`                                                                               |
| 3 · Pagos y monetización                                  | Hecho               | `fb7d7e0a1`, `04f1cd5a6`                                                                               |
| 4 · Progresión comercial y cosméticos                     | Hecho (4a, 4b y 4c) | `4652d4751`, `781ffb17c`, `85f8dc8d4`, `e9995885e`, `107d40ab5`, `cf37651a1`                           |
| 5 · Social (clanes, ranked, leaderboards, Twitch, amigos) | Hecho (5a-5g)     | `76f4892e5`, `e1b4a66c5`, `ccc006f55`, `b851ca0d6`, `58c7fcddd`, `204503082`, `fa8cfbf1b`, `5c6e243bc`, `1dc1c0815`, `fc149b20b` |
| 6 · Recorte de `Api.ts`                                   | Pendiente           | —                                                                                                      |

### Cómo se verifica cada grupo

La línea base actual son **81 fallos estables y 2 flaky conocidos**, todos
originados en `spawnSync bash/sh ENOENT` al correr los tests de los scripts de
despliegue en Windows. Los dos flaky son `MainInitialize` y `ReplayFormat`;
cualquier otro nombre que falle es una regresión.

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

### Resultado del Grupo 4b

Dos corridas completas consecutivas: **81 fallos por corrida, los 81 de la
línea base, cero regresiones por nombre**. Typecheck y lint en 0.

Contra la línea base pre-Fase 1 desaparecieron 6 fallos estables y 6 flaky:
5 estables y 2 flaky ya venían de 4a; 4b sumó el estable de `InventoryModal` y
sus 4 flaky. Se borraron 24 archivos de test y se podaron 16 casos de
`UserSettings.test.ts`; se agregaron 5 tests de caracterización en
`tests/client/CosmeticsCharacterization.test.ts`. El detalle está en el reporte
del grupo.

### Resultado del Grupo 4c

Dos corridas completas consecutivas: **81 fallos por corrida, los 81 de la
línea base, cero regresiones por nombre**. Typecheck y lint en 0. La suite quedó
en 7.358 tests, 7.276 pasados y 81 fallados por corrida.

Se borraron 50 tests: 32 de `SteamGrantNotices.test.ts`, 1 de
`SubscriptionPolicy.test.ts`, 14 casos de `BootInterrupts.test.ts` y 3 de
`UsernameInput.test.ts`. `resources/lang/en.json` perdió 8 claves huérfanas
(`steam_grant.*` y `username.lapse_notice_after_*`). `LangSelector` perdió los
tags `top-bar`, `level-badge` y `past-game-xp-card`, que ya no existen.

### Resultado del Bloque 1 (5a, 5b y 5c)

Dos corridas completas consecutivas: **7090 tests, 7008 pasados, 81 fallados y
1 pending por corrida**. Los 81 nombres son idénticos en ambas corridas, están
todos en `docs/baseline-failures.txt` y no apareció ningún nombre nuevo.
Typecheck y lint en 0.

Contra la línea base pre-Fase 1 desaparecieron 6 fallos estables porque sus
tests se borraron en bloques anteriores. En este bloque se borraron 14 archivos
de test (4 de Twitch, 4 de friends/presencia y 6 de tribus) y se podaron casos
de `ApiSchemas.test.ts`, `LeaderboardModal.test.ts`, `HostLobbyModal*.test.ts`,
`JoinLobbyModal.test.ts` y `Utils.mapKey.test.ts`.

Pruebas manuales con `npm run dev` (Vite en 9000 y server en 3000/3001/3002):

- La home no muestra Twitch, streams, friends ni tribus.
- La clasificación no tiene pestaña Tribes. El deep link
  `#modal=leaderboard&tab=tribes` cae en `players` y muestra las pestañas
  players, 2v2, FFA y clans.
- La cuenta no tiene pestaña Friends. El deep link
  `#modal=account&tab=friends` abre la cuenta normal.
- Los modales de host y join no contienen `Invite Friends`.
- La consola no muestra `Translation key not found` ni errores de módulos
  borrados **en las pantallas recorridas por este smoke**. No se abrieron
  historial ni ranking; ver la corrección del smoke de 5f más abajo. Sólo
  aparece el ruido esperado de `localhost:8787` que se documenta más abajo.

### Resultado del Bloque 2 (5d y 5e)

Dos corridas completas consecutivas: **6983 tests, 6901 pasados, 81 fallados y
1 pending por corrida**. Los 81 nombres son idénticos en ambas corridas, están
todos en `docs/baseline-failures.txt` y no apareció ningún nombre nuevo.
Typecheck, lint y formato en 0.

La suite bajó 107 tests contra el cierre del Bloque 1 (7090 → 6983). Se
borraron 6 archivos de test completos (los de `LeaderboardModal`,
`ApiPlayerLeaderboard`, `Matchmaking`, `RankedTrustLock`, `RankedModalTrust` y
`WinModal`) y se podaron casos de `MainInitialize`, `GameServerApiCallers`,
`PlayerProfilePage`, `PlayerProfileClansTab`, `ClanApiQueries` y `ServerList`;
también se quitó el mock de leaderboard de `ClanModalTestUtils`. Se agregó
cobertura para
`match_cancelled` sin listener de requeue y para un `rankedType` viejo en
`WinModal`.

`leaderboard_modal.try_again` se conservó a propósito: lo usan
`PlayerGameHistoryView`, `ClanGameHistoryView` y `ClanDonationsView`.

Verificación de arranque: `npm run start:server-dev`, solo, levanta el master
en `3000` y los workers en `3001`/`3002`; **no** abre un listener en `8787`.
`http://localhost:3000/` responde `500` por el `static/index.html` ausente, no
por el puerto. La misma corrida en un worktree de `main` dio el resultado
idéntico. Los errores de `8787` son del API separado, que `npm run dev` tampoco
inicia.

### Resultado del Bloque 3 (5f-1 y 5f-2)

Dos corridas completas consecutivas: **6.589 tests, 6.507 pasados, 81 fallados y
1 skipped por corrida**. Los 81 nombres son idénticos en ambas corridas, están
todos en `docs/baseline-failures.txt` y no apareció ningún nombre nuevo. Contra
la línea base original faltan 6 nombres de cliente (`InventoryModal`,
`PastGameXpCard` ×2, `ProfileCard`, `ProgressionModals` y `RewardTrack`) porque
sus tests ya se habían borrado o podado en bloques anteriores; no son fallos
nuevos. Typecheck, lint y formato en 0.

`fa8cfbf1b` borró la UI de clanes (`ClanModal`, `ClanApi`, los 15 componentes de
`components/clan`, el router, `LazyModals`, la navegación, `page-clan` y las
claves `clan_modal.*`, `main.clans`, `account_modal.tab_clans` y
`player_profile.no_clans`). La auditoría posterior encontró que 27 claves
`clan_modal.*` seguían vivas en historial y ranking; se restauraron en
`1463f534f`. Para que ese commit compilara, también se quitó de `UsernameInput`
el chequeo de pertenencia a clan, que era el último consumidor de `ClanApi`; el
selector siguió existiendo hasta 5f-2.

`5c6e243bc` quitó el selector de clan tag de `UsernameInput` (`getClanTag`,
`getClanCheck`, `clearClanTag`, eventos, `page-clan` y `localStorage.clanTag`),
dejó el join con `clanTag: null` en `Main` y en single player, y eliminó
`clanTagCheck` de `ClientGameRunner`. `ClanApiSchemas` se conserva porque
`src/server/PrivilegeRefresher.ts` usa `ReservedClanTagsResponseSchema`.

`ClientJoinMessageSchema` sigue exigiendo la clave `clanTag` (nullable). Un
mensaje con `clanTag: null` es válido; uno sin la clave no lo es, y no se tocó
`WireSchemas` porque está fuera del alcance. El cliente normaliza cualquier
configuración sin tag a `null`, así que el camino real nunca omite la clave. La
cobertura quedó en `tests/core/SpectatorJoinSchema.test.ts`,
`tests/client/TransportSendPaths.test.ts`, `tests/client/UsernameInput.steam.test.ts`
y `tests/TeamAssignment.test.ts`.

La suite bajó 394 tests contra el cierre del Bloque 2 (6.983 → 6.589) por el
borrado de los tests de la UI de clanes.

## Borrado obligatorio antes de cerrar la Fase 1

Esta es la lista de supervivientes del Grupo 4, del Bloque 2 (5d y 5e), del
Bloque 3 (5f) y de los restos del Grupo 3. La Fase 1 **no se cierra** hasta que
quede vacía. Cada ítem indica el subgrupo que lo elimina; al borrarlo se marca la
casilla y se tacha el nombre.

### 5a, 5b y 5c · Social, amigos y tribus pagas — hecho

- [x] ~~Twitch: `FeaturedStream`, `StreamsFeed`, `StreamingNow` y
      `resources/streams.json`~~ — `76f4892e5`
- [x] ~~Friends: `FriendsList`, `FriendsApi`, `DesktopPresence`,
      `PresenceGroup` e `InviteFriendsButton`~~ — `e1b4a66c5`
- [x] ~~Tribus pagas: `TribesPanel`, `TribeStatsView`,
      `LeaderboardTribeTable`, APIs y schemas~~ — `ccc006f55`
- [x] ~~Claves de traducción huérfanas del recorte de tribus~~ — `b851ca0d6`

### 5d y 5e · Leaderboards y ranked — hecho

- [x] ~~`src/client/LeaderboardModal.ts`,
      `components/leaderboard/LeaderboardPlayerList.ts` y
      `LeaderboardClanTable.ts`~~ — `58c7fcddd`
- [x] ~~`fetchPlayerLeaderboard`, `fetchClanLeaderboard` e
      `isPageBoundsMessage`; tests de leaderboard~~ — `58c7fcddd`
- [x] ~~Página, navegación, router y claves de leaderboard en `index.html`,
      `Main.ts`, `LangSelector.ts`, `LazyModals.ts` y `en.json`~~ — `58c7fcddd`
- [x] ~~`src/client/components/RankedModal.ts`, `src/client/Matchmaking.ts`,
      tarjeta y botón ranked del selector de modos~~ — `204503082`
- [x] ~~`WinModal.requeue`, `HeadsUpMessage` con `RankedType`,
      `matchmaking-requeue`, `consumeRequeueUrl` y el wiring de `Main.ts`~~ —
      `204503082`
- [x] ~~`matchmakingSite`, contexto ranked de `TrustRequiredContext` y claves
      `matchmaking_modal.*`, `mode_selector.ranked_*` y
      `win_modal.requeue`~~ — `204503082`

### 5f · Clanes y selector de clan tag — hecho

- [x] ~~`src/client/ClanModal.ts`, `src/client/ClanApi.ts` y los 15 componentes
      de `src/client/components/clan/`~~ — `fa8cfbf1b`
- [x] ~~Entrada `clan-modal` de `LazyModals`, registro `clan` del router y
      `closeMenu` de `Main`; botones `page-clan` de `DesktopNavBar`/`MobileNavBar`;
      `<clan-modal id="page-clan">` de `index.html`~~ — `fa8cfbf1b`
- [x] ~~Tabs y orígenes de clanes en `PlayerProfileModal`, `GameStatsModal`,
      `AccountModal` y sus tests~~ — `fa8cfbf1b`
- [x] ~~Claves `clan_modal.*` huérfanas, `main.clans`,
      `account_modal.tab_clans` y `player_profile.no_clans` de `en.json`~~ —
      `fa8cfbf1b`. La auditoría posterior encontró 27 claves `clan_modal.*` que
      seguían vivas en historial y ranking; se restauraron en `1463f534f`.
- [x] ~~Selector de clan tag, `getClanTag`, `getClanCheck`, `clearClanTag`,
      eventos de clan y `localStorage.clanTag` en `UsernameInput`~~ — `5c6e243bc`
- [x] ~~`clanTagCheck` de `ClientGameRunner`; el join ahora manda
      `clanTag: null`~~ — `5c6e243bc`. `playerClanTag` sigue en `LobbyConfig`,
      `Transport`, `LocalServer` y `GameView`, pero es inerte: `Main.ts` lo pasa
      siempre como `null`.
- [x] ~~Claves `username.clan_*`, `username.tag` y `username.tag_not_member` de
      `en.json`; regla `#clan-tag-menu` de `halloween.css`~~ — `5c6e243bc`.
      Se conservan `username.tag_too_short`, `tag_too_long` y
      `tag_invalid_chars` porque `validateClanTag` sigue existiendo.

### 5g · Economía interna muerta: currency display y cola paga — hecho

Aprobado como hecho por el usuario; se dividió en dos commits.

- [x] ~~`CurrencyDisplay`, `CapIcon`, `BottleCapIcon.svg`, sus estilos y la
      clave `cosmetics.soft`; `AccountModal` ya no muestra el saldo de caps~~ —
      `1dc1c0815`
- [x] ~~Cola paga de lobby: `HostLobbyModal`, `InsufficientCurrencyDialog`,
      `PlutoniumIcon`, `PlutoniumIcon.svg`, helpers de `Cosmetics.ts` y las
      claves `cosmetics.hard`, `lobby_modal.queue*` y
      `store.insufficient_currency*`~~ — `fc149b20b`
- [x] ~~Tests de la UI borrada; se agregaron casos de arranque del host y de
      `MainInitialize`~~ — `fc149b20b`

Después de 5g, `lobbyQueue` sólo sobrevive en `CosmeticSchemas` (y sus tests de
schema); el cliente no lo lee ni lo muestra. `queueLobby` quedó huérfana en
`Api.ts` y se lista como deuda del Grupo 6.

### 4a · Progresión en partida, badges de nivel y cuenta — hecho

Los tres subgrupos se commitearon por separado. `ProvisionalXp`, `XpMultipliers`,
`MomentShare`, `PrestigeFlow` y `FlareCosmetic` se movieron de 4a-1 a 4a-3
porque perfil y cuenta todavía los consumían.

#### 4a-1 · `4652d4751`

- [x] ~~`src/client/components/GameXpPanel.ts`~~
- [x] ~~`src/client/ProvisionalXpAtDeath.ts`~~
- [x] ~~`src/client/components/LegendCeremony.ts`~~
- [x] ~~`src/client/hud/layers/WinModal.ts`~~ — sin XP, Legend, hitos, share ni promo de cosméticos

#### 4a-2 · `781ffb17c`

- [x] ~~`src/client/components/LevelBadge.ts`~~
- [x] ~~`src/client/components/LevelBadgeFill.ts`~~
- [x] ~~`src/client/components/LevelBadgeIcons.ts`~~
- [x] ~~`src/client/components/LevelBadgeLargeIcons.ts`~~
- [x] ~~`src/client/components/LevelBadgeSlot.ts`~~
- [x] ~~`src/client/OwnLevelBadge.ts`~~
- [x] ~~`src/client/LobbyRosterLevels.ts`~~
- [x] ~~`src/client/ClientGameRunner.ts`~~ — sin `rememberLobbyRoster` ni wiring de badges
- [x] ~~`src/client/hud/layers/PlayerPanel.ts`~~ — sin badge de nivel

#### 4a-3 · `85f8dc8d4`

- [x] ~~`src/client/ProvisionalXp.ts`~~
- [x] ~~`src/client/XpMultipliers.ts`~~
- [x] ~~`src/client/MomentShare.ts`~~
- [x] ~~`src/client/components/PrestigeFlow.ts`~~
- [x] ~~`src/client/components/FlareCosmetic.ts`~~
- [x] ~~`src/client/components/ProfileCard.ts`~~
- [x] ~~`src/client/components/ProfileProgression.ts`~~
- [x] ~~`src/client/PlayerProgress.ts`~~
- [x] ~~`src/client/ProvisionalProgress.ts`~~
- [x] ~~`src/client/Progression.ts`~~
- [x] ~~`src/client/ProgressionAccount.ts`~~
- [x] ~~`src/client/ProgressionApi.ts`~~
- [x] ~~`src/client/components/ProgressionSection.ts`~~
- [x] ~~`src/client/components/RewardTrack.ts`~~
- [x] ~~`src/client/components/RewardsPanel.ts`~~
- [x] ~~`src/client/RewardsModal.ts`~~
- [x] ~~`src/client/RewardClaims.ts`~~
- [x] ~~`src/client/GameRewards.ts`~~
- [x] ~~`src/client/components/XpBar.ts`~~
- [x] ~~`src/client/components/PastGameXpCard.ts`~~
- [x] ~~`src/client/Main.ts`~~ — sin rewards modal, arranque de progresión ni boot interrupt
- [x] ~~`src/client/AccountModal.ts`~~ — sin tab de progresión
- [x] ~~`src/client/PlayerProfileModal.ts`~~ — sin nivel ni progresión
- [x] ~~`src/client/GameStatsModal.ts`~~ — sin XP
- [x] ~~`src/client/components/NavAccountMenu.ts`~~ — sin nivel ni badge
- [x] ~~`src/client/components/AccountSettingsPanel.ts`~~ — sin settings de progresión
- [x] ~~`src/client/Api.ts`~~ — sin endpoints de nivel, progresión ni rewards
- [x] `resources/lang/en.json` — 163 claves huérfanas eliminadas

### 4b · Inventario, tienda cosmética y fondo de la home — hecho

4b-1 `e9995885e` borró la UI; 4b-2 `107d40ab5` redujo el motor de cosméticos a
la ruta de display. El detalle de tests y claves está en el reporte del grupo.

#### 4b-1 · `e9995885e`

- [x] ~~`src/client/InventoryModal.ts`~~
- [x] ~~`src/client/components/InventoryLoadoutBar.ts`~~
- [x] ~~`src/client/components/InventoryLoadoutMenu.ts`~~
- [x] ~~`src/client/components/EquippedCosmeticsRow.ts`~~
- [x] ~~`src/client/EquippedCosmetics.ts`~~
- [x] ~~`src/client/components/CosmeticBackground.ts`~~
- [x] ~~`src/client/components/CosmeticCard.ts`~~
- [x] ~~`src/client/components/CosmeticInfo.ts`~~
- [x] ~~`src/client/components/CosmeticPresentation.ts`~~
- [x] ~~`src/client/components/CosmeticPreview.ts`~~
- [x] ~~`src/client/components/CosmeticPreviewBubble.ts`~~
- [x] ~~`src/client/components/CosmeticPreviewModal.ts`~~
- [x] ~~`src/client/components/EffectsGrid.ts`~~
- [x] ~~`src/client/components/PatternPreview.ts`~~
- [x] ~~`src/client/components/EffectPreview.ts`~~
- [x] ~~`src/client/components/cosmetics/CosmeticRenderCanvas.ts`~~
- [x] ~~`src/client/render/preview/`~~ — renderer, ticker, map loader y territory pass
- [x] ~~`index.html`~~ — sin `<inventory-modal>`
- [x] ~~`src/client/Main.ts`~~ — sin ruta/nav de inventario ni entrada en `LazyModals`
- [x] ~~`src/client/LangSelector.ts`~~ — sin tags de inventario/cosméticos
- [x] ~~`src/client/PlayPage.ts`~~ — sin fondo cosmético
- [x] ~~Productores de `#modal=store`~~ — cero
- [x] ~~`main.store`~~ — sin consumidores

#### 4b-2 · `107d40ab5`

- [x] ~~`src/client/Cosmetics.ts`~~ — 11 exports, sin compra, tienda ni resolución
- [x] ~~`src/client/UserSettings.ts`~~ — sin loadouts; quedan `PATTERN_KEY`, `FLAG_KEY`, `CROWN_KEY` y `EFFECTS_KEY`
- [x] ~~`src/client/Api.ts`~~ — sin compra de cosméticos ni listados de tienda
- [x] `resources/lang/en.json` — 74 claves en 4b-1 y 30 en 4b-2

### 4c · Restos de pagos y Steam — hecho

- [x] ~~`src/client/Payments.ts`~~
- [x] ~~`src/client/SubscriptionPolicy.ts`~~
- [x] ~~`src/client/SteamGrantNotices.ts`~~
- [x] ~~`translateCosmetic` en `src/client/Cosmetics.ts`~~
- [x] ~~`steam_grant.*` y `username.lapse_notice_after_*` en `en.json`~~ — 8 claves
- [x] ~~Tags muertos en `src/client/LangSelector.ts`~~ — `top-bar`, `level-badge`, `past-game-xp-card`

### Restos que no son de este grupo

- [x] ~~`src/client/components/CurrencyDisplay.ts`~~ — 5g (`1dc1c0815`)
- [x] ~~`src/client/components/InsufficientCurrencyDialog.ts`~~ — 5g (`fc149b20b`)
- [ ] `src/client/Api.ts` — `createPaymentsCheckout`, `finalizeSteamOrder`,
      `queueLobby` — Grupo 6

## Deuda para Fase 2

### API de `8787`

El API de `localhost:8787` **no está en el repositorio**: `npm run dev` sólo
levanta Vite y el game server. Toda llamada del cliente a sesión/auth
(`auth/refresh`, JWT), `cosmetics.json`, `cluster.json`, historial de partidas y
stats tiene que reemplazarse por Supabase, stubearse o eliminarse en Fase 2.
Mientras tanto, esos pedidos fallan y son parte del ruido de consola esperado.

No es posible hacer una verificación real de cosméticos en local: no hay backend
que sirva el catálogo ni el inventario del jugador. La única verificación local
posible es que el cliente arranque con el catálogo vacío o el fallback y que el
render no dependa de cosméticos comprados. La validación con cosméticos reales
queda para un entorno con backend o para cuando Supabase tenga el catálogo.

El catálogo de cosméticos todavía depende del servidor original. `fetchCosmetics`,
`getPlayerCosmeticsRefs` y `cosmeticsJsonUrl` en `src/client/Cosmetics.ts`, más
el join que arma `PlayerCosmetics` para el servidor, asumen un backend que
sirve `cosmetics.json` y resuelve el inventario del jugador. Al reemplazar ese
backend por Supabase hay que decidir de dónde sale el catálogo (tabla, storage
o archivo estático) y si el join de `PlayerCosmetics` se conserva o se elimina.
No es deuda de la Fase 1: el render de cosméticos sigue funcionando con el
contrato actual.

Además, `fetchCosmetics()` pide `cosmetics.json` al servidor original con un
timeout de 10 s. En Fase 2, sin ese servidor, la petición debe fallar rápido y
el juego debe arrancar igual. Hay que verificar también que una URL inexistente
en Vercel no devuelva el `index.html`: un fallback SPA haría pasar un 404 por un
catálogo válido.

### Campos y schemas que sobreviven a 5a-5g

Estos nombres no se tocaron en 5a-5g. La columna "estado" dice qué queda vivo
hoy, para no confundir "sin consumidor en el cliente" con "se puede borrar ya":

| Nombre           | Dónde queda                                                               | Estado tras 5g                                                                                   | Cuándo se va |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------ |
| `friends`        | `WireSchemas`, `ApiSchemas`, `SharedUtil`, `engine-api`, snapshots        | Campo inerte en el cliente: la UI ya no lo lee. Sigue en el wire y en `TeamAssignment`.          | Fase 2       |
| `GroupToken`     | `WireSchemas` (`GroupTokenEvent`, mensajes de lobby/start)                | El cliente ya no lo emite ni lo consume; el evento y el schema siguen por el netcode.            | Fase 2       |
| `tribeNames`     | `CosmeticSchemas`                                                         | Sin consumidores tras borrar la tienda de tribus. El schema queda para no tocar el contrato.     | Fase 2       |
| `lobbyQueue`     | `CosmeticSchemas` (sólo el schema)                                        | Inerte en el cliente tras 5g: el host ya no muestra ni cobra la cola paga. Se conserva para no tocar el contrato. | Fase 2       |
| `clanTag`        | `engine-api`, `engine`, `WireSchemas`, `ApiSchemas` y estado determinista | El cliente ya no lo lee de `localStorage` ni envía uno propio: el join manda `null`.             | Fase 2       |
| `RankedType`     | `engine-api`, `engine`, `ApiSchemas` y stats del cliente                  | Sin UI ni cola ranked en el cliente tras 5e; sigue para el check de victoria del engine.         | Fase 2       |
| `ClanApiSchemas` | `src/server/PrivilegeRefresher.ts`                                        | Sólo `ReservedClanTagsResponseSchema`; el resto queda inerte.                                    | Fase 2       |
| `TeamAssignment` | `engine-lib/src/game/TeamAssignment.ts`                                   | Agrupa por `clanTag` y `friends`; con ambos vacíos la agrupación queda inerte, pero se conserva. | Fase 2       |

`TeamAssignment` quedó cubierto por `tests/TeamAssignment.test.ts` con todos los
`clanTag` en `null` y `friends` vacío, y se prueba además en la partida por
equipos contra bots del smoke test del Bloque 3.

### Cola paga y textos de clan en historial/stats

- `queueLobby` quedó huérfana en `src/client/Api.ts` después de `fc149b20b`.
  No se borra en Fase 1 porque el recorte de `Api.ts` es del Grupo 6; se va con
  ese recorte o en Fase 2.
- Las vistas de historial y stats siguen usando textos `clan_modal.*` aunque el
  juego ya no tenga clanes: `PlayerGameHistoryView.ts`, `GameHistoryDates.ts`,
  `GameTypeLabels.ts` y `PlayerRow.ts`. Los textos funcionan y están
  restaurados, pero en Fase 2 hay que decidir si esas etiquetas siguen teniendo
  sentido sin clanes o si pasan a un namespace de historial general.

## Deuda de Grupo 6

- `src/client/Api.ts`: `queueLobby` quedó sin consumidor en el cliente tras
  borrar la cola paga (`fc149b20b`). Recortarla junto con el resto de `Api.ts`.
- Revisar si las vistas de historial/stats que usan claves `clan_modal.*`
  (`PlayerGameHistoryView`, `GameHistoryDates`, `GameTypeLabels`, `PlayerRow`)
  tienen sentido sin clanes, o si hay que mover esas etiquetas a un namespace
  de historial general.
- `createPaymentsCheckout`, `finalizeSteamOrder` y sus tipos siguen en `Api.ts`
  sin consumidores.
- `ClientEnv.stripePublishableKey()` y el bootstrap de Stripe en
  `index.html`/`RenderHtml`/`ServerEnv` siguen sin consumidor.

## Contratos del engine y del netcode

### `clanTag` en el contrato del engine

Los clanes desaparecieron del cliente en 5f, pero `clanTag` sigue viajando en
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

**Cuándo:** Fase 2. Tras 5e el cliente ya no tiene cola ni UI ranked; el enum
queda por el engine, el check de victoria y las estadísticas.

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

### `Payments` se borró

- `src/client/Payments.ts` — 4c (`cf37651a1`).

**Por qué:** 4b-2 borró sus últimos consumidores. Era una fachada inerte que no
abría ninguna pasarela y sólo conservaba tipos y clasificadores sin uso.

**Cuándo:** hecho.

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
- No quedan productores de `#modal=store`: los deep links de `EquippedCosmetics`
  e `InventoryModal` se borraron en 4b, y la clave `main.store` ya no existe en
  `en.json`.

### `SteamNotices` y `SteamGrantNotices` se borraron

`SteamNotices` se fue en el Grupo 2 y `SteamGrantNotices` en 4c. Con ellos se
fueron los interrupts `steam-notice`, `grant-welcome` y `grant-ended`, sus
puertos (`tierName`, `updateSteamGrant`), el almacén por cuenta en
`localStorage` y las claves `steam_grant.*`. El aviso de lapse sigue existiendo
para suscriptores, sin la variante posterior a un grant.

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

### Smoke test del Grupo 4c

```
npm run dev
```

Abrí `http://localhost:9000`.

1. **Home y consola.** La home carga sin errores de módulos `SteamGrantNotices`,
   `Payments` ni `SubscriptionPolicy`.
2. **Cuenta vencida.** Iniciá sesión con una cuenta cuyo nombre esté por vencer:
   el aviso de lapse aparece una sola vez y usa el texto ordinario
   (`username.lapse_notice` o `username.lapse_notice_at_risk`), no una variante
   `after_grant` / `after_free_access`.
3. **Sin avisos de Steam.** No aparece ningún cartel de bienvenida ni de fin del
   mes de Steam.
4. **Deep link muerto.** `#modal=store` no abre nada y el hash se limpia.
5. **Traducciones.** La consola no muestra `Translation key not found` por
   `steam_grant.*` ni por `username.lapse_notice_after_*`.

### Smoke test del Bloque 2 (5d y 5e)

```
npm run dev
```

Abrí `http://localhost:9000`.

1. **Home.** El selector de modos no tiene la tarjeta "Ranked"; quedan Create y
   Join en la grilla de acciones.
2. **Navegación.** La barra de navegación no tiene "Leaderboard". Los deep links
   `#modal=leaderboard` y `#modal=ranked` no abren nada, limpian el hash y no
   lanzan excepciones.
3. **Perfil.** Un perfil público no tiene "View leaderboard"; Back vuelve a la
   home y no a una clasificación.
4. **Partida contra bots.** Entrá a Single Player, elegí mapa y bots, y jugá
   hasta que termine. El modal de victoria muestra Exit y Keep; no hay botón
   Requeue ni aunque la configuración vieja traiga `rankedType`.
5. **Consola.** No aparece `Failed to fetch dynamically imported module` por
   `LeaderboardModal`, `RankedModal` ni `Matchmaking`. El ruido de `8787` sigue
   siendo el documentado abajo.

### Smoke test del Bloque 3 (5f)

```
npm run dev
```

Abrí `http://localhost:9000`.

1. **Navegación.** No hay botón ni entrada "Clans" en desktop ni mobile;
   `#modal=clan` no abre nada, limpia el hash y no lanza excepciones.
2. **Home.** El campo de nombre no tiene selector de clan tag ni
   `#clan-tag-menu`; el join no manda un tag.
3. **`localStorage` viejo.** Con `localStorage.clanTag` guardado de una versión
   anterior, la home carga, el nombre se puede editar y el join funciona; el
   valor viejo no se lee.
4. **Partida por equipos.** Single Player → Teams → bots → jugá hasta que
   termine. Los equipos se reparten sin errores y el juego termina.
5. **Perfil y stats.** El perfil y el modal de stats no tienen tabs ni links de
   clanes; Back no intenta volver a un clan.
6. **Consola.** No aparece `Failed to fetch dynamically imported module` por
   `ClanModal` o `components/clan`. **Corrección:** este smoke no abrió
   historial ni ranking. Esas vistas sí mostraban `Translation key not found`
   porque `fa8cfbf1b` había borrado 27 claves `clan_modal.*` que seguían en uso.
   Se restauraron en `1463f534f` y el test nuevo
   `tests/TranslationKeyUsage.test.ts` cubre las claves estáticas. El ruido de
   `8787` sigue siendo el documentado abajo.

Resultado del smoke automatizado (26/10/2026): partida **Teams** en Pangaea
compacto (500×500), 3 bots, dificultad Easy, jugada en Chromium **headless**
hasta el final. No es una prueba manual humana; queda pendiente repetirla a mano
en un navegador real. El humano quedó en el equipo Red y ganó en el tick 1116 con
todos los enemigos eliminados; no hubo errores de equipos ni de clanes en la
partida.

### Smoke test del Bloque 4 (5g)

```
npm run dev
```

Abrí `http://localhost:9000`.

1. **Cuenta.** El menú de cuenta no muestra el saldo de caps ni
   `CurrencyDisplay`; el resto de la cuenta sigue abriendo.
2. **Host Lobby.** El modal de host no tiene "Queue", precio en Plutonio,
   "Pay and queue" ni el diálogo de moneda insuficiente. Crear un lobby normal
   sigue funcionando.
3. **Consola.** No aparecen errores de módulos `CurrencyDisplay`,
   `InsufficientCurrencyDialog` ni `PlutoniumIcon`, ni
   `Translation key not found` por `lobby_modal.queue*`,
   `store.insufficient_currency*` o `cosmetics.soft`/`cosmetics.hard`.

### `window.adsEnabled`

- Se eliminó la asignación en `Main.ts` junto con el resto de la publicidad.
- `src/client/Auth.ts` todavía lo menciona en un comentario sobre el flujo de
  sesión.

**Cuándo:** Fase 2, con el login.

## Ruido de consola esperado hasta Fase 2

Con el cliente levantado y el API de `localhost:8787` apagado, la consola del
navegador muestra errores que **no son regresiones**. Desaparecen cuando ese
API está arriba:

- **CORS / `Failed to fetch`** en `cluster.json`, `auth/refresh` y
  `cosmetics.json`. El cliente los pide a `8787`; sin server, el navegador corta
  la petición.
- **`Server list API unreachable` / `Server list API still unreachable`**:
  `ServerList.ts` cae al fallback offline.
- **`Lobby socket ... closed (1001/1006)`**: Vite proxya `/w1` a `8787`; sin
  server el WebSocket se cierra y `LobbySocket` reintenta.
- **`No JWT found`, `Refreshing jwt`, `Refresh failed`**: no hay sesión y el
  endpoint de refresh no responde.
- **`Permissions Policy: Skipping unsupported feature name ...`**: los emite
  el navegador al leer el atributo `allow` del iframe de `HelpModal` y el de
  Cloudflare Turnstile. Son avisos por features que el navegador no reconoce,
  no errores de la app.
- **`SpawnExecution: cannot spawn Antarctica`**: el mapa World no encuentra
  tile de spawn para Antártida. Es una advertencia del engine, no un fallo de
  arranque.

`start:server-dev` no levanta el API de `8787`: abre el game server en `3000`
(con workers en `3001`/`3002`). Por eso los errores de API siguen apareciendo
aunque ese comando esté corriendo. El `500` de `http://localhost:3000/` viene de
que falta `static/index.html`, no de un puerto mal configurado.

**Confirmación pre-Fase 1.** En un worktree de `main` (`6b9933ea6`) se verificó
que ambos avisos ya existían: el iframe de `HelpModal.ts` con
`allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope;
picture-in-picture; web-share"` viene de `0fb2ee19b2` (15 sep 2026) y el
`console.warn` de `SpawnExecution.ts` viene de `6112547273` (20 dic 2025); el
archivo se movió después en `377db1773`. Ninguno de los dos archivos cambió
entre `main` y la rama de Fase 1. Los avisos de Turnstile vienen de
`challenges.cloudflare.com/turnstile/v0/api.js`, que también está en `main`.

**Qué mirar en su lugar.** Para detectar regresiones reales, ignorá esa lista y
buscá errores de módulos borrados, `Translation key not found`, o fallos del
render/WebGL. El smoke test de cada grupo está arriba.

### Worktree de verificación bloqueado

El worktree temporal que se usó para comparar contra `main` quedó con un
directorio que Windows no deja borrar desde Git:

`C:\Users\esteban.rey\AppData\Local\Temp\opencode\frontwars-main`

Ya no aparece en `git worktree list`. Para limpiarlo del todo, borrar la carpeta
a mano y podar la metadata:

```powershell
Remove-Item -Recurse -Force C:\Users\esteban.rey\AppData\Local\Temp\opencode\frontwars-main
git worktree prune
```

No afecta al repo ni a la rama; es sólo basura local de la verificación.

## Economía interna: qué se conserva

### `SubscriptionPolicy.ts` se borró

- `STEAM_TIER_CHANGE_IN_APP = false` — 4c (`cf37651a1`).

**Por qué:** era una constante pura sin lógica de pago. 4b-2 borró su último
consumidor, así que no quedaba nada que la leyera.

### `CurrencyDisplay` e `InsufficientCurrencyDialog` se borraron

- `CurrencyDisplay` — 5g (`1dc1c0815`).
- `InsufficientCurrencyDialog` — 5g (`fc149b20b`).

**Por qué:** eran UI de economía interna (plutonio/caps), no checkout.
`CurrencyDisplay` lo usaba `AccountModal`; `InsufficientCurrencyDialog` lo usaba
`HostLobbyModal` para la cola paga. Con la cuenta sin saldo visible y la cola
paga eliminada, no quedaba ningún consumidor.

**Cuándo:** hecho.

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
- `src/client/Api.ts` conserva `createPaymentsCheckout`, `finalizeSteamOrder`,
  `queueLobby` y sus tipos, ya sin consumidores en el cliente. Se van con el
  recorte de `Api.ts` (Grupo 6) o con la reescritura del netcode.
- `ClientEnv.stripePublishableKey()` y el bloque `stripePublishableKey` de
  `index.html`/`RenderHtml`/`ServerEnv` quedaron sin consumidor al borrar
  `StripeInline`. Son config del bootstrap; se van con el recorte de `Api.ts` o
  con Fase 2.
- `src/server` conserva los endpoints de pago; son server, no entran en la
  limpieza del cliente. Fase 2.
