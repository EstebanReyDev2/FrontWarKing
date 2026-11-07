// Binary framing and JSON control helpers for the Phase 2 realtime protocol.
//
// Binary frames are: [protocolVersion: u8][zbin payload]. The caller knows
// which schema belongs to the channel/event it is handling, so there is no
// envelope tag beyond the version byte. Control messages stay JSON.
import { ZbContext, ZbDecodeError } from "@openfront/zbin";
import {
  Ack,
  HistoryChunk,
  HistoryChunkSchema,
  IntentBatch,
  IntentBatchSchema,
  MAX_CONTROL_BYTES,
  MAX_HISTORY_CHUNK_BYTES,
  MAX_REALTIME_FRAME_BYTES,
  REALTIME_PROTOCOL_VERSION,
  RealtimeControl,
  RealtimeControlSchema,
  TurnBatch,
  TurnBatchPayload,
  TurnBatchPayloadSchema,
  TurnBatchSchema,
} from "./RealtimeSchemas";

const utf8 = new TextEncoder();

export class RealtimeWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeWireError";
  }
}

function frame(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  if (payload.byteLength + 1 > MAX_REALTIME_FRAME_BYTES) {
    throw new RangeError(
      `realtime frame is ${payload.byteLength + 1} bytes; limit is ${MAX_REALTIME_FRAME_BYTES}`,
    );
  }
  const out = new Uint8Array(payload.byteLength + 1);
  out[0] = REALTIME_PROTOCOL_VERSION;
  out.set(payload, 1);
  return out;
}

function unframe(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) {
    throw new RealtimeWireError("empty realtime frame");
  }
  if (bytes.byteLength > MAX_REALTIME_FRAME_BYTES) {
    throw new RealtimeWireError(
      `realtime frame is ${bytes.byteLength} bytes; limit is ${MAX_REALTIME_FRAME_BYTES}`,
    );
  }
  if (bytes[0] !== REALTIME_PROTOCOL_VERSION) {
    throw new RealtimeWireError(
      `unsupported realtime protocol version ${bytes[0]}`,
    );
  }
  return bytes.subarray(1);
}

// FNV-1a over raw bytes. This is a conflict detector, not a cryptographic
// digest: the host and the roster are still the authority.
export function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function encodeTurnBatch(
  batch: TurnBatch,
  ctx?: ZbContext,
): Uint8Array<ArrayBuffer> {
  return frame(TurnBatchSchema.serialize(batch, ctx));
}

export function decodeTurnBatch(
  bytes: Uint8Array,
  ctx?: ZbContext,
): TurnBatch {
  return TurnBatchSchema.parseBytes(unframe(bytes), ctx);
}

export function encodeTurnBatchPayload(
  payload: TurnBatchPayload,
  ctx?: ZbContext,
): Uint8Array<ArrayBuffer> {
  return TurnBatchPayloadSchema.serialize(payload, ctx);
}

export function turnBatchPayload(batch: TurnBatch): TurnBatchPayload {
  return {
    type: batch.type,
    v: batch.v,
    term: batch.term,
    hostID: batch.hostID,
    fromTurn: batch.fromTurn,
    turns: batch.turns,
    prevHash: batch.prevHash,
  };
}

export function hashTurnBatch(
  batch: TurnBatch,
  ctx?: ZbContext,
): number {
  return fnv1a32(encodeTurnBatchPayload(turnBatchPayload(batch), ctx));
}

export function isTurnBatchHashValid(
  batch: TurnBatch,
  ctx?: ZbContext,
): boolean {
  return hashTurnBatch(batch, ctx) === batch.hash;
}

export function encodeIntentBatch(
  batch: IntentBatch,
  ctx?: ZbContext,
): Uint8Array<ArrayBuffer> {
  return frame(IntentBatchSchema.serialize(batch, ctx));
}

export function decodeIntentBatch(
  bytes: Uint8Array,
  ctx?: ZbContext,
): IntentBatch {
  return IntentBatchSchema.parseBytes(unframe(bytes), ctx);
}

export function encodeHistoryChunk(
  chunk: HistoryChunk,
  ctx?: ZbContext,
): Uint8Array<ArrayBuffer> {
  const payload = HistoryChunkSchema.serialize(chunk, ctx);
  if (payload.byteLength > MAX_HISTORY_CHUNK_BYTES) {
    throw new RangeError(
      `history chunk is ${payload.byteLength} bytes; limit is ${MAX_HISTORY_CHUNK_BYTES}`,
    );
  }
  return frame(payload);
}

export function decodeHistoryChunk(
  bytes: Uint8Array,
  ctx?: ZbContext,
): HistoryChunk {
  return HistoryChunkSchema.parseBytes(unframe(bytes), ctx);
}

export function encodeControl(message: RealtimeControl): string {
  const parsed = RealtimeControlSchema.parse(message);
  const json = JSON.stringify(parsed);
  const size = utf8.encode(json).byteLength;
  if (size > MAX_CONTROL_BYTES) {
    throw new RangeError(
      `control message is ${size} bytes; limit is ${MAX_CONTROL_BYTES}`,
    );
  }
  return json;
}

export function decodeControl(raw: string | Uint8Array): RealtimeControl {
  if (typeof raw === "string") {
    const size = utf8.encode(raw).byteLength;
    if (size > MAX_CONTROL_BYTES) {
      throw new RealtimeWireError(
        `control message is ${size} bytes; limit is ${MAX_CONTROL_BYTES}`,
      );
    }
    return RealtimeControlSchema.parse(JSON.parse(raw));
  }
  if (raw.byteLength > MAX_CONTROL_BYTES) {
    throw new RealtimeWireError(
      `control message is ${raw.byteLength} bytes; limit is ${MAX_CONTROL_BYTES}`,
    );
  }
  const text = new TextDecoder().decode(raw);
  try {
    return RealtimeControlSchema.parse(JSON.parse(text));
  } catch (error) {
    if (error instanceof ZbDecodeError) throw error;
    throw new RealtimeWireError(
      `invalid control message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Convenience for the ack+hash single message. A caller that has no new hash
// report yet can omit both hash fields.
export function makeAck(input: {
  term: number;
  hostID: string;
  clientID: string;
  turn: number;
  hash: number;
  hashTurn?: number;
  hashValue?: number;
}): Ack {
  return {
    type: "ack",
    v: REALTIME_PROTOCOL_VERSION,
    ...input,
  };
}
