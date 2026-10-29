import type {
  Intent,
  StampedIntent,
  Turn,
} from "@openfront/engine-api/Schemas";
import type { TurnBatch } from "@openfront/shared/RealtimeSchemas";
import { hashTurnBatch } from "@openfront/shared/RealtimeWire";
import type { ZbContext } from "@openfront/zbin";
import type { TurnClock } from "./TurnClock";

export type TurnSink = {
  publish(batch: TurnBatch): Promise<void>;
};

export type TurnMakerOptions = {
  term: number;
  hostID: string;
  turnsPerBatch: number;
  maxIntentsPerTurn: number;
  maxQueuedIntents?: number;
  clock: TurnClock;
  sink: TurnSink;
  ctx: ZbContext;
  isLeaseValid: () => boolean;
  onPublished?: (batch: TurnBatch) => void;
  onPublishError?: (error: unknown) => void;
  onLeaseLost?: () => void;
  onQueueOverflow?: () => void;
};

type QueuedIntent = {
  clientID: string;
  intent: Intent;
};

export const DEFAULT_TURNS_PER_BATCH = 2;
export const DEFAULT_MAX_INTENTS_PER_TURN = 64;
export const DEFAULT_MAX_QUEUED_INTENTS = 4096;

/**
 * The host's turn producer.
 *
 * It does not know about HostAuthority, Supabase or the election. The caller
 * supplies `term`, `isLeaseValid()` and a clock; production wires those to the
 * host role and the WorkerTurnClock, tests wire them to memory.
 */
export class TurnMaker {
  private readonly queue: QueuedIntent[] = [];
  private readonly lastIntentSeq = new Map<string, number>();
  private nextTurnValue: number;
  private lastHashValue: number;
  private started = false;
  private paused = false;
  private leaseLost = false;
  private leaseLostNotified = false;
  private publishing = false;
  private pendingPublish: TurnBatch | null = null;
  private readonly maxQueuedIntents: number;

  constructor(private readonly opts: TurnMakerOptions) {
    if (!Number.isInteger(opts.term) || opts.term < 0) {
      throw new Error(`invalid term: ${opts.term}`);
    }
    if (!Number.isInteger(opts.turnsPerBatch) || opts.turnsPerBatch <= 0) {
      throw new Error(`invalid turnsPerBatch: ${opts.turnsPerBatch}`);
    }
    if (
      !Number.isInteger(opts.maxIntentsPerTurn) ||
      opts.maxIntentsPerTurn <= 0
    ) {
      throw new Error(`invalid maxIntentsPerTurn: ${opts.maxIntentsPerTurn}`);
    }
    this.maxQueuedIntents = opts.maxQueuedIntents ?? DEFAULT_MAX_QUEUED_INTENTS;
    if (
      !Number.isInteger(this.maxQueuedIntents) ||
      this.maxQueuedIntents <= 0
    ) {
      throw new Error(`invalid maxQueuedIntents: ${this.maxQueuedIntents}`);
    }
    this.nextTurnValue = 0;
    this.lastHashValue = 0;
  }

  get nextTurn(): number {
    return this.nextTurnValue;
  }

  get lastHash(): number {
    return this.lastHashValue;
  }

  get queuedIntents(): number {
    return this.queue.length;
  }

  get isRunning(): boolean {
    return this.started && !this.paused;
  }

  get isLeaseLost(): boolean {
    return this.leaseLost;
  }

  start(nextTurn: number, lastHash = 0): void {
    if (!Number.isInteger(nextTurn) || nextTurn < 0) {
      throw new Error(`invalid start turn: ${nextTurn}`);
    }
    this.nextTurnValue = nextTurn;
    this.lastHashValue = lastHash;
    this.started = true;
    this.paused = false;
    this.leaseLost = false;
    this.leaseLostNotified = false;
    this.pendingPublish = null;
    this.publishing = false;
    this.opts.clock.start(() => this.tick());
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.started) return;
    this.paused = false;
  }

  stop(): void {
    this.started = false;
    this.paused = false;
    this.opts.clock.stop();
  }

  enqueue(clientID: string, intent: Intent): void {
    this.push({ clientID, intent });
  }

  enqueueBatch(
    clientID: string,
    seq: number,
    intents: readonly Intent[],
  ): void {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error(`invalid intent seq: ${seq}`);
    }
    const previous = this.lastIntentSeq.get(clientID);
    if (previous !== undefined && seq <= previous) return;
    this.lastIntentSeq.set(clientID, seq);
    for (const intent of intents) this.push({ clientID, intent });
  }

  /**
   * Runs one turn-building step. The clock calls this; tests can call it
   * directly after a fake-clock tick.
   */
  async tick(): Promise<void> {
    if (!this.started || this.paused || this.publishing) return;

    if (!this.opts.isLeaseValid()) {
      this.loseLease();
      return;
    }

    this.publishing = true;
    try {
      const batch = this.pendingPublish ?? this.buildBatch();
      this.pendingPublish = batch;
      try {
        await this.opts.sink.publish(batch);
      } catch (error) {
        this.opts.onPublishError?.(error);
        return;
      }
      this.pendingPublish = null;
      this.nextTurnValue = batch.fromTurn + batch.turns.length;
      this.lastHashValue = batch.hash;
      this.opts.onPublished?.(batch);
    } finally {
      this.publishing = false;
    }
  }

  private buildBatch(): TurnBatch {
    const turns: Turn[] = [];
    for (let i = 0; i < this.opts.turnsPerBatch; i++) {
      const intents: StampedIntent[] = [];
      const count = Math.min(this.opts.maxIntentsPerTurn, this.queue.length);
      for (let j = 0; j < count; j++) {
        const queued = this.queue.shift();
        if (queued === undefined) break;
        intents.push({
          ...queued.intent,
          clientID: queued.clientID,
        } as StampedIntent);
      }
      turns.push({
        turnNumber: this.nextTurnValue + i,
        intents,
      });
    }

    const batch: TurnBatch = {
      type: "turn_batch",
      v: 1,
      term: this.opts.term,
      hostID: this.opts.hostID,
      fromTurn: this.nextTurnValue,
      turns,
      prevHash: this.lastHashValue,
      hash: 0,
    };
    batch.hash = hashTurnBatch(batch, this.opts.ctx);
    return batch;
  }

  private push(intent: QueuedIntent): void {
    if (this.queue.length >= this.maxQueuedIntents) {
      this.queue.shift();
      this.opts.onQueueOverflow?.();
    }
    this.queue.push(intent);
  }

  private loseLease(): void {
    this.leaseLost = true;
    this.paused = true;
    if (this.leaseLostNotified) return;
    this.leaseLostNotified = true;
    this.opts.onLeaseLost?.();
  }
}
