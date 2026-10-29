import type { TurnBatch } from "@openfront/shared/RealtimeSchemas";
import { isTurnBatchHashValid } from "@openfront/shared/RealtimeWire";
import type { ZbContext } from "@openfront/zbin";
import { TurnLog } from "./TurnLog";

export type TurnReceiverResult = "applied" | "ignored" | "pending" | "conflict";

export type TurnReceiverOptions = {
  term: number;
  hostID: string;
  nextTurn: number;
  lastHash: number;
  ctx: ZbContext;
  log?: TurnLog;
  allowTermChange?: boolean;
  maxPendingBatches?: number;
  onApply?: (batch: TurnBatch) => void;
  onGap?: (fromTurn: number) => void;
  onConflict?: (message: string) => void;
  onDuplicate?: (batch: TurnBatch) => void;
};

export const DEFAULT_MAX_PENDING_BATCHES = 256;

/**
 * Validates the host's turn chain and keeps out-of-order batches until the
 * missing range arrives.
 *
 * The receiver does not know about Supabase, the worker or the UI. Its only
 * input is a TurnBatch; the caller turns onApply/onGap/onConflict into network
 * and UI actions.
 */
export class TurnReceiver {
  private currentTerm: number;
  private currentHostID: string;
  private nextTurnValue: number;
  private lastHashValue: number;
  private readonly pending = new Map<number, TurnBatch>();
  private paused = false;
  private readonly maxPendingBatches: number;
  private readonly allowTermChange: boolean;

  constructor(private readonly opts: TurnReceiverOptions) {
    if (!Number.isInteger(opts.term) || opts.term < 0) {
      throw new Error(`invalid term: ${opts.term}`);
    }
    if (!Number.isInteger(opts.nextTurn) || opts.nextTurn < 0) {
      throw new Error(`invalid nextTurn: ${opts.nextTurn}`);
    }
    this.currentTerm = opts.term;
    this.currentHostID = opts.hostID;
    this.nextTurnValue = opts.nextTurn;
    this.lastHashValue = opts.lastHash;
    this.allowTermChange = opts.allowTermChange ?? false;
    this.maxPendingBatches =
      opts.maxPendingBatches ?? DEFAULT_MAX_PENDING_BATCHES;
    if (
      !Number.isInteger(this.maxPendingBatches) ||
      this.maxPendingBatches <= 0
    ) {
      throw new Error(`invalid maxPendingBatches: ${this.maxPendingBatches}`);
    }
  }

  get term(): number {
    return this.currentTerm;
  }

  get hostID(): string {
    return this.currentHostID;
  }

  get nextTurn(): number {
    return this.nextTurnValue;
  }

  get lastHash(): number {
    return this.lastHashValue;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  accept(batch: TurnBatch): TurnReceiverResult {
    if (this.paused) return "conflict";

    if (batch.term < this.currentTerm) return "ignored";
    if (batch.term > this.currentTerm) {
      if (!this.allowTermChange) {
        return this.conflict(
          `unexpected term ${batch.term}; F2a keeps host ${this.currentHostID}`,
        );
      }
      this.currentTerm = batch.term;
      this.currentHostID = batch.hostID;
      this.pending.clear();
    }

    if (batch.hostID !== this.currentHostID) {
      return this.conflict(
        `host ${batch.hostID} does not match ${this.currentHostID}`,
      );
    }

    const shapeError = this.shapeError(batch);
    if (shapeError !== null) return this.conflict(shapeError);

    if (this.opts.log?.findOverlap(batch) === "conflict") {
      return this.conflict(`overlapping batch at ${batch.fromTurn}`);
    }

    if (batch.fromTurn < this.nextTurnValue) {
      // The whole batch is already applied. Comparing its final hash is enough
      // when it ends exactly at the previous turn; the log can also prove an
      // exact duplicate when it is available.
      if (
        batch.fromTurn + batch.turns.length - 1 === this.nextTurnValue - 1 &&
        batch.hash === this.lastHashValue
      ) {
        this.opts.onDuplicate?.(batch);
        return "ignored";
      }
      if (this.opts.log?.findOverlap(batch) === "duplicate") {
        this.opts.onDuplicate?.(batch);
        return "ignored";
      }
      return this.conflict(
        `batch ${batch.fromTurn} is behind next ${this.nextTurnValue}`,
      );
    }

    if (batch.fromTurn > this.nextTurnValue) {
      const existing = this.pending.get(batch.fromTurn);
      if (existing !== undefined) {
        if (existing.hash === batch.hash) return "ignored";
        return this.conflict(`different pending batch at ${batch.fromTurn}`);
      }
      if (this.pending.size >= this.maxPendingBatches) {
        return this.conflict(
          `too many pending batches (${this.pending.size}) while waiting for ${this.nextTurnValue}`,
        );
      }
      this.pending.set(batch.fromTurn, batch);
      this.opts.onGap?.(this.nextTurnValue);
      return "pending";
    }

    if (batch.prevHash !== this.lastHashValue) {
      return this.conflict(
        `batch ${batch.fromTurn} prevHash ${batch.prevHash} does not match ${this.lastHashValue}`,
      );
    }

    this.apply(batch);
    this.drain();
    return "applied";
  }

  private drain(): void {
    for (;;) {
      const batch = this.pending.get(this.nextTurnValue);
      if (batch === undefined) return;
      this.pending.delete(batch.fromTurn);

      const shapeError = this.shapeError(batch);
      if (shapeError !== null) {
        this.conflict(shapeError);
        return;
      }
      if (batch.prevHash !== this.lastHashValue) {
        this.conflict(
          `pending batch ${batch.fromTurn} prevHash ${batch.prevHash} does not match ${this.lastHashValue}`,
        );
        return;
      }
      this.apply(batch);
    }
  }

  private apply(batch: TurnBatch): void {
    this.opts.onApply?.(batch);
    this.nextTurnValue = batch.fromTurn + batch.turns.length;
    this.lastHashValue = batch.hash;
  }

  private shapeError(batch: TurnBatch): string | null {
    if (batch.turns.length === 0) return `empty batch at ${batch.fromTurn}`;
    if (batch.turns[0].turnNumber !== batch.fromTurn) {
      return `batch starts at ${batch.fromTurn} but first turn is ${batch.turns[0].turnNumber}`;
    }
    for (let i = 1; i < batch.turns.length; i++) {
      const expected = batch.fromTurn + i;
      if (batch.turns[i].turnNumber !== expected) {
        return `batch turn ${batch.turns[i].turnNumber} does not follow ${expected - 1}`;
      }
    }
    if (!Number.isFinite(batch.prevHash) || !Number.isFinite(batch.hash)) {
      return `batch ${batch.fromTurn} has a non-finite hash`;
    }
    if (!isTurnBatchHashValid(batch, this.opts.ctx)) {
      return `batch ${batch.fromTurn} has an invalid hash`;
    }
    return null;
  }

  private conflict(message: string): "conflict" {
    this.paused = true;
    this.opts.onConflict?.(message);
    return "conflict";
  }
}
