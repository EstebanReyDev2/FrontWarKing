// Schemas for the Phase 2 realtime netcode.
//
// Binary frames (turn batches, intent batches and history chunks) use zbin.
// Handshake/control messages stay JSON because they are few, cold and easier to
// inspect. This file is new on purpose: WireSchemas.ts and CosmeticSchemas.ts
// must keep their current wire layout while the Phase 2 transport is built.
import {
  GameStartInfoSchema,
  ID,
  IntentSchema,
  MappedID,
  TurnSchema,
} from "@openfront/engine-api/Schemas";
import { zb, ZbDecodeError } from "@openfront/zbin";
import { z } from "zod";

export const REALTIME_PROTOCOL_VERSION = 1;

// One byte of protocol version, then the zbin payload. The zbin format has no
// version of its own, so this prefix is what lets a future build reject a peer
// instead of silently mis-decoding it.
export const REALTIME_VERSION_BYTES = 1;

// Supabase Free caps a broadcast payload at 256 KB. Keep the design's working
// limits below that, leaving room for transport headers.
export const MAX_REALTIME_FRAME_BYTES = 256 * 1024;
export const MAX_HISTORY_CHUNK_BYTES = 96 * 1024;
export const MAX_CONTROL_BYTES = 128 * 1024;

const BytesSchema = zb.custom(
  z.custom<Uint8Array>((v) => v instanceof Uint8Array, "expected bytes"),
  {
    enc(w, v) {
      w.uint(v.byteLength);
      for (let i = 0; i < v.byteLength; i++) w.u8(v[i]);
    },
    dec(r) {
      const length = r.uint();
      if (length > r.remaining) {
        throw new ZbDecodeError(
          `history frame claims ${length} bytes with ${r.remaining} left`,
        );
      }
      // Copy so the decoded chunk does not keep the whole payload alive.
      return r.readBytes(length).slice();
    },
    minBytes: 1,
  },
);

export const TurnBatchSchema = zb.object({
  type: zb.literal("turn_batch"),
  v: zb.literal(REALTIME_PROTOCOL_VERSION),
  term: zb.uint(),
  hostID: MappedID,
  fromTurn: zb.uint(),
  turns: z.array(TurnSchema),
  prevHash: zb.float(),
  hash: zb.float(),
});

// Same fields minus `hash`. The host hashes these bytes; the receiver hashes
// the same shape, so a decoded intent's property order cannot change the hash.
export const TurnBatchPayloadSchema = zb.object({
  type: zb.literal("turn_batch"),
  v: zb.literal(REALTIME_PROTOCOL_VERSION),
  term: zb.uint(),
  hostID: MappedID,
  fromTurn: zb.uint(),
  turns: z.array(TurnSchema),
  prevHash: zb.float(),
});

export type TurnBatch = z.infer<typeof TurnBatchSchema>;
export type TurnBatchPayload = z.infer<typeof TurnBatchPayloadSchema>;

export const IntentBatchSchema = zb.object({
  type: zb.literal("intent_batch"),
  v: zb.literal(REALTIME_PROTOCOL_VERSION),
  clientID: MappedID,
  seq: zb.uint(),
  intents: z.array(IntentSchema),
});

export type IntentBatch = z.infer<typeof IntentBatchSchema>;

export const HistoryChunkSchema = zb.object({
  type: zb.literal("history_chunk"),
  v: zb.literal(REALTIME_PROTOCOL_VERSION),
  requestId: zb.string(),
  term: zb.uint(),
  hostID: MappedID,
  fromTurn: zb.uint(),
  toTurn: zb.uint(),
  frames: z.array(BytesSchema),
  more: z.boolean(),
});

export type HistoryChunk = z.infer<typeof HistoryChunkSchema>;

const ClientIDSchema = ID;
const HashSchema = z.number();
const TurnNumberSchema = z.number().int().nonnegative();

export const HelloSchema = z.object({
  type: z.literal("hello"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  clientID: ClientIDSchema,
  nickname: z.string().min(1).max(32).optional(),
  lastTurn: TurnNumberSchema,
  lastHash: HashSchema,
  coldStart: z.boolean(),
});

export const AckSchema = z.object({
  type: z.literal("ack"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  term: TurnNumberSchema,
  hostID: ClientIDSchema,
  clientID: ClientIDSchema,
  turn: TurnNumberSchema,
  hash: HashSchema,
  // The same one-second message carries the latest engine hash report. Keeping
  // it optional lets a client ack while it has no new report yet.
  hashTurn: TurnNumberSchema.optional(),
  hashValue: HashSchema.optional(),
});

export const HistoryRequestSchema = z.object({
  type: z.literal("history_req"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(64),
  fromTurn: TurnNumberSchema,
  maxBytes: z.number().int().positive().max(MAX_HISTORY_CHUNK_BYTES),
});

export const StartSchema = z.object({
  type: z.literal("start"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  gameStartInfo: GameStartInfoSchema,
  myClientID: ClientIDSchema,
  term: TurnNumberSchema,
  hostID: ClientIDSchema,
  fromTurn: TurnNumberSchema,
  historyComplete: z.boolean(),
  historyFrom: TurnNumberSchema,
});

export const HostClaimSchema = z.object({
  type: z.literal("host_claim"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  term: TurnNumberSchema,
  hostID: ClientIDSchema,
  priority: TurnNumberSchema,
  lastTurn: TurnNumberSchema,
  lastHash: HashSchema,
});

export const HostElectedSchema = z.object({
  type: z.literal("host_elected"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  term: TurnNumberSchema,
  hostID: ClientIDSchema,
  voters: z.array(ClientIDSchema),
  lastTurn: TurnNumberSchema,
});

export const HostHeartbeatSchema = z.object({
  type: z.literal("host_heartbeat"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  term: TurnNumberSchema,
  hostID: ClientIDSchema,
  lastTurn: TurnNumberSchema,
  lastHash: HashSchema,
});

export const DesyncSchema = z.object({
  type: z.literal("desync"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  term: TurnNumberSchema,
  hostID: ClientIDSchema,
  turn: TurnNumberSchema,
  expectedHash: HashSchema,
  reportedHash: HashSchema,
  clientID: ClientIDSchema.optional(),
});

export const HistoryUnavailableSchema = z.object({
  type: z.literal("history_unavailable"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(64),
  fromTurn: TurnNumberSchema,
  reason: z.enum(["too_old", "too_large", "late_join_disabled"]),
});

export const ErrorSchema = z.object({
  type: z.literal("error"),
  v: z.literal(REALTIME_PROTOCOL_VERSION),
  code: z.enum(["host_lost", "conflict", "invalid", "history_unavailable"]),
  message: z.string().min(1).max(512),
  fatal: z.boolean(),
});

export const RealtimeControlSchema = z.discriminatedUnion("type", [
  HelloSchema,
  AckSchema,
  HistoryRequestSchema,
  StartSchema,
  HostClaimSchema,
  HostElectedSchema,
  HostHeartbeatSchema,
  DesyncSchema,
  HistoryUnavailableSchema,
  ErrorSchema,
]);

export type RealtimeControl = z.infer<typeof RealtimeControlSchema>;
export type Hello = z.infer<typeof HelloSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type HistoryRequest = z.infer<typeof HistoryRequestSchema>;
export type Start = z.infer<typeof StartSchema>;
export type HostClaim = z.infer<typeof HostClaimSchema>;
export type HostElected = z.infer<typeof HostElectedSchema>;
export type HostHeartbeat = z.infer<typeof HostHeartbeatSchema>;
export type Desync = z.infer<typeof DesyncSchema>;
export type HistoryUnavailable = z.infer<typeof HistoryUnavailableSchema>;
export type RealtimeError = z.infer<typeof ErrorSchema>;

// Keep the engine-api ID schema referenced so an accidental import-cycle
// change is caught here rather than in a far-away consumer.
export type RealtimeClientID = z.infer<typeof ID>;
