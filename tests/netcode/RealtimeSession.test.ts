import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import type { Intent } from "@openfront/engine-api/Schemas";
import type {
  ServerMessage,
  WireGameStartInfo,
} from "@openfront/shared/WireSchemas";
import { RealtimeSession } from "src/client/netcode/RealtimeSession";
import type {
  RealtimeTransport,
  TransportListener,
  TransportPacket,
  TransportStateListener,
} from "src/client/netcode/RealtimeTransport";
import type { TurnClock } from "src/client/netcode/TurnClock";
import { describe, expect, it, vi } from "vitest";

const HOST_ID = "HOST0001";
const PEER_ID = "PEER0001";

class MemoryNetwork {
  private readonly listeners = new Map<string, Set<TransportListener>>();
  dropNextTurnTo: string | null = null;
  readonly sent: Array<{
    from: string;
    to?: string;
    kind: TransportPacket["kind"];
    packet: Omit<TransportPacket, "to">;
  }> = [];

  subscribe(clientID: string, listener: TransportListener): void {
    const listeners = this.listeners.get(clientID) ?? new Set();
    listeners.add(listener);
    this.listeners.set(clientID, listeners);
  }

  unsubscribe(clientID: string): void {
    this.listeners.delete(clientID);
  }

  send(
    packet: Omit<TransportPacket, "to">,
    recipients: readonly string[],
  ): void {
    for (const recipient of recipients) {
      this.sent.push({
        from: packet.from,
        to: recipient,
        kind: packet.kind,
        packet,
      });
      for (const listener of this.listeners.get(recipient) ?? []) {
        listener(packet);
      }
    }
  }

  broadcast(packet: Omit<TransportPacket, "to">): void {
    for (const [clientID, listeners] of this.listeners) {
      if (clientID === packet.from) continue;
      if (packet.kind === "turn" && clientID === this.dropNextTurnTo) {
        this.dropNextTurnTo = null;
        continue;
      }
      this.sent.push({ from: packet.from, kind: packet.kind, packet });
      for (const listener of listeners) listener(packet);
    }
  }

  disconnect(clientID: string): void {
    this.listeners.delete(clientID);
  }
}

class ManualClock implements TurnClock {
  private ticker: (() => void | Promise<void>) | null = null;

  start(onTick: () => void | Promise<void>): void {
    this.ticker = onTick;
  }

  stop(): void {
    this.ticker = null;
  }

  async tick(): Promise<void> {
    await this.ticker?.();
  }
}

class MemoryTransport implements RealtimeTransport {
  constructor(
    private readonly network: MemoryNetwork,
    private readonly clientID: string,
  ) {}

  subscribe(clientID: string, listener: TransportListener): void {
    this.network.subscribe(clientID, listener);
  }

  unsubscribe(clientID: string): void {
    this.network.unsubscribe(clientID);
  }

  send(
    packet: Omit<TransportPacket, "to">,
    recipients: readonly string[],
  ): void {
    this.network.send(packet, recipients);
  }

  broadcast(packet: Omit<TransportPacket, "to">): void {
    this.network.broadcast(packet);
  }

  close(): void {
    this.network.unsubscribe(this.clientID);
  }

  onStateChange(_listener: TransportStateListener): () => void {
    return () => {};
  }
}

function startInfo(): WireGameStartInfo {
  return {
    gameID: HOST_ID,
    lobbyCreatedAt: 1,
    config: {
      gameMap: GameMapType.World,
      gameMapSize: GameMapSize.Compact,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
      bots: 0,
      nations: "disabled",
      maxPlayers: 2,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      donateGold: false,
      donateTroops: false,
      randomSpawn: false,
    },
    players: [{ clientID: HOST_ID, username: "Host", clanTag: null }],
  };
}

function setup(): {
  network: MemoryNetwork;
  clock: ManualClock;
  host: RealtimeSession;
  peer: RealtimeSession;
  hostMessages: ServerMessage[];
  peerMessages: ServerMessage[];
} {
  const network = new MemoryNetwork();
  const clock = new ManualClock();
  const hostMessages: ServerMessage[] = [];
  const peerMessages: ServerMessage[] = [];
  const host = new RealtimeSession({
    gameID: HOST_ID,
    clientID: HOST_ID,
    hostID: HOST_ID,
    nickname: "Host",
    gameStartInfo: startInfo(),
    transport: new MemoryTransport(network, HOST_ID),
    clock,
    allowGeneralHello: true,
    now: () => Date.now(),
    onMessage: (message) => hostMessages.push(message),
  });
  const peer = new RealtimeSession({
    gameID: HOST_ID,
    clientID: PEER_ID,
    hostID: HOST_ID,
    nickname: "Peer",
    transport: new MemoryTransport(network, PEER_ID),
    allowGeneralHello: true,
    now: () => Date.now(),
    onMessage: (message) => peerMessages.push(message),
  });
  return { network, clock, host, peer, hostMessages, peerMessages };
}

async function connectAndStart(
  session: ReturnType<typeof setup>,
): Promise<void> {
  await session.host.connect(
    () => {},
    (message) => session.hostMessages.push(message),
  );
  await session.peer.connect(
    () => {},
    (message) => session.peerMessages.push(message),
  );
  await session.host.joinGame();
  await session.peer.joinGame();
  // The host answers the first hello with start. Let that async send settle
  // before the test issues the rejoin, exactly like ClientGameRunner does:
  // it only calls rejoinGame after it has received the start message.
  for (let i = 0; i < 4; i++) await Promise.resolve();
  // The peer's rejoin is the second hello that makes the host start producing
  // turns once both sides are ready.
  await session.host.rejoinGame(0);
  await session.peer.rejoinGame(0);
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("RealtimeSession", () => {
  it("starts a two-client session and delivers turns in order", async () => {
    vi.useFakeTimers();
    const session = setup();
    await connectAndStart(session);

    expect(
      session.hostMessages.some((message) => message.type === "start"),
    ).toBe(true);
    expect(
      session.peerMessages.some((message) => message.type === "start"),
    ).toBe(true);

    await session.clock.tick();
    const hostTurns = session.hostMessages.filter(
      (message) => message.type === "turn",
    );
    const peerTurns = session.peerMessages.filter(
      (message) => message.type === "turn",
    );
    expect(hostTurns).toHaveLength(2);
    expect(peerTurns).toHaveLength(2);
    expect(hostTurns.map((message) => message.turn.turnNumber)).toEqual([0, 1]);
    expect(peerTurns.map((message) => message.turn.turnNumber)).toEqual([0, 1]);
    expect(session.host.turnCountSeen).toBe(2);
    expect(session.peer.turnCountSeen).toBe(2);
    vi.useRealTimers();
  });

  it("fills a dropped turn from the host's history log", async () => {
    vi.useFakeTimers();
    const session = setup();
    await connectAndStart(session);

    session.network.dropNextTurnTo = PEER_ID;
    await session.clock.tick();
    expect(
      session.peerMessages.filter((message) => message.type === "turn"),
    ).toHaveLength(0);

    await session.clock.tick();
    for (let i = 0; i < 6; i++) await Promise.resolve();

    const turns = session.peerMessages.filter(
      (message) => message.type === "turn",
    );
    expect(turns.map((message) => message.turn.turnNumber)).toEqual([
      0, 1, 2, 3,
    ]);
    vi.useRealTimers();
  });

  it("forwards a peer intent to the host's next batch", async () => {
    vi.useFakeTimers();
    const session = setup();
    await connectAndStart(session);

    const intent: Intent = { type: "toggle_pause", paused: true };
    session.peer.sendIntent(intent);
    await vi.advanceTimersByTimeAsync(100);
    await session.clock.tick();

    const peerTurns = session.peerMessages.filter(
      (message) => message.type === "turn",
    );
    expect(peerTurns).toHaveLength(2);
    expect(peerTurns[0]?.turn.intents).toHaveLength(1);
    expect(peerTurns[0]?.turn.intents[0]?.type).toBe("toggle_pause");
    expect(peerTurns[0]?.turn.intents[0]?.clientID).toBe(PEER_ID);
    vi.useRealTimers();
  });

  it("acknowledges lastExecutedTurn, not turnsSeen", async () => {
    vi.useFakeTimers();
    const session = setup();
    await connectAndStart(session);
    await session.clock.tick();

    session.peer.reportHash(1, 0.5);
    expect(session.peer.turnCountSeen).toBe(2);
    expect(session.peer.lastExecutedTurnValue).toBe(1);

    const before = session.network.sent.length;
    await vi.advanceTimersByTimeAsync(1_100);
    const acks = session.network.sent
      .slice(before)
      .filter(
        (entry) =>
          entry.kind === "control" && entry.packet.control?.type === "ack",
      );
    expect(acks).toHaveLength(1);
    const ack = acks[0]?.packet.control;
    if (ack?.type !== "ack") throw new Error("expected ack");
    expect(ack.turn).toBe(1);
    expect(ack.hashTurn).toBe(1);
    expect(ack.hashValue).toBe(0.5);
    vi.useRealTimers();
  });

  it("reports a lost host after the lease window", async () => {
    vi.useFakeTimers();
    const session = setup();
    await connectAndStart(session);
    session.network.disconnect(HOST_ID);
    await session.host.leaveGame();

    await vi.advanceTimersByTimeAsync(4_500);
    const errors = session.peerMessages.filter(
      (message) => message.type === "error",
    );
    expect(errors.some((message) => message.error === "host_lost")).toBe(true);
    vi.useRealTimers();
  });
});
