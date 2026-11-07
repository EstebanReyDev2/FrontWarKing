import type { Turn } from "@openfront/engine-api/Schemas";
import {
  MAX_HISTORY_CHUNK_BYTES,
  REALTIME_PROTOCOL_VERSION,
} from "@openfront/shared/RealtimeSchemas";
import type {
  HistoryChunk,
  RealtimeControl,
  TurnBatch,
} from "@openfront/shared/RealtimeSchemas";
import {
  RealtimeWireError,
  decodeControl,
  decodeHistoryChunk,
  decodeIntentBatch,
  decodeTurnBatch,
  encodeControl,
  encodeHistoryChunk,
  encodeIntentBatch,
  encodeTurnBatch,
  fnv1a32,
  hashTurnBatch,
  isTurnBatchHashValid,
} from "@openfront/shared/RealtimeWire";
import { createGameWireContext } from "@openfront/shared/ZbinWire";
import { describe, expect, it } from "vitest";

const PLAYERS = [
  { clientID: "aB3dEf7h" },
  { clientID: "Xk9mNp2q" },
  { clientID: "Zz8wVu5t" },
];

const [P1, P2] = PLAYERS.map((p) => p.clientID);

function contexts() {
  return [createGameWireContext(PLAYERS), createGameWireContext(PLAYERS)];
}

function turn(turnNumber: number): Turn {
  return {
    turnNumber,
    intents: [
      { type: "spawn", clientID: P1, tile: turnNumber + 1 },
      { type: "attack", clientID: P2, targetID: P1, troops: 12.5 },
    ],
  };
}

function batch(overrides: Partial<TurnBatch> = {}): TurnBatch {
  return {
    type: "turn_batch",
    v: 1,
    term: 1,
    hostID: P1,
    fromTurn: 0,
    turns: [turn(0), turn(1)],
    prevHash: 0,
    hash: 0,
    ...overrides,
  };
}

describe("RealtimeWire", () => {
  it("round-trips a turn batch with a shared roster context", () => {
    const [hostCtx, receiverCtx] = contexts();
    const outgoing = batch();
    outgoing.hash = hashTurnBatch(outgoing, hostCtx);

    const bytes = encodeTurnBatch(outgoing, hostCtx);
    expect(bytes[0]).toBe(REALTIME_PROTOCOL_VERSION);
    expect(decodeTurnBatch(bytes, receiverCtx)).toEqual(outgoing);
  });

  it("hashes the payload without requiring the hash field", () => {
    const [ctx] = contexts();
    const outgoing = batch();
    outgoing.hash = hashTurnBatch(outgoing, ctx);

    expect(isTurnBatchHashValid(outgoing, ctx)).toBe(true);
    const changed = batch({ turns: [turn(0), turn(1)] });
    changed.hash = outgoing.hash;
    changed.turns[1].intents[0] = {
      type: "spawn",
      clientID: P2,
      tile: 99,
    };
    expect(isTurnBatchHashValid(changed, ctx)).toBe(false);
  });

  it("round-trips an intent batch", () => {
    const [ctx] = contexts();
    const outgoing = {
      type: "intent_batch" as const,
      v: 1 as const,
      clientID: P2,
      seq: 7,
      intents: [{ type: "spawn" as const, tile: 42 }],
    };
    const bytes = encodeIntentBatch(outgoing, ctx);
    expect(decodeIntentBatch(bytes, ctx)).toEqual(outgoing);
  });

  it("round-trips a history chunk and its raw turn frames", () => {
    const [ctx] = contexts();
    const outgoingTurn = batch();
    outgoingTurn.hash = hashTurnBatch(outgoingTurn, ctx);
    const frame = encodeTurnBatch(outgoingTurn, ctx);
    const chunk: HistoryChunk = {
      type: "history_chunk",
      v: 1,
      requestId: "req-1",
      term: 1,
      hostID: P1,
      fromTurn: 0,
      toTurn: 1,
      frames: [frame],
      more: false,
    };

    const decoded = decodeHistoryChunk(encodeHistoryChunk(chunk, ctx), ctx);
    expect(decoded).toEqual(chunk);
    expect(decodeTurnBatch(decoded.frames[0], ctx)).toEqual(outgoingTurn);
  });

  it("rejects a history chunk over 96 KB", () => {
    const [ctx] = contexts();
    const chunk: HistoryChunk = {
      type: "history_chunk",
      v: 1,
      requestId: "too-big",
      term: 1,
      hostID: P1,
      fromTurn: 0,
      toTurn: 999,
      frames: [new Uint8Array(MAX_HISTORY_CHUNK_BYTES)],
      more: false,
    };
    expect(() => encodeHistoryChunk(chunk, ctx)).toThrow(RangeError);
  });

  it("round-trips the combined ack and hash report as JSON", () => {
    const ack: RealtimeControl = {
      type: "ack",
      v: 1,
      term: 1,
      hostID: P1,
      clientID: P2,
      turn: 120,
      hash: 1234,
      hashTurn: 120,
      hashValue: 5678,
    };

    expect(decodeControl(encodeControl(ack))).toEqual(ack);
    expect(JSON.parse(encodeControl(ack))).toMatchObject({
      type: "ack",
      turn: 120,
      hashTurn: 120,
      hashValue: 5678,
    });
  });

  it("round-trips hello and history requests", () => {
    const hello: RealtimeControl = {
      type: "hello",
      v: 1,
      clientID: P2,
      nickname: "bravo",
      lastTurn: 3,
      lastHash: 99,
      coldStart: false,
    };
    const req: RealtimeControl = {
      type: "history_req",
      v: 1,
      requestId: "sync-1",
      fromTurn: 4,
      maxBytes: 32 * 1024,
    };

    expect(decodeControl(encodeControl(hello))).toEqual(hello);
    expect(decodeControl(encodeControl(req))).toEqual(req);
  });

  it("rejects an unknown protocol version", () => {
    const [ctx] = contexts();
    const bytes = encodeTurnBatch(batch(), ctx);
    bytes[0] = 99;
    expect(() => decodeTurnBatch(bytes, ctx)).toThrow(RealtimeWireError);
  });

  it("rejects control JSON that does not match the schema", () => {
    expect(() => decodeControl('{"type":"ack"}')).toThrow();
  });

  it("keeps FNV-1a deterministic across byte arrays", () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(fnv1a32(bytes)).toBe(fnv1a32(new Uint8Array([0, 1, 2, 255])));
    expect(fnv1a32(bytes)).not.toBe(fnv1a32(new Uint8Array([0, 1, 2, 254])));
  });
});
