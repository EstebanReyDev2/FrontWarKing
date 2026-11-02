import type {
  SupabaseChannelLike,
  SupabaseClientLike,
} from "src/client/netcode/SupabaseBroadcastTransport";

type BroadcastHandler = (message: { payload: unknown }) => void;

export type FakeDelivery = {
  topic: string;
  event: string;
  payload: unknown;
  from: FakeChannel;
};

/**
 * Tiny in-memory Supabase Realtime stand-in.
 *
 * It deliberately models only the parts the adapter uses: topics, broadcast
 * events, channel status callbacks and binary payload preservation.
 */
export class FakeSupabaseBus {
  private readonly channels = new Map<string, Set<FakeChannel>>();
  readonly deliveries: FakeDelivery[] = [];

  register(channel: FakeChannel): void {
    let subscribers = this.channels.get(channel.topic);
    if (subscribers === undefined) {
      subscribers = new Set();
      this.channels.set(channel.topic, subscribers);
    }
    subscribers.add(channel);
  }

  unregister(channel: FakeChannel): void {
    this.channels.get(channel.topic)?.delete(channel);
  }

  deliver(
    topic: string,
    event: string,
    payload: unknown,
    from: FakeChannel,
  ): void {
    this.deliveries.push({ topic, event, payload, from });
    for (const channel of this.channels.get(topic) ?? []) {
      if (channel === from || channel.status !== "SUBSCRIBED") continue;
      channel.deliver(event, payload);
    }
  }
}

export class FakeSupabaseClient implements SupabaseClientLike {
  private readonly channels = new Map<string, FakeChannel>();

  constructor(
    private readonly bus: FakeSupabaseBus,
    readonly label = "client",
  ) {}

  channel(topic: string): SupabaseChannelLike {
    let channel = this.channels.get(topic);
    if (channel === undefined) {
      channel = new FakeChannel(topic, this.bus);
      this.channels.set(topic, channel);
    }
    return channel;
  }

  removeChannel(channel: SupabaseChannelLike): Promise<unknown> {
    const fake = channel as FakeChannel;
    this.channels.delete(fake.topic);
    return fake.unsubscribe();
  }

  get(topic: string): FakeChannel | undefined {
    return this.channels.get(topic);
  }
}

export class FakeChannel implements SupabaseChannelLike {
  status = "CLOSED";
  private statusCallback?: (status: string, error?: Error) => void;
  private readonly handlers = new Map<string, Set<BroadcastHandler>>();
  readonly sent: Array<{
    event: string;
    payload: Uint8Array | string;
  }> = [];

  constructor(
    readonly topic: string,
    private readonly bus: FakeSupabaseBus,
  ) {}

  on(
    _type: "broadcast",
    filter: { event: string },
    callback: BroadcastHandler,
  ): SupabaseChannelLike {
    let handlers = this.handlers.get(filter.event);
    if (handlers === undefined) {
      handlers = new Set();
      this.handlers.set(filter.event, handlers);
    }
    handlers.add(callback);
    return this;
  }

  subscribe(
    callback?: (status: string, error?: Error) => void,
  ): SupabaseChannelLike {
    this.statusCallback = callback;
    this.status = "SUBSCRIBED";
    this.bus.register(this);
    queueMicrotask(() => {
      if (this.status === "SUBSCRIBED") callback?.("SUBSCRIBED");
    });
    return this;
  }

  send(args: {
    type: "broadcast";
    event: string;
    payload: Uint8Array | string;
  }): Promise<unknown> {
    this.sent.push({ event: args.event, payload: args.payload });
    this.bus.deliver(this.topic, args.event, args.payload, this);
    return Promise.resolve("ok");
  }

  unsubscribe(): Promise<unknown> {
    this.bus.unregister(this);
    this.status = "CLOSED";
    return Promise.resolve("ok");
  }

  trigger(status: string, error?: Error): void {
    this.status = status;
    this.statusCallback?.(status, error);
  }

  deliver(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({ payload });
    }
  }
}
