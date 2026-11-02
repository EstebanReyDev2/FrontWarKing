import type { RealtimeControl } from "@openfront/shared/RealtimeSchemas";
import type { EventRateLimiter } from "src/client/netcode/EventRateLimiter";
import { EventRateLimiter as RealRateLimiter } from "src/client/netcode/EventRateLimiter";
import type { TransportPacket } from "src/client/netcode/RealtimeTransport";
import { SupabaseBroadcastTransport } from "src/client/netcode/SupabaseBroadcastTransport";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSupabaseBus, FakeSupabaseClient } from "./fakeSupabase";
import { P1, P2 } from "./fixtures";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function makeTransport(
  client: FakeSupabaseClient,
  clientID: string,
  options: {
    rateLimiter?: EventRateLimiter;
    retryDelayMs?: (attempt: number) => number;
    maxReconnectAttempts?: number;
  } = {},
): SupabaseBroadcastTransport {
  return new SupabaseBroadcastTransport({
    client,
    gameID: "game1",
    clientID,
    hostID: P1,
    rateLimiter: options.rateLimiter,
    retryDelayMs: options.retryDelayMs,
    maxReconnectAttempts: options.maxReconnectAttempts,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SupabaseBroadcastTransport", () => {
  it("routes turns, history requests and targeted control over the designed topics", async () => {
    const bus = new FakeSupabaseBus();
    const hostClient = new FakeSupabaseClient(bus, "host");
    const peerClient = new FakeSupabaseClient(bus, "peer");
    const host = makeTransport(hostClient, P1);
    const peer = makeTransport(peerClient, P2);
    const hostPackets: TransportPacket[] = [];
    const peerPackets: TransportPacket[] = [];

    await host.subscribe(P1, (packet) => hostPackets.push(packet));
    await host.subscribe(P2, (packet) => hostPackets.push(packet));
    await peer.subscribe(P2, (packet) => peerPackets.push(packet));

    const turn = bytes(1, 2, 3);
    await host.broadcast({ kind: "turn", from: P1, bytes: turn });
    expect(peerPackets).toHaveLength(1);
    expect(peerPackets[0]).toMatchObject({ kind: "turn", from: P1 });
    expect(peerPackets[0].bytes).toEqual(turn);
    expect(hostPackets).toHaveLength(0);

    await peer.send(
      { kind: "history_req", from: P2, fromTurn: 4, requestId: "r1" },
      [P1],
    );
    expect(hostPackets).toHaveLength(1);
    expect(hostPackets[0]).toMatchObject({
      kind: "history_req",
      from: P2,
      to: P1,
      fromTurn: 4,
      requestId: "r1",
    });

    const chunk = bytes(9, 8, 7);
    await host.send({ kind: "history_chunk", from: P1, bytes: chunk }, [P2]);
    expect(peerPackets[peerPackets.length - 1]).toMatchObject({
      kind: "history_chunk",
      from: P1,
      to: P2,
    });
    expect(peerPackets[peerPackets.length - 1]?.bytes).toEqual(chunk);

    const unavailable: RealtimeControl = {
      type: "history_unavailable",
      v: 1,
      requestId: "r1",
      fromTurn: 4,
      reason: "too_old",
    };
    await host.send({ kind: "control", from: P1, control: unavailable }, [P2]);
    expect(peerPackets[peerPackets.length - 1]).toMatchObject({
      kind: "control",
      from: P1,
      to: P2,
      control: unavailable,
    });

    expect(bus.deliveries.map((d) => `${d.topic}:${d.event}`)).toEqual([
      "game:game1:turn",
      "game:game1:in:Xk9mNp2q:history_req",
      "game:game1:ctl:Xk9mNp2q:history_chunk",
      "game:game1:ctl:Xk9mNp2q:history_unavailable",
    ]);
  });

  it("keeps binary frames binary and control frames JSON", async () => {
    const bus = new FakeSupabaseBus();
    const hostClient = new FakeSupabaseClient(bus, "host");
    const peerClient = new FakeSupabaseClient(bus, "peer");
    const host = makeTransport(hostClient, P1);
    const peer = makeTransport(peerClient, P2);
    const received: TransportPacket[] = [];
    await host.subscribe(P1, () => {});
    await peer.subscribe(P2, (packet) => received.push(packet));

    const turn = bytes(0xaa, 0xbb);
    await host.broadcast({ kind: "turn", from: P1, bytes: turn });
    await host.broadcast({
      kind: "heartbeat",
      from: P1,
      lastTurn: 7,
      lastHash: 123,
      term: 2,
    });

    expect(bus.deliveries[0].payload).toBe(turn);
    expect(bus.deliveries[0].payload).toBeInstanceOf(Uint8Array);
    expect(typeof bus.deliveries[1].payload).toBe("string");
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({
      kind: "heartbeat",
      from: P1,
      lastTurn: 7,
      lastHash: 123,
      term: 2,
    });
  });

  it("charges the limiter per delivery and not per publish call", async () => {
    const bus = new FakeSupabaseBus();
    const hostClient = new FakeSupabaseClient(bus, "host");
    const peerClient = new FakeSupabaseClient(bus, "peer");
    const costs: number[] = [];
    const limiter = {
      acquire: vi.fn(async (cost: number) => {
        costs.push(cost);
      }),
    } as unknown as EventRateLimiter;
    const host = makeTransport(hostClient, P1, { rateLimiter: limiter });
    const peer = makeTransport(peerClient, P2);
    await host.subscribe(P1, () => {});
    await host.subscribe(P2, () => {});
    await peer.subscribe(P2, () => {});

    await host.broadcast({ kind: "turn", from: P1, bytes: bytes(1) });
    await host.send({ kind: "turn", from: P1, bytes: bytes(2) }, [P1, P2]);

    expect(costs).toEqual([2, 2]);
  });

  it("reports channel errors and reconnects the channels", async () => {
    vi.useFakeTimers();
    const bus = new FakeSupabaseBus();
    const client = new FakeSupabaseClient(bus, "host");
    const transport = makeTransport(client, P1, {
      retryDelayMs: () => 10,
      maxReconnectAttempts: 2,
    });
    const states: string[] = [];
    transport.onStateChange((state) => states.push(state.status));
    await transport.subscribe(P1, () => {});

    const general = client.get("game:game1");
    expect(general).toBeDefined();
    general?.trigger("TIMED_OUT", new Error("timed out"));
    expect(states).toContain("error");
    expect(states[states.length - 1]).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(10);
    expect(states[states.length - 1]).toBe("connected");
    expect(client.get("game:game1")?.status).toBe("SUBSCRIBED");
  });

  it("reports close and removes every channel", async () => {
    const bus = new FakeSupabaseBus();
    const client = new FakeSupabaseClient(bus, "peer");
    const transport = makeTransport(client, P2);
    const states: string[] = [];
    transport.onStateChange((state) => states.push(state.status));
    await transport.subscribe(P2, () => {});

    await transport.close();
    expect(states[states.length - 1]).toBe("closed");
    expect(client.get("game:game1")).toBeUndefined();
    expect(client.get("game:game1:ctl:Xk9mNp2q")).toBeUndefined();
  });

  it("waits instead of dropping when the token bucket is empty", async () => {
    vi.useFakeTimers();
    const bus = new FakeSupabaseBus();
    const client = new FakeSupabaseClient(bus, "peer");
    const limited: number[] = [];
    const limiter = new RealRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      onLimit: (event) => limited.push(event.waitMs),
    });
    const transport = makeTransport(client, P2, { rateLimiter: limiter });
    await transport.subscribe(P2, () => {});

    await transport.broadcast({ kind: "turn", from: P1, bytes: bytes(1) });
    const pending = transport.broadcast({
      kind: "turn",
      from: P1,
      bytes: bytes(2),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(limited.length).toBeGreaterThan(0);
    expect(bus.deliveries).toHaveLength(2);
  });
});
