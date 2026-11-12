# Fase 2 · Insumos para el reemplazo de red

**Estado:** investigación de código, sin diseño final.
**Base:** rama `fase-1-limpieza`, commit `74c1843f6`.
**Alcance:** leer el cliente, el servidor, `packages/shared` y el punto del engine
donde se generan los hashes. No se ejecutó el juego, no se levantó Supabase y no
se modificó código.

Este documento reúne lo que hoy existe para que la Fase 2 pueda decidir sin
adivinar. No propone una arquitectura, no elige tablas ni canales, y no marca
como definitivo nada que no esté respaldado por el código o por una fuente
externa citada.

**Leyenda**

- **Confirmado:** se leyó en el código de este repositorio.
- **No confirmado:** es una consecuencia, una estimación o un dato externo que
  todavía necesita verificación en un entorno real.

---

## Resumen de los nueve temas

| #   | Tema                                        | Qué deja para Fase 2                                                                 |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Arquitectura de red actual                  | Dos sockets, un API HTTP externo y el servidor Node con master/workers.               |
| 2   | Mensajes del socket de juego                | 10 mensajes cliente→servidor y 10 servidor→cliente, con frecuencias y mensajes muertos. |
| 3   | Mensajes del socket de lobby                | `full` y `counts`, quién los genera y cada cuánto.                                    |
| 4   | Frecuencias, límites y ciclo de vida         | Turnos, pings, reconexión, límites por cliente y reaping de partidas.                 |
| 5   | URLs, HTTP y comportamiento ante fallos      | Qué host se usa, qué endpoints existen y qué hace el cliente cuando fallan.           |
| 6   | Autoridad del servidor y datos sensibles     | Qué decide el servidor, qué se queda en el cliente y qué nunca debe salir.            |
| 7   | Late join, reconexión y singleplayer/replay  | Cómo se reengancha alguien, por qué no hay snapshots y cómo funciona el modo local.   |
| 8   | Dependencias de Node y despliegue            | Qué necesita un proceso Node real y por qué Vercel no lo puede hospedar tal cual.     |
| 9   | Riesgos de Supabase Realtime                 | Límites documentados y puntos que el netcode actual resuelve y Supabase no promete.   |

---

## 1. Arquitectura de red actual

### 1.1 Vista general

El cliente es una aplicación web estática servida por Vite. La simulación corre
en un Web Worker del navegador, no en el servidor:

- `src/client/WorkerClient.ts:32-40` crea el worker del juego.
- `src/client/ClientGameRunner.ts:698` y `:1009` lo instancian y arrancan.
- El servidor no simula la partida normal; recibe intents, arma turnos y
  retransmite.

El servidor Node tiene dos procesos lógicos:

- **Master:** `src/server/Server.ts:1-19` usa `cluster`; el primario llama a
  `startMaster()`.
- **Workers:** cada worker llama a `startWorker()` y atiende un subconjunto de
  partidas.
- El master escucha en `3000` (`src/server/Master.ts:286-288`); los workers en
  `3001 + índice` (`src/server/ServerEnv.ts:148-153`).

El master sirve el shell HTML, estáticos y el listado de lobbies. Los workers
sirven el HTTP de juego y los WebSockets.

### 1.2 Los dos WebSockets

1. **Lobby público**
   - URL: `${ClientEnv.serverWsBase()}${workerPath}/lobbies?platform=...`
     (`src/client/LobbySocket.ts:173-175`).
   - El upgrade se enruta en `WorkerLobbyService` cuando el path termina en
     `/lobbies` (`src/server/WorkerLobbyService.ts:302-314`).
   - Es de sólo bajada: si el cliente manda un mensaje, el servidor termina la
     conexión (`src/server/WorkerLobbyService.ts:336-338`).

2. **Juego**
   - URL: `${ClientEnv.gameWsBase(gameID)}/${workerPath}`
     (`src/client/Transport.ts:468-470`).
   - El mismo upgrade handler manda todo lo que no es `/lobbies` al WebSocket de
     juego (`src/server/WorkerLobbyService.ts:302-314`).

Los dos sockets usan **zbin binario**, sin JSON, sin negociación y sin byte de
versión (`packages/shared/src/ZbinWire.ts:1-14`). El diccionario de `clientID`
se siembra desde `GameStartInfo.players`; el orden del array es parte del
contrato (`ZbinWire.ts:14-20`). El mensaje `start` se codifica sin contexto
porque es el que siembra la tabla (`ZbinWire.ts:48-58`).

### 1.3 Desarrollo local

`vite.config.ts:466-494` proxya:

- `/lobbies` → `ws://localhost:3000`
- `/w0` → `ws://localhost:3001`
- `/w1` → `ws://localhost:3002`
- `/api` → `http://localhost:3000`

El API de cuentas, sesión, cosméticos, historial y `cluster.json` **no está en
este repositorio**. En local apunta a `http://localhost:8787`
(`src/client/ApiBase.ts:10-18`) y se documenta como deuda de Fase 2 en
`docs/FASE-1-PENDIENTES.md:366-372`.

### 1.4 Resolución de host

`ClientEnv` decide el host del juego y del API:

- `gameWsBase`/`gameHttpBase` resuelven el servidor que posee el `gameID`
  (`src/client/ClientEnv.ts:305-313`).
- `serverWsBase`/`serverHttpBase` usan el servidor elegido por el listado, el
  `serverHost` inyectado o el mismo origen (`ClientEnv.ts:431-459`).
- Si la página no tiene servidor propio y el listado no trae uno, los accessors
  lanzan `NoServerError` en lugar de construir una URL contra un host que no
  puede responder (`ClientEnv.ts:423-430`).
- Un `gameID` de 10 caracteres puede resolver a otro host por su letra inicial
  (`ClientEnv.ts:531-560`).

> **No confirmado:** el comportamiento exacto del edge que enruta `/wN` y
> `/lobbies` en producción no está en este repo. Lo que sí está confirmado es
> que el cliente espera un prefijo `/wN` y que el servidor lo atiende.

---

## 2. Mensajes del socket de juego

### 2.1 Cliente → servidor

La unión está en `packages/shared/src/WireSchemas.ts:756-767`.

| Mensaje     | Para qué sirve                                                                 | Frecuencia actual                                                                 | Evidencia |
| ----------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------- |
| `join`      | Entrada autenticada a una partida. Lleva token, nombre, clan, cosméticos, Turnstile, spectator, commit, plataforma y device. | Una vez por intento de entrada. | `WireSchemas.ts:714-736`; `Transport.ts:710-728` |
| `rejoin`    | Reconectar una conexión ya admitida. Lleva `lastTurn` para recibir lo que falta. | Una vez por reconexión; máximo 5/min. | `WireSchemas.ts:738-746`; `Transport.ts:731-739`; `ClientMsgRateLimiter.ts:7-11` |
| `ping`      | Latido y medición de RTT. El servidor responde `pong`. | Cada 5 s. | `WireSchemas.ts:681-687`; `Transport.ts:385-394` |
| `intent`    | Acción del jugador (spawn, ataque, alianza, construcción, etc.). | Por evento; 10/s y 150/min; máximo 2 KB por intent. | `WireSchemas.ts:689-692`; `ClientMsgRateLimiter.ts:4-6` |
| `hash`      | Hash del estado para detectar desync. | Cada 10 ticks del engine, aproximadamente 1/s. | `WireSchemas.ts:669-673`; `packages/engine/src/game/GameImpl.ts:636` |
| `winner`    | Voto de ganador y estadísticas finales. | Al terminar la partida, por cliente. | `WireSchemas.ts:607-611`; `GameServer.ts:2190-2230` |
| `live_stats`| Snapshot de estadísticas para el admin bot. | Cada 100 turnos, aproximadamente 10 s, sólo si la partida lo habilita. | `WireSchemas.ts:639-642`; `src/client/controllers/LiveStatsController.ts:7-12` |
| `report`    | Reporte de otro jugador. | Por evento. | `WireSchemas.ts:653-667` |
| `spectate`  | Cambiar entre jugar y mirar, sólo en lobby. | Por evento. | `WireSchemas.ts:748-754` |
| `log`       | Existe en el schema, pero **no se encontró productor ni consumidor** en `src/client` ni `src/server`. | No aplica hoy. | `WireSchemas.ts:675-679` |

Notas confirmadas:

- `join.token` está marcado como PII en el propio schema
  (`WireSchemas.ts:712-716`). No debe loggearse ni reenviarse.
- `hash` y `report` están bloqueados para espectadores
  (`src/server/SocketIngress.ts:18-28`).
- `live_stats` y `winner` se votan por mayoría ponderada por IP; los clientes
  desincronizados no votan (`GameServer.ts:2190-2205`, `2259-2274`).
- El servidor estampa `clientID` y `reportedBy`; el cliente no los manda
  (`WireSchemas.ts:662-663`; `GameServer.ts:776-779`).

### 2.2 Servidor → cliente

La unión está en `WireSchemas.ts:589-601`.

| Mensaje       | Para qué sirve                                                                 | Cuándo se envía                                                                 | Evidencia |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------- |
| `turn`        | Turno autoritativo: número e intents.                                           | Cada 100 ms mientras la partida corre.                                          | `WireSchemas.ts:486-489`; `GameServer.ts:1160-1163`, `1464-1496` |
| `start`       | `gameStartInfo`, `myClientID`, `groupToken` y los turnos que el cliente no vio. | Al empezar, al entrar tarde o al reconectar.                                    | `WireSchemas.ts:513-527`; `GameServer.ts:1414-1455` |
| `lobby_info`  | Estado del lobby y `myClientID`/`groupToken`.                                  | Cada 1 s mientras el lobby está abierto.                                        | `WireSchemas.ts:552-564`; `GameServer.ts:1026-1037` |
| `pong`        | Eco del `sentAt` del ping.                                                      | Como respuesta a cada `ping`.                                                   | `WireSchemas.ts:574-578`; `GameServer.ts:793-807` |
| `prestart`    | Mapa y tamaño para que el cliente vaya cargando.                               | Una vez, al pasar a `prestart`.                                                 | `WireSchemas.ts:495-499`; `GameServer.ts:956-986` |
| `desync`      | Hash correcto, clientes correctos y total activo.                              | Cuando la comparación de hashes encuentra divergencia.                          | `WireSchemas.ts:529-538`; `GameServer.ts:2149-2187` |
| `error`       | Error de protocolo, admisión o partida.                                        | En rechazos y fallos.                                                           | `WireSchemas.ts:540-550` |
| `new_lobby`   | `gameID` del lobby sucesor de una partida privada.                             | Cuando el host crea el siguiente lobby.                                         | `WireSchemas.ts:566-572` |
| `redirect`    | `gameID` del lobby hermano al que el pool deriva al jugador.                   | Antes de cerrar la conexión.                                                    | `WireSchemas.ts:580-587`; `GameServer.ts:556-573` |
| `ping`        | Existe en el schema, pero **no se encontró un productor** en `src/server`.      | No aplica hoy.                                                                  | `WireSchemas.ts:491-493` |

### 2.3 Frecuencia de hashes y desync

- El engine emite un `HashUpdate` cada 10 ticks (`GameImpl.ts:636`).
- `DesyncDetector` compara cada 10 turnos, mirando el turno 10 atrás
  (`src/server/DesyncDetector.ts:72-104`).
- Si un cliente tiene otro hash, el servidor le manda `desync` una sola vez y
  deja de contar sus votos (`DesyncDetector.ts:106-119`;
  `GameServer.ts:2149-2187`).
- El turno guarda el hash mayoritario (`GameServer.ts:2154-2158`).

### 2.4 Puntos que Fase 2 no puede perder

- El orden y la integridad de `turn`.
- La asociación entre `clientID` y diccionario zbin.
- La posibilidad de pedir “desde `lastTurn`” sin huecos.
- El contrato de `start` como mensaje que siembra el diccionario.
- La distinción entre mensajes de jugador y mensajes de espectador.

---

## 3. Mensajes del socket de lobby

El lobby público usa `PublicLobbyMessageSchema` (`WireSchemas.ts:290-330`):

| Mensaje   | Contenido                                                            | Cuándo                                            | Evidencia |
| --------- | -------------------------------------------------------------------- | ------------------------------------------------- | --------- |
| `full`    | Snapshot completo de lobbies, `serverTime`, commit y `active`.       | Al conectar y cuando cambia la huella del listado. | `WireSchemas.ts:300-317`; `WorkerLobbyService.ts:325-335`, `369-396` |
| `counts`  | Solo `gameID → numClients` y `serverTime`.                           | Cuando la estructura no cambió.                   | `WireSchemas.ts:319-323`; `WorkerLobbyService.ts:397-409` |

Frecuencias y mecánica:

- El master llama a `broadcastLobbies()` cada 500 ms
  (`src/server/MasterLobbyService.ts:268-269`).
- El worker compara una huella del listado saneado; si cambió manda `full`, si
  no manda `counts` (`WorkerLobbyService.ts:375-409`).
- Al conectar, el worker manda el último `full` para que el cliente tenga una
  base antes de recibir deltas (`WorkerLobbyService.ts:322-335`).
- El socket es sólo de bajada; cualquier mensaje del cliente termina la
  conexión (`WorkerLobbyService.ts:336-338`).
- El listado se sanea antes de salir: `creatorID`, `createdAt`, `queuedAt` y
  demás campos internos no se envían (`WorkerLobbyService.ts:279-300`).

---

## 4. Frecuencias, límites y ciclo de vida

### 4.1 Ritmo del servidor

| Elemento                         | Valor / comportamiento                                      | Evidencia |
| -------------------------------- | ----------------------------------------------------------- | --------- |
| Turno de partida                 | Cada `100 ms`.                                              | `src/server/ServerEnv.ts:136-138`; `GameServer.ts:1160-1163` |
| Broadcast de `lobby_info`        | Cada `1 s`; se detiene al empezar o al quedar vacío.         | `GameServer.ts:1026-1037` |
| Tick de `GameManager`            | Cada `1 s`; poda, auto-start, prestart y reaping.            | `src/server/GameManager.ts:35`, `175-241` |
| Broadcast del listado de lobbies | Cada `500 ms` en el master.                                 | `MasterLobbyService.ts:268-269` |
| Duración máxima de partida       | 3 horas.                                                    | `GameServer.ts:215`, `1594-1595` |
| Cliente sin ping                 | Se poda a los 60 s.                                         | `GameServer.ts:1558-1576` |
| Estado “disconnected”            | A los 30 s sin ping; se revisa cada 5 turnos.                | `GameServer.ts:217`, `1885-1901` |
| Partida vacía                    | Reaping a los 20 s sin pings y 30 s de warmup; backstop de 10 min. | `GameServer.ts:1635-1655` |
| Arranque                         | `prestart` y luego `start()` con 2 s de margen.              | `GameManager.ts:199-217` |

### 4.2 Ritmo del cliente

| Elemento                  | Valor / comportamiento                                         | Evidencia |
| ------------------------- | -------------------------------------------------------------- | --------- |
| Ping                      | Cada 5 s.                                                      | `Transport.ts:385-394` |
| Watchdog de silencio      | Arranca a los 20 s y revisa cada 1 s; reconecta tras 5 s sin mensajes. | `ClientGameRunner.ts:970-977`, `1627-1639` |
| Reconexión                | Hasta 10 intentos; 1 s a 15 s con jitter; ~90 s nominales.      | `Transport.ts:243-253`, `655-695` |
| Rejoin                    | Como máximo 5 por minuto.                                      | `ClientMsgRateLimiter.ts:7-11` |
| Intents                   | 10/s, 150/min, 2 KB cada uno, 5 MB acumulados por cliente.      | `ClientMsgRateLimiter.ts:4-12` |
| Payload máximo WS de juego| 1 MB.                                                          | `Worker.ts:73-74`, `245-248` |
| Payload máximo WS de lobby| 256 KB.                                                        | `WorkerLobbyService.ts:67-70` |
| Payload HTTP JSON         | 5 MB.                                                          | `Worker.ts:242-244` |

### 4.3 Límites de admisión y abuso

- `SocketIngress` hace decodificación, validación zod, rate limit y bloqueo de
  espectadores antes de entregar el mensaje a `GameServer`
  (`src/server/SocketIngress.ts:42-45`, `108-150`).
- Un mensaje corrupto o inválido puede terminar en kick
  (`SocketIngress.ts:108-135`).
- El servidor limita a 3 IPs simultáneas por partida pública, salvo Dev
  (`GameServer.ts:636-651`).
- En producción impide dos conexiones con el mismo `persistentID` y expulsa la
  anterior (`GameServer.ts:653-685`).
- El `join` se valida con Turnstile/JWT/allowlist/trust; los detalles están en
  `Worker.ts:568-616` y `JoinVerify.ts:130-194`.

### 4.4 Cierre y errores

`packages/shared/src/CloseCodes.ts:1-32` define los códigos. Los relevantes:

- `1000` normal, terminal.
- `1002` protocolo, terminal.
- `1013` “try again later”, no terminal.
- `4000-4999` rechazos de aplicación, terminales.
- `4008` partida ya empezada.
- `4006` lobby lleno.
- `4007` worker equivocado.

El cliente trata `isTerminalClose` como fin de sesión y no reintenta
(`Transport.ts:548-572`). Para cierres no terminales programa reconexión.

---

## 5. URLs, HTTP y comportamiento ante fallos

### 5.1 Base del API

`getApiBase()` devuelve:

- `https://${API_DOMAIN}` si `API_DOMAIN` está definido en localhost.
- `localStorage.apiHost` o `http://localhost:8787` en localhost.
- `https://api.${audience}` en el resto.

Evidencia: `src/client/ApiBase.ts:7-25`.

El API de `8787` no está en el repo (`docs/FASE-1-PENDIENTES.md:366-372`). Las
llamadas que dependen de él fallan en local; el cliente ya tiene varios fallbacks
para que el juego arranque igual.

### 5.2 Inventario de endpoints del cliente

**Bootstrap y catálogo**

| Endpoint | Uso | Fallo actual | Evidencia |
| -------- | --- | ------------ | --------- |
| `GET /cluster.json?site=...` | Listado de servidores y commit. | Timeout de 4 s; conserva el último listado; cae a bootstrap. | `ServerList.ts:46-72`, `202-204`, `351-386` |
| `GET /cosmetics.json?rail=web` | Catálogo de cosméticos. | Timeout de 10 s; devuelve `null`. | `Cosmetics.ts:25`, `47-64` |
| `GET /.well-known/jwks.json` | Clave pública para validar JWT. | Lanza error; el join autenticado no puede continuar. | `ClientEnv.ts:247-267` |

**Sesión, cuenta e identidad**

| Endpoint | Uso | Fallo actual | Evidencia |
| -------- | --- | ------------ | --------- |
| `POST /auth/refresh` | Renovar JWT con cookie. | Timeout de 10 s; un 401 hace logout; 5xx/red limpia JWT y reintenta luego. | `Auth.ts:525-565` |
| `POST /auth/logout` | Cerrar sesión. | Devuelve `false`, pero igual limpia el estado local. | `Auth.ts:285-307` |
| `POST /auth/revoke` | Cerrar todas las sesiones. | Igual que logout. | `Auth.ts:285-307` |
| `GET /auth/login/{discord,google,steam}` | Iniciar OAuth. | Navegación directa; no hay manejo de error en el cliente. | `Auth.ts:101-121` |
| `GET /auth/link/google` | Vincular Google. | Devuelve `false`. | `Auth.ts:150-184` |
| `GET /auth/link/steam` | Vincular Steam. | Devuelve `false`. | `Auth.ts:197-221` |
| `POST /auth/login/token` | Login por token temporal. | `retry` si es red; `failed` si es 400. | `Auth.ts:223-276` |
| `POST /auth/{portal}` | Login de portal (fachada inerte hoy). | Limpia JWT. | `Auth.ts:606-635` |
| `POST /auth/steam` | Canje de ticket de Steam. | Timeout de 10 s; limpia JWT. | `Auth.ts:640-654` |
| `POST /auth/magic-link` | Enviar enlace mágico. | Devuelve `false`. | `Auth.ts:751-785` |
| `GET /users/@me` | Perfil, rol, settings y publicId. | Timeout de 10 s; 401 hace logout; otros errores devuelven `false`. | `Api.ts:188-249` |
| `DELETE /users/@me` | Borrar cuenta. | Devuelve `{ ok: false }`; no hay reintento. | `Api.ts:305-345` |
| `POST /marketing/consent` | Consentimiento de marketing. | Devuelve error; invalida caché si funciona. | `Api.ts:347-380` |
| `PUT /users/@me/{setting}` | Privacidad. | Devuelve error. | `Api.ts:392-430` |
| `POST /users/@me/identity_token` | Token de identidad de 10 min. | `logged_out`, `rate_limited` o `failed`. | `Api.ts:461-500` |
| `PUT /users/@me/username` | Renombrar cuenta. | `taken`, `bare_taken`, `cooldown` o `failed`. | `Api.ts:514-595` |
| `GET /public/identity_token/audiences` | Audiencias disponibles. | Fallback a lista vacía. | `Api.ts:442-451` |

**Perfiles, historial y partidas**

| Endpoint | Uso | Fallo actual | Evidencia |
| -------- | --- | ------------ | --------- |
| `GET /player/:id` | Perfil autenticado. | `false`. | `Api.ts:36-74` |
| `GET /public/player/:publicId` | Perfil público. | `false`. | `Api.ts:76-112` |
| `GET /public/player/:publicId/games` | Historial paginado. | `{ error: "failed" }`. | `Api.ts:114-160` |
| `GET /game/:id` | Registro archivado para replay. | `false`. | `Api.ts:763-797`; `JoinLobbyModal.ts:1040-1099` |
| `GET /api/game/:id/exists` | ¿El lobby existe en el worker? | `false` si no responde o no es 2xx. | `JoinLobbyModal.ts:980-994` |
| `GET /api/game/:id` | Info del lobby y `listed`. | `false`. | `Api.ts:597-615` |
| `POST /api/game/:id/listing` | Publicar/despublicar lobby. | `{ ok: false, error? }`. | `Api.ts:617-653` |
| `POST /api/create_game` | Crear lobby privado. | **Lanza** error. | `Api.ts:663-721` |
| `POST /api/create_game?previous=` | Crear lobby sucesor. | **Lanza** error. | `Api.ts:723-756` |
| `POST /api/singleplayer/:id/heartbeat` | Presencia de singleplayer. | Silencioso; si no hay host, no manda. | `SingleplayerHeartbeat.ts:8-38` |

**Saves**

| Endpoint | Uso | Fallo actual | Evidencia |
| -------- | --- | ------------ | --------- |
| `GET /users/@me/saved_games` | Listar saves. | `false`. | `SavedGamesApi.ts:57-71` |
| `POST /users/@me/saved_games` | Subir snapshot gzip. | `request_failed` o error mapeado. | `SavedGamesApi.ts:73-95` |
| `PATCH /users/@me/saved_games/:id` | Renombrar/compartir. | Error mapeado. | `SavedGamesApi.ts:97-116` |
| `DELETE /users/@me/saved_games/:id` | Borrar. | Error mapeado. | `SavedGamesApi.ts:118-131` |
| `GET /public/saved_games/:id` | Ver save compartido. | Error mapeado. | `SavedGamesApi.ts:133-146` |
| `GET /users/@me/saved_games/:id/data` | Descargar save propio. | Error mapeado. | `SavedGamesApi.ts:152-169` |
| `GET /public/saved_games/:id/data` | Descargar save compartido. | Error mapeado. | `SavedGamesApi.ts:152-169` |
| `POST /archive_singleplayer_game` | Archivar singleplayer. | Si no hay sesión, no manda; si falla, loguea. | `LocalServer.ts:351-397` |

**Servidor de juego**

| Endpoint | Uso | Evidencia |
| -------- | --- | --------- |
| `POST /api/create_game` | Crear partida privada; valida JWT y sólo acepta privadas. | `Worker.ts:334-437` |
| `POST /api/game/:id/listing` | Listar/deslistar; creator-only y con validaciones. | `Worker.ts:116-318` |
| `POST /api/game/:id/queue` | Cola paga; sigue en el servidor aunque el cliente ya no la use. | `Worker.ts:441-444` |
| `POST /api/singleplayer/:id/heartbeat` | Latido de singleplayer. | `Worker.ts:489-501` |
| `GET /api/game/:id/exists` | Existencia. | `Worker.ts:503-508` |
| `GET /api/game/:id` | `gameInfo()` saneado. | `Worker.ts:510-517` |

### 5.3 Fallos que el cliente ya tolera

- **Sin API de listado:** usa el último listado o los valores de bootstrap; el
  singleplayer sigue funcionando (`ServerList.ts:20-37`, `351-386`).
- **Sin catálogo de cosméticos:** `fetchCosmetics()` devuelve `null` después de
  10 s y el juego arranca con el catálogo vacío o fallback
  (`Cosmetics.ts:16-25`, `51-64`).
- **Sin refresh de JWT:** limpia el JWT en memoria pero conserva la cookie en
  fallos transitorios (`Auth.ts:544-563`).
- **Sin host de juego:** `Transport` captura `NoServerError` y entra en el
  camino de conexión rechazada (`Transport.ts:458-466`).
- **Sin singleplayer en línea:** `Main.ts:1242-1251` no bloquea el arranque
  local esperando un refresh de sesión.
- **Sin `/api/game/:id`:** `fetchLobbyListed` devuelve `false` y
  `JoinLobbyModal` considera que el lobby no existe o no está activo.

### 5.4 Fallos que no están resueltos

> **No confirmado:** no se verificó el comportamiento real de Vercel ante una
> ruta inexistente. Si el sitio devuelve `index.html` para cualquier path, un
> 404 de `cosmetics.json` o de `cluster.json` puede parecer un 200 con HTML y
> romper el parseo. Ya está anotado como riesgo en
> `docs/FASE-1-PENDIENTES.md:389-393`.

> **No confirmado:** los códigos de estado exactos del API externo no se pueden
> deducir del cliente. El cliente mapea 400/401/403/404/409/429 en algunos
> flujos, pero el contrato real vive fuera del repo.

---

## 6. Autoridad del servidor y datos sensibles

### 6.1 Qué sigue siendo autoridad del servidor

Aunque la simulación corra en cada cliente, el servidor actual decide:

1. **Admisión:** Turnstile, JWT, allowlist, trust, versión, límite de
   jugadores, bloqueo de IPs y sesión duplicada (`Worker.ts:568-616`,
   `GameServer.ts:528-685`).
2. **Inicio:** `prestart` y `start()`; no arranca una partida sin clientes
   (`GameManager.ts:175-217`).
3. **Orden de turnos:** crea cada turno y lo difunde (`GameServer.ts:1464-1496`).
4. **Pings y presencia:** poda a los 60 s y marca desconexión a los 30 s
   (`GameServer.ts:1558-1576`, `1885-1901`).
5. **Hashes y desync:** compara y decide el hash mayoritario
   (`GameServer.ts:2149-2187`).
6. **Votos:** ganador y live stats por mayoría de IPs
   (`GameServer.ts:2190-2274`).
7. **Replay del ganador:** si el voto es dudoso, simula la partida completa en
   un subproceso (`WinnerReplay.ts:1-30`, `71-153`;
   `GameServer.ts:1935-1999`).
8. **Archivo:** valida y sube el registro al API, con reintentos y timeout
   (`Archive.ts:15-95`).
9. **Kick/ban y cierre:** códigos de cierre y limpieza de roster
   (`CloseCodes.ts:1-32`; `GameServer.ts:838-868`).

### 6.2 Datos que no deben salir al cliente

| Dato | Por qué | Evidencia |
| ---- | ------- | --------- |
| `pool` | IDs de lobbies hermanos; son secretos de entrada. | `GameServer.ts:119-127` |
| `allowedPublicIds` | Allowlist de admisión. | `GameServer.ts:129-136` |
| `nameRevealPublicIds` | Lista de identidades reveladas. | `GameServer.ts:129-136` |
| `hashedCreatorID` | Identifica al creador sin exponer el `persistentID`, pero es interno. | `WorkerLobbyService.ts:279-300`; `GameServer.ts:115-116` |
| `persistentID` | PII; se usa para reconocer al jugador y para el hash del creador. | `WireSchemas.ts:712-716`, `773-775` |
| `groupToken` | Token de grupo que identifica a todos los jugadores de una partida. | `WireSchemas.ts:501-511`, `552-563` |
| JWT / refresh cookie / Turnstile token | Credenciales. | `Auth.ts:525-565`; `WireSchemas.ts:712-716` |

Matices importantes:

- `groupToken` **sí** se envía a los participantes por diseño
  (`WireSchemas.ts:501-511`). No debe aparecer en registros públicos ni en
  telemetría. `Transport` evita loggear el frame de error justamente porque
  `lobby_info` y `start` lo llevan en claro (`Transport.ts:521-538`).
- `GameInfo` se sanea en el servidor antes de responder por HTTP
  (`GameServer.ts:129-136`; `Worker.ts:510-517`).
- El listado público se sanea en `WorkerLobbyService` antes de emitir `full`
  (`WorkerLobbyService.ts:279-300`, `369-395`).
- `ipAnonymize` se usa en logs de admisión (`GameServer.ts:630-634`), pero la IP
  completa se usa para límites y votos.

### 6.3 Lo que el cliente puede falsificar hoy

El cliente corre la simulación, pero el servidor no acepta cualquier cosa:

- `intent` se valida con `IntentSchema` y se estampa con el `clientID` de la
  conexión (`WireSchemas.ts:689-692`; `GameServer.ts:775-782`).
- `hash` se usa sólo para desync; no concede estado.
- `winner` y `live_stats` se votan por IP y se ignoran si el cliente está
  desincronizado (`GameServer.ts:2190-2205`, `2259-2274`).
- `report` se guarda fuera del turn log y se estampa con el emisor
  (`WireSchemas.ts:653-667`).

> **No confirmado:** no se revisó el contenido completo de `IntentSchema` ni
> todas las validaciones de `Gatekeeper`. Lo que sí está confirmado es que el
> servidor no confía en el `clientID` que manda el cliente.

---

## 7. Late join, reconexión y singleplayer/replay

### 7.1 Entrada tarde a una partida

`joinClient` decide (`GameServer.ts:582-605`):

1. Si el `gameID` fue derivado a un lobby hermano, manda `redirect` y termina.
2. Si la partida ya empezó, intenta `rejoinClient` con `lastTurn = 0`.
3. Si el jugador no estaba en el roster y no es espectador, y pasaron menos de
   5 s desde el inicio, manda `error: game-started`.
4. Si pasó la ventana, lo convierte en espectador.

Un espectador que llega después del inicio recibe `start` con todos los turnos
(`GameServer.ts:700-703`). No hay snapshot en multijugador.

### 7.2 Reconexión

- El cliente reconecta y manda `rejoin` con `turnsSeen`
  (`ClientGameRunner.ts:1044-1048`; `Transport.ts:731-739`).
- `turnsSeen` arranca en 0 (`ClientGameRunner.ts:917`). Un refresh de página,
  por lo tanto, pide la partida completa.
- `sendStartGameMsg` manda `this.turns.slice(lastTurn)`
  (`GameServer.ts:1414-1455`).
- El servidor conserva el asiento y el mapeo de reconexión mientras la partida
  no haya terminado (`GameServer.ts:708-752`, `838-868`).
- Si el cliente no vuelve, se poda a los 60 s (`GameServer.ts:1558-1576`).
- El cliente tiene watchdog de 5 s de silencio y hasta 10 reintentos
  (`ClientGameRunner.ts:1627-1639`; `Transport.ts:243-253`).

### 7.3 Por qué no hay snapshots

`ServerStartGameMessageSchema.turns` es el mecanismo de recuperación
(`WireSchemas.ts:513-527`). No se encontró un mensaje de snapshot ni una ruta
que lo genere en `GameServer`/`Worker`/`GameManager`. La única snapshot que
existe es la de saves de singleplayer (`SavedGamesApi.ts`), no la de una partida
multijugador en curso.

Consecuencia confirmada: un late join o un refresh que pide `lastTurn = 0`
recibe **todos** los turnos. En una partida larga esto crece sin límite y es el
punto más delicado para cualquier transporte con tope de payload.

### 7.4 Singleplayer

- `LocalServer` corre en el mismo navegador, no hay WebSocket
  (`src/client/LocalServer.ts:49-81`).
- Revisa el reloj cada 5 ms y emite un turno cada 100 ms
  (`LocalServer.ts:91-112`).
- El `start` local manda `turns: []` y `myClientID`
  (`LocalServer.ts:152-159`).
- El heartbeat de presencia va al worker cada 60 s
  (`SingleplayerHeartbeat.ts:8-38`).
- Al ganar o al cerrar, archiva el registro en
  `POST /archive_singleplayer_game` (`LocalServer.ts:253-260`, `351-397`).
- En replay, lee el registro, verifica hashes cada 100 turnos y compara contra
  el archivado (`LocalServer.ts:140-143`, `216-251`).

### 7.5 Replay multijugador

- `JoinLobbyModal` pide `GET /game/:id` y valida el `gitCommit` del registro
  contra el build actual (`JoinLobbyModal.ts:1040-1099`).
- Si no coincide, intenta redirigir a la versión correcta; si no, muestra
  `version_mismatch`.
- El replay se simula localmente, con el mismo `LocalServer` y el registro
  archivado (`Main.ts:1286-1294`).

### 7.6 Replay autoritativo del ganador

- Si el voto de ganador es dudoso, el servidor simula la partida completa en un
  subproceso (`WinnerReplay.ts:1-30`).
- El subproceso corre con prioridad baja, hasta 30 min y 2 GB de heap
  (`WinnerReplay.ts:24-30`, `90-100`).
- Si el replay falla, se archiva el voto sin confirmar
  (`GameServer.ts:1935-1999`).

> **No confirmado:** no se midió cuántos turnos puede llegar a tener una partida
> real ni cuánto pesa el `start` con historial completo. El riesgo estructural
> está confirmado; el número exacto depende del juego.

---

## 8. Dependencias de Node y despliegue

### 8.1 Procesos y librerías

El servidor actual no es una función serverless. Es un proceso Node de larga
duración con:

- `cluster` (`src/server/Server.ts:1-19`).
- `express` + `http` en master y workers (`Master.ts:4-7`;
  `Worker.ts:28-34`).
- `ws` para dos WebSocket servers (`Worker.ts:35`, `245-248`;
  `WorkerLobbyService.ts:12`, `67-70`).
- `compression`, `express-rate-limit`, `limiter`, `ip-anonymize`
  (`Worker.ts:28-32`; `ClientMsgRateLimiter.ts:1-2`).
- `winston` (`GameServer.ts:63`; `Logger.ts:9`).
- `node-html-parser` (`GamePreviewRoute.ts:6`).
- `jose` para JWT (`ServerEnv.ts:9`).
- `dotenv` (`Server.ts:2`, `7`).
- `tsx`/`ts-node` para ejecutar TypeScript (`package.json`).
- `child_process.fork` para `WinnerReplay` (`WinnerReplay.ts:3`, `90-95`).
- `node:fs`, `node:path`, `node:url`, `node:os`, `node:crypto`
  (`WinnerReplay.ts:3-6`; `Gatekeeper.ts:1-3`; `Master.ts:6-8`).
- `process.env` para configuración (`ServerEnv.ts:24-35`, `173-175`).
- IPC entre master y workers (`WorkerLobbyService.ts:73`, `setupIPCListener`).

### 8.2 Por qué Vercel no lo puede hospedar tal cual

El despliegue objetivo de AGENTS.md es un sitio estático en Vercel. El repo no
tiene `vercel.json` ni un adapter serverless. El servidor actual necesita:

- procesos persistentes con `cluster`;
- sockets abiertos durante horas;
- timers de 100 ms y 1 s;
- filesystem para mapas, estáticos y HTML;
- subprocesos para el replay del ganador;
- estado en memoria (`GameManager`, roster, votos, buffers).

Nada de eso encaja con una función serverless tal cual. La Fase 2 tiene que
decidir qué parte de esa autoridad se mueve a Supabase, qué parte se queda en
un proceso aparte y qué parte se elimina. Ese diseño no está en este documento.

### 8.3 Restos de Node en el cliente

El cliente todavía menciona `process.env.API_DOMAIN` y tipos `NodeJS.Timeout`:

- `src/client/ApiBase.ts:11`.
- `src/client/ClientGameRunner.ts:925-926`.
- `src/client/LocalServer.ts:72`.

No ejecuta Node en el navegador. `vite.config.ts:426-429` reemplaza
`process.env.API_DOMAIN` en build y los `NodeJS.Timeout` son sólo tipos. No es
un runtime Node real.

---

## 9. Riesgos de Supabase Realtime

Esta sección usa la documentación pública de Supabase consultada el 2026-10-28.
No es un diseño ni una prueba de integración.

### 9.1 Límites documentados

Según `https://supabase.com/docs/guides/realtime/limits`:

| Límite | Free | Pro | Pro sin spend cap |
| ------ | ---- | --- | ----------------- |
| Conexiones concurrentes | 200 | 500 | 10.000 |
| Mensajes por segundo | 100 | 500 | 2.500 |
| Channel joins por segundo | 100 | 500 | 2.500 |
| Canales por conexión | 100 | 100 | 100 |
| Presence keys por objeto | 10 | 10 | 10 |
| Presence messages por segundo | 20 | 50 | 1.000 |
| Presence calls por cliente cada 30 s | 5 | 5 | 5 |
| Payload de Broadcast | 256 KB | 3.000 KB | 3.000 KB |
| Retención de replay | 72 h | 72 h | 72 h |
| Mensajes de replay por request | 25 | 25 | 25 |

Según `https://supabase.com/sla`, Realtime **no garantiza entrega**: no hay
at-least-once, exactly-once ni at-most-once. La documentación de Broadcast
tampoco promete un orden global. Esto es un riesgo directo para un lockstep que
necesita que todos los clientes vean los turnos en el mismo orden.

### 9.2 Riesgos concretos

1. **Entrega y orden de turnos**
   - El lockstep actual depende de un orden autoritativo que produce
     `GameServer.endTurn()` (`GameServer.ts:1464-1496`).
   - Broadcast es efímero y no promete entrega ni orden.
   - Numerar y bufferizar turnos del lado del cliente es una posibilidad, pero
     no está diseñada ni probada.

2. **Payload del `start`**
   - `start` manda todos los turnos desde `lastTurn`
     (`GameServer.ts:1414-1455`; `WireSchemas.ts:513-527`).
   - Un refresh pide `lastTurn = 0` (`ClientGameRunner.ts:917`, `1044-1048`).
   - El límite de Broadcast es 256 KB en Free y 3 MB en Pro. Una partida larga
     puede superar ambos.
   - No hay snapshot multijugador que reemplace ese historial.
   - **No confirmado:** el peso real de una partida de 20 jugadores. El riesgo
     es estructural.

3. **Límite de mensajes por segundo**
   - El servidor emite 10 turnos/s; con 20 clientes son 200 entregas/s sólo por
     turnos, sin contar pings, hashes, `lobby_info`, `live_stats` ni votos.
   - Free (100 msg/s) no alcanza para ese fan-out. Pro (500 msg/s) queda justo.
   - **No confirmado:** si el límite de Supabase cuenta cada entrega a cada
     suscriptor o cada mensaje publicado. Hay que medirlo con el plan real.

4. **Presencia**
   - Presence está pensada para estado, no para 10 mensajes/s.
   - El límite de 5 updates por cliente cada 30 s es incompatible con un pulso
     de juego frecuente.
   - No reemplaza `lobby_info` ni el roster autoritativo.

5. **Reconexión y recuperación**
   - Supabase puede reconectar el canal, pero no reconstruye por sí solo los
     turnos perdidos.
   - El replay de 72 h y 25 mensajes por request no es un historial de turnos.
   - El cliente actual pide “desde `lastTurn`” y el servidor responde con el
     slice; si ese slice se pierde, no hay un mecanismo equivalente probado.

6. **Autoridad y trampas**
   - Hoy el servidor decide admisión, allowlist, trust, versión, límite de
     jugadores, kick/ban, orden de turnos y replay del ganador.
   - En un canal de Broadcast, cualquier cliente que pueda publicar puede
     intentar mandar turnos, votos o `live_stats` falsos.
   - RLS/private channels protegen el acceso al canal, pero no validan que un
     mensaje sea una jugada legal ni que el orden sea el correcto.
   - **No confirmado:** si se puede implementar una autoridad equivalente con
     Edge Functions, una tabla de secuencia o un proceso aparte sin volver a un
     servidor persistente. Es una decisión de Fase 2.

7. **Identidad y sesión**
   - El cliente actual usa JWT, refresh cookie, `persistentID` de invitado y
     `getPlayToken()` (`Auth.ts:787-801`).
   - Supabase Auth emite otros tokens y usa RLS. Migrar la identidad de invitado
     sin perder continuidad es un problema abierto.
   - El `anon key` es público; el `service_role` nunca puede llegar al cliente.

8. **Ciclo de vida**
   - Hoy hay reaping de partidas vacías, límite de 3 h, corte de inactividad y
     cierre por fin de partida (`GameServer.ts:215-222`, `1592-1655`).
   - Broadcast no tiene un “dueño” que ejecute ese ciclo. Hace falta una tabla,
     un cron, una Edge Function o un proceso que lo haga.
   - **No confirmado:** los límites de tiempo de Edge Functions y su costo para
     partidas de 3 h.

9. **Replay del ganador**
   - `WinnerReplay` simula la partida completa en un subproceso Node
     (`WinnerReplay.ts:1-30`, `71-153`).
   - Ese subproceso no corre en Vercel ni en el runtime de Realtime.
   - Si se elimina, el ganador queda sólo en manos del voto de los clientes.
   - Si se conserva, necesita un entorno de ejecución aparte.

10. **Protocolo binario zbin**
    - El wire actual es binario y no tiene byte de versión
      (`ZbinWire.ts:1-14`).
    - Broadcast suele transportar JSON. **No confirmado:** si acepta binario
      sin recodificar.
    - Si hay que pasar a JSON o base64, cambia el tamaño, el costo y el contrato
      de compatibilidad entre builds.

11. **Listado de lobbies**
    - Hoy el master agrega todos los workers cada 500 ms y manda `full` o
      `counts` (`MasterLobbyService.ts:268-269`;
      `WorkerLobbyService.ts:369-409`).
    - Supabase Presence/Broadcast no da por sí solo un snapshot agregado y
      consistente de todos los lobbies, ni limpia “fantasmas” con la misma
      semántica que el reaping actual.

12. **Observabilidad y abuso**
    - Hoy hay rate limits por cliente, límite de IPs, anonymización de IPs en
      logs y métricas (`ClientMsgRateLimiter.ts:4-12`; `GameServer.ts:636-651`).
    - En Supabase hay que reproducir esos límites y la trazabilidad sin exponer
      `persistentID`, tokens ni IPs.

### 9.3 Lo que Supabase sí resuelve bien

No todo es riesgo:

- Reconexión de bajo nivel del WebSocket.
- Canales privados y RLS para separar partidas.
- Persistencia de mensajes si se usa replay.
- Presencia para estados simples.
- Una base Postgres para guards, saves, historial y metadatos.

La decisión de Fase 2 es qué parte del netcode actual se puede apoyar en eso y
qué parte necesita autoridad propia.

---

## Preguntas que Fase 2 debe responder

Estas preguntas no tienen respuesta en este documento a propósito:

1. ¿Quién numera y ordena los turnos si no hay `GameServer`?
2. ¿Cómo se recupera un cliente que pidió `lastTurn = 0` sin mandar toda la
   partida por Broadcast?
3. ¿Se conserva zbin o se reemplaza por un protocolo textual?
4. ¿Dónde vive el roster autoritativo y quién aplica allowlist, trust, bans y
   límite de jugadores?
5. ¿Quién decide el ganador y qué pasa con `WinnerReplay`?
6. ¿Cómo se conserva la identidad de invitado y el `persistentID`?
7. ¿Dónde se guardan los registros archivados y los saves?
8. ¿Quién ejecuta el reaping de partidas vacías y el límite de 3 h?
9. ¿Cómo se mide el fan-out real de mensajes por segundo con 20 jugadores?
10. ¿Qué pasa si Supabase no entrega un turno o lo entrega fuera de orden?
11. ¿Cómo se evita que un cliente publique turnos o votos falsos?
12. ¿Qué parte del servidor actual se queda en un proceso Node aparte?

---

## Evidencia que no se pudo confirmar

- El comportamiento real del edge que enruta `/wN` y `/lobbies`.
- El contrato de estados HTTP del API externo de `8787`.
- El peso real de `start` con historial completo en una partida de 20 jugadores.
- El fan-out real de mensajes de Supabase según el plan.
- Si Broadcast acepta binario sin recodificar.
- Los límites de Edge Functions para partidas de 3 h.
- La compatibilidad de identidad de invitado entre el JWT actual y Supabase Auth.

---

## Fuera de alcance

Este documento **no**:

- elige tablas, canales, políticas RLS ni Edge Functions;
- decide si zbin se conserva;
- decide si el servidor Node desaparece o queda como proceso auxiliar;
- implementa ni modifica código;
- cierra la Fase 1 ni crea el tag `fase-1-completa`.
