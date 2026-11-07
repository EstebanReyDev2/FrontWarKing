import { MAX_HISTORY_CHUNK_BYTES } from "@openfront/shared/RealtimeSchemas";
import type { TurnBatch } from "@openfront/shared/RealtimeSchemas";

export const DEFAULT_MAX_TURN_LOG_BYTES = 128 * 1024 * 1024;

export type TurnLogEntry = {
  fromTurn: number;
  toTurn: number;
  term: number;
  hostID: string;
  hash: number;
  bytes: Uint8Array;
};

export type TurnLogRead = {
  fromTurn: number;
  toTurn: number;
  frames: Uint8Array[];
  more: boolean;
};

export type TurnLogAppendResult = {
  stored: boolean;
  lateJoinDisabled: boolean;
};

export type TurnLogOverlap = "duplicate" | "conflict" | "none";

/**
 * In-memory history of turn batches.
 *
 * The canonical payload is the already-encoded zbin frame. There is no gzip,
 * no compression worker and no 256-turn segmentation: a batch is small enough
 * that storing its bytes is simpler and avoids keeping decoded Turn objects
 * alive for the whole game.
 */
export class TurnLog {
  private readonly entries: TurnLogEntry[] = [];
  private readonly byFromTurn = new Map<number, TurnLogEntry>();
  private totalBytes = 0;
  private disabled = false;

  constructor(
    private readonly maxBytes = DEFAULT_MAX_TURN_LOG_BYTES,
    private readonly defaultChunkBytes = MAX_HISTORY_CHUNK_BYTES,
  ) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`invalid TurnLog maxBytes: ${maxBytes}`);
    }
    if (!Number.isInteger(defaultChunkBytes) || defaultChunkBytes <= 0) {
      throw new Error(`invalid TurnLog chunk size: ${defaultChunkBytes}`);
    }
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  get lateJoinDisabled(): boolean {
    return this.disabled;
  }

  get size(): number {
    return this.entries.length;
  }

  get lastTurn(): number {
    return this.entries.length === 0
      ? -1
      : this.entries[this.entries.length - 1].toTurn;
  }

  get lastHash(): number {
    return this.entries.length === 0
      ? 0
      : this.entries[this.entries.length - 1].hash;
  }

  append(batch: TurnBatch, bytes: Uint8Array): TurnLogAppendResult {
    if (this.disabled) return { stored: false, lateJoinDisabled: true };
    validateBatchShape(batch);

    const batchToTurn = batch.fromTurn + batch.turns.length - 1;
    const existing = this.byFromTurn.get(batch.fromTurn);
    if (existing !== undefined) {
      if (
        existing.toTurn === batchToTurn &&
        existing.hash === batch.hash &&
        existing.term === batch.term &&
        existing.hostID === batch.hostID
      ) {
        return { stored: false, lateJoinDisabled: false };
      }
      throw new Error(
        `TurnLog already has a different batch at ${batch.fromTurn}`,
      );
    }

    if (this.totalBytes + bytes.byteLength > this.maxBytes) {
      // Do not silently drop the oldest entries: that would make a cold start
      // impossible without telling the user. Stop growing and disable late join.
      this.disabled = true;
      return { stored: false, lateJoinDisabled: true };
    }

    const entry: TurnLogEntry = {
      fromTurn: batch.fromTurn,
      toTurn: batch.fromTurn + batch.turns.length - 1,
      term: batch.term,
      hostID: batch.hostID,
      hash: batch.hash,
      bytes: bytes.slice(),
    };
    this.entries.push(entry);
    this.byFromTurn.set(entry.fromTurn, entry);
    this.totalBytes += entry.bytes.byteLength;
    return { stored: true, lateJoinDisabled: false };
  }

  read(
    fromTurn: number,
    maxBytes = this.defaultChunkBytes,
  ): TurnLogRead | null {
    if (!Number.isInteger(fromTurn) || fromTurn < 0) {
      throw new Error(`invalid TurnLog read turn: ${fromTurn}`);
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error(`invalid TurnLog read limit: ${maxBytes}`);
    }

    const start = this.indexOfTurn(fromTurn);
    if (start === -1) return null;

    const frames: Uint8Array[] = [];
    let total = 0;
    let end = start;
    for (let i = start; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (frames.length > 0 && total + entry.bytes.byteLength > maxBytes) {
        break;
      }
      frames.push(entry.bytes.slice());
      total += entry.bytes.byteLength;
      end = i;
      if (frames.length === 1 && total > maxBytes) break;
    }

    return {
      fromTurn: this.entries[start].fromTurn,
      toTurn: this.entries[end].toTurn,
      frames,
      more: end + 1 < this.entries.length,
    };
  }

  hasTurn(turn: number): boolean {
    return this.indexOfTurn(turn) !== -1;
  }

  getEntry(fromTurn: number): TurnLogEntry | null {
    return this.byFromTurn.get(fromTurn) ?? null;
  }

  findOverlap(batch: TurnBatch): TurnLogOverlap {
    const batchTo = batch.fromTurn + batch.turns.length - 1;
    for (const entry of this.entries) {
      if (entry.toTurn < batch.fromTurn || entry.fromTurn > batchTo) continue;
      if (
        entry.fromTurn === batch.fromTurn &&
        entry.toTurn === batchTo &&
        entry.hash === batch.hash &&
        entry.term === batch.term &&
        entry.hostID === batch.hostID
      ) {
        return "duplicate";
      }
      return "conflict";
    }
    return "none";
  }

  private indexOfTurn(turn: number): number {
    // The history is append-only and turn ranges do not overlap, so a binary
    // search is enough and keeps late-join reads cheap.
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const entry = this.entries[mid];
      if (turn < entry.fromTurn) hi = mid - 1;
      else if (turn > entry.toTurn) lo = mid + 1;
      else return mid;
    }
    return -1;
  }
}

function validateBatchShape(batch: TurnBatch): void {
  if (batch.turns.length === 0) {
    throw new Error("TurnLog cannot store an empty batch");
  }
  if (batch.turns[0].turnNumber !== batch.fromTurn) {
    throw new Error(
      `TurnLog batch starts at ${batch.fromTurn} but first turn is ${batch.turns[0].turnNumber}`,
    );
  }
  for (let i = 1; i < batch.turns.length; i++) {
    const expected = batch.fromTurn + i;
    if (batch.turns[i].turnNumber !== expected) {
      throw new Error(
        `TurnLog batch turn ${batch.turns[i].turnNumber} does not follow ${expected - 1}`,
      );
    }
  }
}
