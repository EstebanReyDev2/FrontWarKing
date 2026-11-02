import type { RealtimeControl } from "@openfront/shared/RealtimeSchemas";

/**
 * A packet as it crosses the realtime boundary.
 *
 * The transport is deliberately oblivious to the game: it only knows which
 * channel an event belongs to and whether the payload is binary. Turn batches,
 * history chunks and intent batches stay as the bytes produced by
 * RealtimeWire; control messages stay as their JSON string form.
 */
export type TransportPacket = {
  kind: "turn" | "history_chunk" | "history_req" | "heartbeat" | "control";
  from: string;
  to?: string;
  bytes?: Uint8Array;
  fromTurn?: number;
  requestId?: string;
  lastTurn?: number;
  lastHash?: number;
  term?: number;
  control?: RealtimeControl;
};

export type TransportState =
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "reconnecting"; attempt: number }
  | { status: "error"; message: string }
  | { status: "closed" };

export type TransportListener = (packet: TransportPacket) => void;
export type TransportStateListener = (state: TransportState) => void;

/**
 * The subset of the fake transport that the real Supabase adapter also
 * implements. Methods may be synchronous in tests and asynchronous in the
 * browser; callers await them either way.
 */
export interface RealtimeTransport {
  subscribe(
    clientID: string,
    listener: TransportListener,
  ): void | Promise<void>;
  unsubscribe(clientID: string): void | Promise<void>;
  send(
    packet: Omit<TransportPacket, "to">,
    recipients: readonly string[],
  ): void | Promise<void>;
  broadcast(packet: Omit<TransportPacket, "to">): void | Promise<void>;
  close(): void | Promise<void>;
  onStateChange?(listener: TransportStateListener): () => void;
}
