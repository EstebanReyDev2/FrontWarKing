import type { TurnBatch } from "@openfront/shared/RealtimeSchemas";
import type { HistoryChunk } from "@openfront/shared/RealtimeSchemas";
import {
  decodeHistoryChunk,
  decodeTurnBatch,
  encodeHistoryChunk,
  encodeTurnBatch,
} from "@openfront/shared/RealtimeWire";
import type { ZbContext } from "@openfront/zbin";
import type { TurnClock } from "src/client/netcode/TurnClock";
import { TurnLog } from "src/client/netcode/TurnLog";
import { TurnMaker } from "src/client/netcode/TurnMaker";
import { TurnReceiver } from "src/client/netcode/TurnReceiver";

export type FakePacket = {
  kind: "turn" | "history_chunk" | "history_req" | "heartbeat";
  from: string;
  to: string;
  bytes?: Uint8Array;
  fromTurn?: number;
  requestId?: string;
  lastTurn?: number;
};

type Listener = (packet: FakePacket) => void;

export type FakeTransportOptions = {
  seed: number;
  loss?: number;
  duplicate?: number;
  maxLatency?: number;
};

type Queued = {
  due: number;
  seq: number;
  packet: FakePacket;
};

/** Deterministic PRNG; integration tests must not use Math.random. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Broadcast-like in-memory transport with seeded loss, duplication and
 * reordering. Latency is a logical tick delay, so the test never depends on
 * wall-clock time.
 */
export class FakeTransport {
  private readonly listeners = new Map<string, Listener>();
  private queue: Queued[] = [];
  private seq = 0;
  private nowValue = 0;
  private readonly random: () => number;
  private readonly loss: number;
  private readonly duplicate: number;
  private readonly maxLatency: number;

  constructor(options: FakeTransportOptions) {
    this.random = mulberry32(options.seed);
    this.loss = clamp(options.loss ?? 0);
    this.duplicate = clamp(options.duplicate ?? 0);
    this.maxLatency = Math.max(0, Math.floor(options.maxLatency ?? 0));
  }

  get now(): number {
    return this.nowValue;
  }

  subscribe(id: string, listener: Listener): void {
    this.listeners.set(id, listener);
  }

  unsubscribe(id: string): void {
    this.listeners.delete(id);
  }

  send(packet: Omit<FakePacket, "to">, recipients: readonly string[]): void {
    for (const to of recipients) this.enqueue({ ...packet, to });
  }

  broadcast(packet: Omit<FakePacket, "to">, except?: string): void {
    for (const id of this.listeners.keys()) {
      if (id !== except) this.enqueue({ ...packet, to: id });
    }
  }

  advance(): void {
    this.nowValue++;
    this.deliverDue();
  }

  /** Delivers every queued packet, including retries triggered while draining. */
  flush(): void {
    for (let guard = 0; this.queue.length > 0; guard++) {
      if (guard > 10_000) throw new Error("fake transport did not drain");
      this.nowValue++;
      this.deliverDue();
    }
  }

  private enqueue(packet: FakePacket): void {
    if (this.random() < this.loss) return;
    const copies = this.random() < this.duplicate ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      const latency = Math.floor(this.random() * (this.maxLatency + 1));
      this.queue.push({
        due: this.nowValue + latency,
        seq: this.seq++,
        packet,
      });
    }
  }

  private deliverDue(): void {
    const ready = this.queue.filter((item) => item.due <= this.nowValue);
    if (ready.length === 0) return;
    this.queue = this.queue.filter((item) => item.due > this.nowValue);
    ready.sort((a, b) => a.due - b.due || a.seq - b.seq);
    for (const item of ready) {
      this.listeners.get(item.packet.to)?.(item.packet);
    }
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class FakeClock implements TurnClock {
  private callback: (() => void | Promise<void>) | null = null;

  start(callback: () => void | Promise<void>): void {
    this.callback = callback;
  }

  stop(): void {
    this.callback = null;
  }

  async tick(): Promise<void> {
    await this.callback?.();
  }
}

export const HOST_LOST_MESSAGE = "El host se desconectó. La partida terminó.";

export type FakePeerOptions = {
  id: string;
  hostID: string;
  term: number;
  ctx: ZbContext;
  network: FakeTransport;
  leaseTicks: number;
  onHostLost?: (message: string) => void;
};

/**
 * A follower in the integration test. It owns the same TurnLog/TurnReceiver
 * that the real session will own, and asks the host for history when it sees a
 * gap (or when it joins late).
 */
export class FakePeer {
  readonly log = new TurnLog();
  readonly receiver: TurnReceiver;
  private catchUpFrom: number | null = null;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private lastHeardAt: number;
  private requestSeq = 0;
  private hostLost = false;
  private conflictMessage: string | null = null;

  constructor(private readonly opts: FakePeerOptions) {
    this.lastHeardAt = opts.network.now;
    this.receiver = new TurnReceiver({
      term: opts.term,
      hostID: opts.hostID,
      nextTurn: 0,
      lastHash: 0,
      ctx: opts.ctx,
      log: this.log,
      onApply: (batch) => {
        this.log.append(batch, encodeTurnBatch(batch, opts.ctx));
      },
      onGap: (fromTurn) => this.requestHistory(fromTurn),
      onConflict: (message) => {
        this.conflictMessage = message;
      },
    });
    opts.network.subscribe(opts.id, (packet) => this.onPacket(packet));
  }

  get nextTurn(): number {
    return this.receiver.nextTurn;
  }

  get lastHash(): number {
    return this.receiver.lastHash;
  }

  get isHostLost(): boolean {
    return this.hostLost;
  }

  get conflict(): string | null {
    return this.conflictMessage;
  }

  startCatchUp(fromTurn: number): void {
    this.catchUpFrom = fromTurn;
    this.sendHistoryRequest();
  }

  onTick(): void {
    if (
      this.catchUpFrom !== null &&
      this.opts.network.now - this.lastRequestAt >= 2
    ) {
      this.sendHistoryRequest();
    }
    if (
      !this.hostLost &&
      this.opts.network.now - this.lastHeardAt >= this.opts.leaseTicks
    ) {
      this.hostLost = true;
      this.opts.onHostLost?.(HOST_LOST_MESSAGE);
    }
  }

  private onPacket(packet: FakePacket): void {
    if (packet.kind === "turn" && packet.bytes !== undefined) {
      this.lastHeardAt = this.opts.network.now;
      const batch = decodeTurnBatch(packet.bytes, this.opts.ctx);
      this.receiver.accept(batch);
      return;
    }
    if (packet.kind === "history_chunk" && packet.bytes !== undefined) {
      this.lastHeardAt = this.opts.network.now;
      const chunk = decodeHistoryChunk(packet.bytes, this.opts.ctx);
      for (const frame of chunk.frames) {
        const batch = decodeTurnBatch(frame, this.opts.ctx);
        this.receiver.accept(batch);
        if (this.conflictMessage !== null) return;
      }
      if (chunk.more || this.receiver.nextTurn <= chunk.toTurn) {
        this.catchUpFrom = chunk.toTurn + 1;
        this.sendHistoryRequest();
      } else {
        this.catchUpFrom = null;
      }
      return;
    }
    if (packet.kind === "heartbeat" && packet.lastTurn !== undefined) {
      this.lastHeardAt = this.opts.network.now;
      if (this.receiver.nextTurn <= packet.lastTurn) {
        this.requestHistory(this.receiver.nextTurn);
      }
    }
  }

  private requestHistory(fromTurn: number): void {
    if (this.catchUpFrom === null || fromTurn < this.catchUpFrom) {
      this.catchUpFrom = fromTurn;
      this.sendHistoryRequest();
    }
  }

  private sendHistoryRequest(): void {
    if (this.catchUpFrom === null) return;
    this.opts.network.send(
      {
        kind: "history_req",
        from: this.opts.id,
        fromTurn: this.catchUpFrom,
        requestId: `${this.opts.id}-${this.requestSeq++}`,
      },
      [this.opts.hostID],
    );
    this.lastRequestAt = this.opts.network.now;
  }
}

export type FakeHostOptions = {
  id: string;
  term: number;
  ctx: ZbContext;
  network: FakeTransport;
  turnsPerBatch: number;
  maxIntentsPerTurn: number;
};

/**
 * Host harness: TurnMaker plus the host's own TurnLog/TurnReceiver and a tiny
 * history response path. It deliberately does not implement election: F2a has
 * no failover.
 */
export class FakeHost {
  readonly log = new TurnLog();
  readonly receiver: TurnReceiver;
  readonly maker: TurnMaker;
  private readonly clock = new FakeClock();
  private alive = true;

  constructor(private readonly opts: FakeHostOptions) {
    this.receiver = new TurnReceiver({
      term: opts.term,
      hostID: opts.id,
      nextTurn: 0,
      lastHash: 0,
      ctx: opts.ctx,
      log: this.log,
      onApply: () => {},
    });
    this.maker = new TurnMaker({
      term: opts.term,
      hostID: opts.id,
      turnsPerBatch: opts.turnsPerBatch,
      maxIntentsPerTurn: opts.maxIntentsPerTurn,
      clock: this.clock,
      ctx: opts.ctx,
      sink: {
        publish: async (batch) => {
          if (!this.alive) return;
          const bytes = encodeTurnBatch(batch, opts.ctx);
          opts.network.broadcast(
            { kind: "turn", from: opts.id, bytes },
            opts.id,
          );
        },
      },
      isLeaseValid: () => this.alive,
      onPublished: (batch) => {
        this.log.append(batch, encodeTurnBatch(batch, opts.ctx));
        this.receiver.accept(batch);
      },
    });
    opts.network.subscribe(opts.id, (packet) => {
      if (packet.kind === "history_req" && this.alive) {
        this.sendHistory(
          packet.from,
          packet.fromTurn ?? 0,
          packet.requestId ?? "",
        );
      }
    });
  }

  start(): void {
    this.maker.start(0);
  }

  async tick(): Promise<void> {
    await this.maker.tick();
    if (!this.alive) return;
    this.opts.network.broadcast(
      {
        kind: "heartbeat",
        from: this.opts.id,
        lastTurn: this.log.lastTurn,
      },
      this.opts.id,
    );
  }

  stop(): void {
    this.alive = false;
    this.maker.stop();
  }

  get nextTurn(): number {
    return this.receiver.nextTurn;
  }

  get lastHash(): number {
    return this.receiver.lastHash;
  }

  private sendHistory(to: string, fromTurn: number, requestId: string): void {
    const read = this.log.read(fromTurn);
    if (read === null) return;
    const chunk: HistoryChunk = {
      type: "history_chunk",
      v: 1,
      requestId,
      term: this.opts.term,
      hostID: this.opts.id,
      fromTurn: read.fromTurn,
      toTurn: read.toTurn,
      frames: read.frames,
      more: read.more,
    };
    this.opts.network.send(
      {
        kind: "history_chunk",
        from: this.opts.id,
        bytes: encodeHistoryChunk(chunk, this.opts.ctx),
        requestId,
      },
      [to],
    );
  }
}

/** Advances the network and lets each peer retry its catch-up request. */
export function pump(
  network: FakeTransport,
  peers: readonly FakePeer[],
  ticks = 1,
): void {
  for (let i = 0; i < ticks; i++) {
    network.advance();
    for (const peer of peers) peer.onTick();
  }
}

export function stateOf(peer: FakePeer | FakeHost): {
  nextTurn: number;
  lastHash: number;
} {
  return { nextTurn: peer.nextTurn, lastHash: peer.lastHash };
}

export function encodeHostBatch(batch: TurnBatch, ctx: ZbContext): Uint8Array {
  return encodeTurnBatch(batch, ctx);
}
