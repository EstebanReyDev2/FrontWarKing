import type { Intent } from "@openfront/engine-api/Schemas";
import type {
  Hello,
  HistoryChunk,
  IntentBatch,
  RealtimeControl,
  Start,
  TurnBatch,
} from "@openfront/shared/RealtimeSchemas";
import { MAX_HISTORY_CHUNK_BYTES } from "@openfront/shared/RealtimeSchemas";
import {
  decodeHistoryChunk,
  decodeIntentBatch,
  decodeTurnBatch,
  encodeHistoryChunk,
  encodeIntentBatch,
  encodeTurnBatch,
  makeAck,
} from "@openfront/shared/RealtimeWire";
import type {
  ServerMessage,
  WireGameStartInfo,
  WirePlayer,
} from "@openfront/shared/WireSchemas";
import { createGameWireContext } from "@openfront/shared/ZbinWire";
import type { ZbContext } from "@openfront/zbin";
import type {
  RealtimeTransport,
  TransportPacket,
  TransportState,
} from "./RealtimeTransport";
import { WorkerTurnClock, type TurnClock } from "./TurnClock";
import { TurnLog } from "./TurnLog";
import { TurnMaker } from "./TurnMaker";
import { TurnReceiver } from "./TurnReceiver";

export type RealtimeSessionOptions = {
  gameID: string;
  clientID: string;
  hostID: string;
  nickname?: string;
  /** Host only. Followers receive it in the start control message. */
  gameStartInfo?: WireGameStartInfo;
  transport: RealtimeTransport;
  clock?: TurnClock;
  term?: number;
  allowGeneralHello?: boolean;
  turnsPerBatch?: number;
  maxIntentsPerTurn?: number;
  heartbeatMs?: number;
  hostLostMs?: number;
  ackMs?: number;
  intentFlushMs?: number;
  onMessage: (message: ServerMessage) => void;
  onStateChange?: (state: TransportState) => void;
  onError?: (message: string) => void;
  logger?: Pick<Console, "warn" | "error" | "log">;
  now?: () => number;
};

export const REALTIME_TURNS_PER_BATCH = 2;
export const REALTIME_MAX_INTENTS_PER_TURN = 64;
export const REALTIME_HEARTBEAT_MS = 1_000;
// Temporary: the host's main thread is blocked while it loads the map and
// initialises WebGL, so it cannot publish heartbeats for several seconds after
// sending start. A 3s window declared the host dead on every first load.
export const REALTIME_HOST_LOST_MS = 10_000;
export const REALTIME_ACK_MS = 1_000;
export const REALTIME_INTENT_FLUSH_MS = 50;
export const REALTIME_MAX_INTENTS_BUFFER = 32;

const HOST_LOST_MESSAGE = "El host se desconectó. La partida terminó.";

type PeerInfo = {
  nickname?: string;
};

/**
 * Orchestrates one realtime game session.
 *
 * The class owns the pieces that were built in F2a-1..F2a-4: the transport, the
 * receiver/log pair, the host's TurnMaker and the client-side acknowledgement
 * timer. It deliberately exposes the same session-level operations that the
 * existing Transport facade needs, so ClientGameRunner can keep using the
 * ServerMessage union.
 */
export class RealtimeSession {
  private readonly host: boolean;
  private readonly term: number;
  private readonly log = new TurnLog();
  private readonly peers = new Map<string, PeerInfo>();
  private readonly helloCounts = new Map<string, number>();
  private readonly subscribedPeers = new Set<string>();
  private readonly peerReady = new Set<string>();
  private readonly frames = new Map<number, Uint8Array>();
  private readonly earlyTurns: Uint8Array[] = [];
  private readonly pendingIntents: Array<{
    clientID: string;
    batch: IntentBatch;
  }> = [];
  private readonly pendingHostIntents: Intent[] = [];
  private readonly logger: Pick<Console, "warn" | "error" | "log">;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly hostLostMs: number;
  private readonly ackMs: number;
  private readonly intentFlushMs: number;
  private readonly allowGeneralHello: boolean;
  private readonly turnsPerBatch: number;
  private readonly maxIntentsPerTurn: number;

  private onMessage: (message: ServerMessage) => void;
  private onError?: (message: string) => void;
  private unsubscribeState: (() => void) | null = null;
  private gameStartInfo: WireGameStartInfo | null;
  private ctx: ZbContext | null = null;
  private receiver: TurnReceiver | null = null;
  private maker: TurnMaker | null = null;
  private started = false;
  private startSending = false;
  private startSent = false;
  private hostReady = false;
  private makerStarted = false;
  private closed = false;
  private failed = false;
  private hostLost = false;
  private lastTransportStatus: TransportState["status"] | null = null;
  private lastHeardAt: number;
  private lastBatchAt = 0;
  private turnsSeen = 0;
  private lastExecutedTurn = -1;
  private lastExecutedHash = 0;
  private intentSeq = 0;
  private intentBuffer: Intent[] = [];
  private nextHistoryId = 0;
  private pendingHistory: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private hostLostTimer: ReturnType<typeof setInterval> | null = null;
  private ackTimer: ReturnType<typeof setInterval> | null = null;
  private intentTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RealtimeSessionOptions) {
    this.host = opts.clientID === opts.hostID;
    this.term = opts.term ?? 1;
    this.gameStartInfo = opts.gameStartInfo ?? null;
    this.allowGeneralHello = opts.allowGeneralHello ?? false;
    this.turnsPerBatch = opts.turnsPerBatch ?? REALTIME_TURNS_PER_BATCH;
    this.maxIntentsPerTurn =
      opts.maxIntentsPerTurn ?? REALTIME_MAX_INTENTS_PER_TURN;
    this.heartbeatMs = opts.heartbeatMs ?? REALTIME_HEARTBEAT_MS;
    this.hostLostMs = opts.hostLostMs ?? REALTIME_HOST_LOST_MS;
    this.ackMs = opts.ackMs ?? REALTIME_ACK_MS;
    this.intentFlushMs = opts.intentFlushMs ?? REALTIME_INTENT_FLUSH_MS;
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? (() => Date.now());
    this.onMessage = opts.onMessage;
    this.onError = opts.onError;
    this.lastHeardAt = this.now();

    if (this.host && this.gameStartInfo !== null) {
      this.ctx = createGameWireContext(this.gameStartInfo.players);
    }
  }

  get isHost(): boolean {
    return this.host;
  }

  get nextTurn(): number {
    return this.receiver?.nextTurn ?? 0;
  }

  get turnCountSeen(): number {
    return this.turnsSeen;
  }

  get lastExecutedTurnValue(): number {
    return this.lastExecutedTurn;
  }

  get lastExecutedHashValue(): number {
    return this.lastExecutedHash;
  }

  async connect(
    onconnect: () => void,
    onmessage: (message: ServerMessage) => void,
  ): Promise<void> {
    this.onMessage = onmessage;
    this.unsubscribeState =
      this.opts.transport.onStateChange?.((state) => {
        const previous = this.lastTransportStatus;
        this.lastTransportStatus = state.status;
        this.opts.onStateChange?.(state);
        if (
          state.status === "connected" &&
          previous !== "connected" &&
          this.started &&
          !this.closed
        ) {
          if (!this.host) {
            void this.sendHello(false).catch((error: unknown) =>
              this.warn("rejoin hello failed", error),
            );
          }
        }
      }) ?? null;
    await this.opts.transport.subscribe(this.clientID, (packet) =>
      this.onPacket(packet),
    );
    onconnect();
  }

  async joinGame(): Promise<void> {
    if (this.host) return;
    await this.sendHello(true);
  }

  async rejoinGame(lastTurn: number): Promise<void> {
    if (this.closed) return;
    if (this.host) {
      this.hostReady = true;
      await this.maybeStartMaker();
      return;
    }

    // The wire uses the last executed turn, not the number of turns that were
    // handed to the worker. The latter can be ahead while the engine catches
    // up, and asking from it would skip work after a reconnect.
    const fromTurn =
      this.lastExecutedTurn >= 0
        ? this.lastExecutedTurn
        : Math.max(0, lastTurn);
    await this.sendHello(fromTurn === 0);
    if (this.receiver !== null && this.receiver.nextTurn > fromTurn + 1) {
      await this.requestHistory(fromTurn + 1);
    }
  }

  turnComplete(): void {
    // Acks are intentionally timer-driven: one message per second carries both
    // the contiguous turn and the latest hash report.
  }

  reportHash(turn: number, hash: number): void {
    if (!Number.isFinite(turn) || !Number.isFinite(hash)) return;
    if (turn < this.lastExecutedTurn) return;
    this.lastExecutedTurn = turn;
    this.lastExecutedHash = hash;
  }

  sendIntent(intent: Intent): void {
    if (this.closed) return;
    if (this.host) {
      if (this.maker === null) {
        this.pendingHostIntents.push(intent);
      } else {
        this.maker.enqueue(this.clientID, intent);
      }
      return;
    }
    this.intentBuffer.push(intent);
    if (this.intentBuffer.length >= REALTIME_MAX_INTENTS_BUFFER) {
      void this.flushIntents();
    } else {
      this.intentTimer ??= setInterval(() => {
        void this.flushIntents();
      }, this.intentFlushMs);
    }
  }

  async reconnect(): Promise<void> {
    await this.opts.transport.reconnect?.();
  }

  async leaveGame(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopTimers();
    this.maker?.stop();
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    await this.opts.transport.close();
  }

  private get clientID(): string {
    return this.opts.clientID;
  }

  private get hostID(): string {
    return this.opts.hostID;
  }

  private async sendHello(coldStart: boolean): Promise<void> {
    const lastTurn = Math.max(0, this.lastExecutedTurn);
    const control = {
      type: "hello" as const,
      v: 1 as const,
      clientID: this.clientID,
      nickname: this.opts.nickname,
      lastTurn,
      lastHash: this.lastExecutedHash,
      coldStart,
    };
    if (this.allowGeneralHello) {
      await this.opts.transport.broadcast({
        kind: "control",
        from: this.clientID,
        control,
      });
    } else {
      await this.opts.transport.send(
        { kind: "control", from: this.clientID, control },
        [this.hostID],
      );
    }
  }

  private onPacket(packet: TransportPacket): void {
    if (this.closed) return;
    if (packet.kind === "control" && packet.control !== undefined) {
      this.onControl(packet.from, packet.control);
      return;
    }
    if (packet.kind === "heartbeat") {
      this.lastHeardAt = this.now();
      if (
        this.receiver !== null &&
        packet.lastTurn !== undefined &&
        packet.lastTurn > 0 &&
        this.receiver.nextTurn <= packet.lastTurn
      ) {
        void this.requestHistory(this.receiver.nextTurn);
      }
      return;
    }
    if (packet.kind === "turn" && packet.bytes !== undefined) {
      this.lastHeardAt = this.now();
      if (this.ctx === null || this.receiver === null) {
        this.earlyTurns.push(packet.bytes);
        return;
      }
      this.acceptBytes(packet.bytes);
      return;
    }
    if (packet.kind === "intent" && packet.bytes !== undefined) {
      if (!this.host || this.ctx === null) return;
      try {
        const batch = decodeIntentBatch(packet.bytes, this.ctx);
        if (this.maker === null) {
          this.pendingIntents.push({ clientID: packet.from, batch });
        } else {
          this.maker.enqueueBatch(packet.from, batch.seq, batch.intents);
        }
      } catch (error) {
        this.warn(`invalid intent batch from ${packet.from}`, error);
      }
      return;
    }
    if (packet.kind === "history_req") {
      if (!this.host || packet.fromTurn === undefined) return;
      void this.sendHistory(
        packet.from,
        packet.fromTurn,
        packet.requestId ?? "",
      );
      return;
    }
    if (packet.kind === "history_chunk" && packet.bytes !== undefined) {
      this.lastHeardAt = this.now();
      this.acceptHistory(packet.bytes);
    }
  }

  private onControl(from: string, control: RealtimeControl): void {
    if (control.type === "hello") {
      if (this.host) this.handleHello(from, control);
      return;
    }
    if (control.type === "start") {
      if (!this.host) this.handleStart(control);
      return;
    }
    if (control.type === "history_unavailable") {
      if (!this.host)
        this.fail(
          "history_unavailable",
          `History unavailable: ${control.reason}`,
        );
      return;
    }
    if (control.type === "error") {
      this.onMessage({
        type: "error",
        error: control.code,
        message: control.message,
      });
      return;
    }
    // F2a has no committed-turn majority, so an ack is informational only.
  }

  private handleHello(from: string, control: Hello): void {
    if (from === this.clientID) return;
    this.peers.set(from, { nickname: control.nickname });
    const count = (this.helloCounts.get(from) ?? 0) + 1;
    this.helloCounts.set(from, count);
    if (!this.subscribedPeers.has(from)) {
      this.subscribedPeers.add(from);
      void Promise.resolve(
        this.opts.transport.subscribe(from, (packet) => this.onPacket(packet)),
      ).catch((error: unknown) => {
        this.subscribedPeers.delete(from);
        this.warn("peer subscribe failed", error);
      });
    }

    // The second hello is sent after ClientGameRunner has installed its
    // callback and called rejoinGame. It can race with the host still awaiting
    // the send of the start message, so record readiness independently and
    // let sendStart re-check the maker condition when it finishes.
    if (count >= 2) this.peerReady.add(from);
    if (!this.startSent && !this.startSending) {
      void this.sendStart(from);
    } else {
      void this.maybeStartMaker();
      const nextTurn = this.maker?.nextTurn ?? 0;
      if (control.lastTurn + 1 < nextTurn) {
        void this.sendHistory(
          from,
          control.lastTurn + 1,
          `rejoin-${from}-${control.lastTurn}`,
        );
      }
    }
  }

  private async sendStart(peerID: string): Promise<void> {
    this.startSending = true;
    if (this.gameStartInfo === null || this.ctx === null) {
      this.startSending = false;
      this.fail("invalid", "host is missing gameStartInfo");
      return;
    }
    const info = this.withPeer(this.gameStartInfo, peerID);
    this.gameStartInfo = info;
    this.ctx = createGameWireContext(info.players);
    const start: Start = {
      type: "start",
      v: 1,
      gameStartInfo: info,
      myClientID: peerID,
      term: this.term,
      hostID: this.hostID,
      fromTurn: 0,
      historyComplete: true,
      historyFrom: 0,
    };
    try {
      await this.opts.transport.send(
        { kind: "control", from: this.hostID, control: start },
        [peerID],
      );
    } catch (error) {
      this.startSending = false;
      this.warn("start send failed", error);
      return;
    }
    this.startSent = true;
    this.deliverStart(info, this.clientID);
    await this.maybeStartMaker();
  }

  private handleStart(control: Start): void {
    if (control.myClientID !== this.clientID) return;
    if (this.started) return;
    this.gameStartInfo = control.gameStartInfo;
    this.ctx = createGameWireContext(control.gameStartInfo.players);
    this.receiver = new TurnReceiver({
      term: control.term,
      hostID: control.hostID,
      nextTurn: control.fromTurn,
      lastHash: control.fromTurn === 0 ? 0 : this.lastExecutedHash,
      ctx: this.ctx,
      log: this.log,
      onApply: (batch) => this.applyBatch(batch),
      onGap: (fromTurn) => void this.requestHistory(fromTurn),
      onConflict: (message) => this.fail("conflict", message),
      onDuplicate: () => {},
    });
    this.deliverStart(control.gameStartInfo, control.myClientID);
    this.startAckTimer();
    for (const bytes of this.earlyTurns.splice(0)) this.acceptBytes(bytes);
    if (!control.historyComplete && control.historyFrom > 0) {
      void this.requestHistory(control.historyFrom);
    }
  }

  private deliverStart(info: WireGameStartInfo, myClientID: string): void {
    this.started = true;
    this.lastHeardAt = this.now();
    if (this.host && this.receiver === null && this.ctx !== null) {
      this.receiver = new TurnReceiver({
        term: this.term,
        hostID: this.hostID,
        nextTurn: 0,
        lastHash: 0,
        ctx: this.ctx,
        log: this.log,
        onApply: (batch) => this.applyBatch(batch),
        onGap: (fromTurn) => void this.requestHistory(fromTurn),
        onConflict: (message) => this.fail("conflict", message),
        onDuplicate: () => {},
      });
    }
    this.onMessage({
      type: "start",
      turns: [],
      gameStartInfo: info,
      lobbyCreatedAt: info.lobbyCreatedAt,
      myClientID,
    });
  }

  private acceptBytes(bytes: Uint8Array): void {
    if (this.ctx === null || this.receiver === null) {
      this.earlyTurns.push(bytes);
      return;
    }
    try {
      const batch = decodeTurnBatch(bytes, this.ctx);
      this.frames.set(batch.fromTurn, bytes);
      this.receiver.accept(batch);
    } catch (error) {
      this.fail(
        "invalid",
        `invalid turn batch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private acceptHistory(bytes: Uint8Array): void {
    if (this.ctx === null || this.receiver === null) return;
    this.pendingHistory = null;
    try {
      const chunk = decodeHistoryChunk(bytes, this.ctx);
      for (const frame of chunk.frames) {
        const batch = decodeTurnBatch(frame, this.ctx);
        this.frames.set(batch.fromTurn, frame);
        this.receiver.accept(batch);
        if (this.receiver.isPaused) return;
      }
      if (chunk.more) {
        void this.requestHistory(chunk.toTurn + 1);
      } else if (this.receiver.nextTurn <= chunk.toTurn) {
        void this.requestHistory(this.receiver.nextTurn);
      } else {
        this.pendingHistory = null;
      }
    } catch (error) {
      this.fail(
        "invalid",
        `invalid history chunk: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private applyBatch(batch: TurnBatch): void {
    const frame = this.frames.get(batch.fromTurn);
    if (frame === undefined) {
      this.warn(`missing raw frame for turn ${batch.fromTurn}`);
    } else {
      this.log.append(batch, frame);
    }
    for (const turn of batch.turns) {
      this.turnsSeen++;
      this.onMessage({ type: "turn", turn });
    }
  }

  private async requestHistory(fromTurn: number): Promise<void> {
    if (this.host || this.receiver === null) return;
    if (this.pendingHistory !== null) return;
    const requestId = `${this.clientID}-${this.nextHistoryId++}`;
    this.pendingHistory = requestId;
    try {
      await this.opts.transport.send(
        {
          kind: "history_req",
          from: this.clientID,
          fromTurn,
          requestId,
        },
        [this.hostID],
      );
    } catch (error) {
      this.pendingHistory = null;
      this.warn("history request failed", error);
    }
  }

  private async sendHistory(
    peerID: string,
    fromTurn: number,
    requestId: string,
  ): Promise<void> {
    if (this.ctx === null) return;
    if (this.log.lateJoinDisabled) {
      await this.sendHistoryUnavailable(
        peerID,
        fromTurn,
        requestId,
        "late_join_disabled",
      );
      return;
    }
    const read = this.log.read(fromTurn, MAX_HISTORY_CHUNK_BYTES);
    if (read === null) {
      await this.sendHistoryUnavailable(peerID, fromTurn, requestId, "too_old");
      return;
    }
    const chunk: HistoryChunk = {
      type: "history_chunk",
      v: 1,
      requestId,
      term: this.term,
      hostID: this.hostID,
      fromTurn: read.fromTurn,
      toTurn: read.toTurn,
      frames: read.frames,
      more: read.more,
    };
    await this.opts.transport.send(
      {
        kind: "history_chunk",
        from: this.hostID,
        bytes: encodeHistoryChunk(chunk, this.ctx),
      },
      [peerID],
    );
  }

  private async sendHistoryUnavailable(
    peerID: string,
    fromTurn: number,
    requestId: string,
    reason: "too_old" | "too_large" | "late_join_disabled",
  ): Promise<void> {
    await this.opts.transport.send(
      {
        kind: "control",
        from: this.hostID,
        control: {
          type: "history_unavailable",
          v: 1,
          requestId,
          fromTurn,
          reason,
        },
      },
      [peerID],
    );
  }

  private async maybeStartMaker(): Promise<void> {
    if (
      !this.host ||
      this.makerStarted ||
      !this.startSent ||
      !this.hostReady ||
      this.peerReady.size === 0 ||
      this.ctx === null
    ) {
      return;
    }
    const ctx = this.ctx;
    this.maker = new TurnMaker({
      term: this.term,
      hostID: this.hostID,
      turnsPerBatch: this.turnsPerBatch,
      maxIntentsPerTurn: this.maxIntentsPerTurn,
      clock: this.opts.clock ?? new WorkerTurnClock(),
      ctx,
      sink: {
        publish: async (batch) => {
          const bytes = encodeTurnBatch(batch, ctx);
          await this.opts.transport.broadcast({
            kind: "turn",
            from: this.hostID,
            bytes,
          });
          this.lastBatchAt = this.now();
          this.acceptBytes(bytes);
        },
      },
      isLeaseValid: () => !this.closed,
      onPublishError: (error) => {
        this.warn("turn publish failed", error);
      },
      onLeaseLost: () => this.fail("conflict", "host lease lost"),
      onQueueOverflow: () => this.warn("intent queue overflow"),
    });
    for (const pending of this.pendingIntents.splice(0)) {
      this.maker.enqueueBatch(
        pending.clientID,
        pending.batch.seq,
        pending.batch.intents,
      );
    }
    for (const intent of this.pendingHostIntents.splice(0)) {
      this.maker.enqueue(this.clientID, intent);
    }
    this.makerStarted = true;
    this.maker.start(0);
    this.startHeartbeat();
    this.startAckTimer();
  }

  private startHeartbeat(): void {
    if (!this.host || this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || this.maker === null) return;
      if (this.now() - this.lastBatchAt < this.heartbeatMs) return;
      void this.opts.transport.broadcast({
        kind: "heartbeat",
        from: this.hostID,
        lastTurn: Math.max(0, this.maker.nextTurn - 1),
        lastHash: this.maker.lastHash,
        term: this.term,
      });
    }, this.heartbeatMs);
  }

  private startAckTimer(): void {
    if (this.ackTimer !== null) return;
    if (!this.host) {
      this.hostLostTimer = setInterval(
        () => {
          if (this.closed || this.hostLost) return;
          if (this.now() - this.lastHeardAt <= this.hostLostMs) return;
          this.hostLost = true;
          this.stopTimers();
          this.fail("host_lost", HOST_LOST_MESSAGE);
        },
        Math.max(100, Math.floor(this.hostLostMs / 3)),
      );
    }
    this.ackTimer = setInterval(() => {
      if (this.closed || this.host) return;
      const ack = makeAck({
        term: this.term,
        hostID: this.hostID,
        clientID: this.clientID,
        turn: Math.max(0, this.lastExecutedTurn),
        hash: this.lastExecutedHash,
        hashTurn: Math.max(0, this.lastExecutedTurn),
        hashValue: this.lastExecutedHash,
      });
      void this.opts.transport.send(
        { kind: "control", from: this.clientID, control: ack },
        [this.hostID],
      );
    }, this.ackMs);
  }

  private async flushIntents(): Promise<void> {
    if (this.closed || this.host) return;
    if (this.intentBuffer.length === 0) {
      if (this.intentTimer !== null) {
        clearInterval(this.intentTimer);
        this.intentTimer = null;
      }
      return;
    }
    if (this.ctx === null) return;
    const intents = this.intentBuffer.splice(0);
    const batch: IntentBatch = {
      type: "intent_batch",
      v: 1,
      clientID: this.clientID,
      seq: this.intentSeq++,
      intents,
    };
    try {
      await this.opts.transport.send(
        {
          kind: "intent",
          from: this.clientID,
          bytes: encodeIntentBatch(batch, this.ctx),
        },
        [this.hostID],
      );
    } catch (error) {
      this.intentBuffer.unshift(...intents);
      this.warn("intent send failed", error);
    }
  }

  private fail(code: string, message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.stopTimers();
    this.maker?.stop();
    this.onError?.(message);
    this.onMessage({ type: "error", error: code, message });
  }

  private withPeer(info: WireGameStartInfo, peerID: string): WireGameStartInfo {
    if (info.players.some((player) => player.clientID === peerID)) return info;
    const peer = this.peers.get(peerID);
    const player: WirePlayer = {
      clientID: peerID,
      username: peer?.nickname?.slice(0, 20) ?? `Player ${peerID.slice(0, 4)}`,
      clanTag: null,
    };
    return { ...info, players: [...info.players, player] };
  }

  private stopTimers(): void {
    for (const timer of [
      this.heartbeatTimer,
      this.hostLostTimer,
      this.ackTimer,
      this.intentTimer,
    ]) {
      if (timer !== null) clearInterval(timer);
    }
    this.heartbeatTimer = null;
    this.hostLostTimer = null;
    this.ackTimer = null;
    this.intentTimer = null;
  }

  private warn(message: string, error?: unknown): void {
    this.logger.warn(`[realtime] ${message}`, error);
  }
}
