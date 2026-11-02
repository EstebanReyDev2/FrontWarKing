import {
  MAX_HISTORY_CHUNK_BYTES,
  REALTIME_PROTOCOL_VERSION,
} from "@openfront/shared/RealtimeSchemas";
import type {
  HistoryRequest,
  HostHeartbeat,
  RealtimeControl,
} from "@openfront/shared/RealtimeSchemas";
import { decodeControl, encodeControl } from "@openfront/shared/RealtimeWire";
import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_RATE_LIMIT_EVENTS_PER_SECOND,
  EventRateLimiter,
} from "./EventRateLimiter";
import type { RateLimitEvent } from "./EventRateLimiter";
import type {
  RealtimeTransport,
  TransportListener,
  TransportPacket,
  TransportState,
  TransportStateListener,
} from "./RealtimeTransport";
import type { SupabaseRealtimeConfig } from "./SupabaseConfig";

export type SupabaseChannelLike = {
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (message: { payload: unknown }) => void,
  ): SupabaseChannelLike;
  subscribe(
    callback?: (status: string, error?: Error) => void,
  ): SupabaseChannelLike;
  send(args: {
    type: "broadcast";
    event: string;
    payload: Uint8Array | string;
  }): Promise<unknown>;
  unsubscribe(): Promise<unknown>;
};

export type SupabaseClientLike = {
  channel(name: string, options?: unknown): SupabaseChannelLike;
  removeChannel?(channel: SupabaseChannelLike): Promise<unknown>;
};

export type SupabaseBroadcastTransportOptions = {
  client: SupabaseClientLike;
  gameID: string;
  clientID: string;
  hostID: string;
  rateLimiter?: EventRateLimiter;
  eventsPerSecond?: number;
  retryDelayMs?: (attempt: number) => number;
  maxReconnectAttempts?: number;
  logger?: Pick<Console, "warn" | "error" | "log">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type ChannelHandle = {
  topic: string;
  channel: SupabaseChannelLike;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  settled: boolean;
};

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;

function topicIn(base: string, clientID: string): string {
  return `${base}:in:${clientID}`;
}

function topicCtl(base: string, clientID: string): string {
  return `${base}:ctl:${clientID}`;
}

/**
 * Supabase Realtime adapter for the Phase 2 wire.
 *
 * Channel topology (all names scoped to the game code):
 *   game:<id>             host turns and host heartbeats
 *   game:<id>:in:<client> client intents and history requests
 *   game:<id>:ctl:<client> start, history chunks and targeted errors
 *
 * Binary packets are handed to Supabase as Uint8Array, which realtime-js sends
 * as application/octet-stream instead of JSON. Control messages are strings
 * validated by RealtimeSchemas before they leave this class.
 */
export class SupabaseBroadcastTransport implements RealtimeTransport {
  private readonly client: SupabaseClientLike;
  private readonly gameID: string;
  private readonly clientID: string;
  private readonly hostID: string;
  private readonly baseTopic: string;
  private readonly rateLimiter: EventRateLimiter;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly maxReconnectAttempts: number;
  private readonly logger: Pick<Console, "warn" | "error" | "log">;
  private readonly listeners = new Map<string, Set<TransportListener>>();
  private readonly stateListeners = new Set<TransportStateListener>();
  private readonly handles = new Map<string, ChannelHandle>();
  private readonly subscribedClients = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private detaching = false;
  private lastRateLimitLogAt = Number.NEGATIVE_INFINITY;
  private lastState: TransportState = { status: "connecting" };

  constructor(options: SupabaseBroadcastTransportOptions) {
    this.client = options.client;
    this.gameID = options.gameID;
    this.clientID = options.clientID;
    this.hostID = options.hostID;
    this.baseTopic = `game:${options.gameID}`;
    this.retryDelayMs =
      options.retryDelayMs ??
      ((attempt) => Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt - 1)));
    this.maxReconnectAttempts =
      options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.logger = options.logger ?? console;
    this.rateLimiter =
      options.rateLimiter ??
      new EventRateLimiter({
        capacity:
          options.eventsPerSecond ?? DEFAULT_RATE_LIMIT_EVENTS_PER_SECOND,
        refillPerSecond:
          options.eventsPerSecond ?? DEFAULT_RATE_LIMIT_EVENTS_PER_SECOND,
        now: options.now,
        sleep: options.sleep,
        onLimit: (event) => this.logRateLimit(event),
      });
  }

  get id(): string {
    return this.clientID;
  }

  get isHost(): boolean {
    return this.clientID === this.hostID;
  }

  async subscribe(
    clientID: string,
    listener: TransportListener,
  ): Promise<void> {
    if (this.closed) return;
    let listeners = this.listeners.get(clientID);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(clientID, listeners);
    }
    listeners.add(listener);
    this.subscribedClients.add(clientID);

    await this.ensureGeneralChannel();
    await this.ensureClientChannels(clientID);
  }

  async unsubscribe(clientID: string): Promise<void> {
    this.listeners.delete(clientID);
    this.subscribedClients.delete(clientID);
  }

  async send(
    packet: Omit<TransportPacket, "to">,
    recipients: readonly string[],
  ): Promise<void> {
    if (recipients.length === 0) return;
    const routes = this.routes(packet, recipients);
    await this.rateLimiter.acquire(recipients.length);
    for (const route of routes) {
      await this.publish(route.topic, route.event, route.payload);
    }
  }

  async broadcast(packet: Omit<TransportPacket, "to">): Promise<void> {
    const routes = this.routes(packet, []);
    const cost = Math.max(1, this.subscribedClients.size);
    await this.rateLimiter.acquire(cost);
    for (const route of routes) {
      await this.publish(route.topic, route.event, route.payload);
    }
  }

  onStateChange(listener: TransportStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.lastState);
    return () => this.stateListeners.delete(listener);
  }

  async reconnect(): Promise<void> {
    if (this.closed) return;
    this.reconnectAttempts = 0;
    await this.reconnectNow();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.detachAll();
    this.listeners.clear();
    this.subscribedClients.clear();
    this.emitState({ status: "closed" });
  }

  private async ensureGeneralChannel(): Promise<void> {
    await this.ensureChannel(this.baseTopic);
  }

  private async ensureClientChannels(clientID: string): Promise<void> {
    if (clientID === this.clientID) {
      // A follower listens on its own control channel. The host listens on
      // each peer's `in` channel; it has no reason to read their control
      // channels (and doing so would duplicate its own targeted messages).
      await this.ensureChannel(topicCtl(this.baseTopic, clientID));
      return;
    }
    await this.ensureChannel(topicIn(this.baseTopic, clientID));
  }

  private async ensureChannel(topic: string): Promise<ChannelHandle> {
    const existing = this.handles.get(topic);
    if (existing !== undefined) {
      await existing.ready;
      return existing;
    }

    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // A failed subscription is reported through onStateChange; avoid an
    // unhandled rejection when the caller is not waiting on this channel yet.
    void ready.catch(() => {});

    const channel = this.client.channel(topic, {
      config: { broadcast: { self: false, ack: false } },
    });
    const handle: ChannelHandle = {
      topic,
      channel,
      ready,
      resolveReady,
      rejectReady,
      settled: false,
    };
    this.handles.set(topic, handle);
    this.attachHandlers(topic, channel);
    channel.subscribe((status, error) =>
      this.onChannelStatus(handle, status, error),
    );
    await ready;
    return handle;
  }

  private attachHandlers(topic: string, channel: SupabaseChannelLike): void {
    const general = topic === this.baseTopic;
    const inTopic = topic.startsWith(`${this.baseTopic}:in:`);
    const ctlTopic = topic.startsWith(`${this.baseTopic}:ctl:`);

    if (general) {
      channel.on("broadcast", { event: "turn" }, ({ payload }) => {
        const bytes = toBytes(payload);
        if (bytes !== null) {
          this.dispatch({
            kind: "turn",
            from: this.hostID,
            bytes,
          });
        }
      });
      for (const event of [
        "host_heartbeat",
        "host_claim",
        "host_elected",
        "desync",
      ]) {
        channel.on("broadcast", { event }, ({ payload }) => {
          this.onControlPayload(event, this.hostID, undefined, payload);
        });
      }
      return;
    }

    if (inTopic) {
      const clientID = topic.slice(`${this.baseTopic}:in:`.length);
      for (const event of ["hello", "ack", "history_req"]) {
        channel.on("broadcast", { event }, ({ payload }) => {
          this.onControlPayload(event, clientID, this.hostID, payload);
        });
      }
      return;
    }

    if (ctlTopic) {
      const clientID = topic.slice(`${this.baseTopic}:ctl:`.length);
      channel.on("broadcast", { event: "history_chunk" }, ({ payload }) => {
        const bytes = toBytes(payload);
        if (bytes !== null) {
          this.dispatch({
            kind: "history_chunk",
            from: this.hostID,
            to: clientID,
            bytes,
          });
        }
      });
      for (const event of ["start", "history_unavailable", "error"]) {
        channel.on("broadcast", { event }, ({ payload }) => {
          this.onControlPayload(event, this.hostID, clientID, payload);
        });
      }
    }
  }

  private onControlPayload(
    event: string,
    from: string,
    to: string | undefined,
    payload: unknown,
  ): void {
    const raw =
      typeof payload === "string"
        ? payload
        : payload instanceof Uint8Array
          ? payload
          : null;
    if (raw === null) {
      this.reportError(`invalid control payload on ${event}`);
      return;
    }
    try {
      const control = decodeControl(raw);
      if (control.type === "host_heartbeat") {
        this.dispatch({
          kind: "heartbeat",
          from: control.hostID,
          lastTurn: control.lastTurn,
          lastHash: control.lastHash,
          term: control.term,
        });
        return;
      }
      if (control.type === "history_req") {
        this.dispatch({
          kind: "history_req",
          from,
          to,
          fromTurn: control.fromTurn,
          requestId: control.requestId,
        });
        return;
      }
      this.dispatch({
        kind: "control",
        from,
        to,
        control,
      });
    } catch (error) {
      this.reportError(
        `invalid control message on ${event}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private dispatch(packet: TransportPacket): void {
    if (this.closed) return;
    if (packet.to !== undefined) {
      this.listeners.get(packet.to)?.forEach((listener) => listener(packet));
      return;
    }
    // General-channel packets go to every subscriber (the sending side is
    // filtered by Supabase's broadcast self:false setting). A host subscribes
    // one channel per peer but normally has a single listener; dedupe so one
    // turn is not delivered once per subscribed client ID.
    const unique = new Set<TransportListener>();
    for (const listeners of this.listeners.values()) {
      listeners.forEach((listener) => unique.add(listener));
    }
    unique.forEach((listener) => listener(packet));
  }

  private routes(
    packet: Omit<TransportPacket, "to">,
    recipients: readonly string[],
  ): Array<{
    topic: string;
    event: string;
    payload: Uint8Array | string;
  }> {
    if (packet.kind === "turn") {
      if (packet.bytes === undefined) {
        throw new Error("turn packet is missing bytes");
      }
      return [
        {
          topic: this.baseTopic,
          event: "turn",
          payload: packet.bytes,
        },
      ];
    }

    if (packet.kind === "history_chunk") {
      if (packet.bytes === undefined) {
        throw new Error("history chunk is missing bytes");
      }
      return recipients.map((to) => ({
        topic: topicCtl(this.baseTopic, to),
        event: "history_chunk",
        payload: packet.bytes as Uint8Array,
      }));
    }

    if (packet.kind === "history_req") {
      if (packet.fromTurn === undefined || packet.requestId === undefined) {
        throw new Error("history request is missing fields");
      }
      const control: HistoryRequest = {
        type: "history_req",
        v: REALTIME_PROTOCOL_VERSION,
        requestId: packet.requestId,
        fromTurn: packet.fromTurn,
        maxBytes: MAX_HISTORY_CHUNK_BYTES,
      };
      return [
        {
          topic: topicIn(this.baseTopic, packet.from),
          event: "history_req",
          payload: encodeControl(control),
        },
      ];
    }

    if (packet.kind === "heartbeat") {
      const control: HostHeartbeat = {
        type: "host_heartbeat",
        v: REALTIME_PROTOCOL_VERSION,
        term: packet.term ?? 1,
        hostID: this.hostID,
        lastTurn: packet.lastTurn ?? 0,
        lastHash: packet.lastHash ?? 0,
      };
      return [
        {
          topic: this.baseTopic,
          event: "host_heartbeat",
          payload: encodeControl(control),
        },
      ];
    }

    const control = packet.control;
    if (control === undefined) {
      throw new Error("control packet is missing control");
    }
    const payload = encodeControl(control);
    if (
      control.type === "hello" ||
      control.type === "ack" ||
      control.type === "history_req"
    ) {
      return [
        {
          topic: topicIn(this.baseTopic, packet.from),
          event: control.type,
          payload,
        },
      ];
    }
    if (
      control.type === "start" ||
      control.type === "history_unavailable" ||
      control.type === "error"
    ) {
      return recipients.map((to) => ({
        topic: topicCtl(this.baseTopic, to),
        event: control.type,
        payload,
      }));
    }
    return [
      {
        topic: this.baseTopic,
        event: control.type,
        payload,
      },
    ];
  }

  private async publish(
    topic: string,
    event: string,
    payload: Uint8Array | string,
  ): Promise<void> {
    if (this.closed) return;
    const handle = await this.ensureChannel(topic);
    const result = await handle.channel.send({
      type: "broadcast",
      event,
      payload,
    });
    if (result === "error" || result === "timed out") {
      this.reportError(`broadcast ${event} on ${topic} returned ${result}`);
    }
  }

  private onChannelStatus(
    handle: ChannelHandle,
    status: string,
    error?: Error,
  ): void {
    if (this.closed || this.detaching) return;
    if (status === "SUBSCRIBED") {
      handle.settled = true;
      handle.resolveReady();
      this.reconnectAttempts = 0;
      this.emitState({ status: "connected" });
      return;
    }

    if (
      status === "TIMED_OUT" ||
      status === "CHANNEL_ERROR" ||
      status === "CLOSED"
    ) {
      const message =
        error?.message ??
        (status === "TIMED_OUT"
          ? "Supabase channel timed out"
          : `Supabase channel ${status.toLowerCase()}`);
      if (!handle.settled) {
        handle.settled = true;
        handle.rejectReady(new Error(message));
      }
      if (this.handles.get(handle.topic) === handle) {
        this.handles.delete(handle.topic);
      }
      void handle.channel.unsubscribe().catch(() => {});
      const removed = this.client.removeChannel?.(handle.channel);
      if (removed !== undefined) void removed.catch(() => {});
      this.emitState({ status: "error", message });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (
      this.closed ||
      this.reconnectTimer !== null ||
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      if (!this.closed && this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.emitState({
          status: "error",
          message: "Supabase reconnect attempts exhausted",
        });
      }
      return;
    }
    const attempt = ++this.reconnectAttempts;
    const delay = this.retryDelayMs(attempt);
    this.emitState({ status: "reconnecting", attempt });
    this.logger.warn(
      `[realtime] reconnecting channel after ${delay} ms (attempt ${attempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow();
    }, delay);
  }

  private async reconnectNow(): Promise<void> {
    if (this.closed) return;
    await this.detachAll();
    try {
      await this.ensureGeneralChannel();
      for (const clientID of [...this.listeners.keys()]) {
        await this.ensureClientChannels(clientID);
      }
      this.reconnectAttempts = 0;
      this.emitState({ status: "connected" });
    } catch (error) {
      this.reportError(
        `reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleReconnect();
    }
  }

  private async detachAll(): Promise<void> {
    this.detaching = true;
    const handles = [...this.handles.values()];
    this.handles.clear();
    for (const handle of handles) {
      if (!handle.settled) {
        handle.settled = true;
        handle.rejectReady(new Error("channel detached"));
      }
      try {
        await handle.channel.unsubscribe();
      } catch (error) {
        this.logger.warn("[realtime] channel unsubscribe failed", error);
      }
      try {
        await this.client.removeChannel?.(handle.channel);
      } catch (error) {
        this.logger.warn("[realtime] channel removal failed", error);
      }
    }
    this.detaching = false;
  }

  private reportError(message: string): void {
    this.logger.error(`[realtime] ${message}`);
    this.emitState({ status: "error", message });
  }

  private emitState(state: TransportState): void {
    this.lastState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private logRateLimit(event: RateLimitEvent): void {
    const now = Date.now();
    if (now - this.lastRateLimitLogAt < 1_000) return;
    this.lastRateLimitLogAt = now;
    this.logger.warn(
      `[realtime] rate limit: ${event.cost} events, ${event.available.toFixed(1)}/${event.capacity} available, waiting ${event.waitMs} ms`,
    );
  }
}

function toBytes(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
  }
  return null;
}

/**
 * Production client factory. Auth is disabled: F2a only uses anonymous
 * broadcast channels, and there is no account session to persist.
 */
export function createSupabaseRealtimeClient(
  config: SupabaseRealtimeConfig,
): SupabaseClientLike {
  return createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }) as unknown as SupabaseClientLike;
}

export type { RealtimeControl };
