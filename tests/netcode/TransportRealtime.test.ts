// @vitest-environment jsdom
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import type {
  ServerMessage,
  WireGameStartInfo,
} from "@openfront/shared/WireSchemas";
import type { LobbyConfig } from "src/client/ClientGameRunner";
import type {
  RealtimeTransport,
  TransportListener,
  TransportPacket,
} from "src/client/netcode/RealtimeTransport";
import type { TurnClock } from "src/client/netcode/TurnClock";
import { Transport } from "src/client/Transport";
import { describe, expect, it } from "vitest";

const HOST_ID = "HOST0001";
const PEER_ID = "PEER0001";

class Network {
  private readonly listeners = new Map<string, Set<TransportListener>>();

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
      for (const listener of this.listeners.get(recipient) ?? []) {
        listener(packet);
      }
    }
  }

  broadcast(packet: Omit<TransportPacket, "to">): void {
    for (const [clientID, listeners] of this.listeners) {
      if (clientID === packet.from) continue;
      for (const listener of listeners) listener(packet);
    }
  }
}

class Client implements RealtimeTransport {
  constructor(
    private readonly network: Network,
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

function config(
  clientID: string,
  hostID: string,
  network: Network,
  clock?: ManualClock,
): LobbyConfig {
  return {
    cosmetics: {},
    playerName: clientID,
    playerClanTag: null,
    playerRole: null,
    gameID: hostID,
    turnstileToken: null,
    gameStartInfo: clientID === hostID ? startInfo() : undefined,
    realtime: {
      clientID,
      hostID,
      transport: new Client(network, clientID),
      allowGeneralHello: true,
      clock,
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("Transport realtime facade", () => {
  it("delivers start and turns through the existing ServerMessage callbacks", async () => {
    const network = new Network();
    const clock = new ManualClock();
    const hostMessages: ServerMessage[] = [];
    const peerMessages: ServerMessage[] = [];
    const host = new Transport(
      config(HOST_ID, HOST_ID, network, clock),
      new EventBus(),
    );
    const peer = new Transport(
      config(PEER_ID, HOST_ID, network),
      new EventBus(),
    );

    expect(host.isLocal).toBe(false);
    host.connect(
      () => {},
      (message) => hostMessages.push(message),
    );
    peer.connect(
      () => {},
      (message) => peerMessages.push(message),
    );
    await flush();
    await host.joinGame();
    await peer.joinGame();
    await flush();

    expect(hostMessages.some((message) => message.type === "start")).toBe(true);
    expect(peerMessages.some((message) => message.type === "start")).toBe(true);

    await host.rejoinGame(0);
    await peer.rejoinGame(0);
    await flush();
    await clock.tick();

    expect(
      peerMessages.filter((message) => message.type === "turn"),
    ).toHaveLength(2);
    expect(
      hostMessages.filter((message) => message.type === "turn"),
    ).toHaveLength(2);

    host.leaveGame();
    peer.leaveGame();
  });
});
