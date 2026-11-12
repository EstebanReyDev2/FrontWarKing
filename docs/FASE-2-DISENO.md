# Fase 2 · Diseño de red con Supabase Realtime

**Estado:** diseño aprobado con cambios. Bloque 1 (puro) en implementación.
**Fecha:** 2026-10-29.
**Alcance:** transporte del socket de juego multijugador y el mínimo de lobby/identidad necesario para F2a. No incluye API de cuentas, moderación, replay del ganador ni persistencia de partidas.

---

## 1. Resumen ejecutivo

La partida sigue siendo lockstep determinista: el engine corre en cada cliente y todos ejecutan los mismos turnos en el mismo orden. Lo que cambia es quién arma ese orden y cómo se reparte.

- El **host** es un cliente más. Es la única autoridad de numeración y contenido de los turnos.
- Cada batch viaja firmado por `term` (término numérico) y `hostID`. Los clientes aceptan sólo el siguiente turno, ignoran duplicados y piden huecos.
- **F2a no tiene failover.** El host es fijo y no hay quórum. Si el host deja de publicar, la partida termina con un mensaje claro: “El host se desconectó. La partida terminó.”
- **F2b agrega failover** por elección con quórum. Un cliente sólo vota si su propio lease también venció.
- **F2c endurece** el camino: refresh en frío, reenvío de intents, topes y casos raros.
- **F2d despliega** el cliente estático, sin el servidor Node.
- Todos los clientes conservan un `TurnLog` con los bytes zbin crudos de cada batch, en memoria. **Hoy no lo hacen**: el cliente actual sólo guarda `turnsSeen` (`ClientGameRunner.ts:917`). Ésa es la corrección más importante a la premisa de partida.
- No hay tabla ni snapshot en la ruta crítica. La base de Supabase no se usa para turnos. Un refresh de página se recupera replicando desde el turno 0 con el historial en memoria.
- Supabase Broadcast es efímero: no garantiza entrega ni orden. El protocolo compensa con secuencia, `term`, hash de cadena, buffer de fuera de orden y pedidos de huecos.
- El límite Free de 100 msg/s cuenta **entregas**, no publicaciones: un broadcast a 8 clientes son 8 eventos. El diseño entra con 6 jugadores y deja margen; con 8 y muchas acciones queda cerca del límite y hay que medirlo.

---

## 2. Evidencia del código actual

| Tema | Qué hay hoy | Consecuencia |
| --- | --- | --- |
| Turno | `TurnSchema` es **un** turno: `{ turnNumber, intents, hash? }` (`packages/engine-api/src/Schemas.ts:608-613`). No es un batch. | Hay que crear `TurnBatch` para mandar 2 turnos por mensaje. |
| Cliente | `ClientGameRunner` guarda sólo `turnsSeen` (`:917`). En `start` aplica `message.turns` (`:1089-1102`); en `turn` descarta todo lo que no sea exactamente el siguiente (`:1163-1182`). | **No conserva historial.** No puede ser fuente de recuperación ni de failover. |
| Servidor | `GameServer.endTurn()` crea un turno cada 100 ms y lo difunde (`GameServer.ts:1464-1496`). Guarda `this.turns`. | Es la autoridad que hay que reemplazar. |
| Late join | `start` manda `this.turns.slice(lastTurn)` (`GameServer.ts:1440`). El cliente nuevo pide `rejoinGame(0)` (`ClientGameRunner.ts:1188`). | Un refresh recibe todo el historial; con Broadcast eso puede superar 256 KB. |
| Reconexión | El cliente reconecta y pide desde `turnsSeen` (`ClientGameRunner.ts:1044-1048`). | `turnsSeen` es “enviado al worker”, no “ejecutado”. Hay que separar ambos. |
| Catch-up | El worker tiene `run_turns` (`WorkerMessages.ts:87-90`), pero el camino normal manda turnos de a uno (`Worker.worker.ts:37,89-95`). | Un refresh frío de una partida larga puede tardar horas si se reproduce en tiempo real. |
| Singleplayer | `LocalServer` sí guarda `turns` (`LocalServer.ts:53`). | Ese camino no se toca. |
| Lobby | Hoy depende de `GameServer`, tokens y API HTTP. | F2a necesita un lobby mínimo sin JWT. |
| Identidad | Hoy el ingreso pasa por la API y un token. | F2a usa `persistentID` local + apodo, sin token. |

**Contradicción concreta:** la premisa “todos los clientes ya conservan el historial” no se cumple. Sin `TurnLog` en el cliente, el failover “desde el último turno que tenga” no tiene de dónde salir.

---

## 3. Etapas

### 3.1 F2a — partida completa con host fijo

Objetivo: jugar una partida de 2 a 20 compañeros con un host fijo, sin Supabase real todavía en el Bloque 1.

- El creador de la sala es el host y conserva ese rol durante toda la partida.
- No hay elección, ni votos, ni quórum.
- `term` es numérico y siempre viaja en los mensajes. En F2a es siempre `1`.
- Si el host deja de publicar (`HOST_LEASE_MS` sin heartbeat ni batch), los clientes pausan y muestran un mensaje claro. No intentan reemplazarlo.
- No hay `intent_nack`. Si se pierde un intent, la acción se pierde; el protocolo no promete entrega de acciones en F2a.
- Lobby mínimo: crear sala con código de 4 a 6 caracteres y link, lista de jugadores, botón **Empezar** del host que fija `gameStartInfo`.
- Identidad de invitado: `persistentID` local y apodo. Sin JWT.
- Stub de las llamadas que hoy van a `localhost:8787`, para que F2a no dependa del servidor Node.

### 3.2 F2b — failover con quórum

- Si el host cae, los clientes esperan a que venza el lease.
- Un cliente sólo vota si **su propio** lease también venció. Esto evita que un cliente con reloj adelantado vote antes de tiempo.
- El candidato de menor índice en el roster fijo arranca la elección; se necesita mayoría del roster para elegir.
- El nuevo host parte del último turno confirmado y reconcilia con los pares antes de publicar.
- `HostAuthority` reemplaza al host fijo. `TurnMaker` no conoce `HostAuthority`: recibe `term` e `isLeaseValid()`.

### 3.3 F2c — endurecimiento

- Refresh en frío: replay del historial con el worker.
- Reenvío de intents: el cliente conserva los no confirmados y los reenvía.
- Topes de memoria, batches pendientes, chunks de historial y payloads.
- Casos raros: host viejo que vuelve, particiones, conflictos de hash, late join con historial incompleto.

Antes de agregar el campo `emit` a `run_turns`, hay que medir el camino actual del replay en partidas de 30, 60 y 180 minutos. Si el `run_turns` actual alcanza, no se toca `packages/engine-api`. Si hace falta `emit`, se pide aprobación explícita con esa medición.

### 3.4 F2d — despliegue

- `index.html` estático, sin la inyección de `RenderHtml.ts`.
- Manifest y variables de entorno resueltos en build.
- `vercel.json` y `outputDirectory: "static"`.
- Sin servidor Node persistente en producción.

---

## 4. Decisiones y correcciones a las premisas

### 4.1 El host numera y ordena: sí

Los clientes no renumeran ni reordenan. El host decide el orden de los intents dentro de cada turno y publica el batch ya armado.

### 4.2 “Aceptar sólo consecutivos, descartar duplicados, pedir huecos”: sí, con matices

- Un batch que empieza en `nextTurn` se aplica.
- Un batch que empieza más adelante se **bufferiza** un rato y se pide el hueco. Descartarlo en el acto castiga cualquier reordenamiento normal de Supabase.
- Un batch que solapa turnos ya aplicados se compara con el `TurnLog`. Si coincide, es duplicado y se ignora; si no coincide, es conflicto y se pausa.

### 4.3 F2a sin quórum; F2b con quórum y leases

En F2a no hay forma de elegir un host nuevo y no se intenta. La partida termina con un mensaje claro. Esto evita dos hosts avanzando en paralelo sin introducir consenso en la primera etapa.

En F2b, “el clientID más bajo” solo no alcanza por dos motivos:

1. **Partición:** dos clientes pueden creerse host y producir turnos distintos con el mismo número. Sin mayoría, no hay forma de saber cuál es el bueno.
2. **Historial:** el cliente más bajo puede tener menos turnos que otro. Asumir “desde el último turno que tenga” puede perder turnos que otro ya aplicó.

La solución es `term` + mayoría del roster + sincronización de historial entre pares. El “más bajo” se usa como prioridad de elección, no como autoridad automática.

Además, `clientID` es un string aleatorio de 8 caracteres. Para evitar comparaciones dependientes de locale, la prioridad es el **índice en el roster fijo** (`gameStartInfo.players`), que todos los clientes comparten.

### 4.4 “Sin tabla ni snapshot”: viable para la partida viva, con un límite

Para el juego en curso, sí: no hace falta Postgres ni snapshot. El historial en memoria alcanza.

Pero hay que aceptar dos consecuencias:

- Un refresh de página pierde el estado del engine. La única recuperación sin snapshot es replicar desde el turno 0. Con historial en memoria y un modo de catch-up rápido es viable; con el camino actual, no.
- Si el historial supera el tope de memoria, no se puede ofrecer late join desde cero. En ese momento hay que bloquear el late join o aceptar que hace falta un snapshot.

### 4.5 TurnLog: zbin crudo en memoria, sin compresión

Se guardan los bytes zbin de cada batch tal como se publicaron. No hay gzip, no hay worker de compresión, no hay tramos de 256 turnos y no hay tope de 64 MB.

- Las mediciones de la sección 9 muestran que el zbin de una partida de 3 h pesa menos de 1 MB en el caso normal.
- El costo real no es el byte en sí, sino mantener 108.000 objetos `Turn` con arrays de intents. Guardar bytes crudos ya evita eso.
- El tope es simple y generoso: **128 MB por cliente**, como red de seguridad. Al superarlo se deja de agregar, se marca `lateJoinDisabled` y se avisa. No se borra el principio en silencio.
- Los chunks de historial siguen respetando **96 KB** para no acercarse al límite de 256 KB de Supabase.

### 4.6 Ack + hash_report: un solo mensaje por segundo

`ack` y `hash_report` se combinan en un único mensaje por cliente por segundo. El mensaje lleva el último turno contiguo aplicado, su hash, y opcionalmente el último hash de estado reportado.

Esto corrige el presupuesto: con 6 jugadores son 5 mensajes/s de clientes (más la entrega al host), no dos flujos separados. El costo es que un failover puede perder hasta ~1 s de turnos; el nuevo host los recupera de los pares.

### 4.7 Sin `intent_nack` en F2a

El host no pide intents faltantes. Si un `IntentBatch` se pierde o llega fuera de orden, se descarta o se aplica si el orden es recuperable, pero no hay un canal de retransmisión. F2c agrega reenvío.

### 4.8 Reloj del host en Web Worker

El reloj que dispara los turnos del host corre en un Web Worker dedicado. La publicación del batch sigue en el hilo principal: el Worker sólo avisa “pasó el intervalo”, y el hilo principal arma y publica.

Motivo: una pestaña de fondo puede ser throttelevada y congelar la partida. El Worker no elimina el throttle del navegador, pero separa el reloj del trabajo de render y permite medir el lease con una fuente menos contaminada.

Verificación obligatoria en navegador real: host con la pestaña oculta durante 2 minutos, camino completo (reloj en el Worker, publicación desde el hilo principal). Si el navegador congela el Worker, el lease vence y F2a termina con el mensaje claro; F2b elige otro host.

### 4.9 `TurnMaker` desacoplado de `HostAuthority`

`TurnMaker` no recibe `HostAuthority`. Recibe:

- `term` numérico,
- `isLeaseValid(): boolean`,
- un `TurnSink` (en producción publica; en tests es memoria),
- un reloj inyectable.

Así el mismo componente sirve para F2a (host fijo, lease siempre válido) y F2b (host electo, lease real) sin conocer la política de elección.

### 4.10 Archivos protegidos

En F2a y F2b **no se toca**:

- `packages/engine`
- `packages/engine-api`
- `packages/engine-lib`
- `packages/shared/src/WireSchemas.ts`
- `packages/shared/src/CosmeticSchemas.ts`
- `src/server`

Los schemas nuevos viven en archivos nuevos de `packages/shared`. El catch-up con `run_turns` es F2c y requiere la medición previa.

### 4.11 Lobby mínimo e identidad de invitado (F2a)

F2a no puede asumir que `GameStartInfo` llega desde el servidor. Se agrega lo mínimo:

- Crear sala con código de 4 a 6 caracteres y link `?game=<code>`.
- Lista de jugadores en la sala.
- El host ve el botón **Empezar**; al pulsarlo fija `gameStartInfo` y lo publica.
- `persistentID` se genera localmente y se guarda en `localStorage`; el apodo se elige en la sala.
- No hay JWT ni cuentas. Las rutas que hoy exigen token (`/api/user/me`, join con token, etc.) no se usan en F2a; el stub de `localhost:8787` devuelve datos locales o un error explícito, nunca bloquea la partida.

### 4.12 Línea base de tests

La línea base correcta es:

- **81 fallos estables** en `docs/baseline-failures.txt`.
- **2 fallos flaky** en `docs/baseline-flaky.txt`.

No se agregan fallos nuevos. No se “arreglan” los 81 ajenos dentro de esta fase.

---

## 5. Arquitectura

```text
ClientGameRunner
      │  eventos de UI / turnos
      ▼
Transport (fachada; conserva LocalServer)
      │
      ▼
RealtimeSession
  ├── HostAuthority      (F2b: término, elección, quórum)
  ├── TurnMaker          (host: arma TurnBatch; term + isLeaseValid)
  ├── TurnReceiver       (valida secuencia, buffer, huecos)
  ├── TurnLog            (bytes zbin crudos en memoria)
  └── SupabaseBroadcastTransport
            │
            ▼
      Supabase Realtime (Broadcast efímero)
```

`TurnMaker` no conoce Supabase ni `HostAuthority`. Recibe intents y un `TurnSink`; devuelve batches. `SupabaseBroadcastTransport` no conoce reglas de juego: sólo publica y recibe bytes/JSON en un topic. `RealtimeSession` los une.

`Transport` sigue siendo la fachada que usa `ClientGameRunner`: en local sigue usando `LocalServer`; en remoto delega en `RealtimeSession`. Así no se reescribe la UI ni el camino de singleplayer.

El reloj del host:

```text
TurnClock.worker.ts  --tick-->  TurnMaker (hilo principal)  --publish-->  Supabase
```

El Worker no toca el engine ni los turnos. Sólo cuenta intervalos.

---

## 6. Protocolo

### 6.1 Canales y eventos

| Canal | Publica | Escucha | Eventos |
| --- | --- | --- | --- |
| `game:<id>` | host; en F2b cualquier candidato sólo para `host_claim` | todos | `turn` (binario), `host_claim`, `host_elected`, `host_heartbeat`, `desync` (JSON) |
| `game:<id>:in:<clientID>` | ese cliente | host | `intent` (binario), `hello`, `ack`, `history_req` (JSON) |
| `game:<id>:ctl:<clientID>` | host | ese cliente | `start`, `history_chunk`, `error` |

No se usa Presence para decidir autoridad. Presence puede servir como pista de UI, pero no para quórum: sus límites y su semántica no son un consenso.

En F2a el canal general sólo lo publica el host. En F2b un candidato puede publicar `host_claim`; nada más.

### 6.2 Framing

- Cada payload binario empieza con `u8 protocolVersion = 1`.
- Después va el zbin de un schema de `packages/shared`.
- Los turnos usan el `ZbContext` creado con `createGameWireContext(players)`, igual que hoy (`ZbinWire.ts:37-46`). El `start` va antes que cualquier frame binario del juego.
- Los chunks de historial llevan frames de `TurnBatch` crudos y respetan **96 KB** por chunk.
- Límite de payload: 256 KB Free. El diseño usa **96 KB** por chunk de historial y **128 KB** para JSON de control, con margen para headers.

### 6.3 Schemas principales

```ts
type TurnBatch = {
  type: "turn_batch";
  v: 1;
  term: number;
  hostID: ClientID;
  fromTurn: number;
  turns: Turn[];        // 2 por defecto; máximo configurable
  prevHash: number;     // hash del batch anterior de este término
  hash: number;         // FNV-1a sobre el zbin del batch sin `hash`
};

type IntentBatch = {
  type: "intent_batch";
  v: 1;
  clientID: ClientID;
  seq: number;          // monotónico por cliente
  intents: Intent[];    // sin clientID; el host lo estampa desde el topic
};

type HistoryRequest = {
  type: "history_req";
  requestId: string;
  fromTurn: number;
  maxBytes: number;
};

type HistoryChunk = {
  type: "history_chunk";
  v: 1;
  requestId: string;
  term: number;
  hostID: ClientID;
  fromTurn: number;
  toTurn: number;
  frames: Uint8Array[]; // TurnBatch ya codificados
  more: boolean;
};

type HostClaim = {
  type: "host_claim";
  term: number;
  hostID: ClientID;
  priority: number;      // índice en el roster
  lastTurn: number;
  lastHash: number;
};

type HostElected = {
  type: "host_elected";
  term: number;
  hostID: ClientID;
  voters: ClientID[];    // prueba de quórum; el cliente cuenta
  lastTurn: number;
};

type Ack = {
  type: "ack";
  term: number;
  hostID: ClientID;
  clientID: ClientID;
  turn: number;          // último turno contiguo aplicado
  hash: number;          // hash de la cadena en `turn`
  hashTurn?: number;     // último hash de estado reportado
  hashValue?: number;
};
```

`hash` es sólo para detectar conflictos y cadenas rotas; no es seguridad criptográfica. La autoridad sigue siendo el host y el roster.

### 6.4 Handshake

1. El cliente se suscribe a `game:<id>`, `game:<id>:in:<clientID>` y `game:<id>:ctl:<clientID>`.
2. Publica `hello` en su `in` con `clientID`, `protocolVersion`, `lastTurn`, `lastHash` y `coldStart` (`true` si la página se recargó y no hay estado del engine).
3. El host valida que el `clientID` esté en el roster y responde en `ctl` con `start`:
   - `gameStartInfo` (el mismo para todos),
   - `myClientID`,
   - `term`, `hostID`,
   - `fromTurn` (0 si `coldStart`, o `lastTurn + 1`),
   - `historyComplete` / `historyFrom`.
4. El cliente crea el `ZbContext` con `gameStartInfo.players`, inicializa el worker si hace falta y pide historial desde `fromTurn`.
5. El host manda `history_chunk` en `ctl` hasta `lastTurn`; después empiezan a fluir los `turn` del canal general. El cliente puede bufferizar turnos en vivo mientras termina el historial.

### 6.5 Intents

- El cliente agrupa intents en `IntentBatch` y los manda a su `in`, con `seq` monotónico.
- El host escucha ese topic y **estampa `clientID` desde el topic**, no desde el payload.
- El host mantiene `lastIntentSeq` por cliente. Si llega `seq = last + 1`, encola. Si llega un duplicado, lo ignora. Si llega un salto, en F2a lo descarta; F2c agrega reenvío y recuperación.
- El orden dentro del turno lo decide el host al hacer `drain`. Los clientes ejecutan el array tal como llega.

### 6.6 Turnos

- El host arma `TurnBatch` cada 200 ms con 2 turnos por defecto.
- Cada turno toma hasta `MAX_INTENTS_PER_TURN` (propuesto: 64) del queue, en orden de llegada.
- Los turnos vacíos también se emiten: el tiempo del juego avanza aunque nadie actúe.
- El batch se publica con `ack: true`; el host lo aplica localmente después de que Supabase confirma la recepción. Si falla, reintenta el mismo batch (idempotente por `term` + `fromTurn` + `hash`).
- El host actualiza `committedTurn` con el `ack` de mayoría. En F2a no hay mayoría; usa el último batch publicado.

### 6.7 Control

- `hello`, `ack`, `history_req` van por el `in` del cliente (JSON).
- `start`, `history_chunk`, `error` van por el `ctl` del cliente.
- `host_claim`, `host_elected` y `host_heartbeat` van por el canal general (JSON), sólo en F2b.
- `ack` se manda cada 1 s, no por batch, y combina el reporte de hash. Con 6 jugadores eso son 5 envíos/s + 5 entregas al host; no 50 eventos/s.

---

## 7. Componentes

### 7.1 `TurnMaker`

Interfaz propuesta:

```ts
interface TurnSink {
  publish(batch: TurnBatch): Promise<void>;
}

class TurnMaker {
  constructor(opts: {
    term: number;
    hostID: ClientID;
    turnsPerBatch: number;    // 2
    maxIntentsPerTurn: number;// 64
    clock: TurnClock;         // WorkerTurnClock(200) en producción; falso en tests
    sink: TurnSink;
    ctx: ZbContext;           // mismo roster que TurnReceiver
    isLeaseValid: () => boolean;
    onLeaseLost?: () => void;
  });

  start(nextTurn: number, lastHash?: number): void;
  enqueue(clientID: ClientID, intent: Intent): void;
  enqueueBatch(clientID: ClientID, seq: number, intents: Intent[]): void;
  pause(): void;
  resume(): void;
  stop(): void;
}
```

No importa `shared` ni Supabase. El host lo conecta a `RealtimeSession`; los tests lo conectan a un sink en memoria.

`TurnClock` es una interfaz mínima:

```ts
interface TurnClock {
  start(onTick: () => void): void;
  stop(): void;
}
```

En producción se implementa con `TurnClock.worker.ts`. En tests se usa un reloj falso que dispara ticks a mano. La publicación siempre ocurre en el hilo que llama `onTick` (el principal).

### 7.2 `TurnLog`

- Guarda el frame zbin crudo de cada `TurnBatch` ya validado.
- Índice `{ fromTurn, toTurn, term, hostID, hash, bytes }`.
- `read(fromTurn, maxBytes = 96 KB)` devuelve los frames que entran en el tope, sin mutar el log.
- `append` es síncrono y copia los bytes para que el llamador no pueda mutarlos.
- Tope: **128 MB por cliente**. Al superarlo no se borra el principio: se marca `lateJoinDisabled` y se avisa. Borrar el principio sin snapshot rompe la recuperación desde cero.
- No hay gzip ni worker de compresión.

### 7.3 `TurnReceiver`

Estados: `term`, `hostID`, `nextTurn`, `lastHash`, `pending: Map<fromTurn, TurnBatch>`, `lastAckTurn`.

Reglas:

1. `batch.term < term` → ignorar.
2. `batch.term > term` → en F2a es conflicto (el host es fijo); en F2b, nuevo término.
3. `batch.term === term` y `hostID` distinto → conflicto; pausar.
4. `batch.fromTurn === nextTurn`:
   - si `prevHash === lastHash` y el hash del batch es válido, aplicar en orden y drenar `pending`;
   - si no, pedir historial; si el hash sigue sin cerrar, conflicto y pausa.
5. `batch.fromTurn > nextTurn` → guardar en `pending` (máximo 256 batches) y pedir `history_req(nextTurn)`.
6. `batch.fromTurn < nextTurn` → solapamiento; si los turnos ya aplicados coinciden por hash en el `TurnLog`, duplicado; si no, conflicto y pausa.

`nextTurn` se actualiza cuando el batch se entrega al worker, pero el `ack` usa `lastExecutedTurn`, que sale de `GameUpdateViewData.tick`. Son dos cosas distintas.

### 7.4 `HostAuthority` (F2b)

```ts
type HostRole = "follower" | "candidate" | "host" | "paused";

type HostState = {
  term: number;
  hostID: ClientID | null;
  role: HostRole;
  lastTurn: number;
  lastHash: number;
  quorum: number;           // floor(roster.length / 2) + 1
  voters: Set<ClientID>;
};
```

Parámetros propuestos:

- `HOST_HEARTBEAT_MS = 1000`
- `HOST_LEASE_MS = 3000`
- `ELECTION_TIMEOUT_MS = 3000`
- `CLAIM_TIMEOUT_MS = 1500`
- `QUORUM = floor(N / 2) + 1` sobre el roster fijo (4 de 6; 5 de 8)

Flujo:

1. Al empezar, el creador del lobby es host con `term = 1`. En F2a no hay votos.
2. En F2b, si no hay heartbeat por `HOST_LEASE_MS`, cada cliente calcula `ELECTION_TIMEOUT + priority * 100ms`. El de menor índice arranca primero.
3. El candidato manda `host_claim(term + 1)`. Los clientes votan **sólo si su propio lease venció** y no vieron un término mayor. El candidato con quórum manda `host_elected`.
4. Dos candidatos con el mismo término: gana el de menor `priority`. El otro baja al ver el claim o los votos del ganador.
5. Dos particiones: ninguna tiene mayoría; ninguna avanza. La partida se pausa hasta que se recomponga la mayoría.
6. El host viejo que vuelve ve un `term` mayor y baja. No puede seguir publicando con el término viejo.

Un quórum sobre roster fijo significa que si se van demasiados jugadores, la partida se pausa. Es el precio de no tener una tabla de coordinación. Para 6–8 compañeros es aceptable; si no, hay que definir una votación de reducción de roster, fuera de este paso.

### 7.5 `RealtimeSession`

Es el orquestador. No tiene reglas de juego, pero sí de sesión:

- Crea `SupabaseBroadcastTransport` y los canales.
- Mantiene `HostAuthority` (F2b), `TurnReceiver`, `TurnLog`, y `TurnMaker` si es host.
- Traduce `TurnBatch` a los eventos `turn` que `ClientGameRunner` ya entiende (2 por batch); para el historial usa el camino de catch-up, no 108.000 mensajes `turn`.
- Expone a `Transport` la misma API: `connect`, `rejoinGame`, `sendIntent`, `turnComplete`, `leaveGame`.

### 7.6 Catch-up del worker (F2c)

El worker ya tiene `run_turns` (`WorkerMessages.ts:87-90`) y lo usa el replay. Antes de modificarlo hay que medir el camino actual en partidas de 30, 60 y 180 minutos. Si el `run_turns` actual alcanza, no se toca.

Si la medición muestra que hace falta, la propuesta es:

```ts
type RunTurnsMessage = {
  type: "run_turns";
  turns: Turn[];
  emit?: "all" | "final" | "none"; // default "all"
};
```

- `final` devuelve sólo el último update, para que el cliente pinte el estado actual y siga en vivo.
- `none` para tests o cuando la UI ya se va a actualizar por otro camino.

El campo `emit` no se agrega sin aprobación explícita y la medición adjunta.

---

## 8. Flujos

### 8.1 Partida normal (F2a)

1. Host fijo, `term=1`, sin quórum.
2. Cada 200 ms, `TurnMaker` arma 2 turnos y publica un `TurnBatch`.
3. Todos los clientes validan `term`, `hostID`, `fromTurn` y `prevHash`; aplican en orden.
4. Cada cliente manda un `ack` combinado con `hash_report` cada 1 s.
5. Si un cliente detecta un hueco, pide `history_req` a su `ctl`; el host responde en tramos.

### 8.2 Hueco

1. Llega el batch 101 y el cliente espera 100.
2. Lo guarda en `pending` y manda `history_req(100)`.
3. El host manda `history_chunk` con el turno 100 (y los que entren en 96 KB).
4. El cliente aplica 100, drena 101 y sigue.
5. Si el hueco no se llena en `SYNC_TIMEOUT_MS` (propuesto: 5 s), repite el pedido. A los 15 s, pausa y muestra error.

### 8.3 Reconexión con engine vivo

1. El canal de Supabase se cae y vuelve; el worker y el engine siguen vivos.
2. `ClientGameRunner` pide rejoin desde `lastExecutedTurn + 1`, no desde `turnsSeen`.
3. El host manda el historial faltante y luego los turnos vivos.
4. No se re-inicializa el worker.

### 8.4 Refresh frío (F2c)

1. No hay estado del engine. `coldStart = true`.
2. El host manda `start` con `gameStartInfo`, `fromTurn = 0` y `historyComplete`.
3. El cliente pide todo el historial en tramos de 96 KB.
4. El worker se inicializa y ejecuta el historial con el camino de catch-up medido.
5. Al terminar, se pone al día con los turnos vivos bufferizados y recién ahí se muestra el juego.

Si el historial supera el tope o `lateJoinDisabled` está activo, el host responde `history_unavailable`; el cliente no entra. Sin snapshot no hay una tercera opción honesta.

### 8.5 Cae el host en F2a

1. Los clientes dejan de recibir batches y heartbeat.
2. A los `HOST_LEASE_MS` (3 s), no hay failover.
3. La UI pausa la partida y muestra: “El host se desconectó. La partida terminó.”
4. No se elige otro host. No se aplican turnos nuevos.

### 8.6 Cae el host en F2b

1. Los clientes dejan de recibir batches y heartbeat.
2. A los 3 s, cada cliente verifica **su propio** lease; sólo vota si también venció.
3. El de menor `priority` candidatiza con `term + 1`.
4. Los clientes votan; con mayoría, manda `host_elected`.
5. El nuevo host parte de `committedTurn`.
6. Pide a los pares sus `lastTurn`/`lastHash`. Si alguien tiene turnos más nuevos con la misma cadena, los adopta; si hay conflicto, pausa.
7. Reanuda `TurnMaker` en `lastTurn + 1`.

### 8.7 Dos clientes se creen host (F2b)

- Mismo término: gana el menor `priority`; el otro baja al ver el claim o los votos.
- Términos distintos: gana el mayor; el viejo baja.
- Partición sin mayoría: nadie avanza. Es preferible una pausa visible a dos simulaciones divergentes.
- Si aun así se aplicaron turnos distintos en dos lados, no hay rollback sin snapshot: el nuevo host detecta el conflicto por `term`/hash, pausa y muestra “partida desincronizada”.

### 8.8 Hashes y desync

- `GameUpdateViewData` sigue emitiendo hashes cada 10 ticks.
- El cliente manda el hash reportado dentro del `ack` de cada segundo.
- El host compara mayoría. Si hay desacuerdo, publica `desync` y pausa. No hay una autoridad independiente: el host es juez y parte. Es una limitación aceptada para una partida de oficina; la alternativa es un proceso neutral, que volvería a introducir un servidor.

---

## 9. Historial y memoria

Medición sintética con 6 jugadores, 1.000 turnos, zbin (no es una partida real; sirve para dimensionar):

| Intents por turno | Bytes zbin/turno | 108.000 turnos (3 h a 10/s) |
| --- | ---: | ---: |
| 0 | 4,9 | ~0,53 MB |
| 1 | 16,9 | ~1,83 MB |
| 2 | 28,9 | ~3,12 MB |
| 6 | 76,9 | ~8,30 MB |
| 12 | 148,9 | ~16,1 MB |

La conclusión no es “siempre son 0,3 MB”: es que el zbin crudo es chico y que el costo dominante es mantener 108.000 objetos `Turn` con arrays de intents en JS. Guardar los bytes de cada batch resuelve eso.

Propuesta:

- `HISTORY_CHUNK_MAX_BYTES = 96 KB` (frames crudos por chunk)
- `LIVE_TAIL_TURNS = 512` para responder rápido sin recorrer todo
- `MAX_HISTORY_BYTES = 128 MB` por cliente (red de seguridad)
- `MAX_PENDING_BATCHES = 256`
- `MAX_INTENTS_PER_TURN = 64`
- `MAX_INTENT_BATCH = 32`

Si se supera el tope: no se borra historial viejo. Se marca `lateJoinDisabled`, se avisa en UI y se sigue jugando. Un late join nuevo se rechaza con `history_unavailable`. Si el producto necesita late join siempre, la fase siguiente tiene que agregar snapshot; no hay magia.

---

## 10. Presupuesto de mensajes

Tabla conservadora (Supabase cuenta entregas). `ack` y `hash_report` ya están combinados:

| Jugadores | Turnos | Ack+hash | Heartbeat | Intents (~5/s) | Total | Margen Free |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6 | 30 | 10 | 0–6 | 10 | 50–56 | ~44% |
| 8 | 40 | 14 | 0–8 | 16 | 70–78 | ~22% |

Notas:

- El límite Free es **por proyecto**, no por partida. Si en la misma oficina hay dos partidas a la vez, los eventos se suman; el presupuesto asume una sola partida.
- El heartbeat sólo se manda si no hubo batch en el último segundo; en partida activa no suma.
- Los `ack` son 1/s por cliente, no por batch, y ya incluyen el hash reportado. Si se mandaran por separado, el presupuesto se rompe.
- Los intents van por topic por cliente: 2 eventos por intent (envío + entrega al host), no 8.
- El transporte lleva un contador de eventos y un token bucket. Al pasar 80/s: baja el ritmo de batches, agrupa más intents o avisa que hay que pasar a Pro. No se espera al `tenant_events` de Supabase.
- `channel joins`: 3 por cliente; el host ~2N+1. Muy por debajo de 100/s.
- `payload`: batches de 2 turnos son cientos de bytes; historial 96 KB; `start` JSON con tope de 128 KB. Nada cerca de 256 KB.

---

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación | Residual |
| --- | --- | --- |
| Broadcast pierde un turno | Secuencia + buffer + `history_req` | Si el host ya no lo tiene, se pide a un par; si nadie lo tiene, pausa. |
| Broadcast reordena | Buffer de `pending` y aplicación sólo en `nextTurn` | Un reordenamiento muy grande llena el buffer; se pide historial. |
| Dos hosts (F2b) | Término + quórum de mayoría + prioridad de roster | Partición sin mayoría: pausa. |
| Host muere en F2a | Lease + mensaje claro + fin de partida | No hay continuidad; es el precio de no tener failover todavía. |
| Host muere con turnos no difundidos (F2b) | `committedTurn` + recolección de `lastTurn` de pares | Se puede perder hasta ~1 s si nadie lo recibió. |
| Host viejo vuelve (F2b) | Término mayor lo baja; resync o re-init | Si su engine quedó adelantado y no se adopta, debe recargar. |
| Refresh frío | Historial en memoria + catch-up medido | Si se supera el tope, no entra. |
| Tope de memoria | 128 MB crudos; `lateJoinDisabled` | Sin snapshot no hay late join ilimitado. |
| Pestaña de host en background | Reloj en Web Worker; verificación real de 2 min | Si el navegador congela el Worker, F2a termina; F2b elige. |
| Límite Free | Presupuesto, token bucket, 6 jugadores objetivo | Con 8 y muchas acciones, Pro. |
| Binario no soportado por el receptor | Versión mínima de SDK + smoke test | Fallback zbin+base64, más pesado. |
| Canal público | IDs de partida privados; confianza de oficina | Cualquiera con la publishable key y el ID puede entrar. Aceptado. |
| Sin DB | Broadcast efímero | Si Supabase cae, no hay recuperación desde afuera. |
| Lobby mínimo incompleto | Código + link + lista + Empezar; sin JWT | Sin admisión avanzada, cualquiera con el código entra. Aceptado. |

---

## 12. Archivos y pruebas

### Bloque 1 (puro, sin Supabase real)

Orden de implementación, un commit por punto:

1. **F2a-1** — `packages/shared/src/RealtimeSchemas.ts` y `packages/shared/src/RealtimeWire.ts` (archivos nuevos; no se tocan `WireSchemas.ts` ni `CosmeticSchemas.ts`) + tests.
2. **F2a-2** — `src/client/netcode/TurnLog.ts` y `src/client/netcode/TurnReceiver.ts` + tests.
3. **F2a-3** — `src/client/netcode/TurnMaker.ts`, `src/client/netcode/TurnClock.ts` y `src/client/netcode/TurnClock.worker.ts` + tests con reloj falso.
4. **F2a-4** — transporte falso con fallas sembradas (pérdida, duplicados, reorden, latencia) y prueba de integración con 6 pares: convergencia con el mismo hash, host que cae a mitad de partida termina con mensaje claro, late join desde el turno N.

### Archivos nuevos propuestos (F2 completa)

- `packages/shared/src/RealtimeSchemas.ts`
- `packages/shared/src/RealtimeWire.ts`
- `src/client/netcode/TurnMaker.ts`
- `src/client/netcode/TurnClock.ts`
- `src/client/netcode/TurnClock.worker.ts`
- `src/client/netcode/TurnLog.ts`
- `src/client/netcode/TurnReceiver.ts`
- `src/client/netcode/HostAuthority.ts` (F2b)
- `src/client/netcode/RealtimeSession.ts` (Bloque 2)
- `src/client/netcode/SupabaseBroadcastTransport.ts` (Bloque 2)
- `tests/netcode/*.test.ts`

### Archivos a tocar (F2 completa)

- `src/client/Transport.ts`: delegar remoto a `RealtimeSession`; mantener `LocalServer`.
- `src/client/ClientGameRunner.ts`: separar `turnsSeen` de `lastExecutedTurn`; aceptar `start` con `fromTurn`/catch-up; aplicar los turnos en vivo.
- `src/client/WorkerClient.ts`: catch-up, sólo después de la medición de F2c.
- `packages/engine-api/src/worker/WorkerMessages.ts`: campo `emit` en `run_turns`, **sólo F2c con aprobación**.
- `packages/engine/src/worker/Worker.worker.ts`: implementar `emit`, **sólo F2c con aprobación**.
- `package.json`: `@supabase/supabase-js` (versión mínima con binario).
- `src/client/ClientEnv.ts` o config: URL y publishable key; nunca `service_role`.
- `index.html`, `vercel.json`, configuración de Vite: F2d.

No se borra `GameServer` en este paso. Se mantiene hasta que el adaptador esté probado; la limpieza es una tarea posterior.

### Pruebas

1. **RealtimeSchemas/Wire**: round-trip zbin, versión binaria, hash FNV-1a, rechazo de payload > 256 KB, chunk de 96 KB, control JSON.
2. **TurnMaker**: 2 turnos/200 ms, turnos vacíos, tope de intents, pausa, numeración sin duplicados, lease vencido no publica, reloj falso.
3. **TurnLog**: append/read en bordes, bytes crudos sin compresión, tope de 128 MB, late join desde N arbitrario, no mutación.
4. **TurnReceiver**: orden, duplicados, fuera de orden, hueco, cambio de término, conflicto de hash.
5. **HostAuthority** (F2b): 6 y 8 jugadores; elección; empate por prioridad; partición sin quórum; host viejo que vuelve; voto sólo con lease propio vencido.
6. **Presupuesto**: 6/8 jugadores a 5 batches/s; verificar que `ack+hash` es un solo mensaje.
7. **Integración en memoria**: 6 pares con transporte falso que pierde, duplica y reordena con semilla; matar al host en un turno aleatorio; verificar convergencia, fin claro y late join desde el turno N.
8. **LayerBoundaries**: el engine no importa `shared` ni usa `Math.random`/`Date.now`; los schemas nuevos viven fuera del engine.

Después de cada tarea: typecheck, lint, tests nuevos y red de seguridad. La línea base es **81 fallos estables + 2 flaky**; no se agregan fallos nuevos.

---

## 13. Fuera de alcance y persistencia futura

No se implementa en F2a/F2b:

- Admisión avanzada, allowlist, trust, bans y límite de jugadores más allá del código de sala.
- Cuentas, JWT, moderación, reportes, votos.
- Ganador y `WinnerReplay`.
- Reaping de partidas vacías y límite de 3 h.
- Persistencia de partidas.

Persistencia futura, **fuera de la ruta crítica**:

- Al terminar, subir `GameRecord` con los turnos a Postgres o Storage, idempotente por `gameID`.
- Guardar partidas (saves) con snapshots del engine, no con historial completo.
- Resultados y estadísticas.
- Replay del ganador en un proceso aparte.

`Broadcast Replay` de Supabase no sirve como historial de turnos: sólo aplica a mensajes enviados desde la base y canales privados, y devuelve hasta 25 mensajes por request. No se usa.

---

## 14. Aprobación y siguiente paso

El diseño queda aprobado con estas correcciones:

1. Agregar `TurnLog` en todos los clientes, con bytes zbin crudos y tope de 128 MB.
2. F2a con host fijo y fin claro si cae; F2b con quórum y voto sólo con lease propio vencido; F2c endurecimiento; F2d despliegue.
3. Aceptar que, sin snapshot, un refresh frío replica desde 0 y que al superar el tope de historial se bloquea el late join.
4. Reloj del host en Web Worker, publicación desde el hilo principal.
5. `TurnMaker` desacoplado de `HostAuthority` mediante `term` e `isLeaseValid()`.
6. No tocar `packages/engine` ni `packages/engine-api` en F2a/F2b.

El Bloque 1 (F2a-1 a F2a-4) se implementa primero, sin Supabase real. El Bloque 2 (adaptador real, `RealtimeSession`, `Transport` y lobby) espera OK explícito.
