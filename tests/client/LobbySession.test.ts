import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import type { WireGameStartInfo } from "@openfront/shared/WireSchemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOIN_TIMEOUT_MS } from "../../src/client/lobby/LobbyRules";
import { LobbyStartSchema } from "../../src/client/lobby/LobbySchemas";
import {
  LOBBY_HOST_TIMEOUT_MS,
  LobbySession,
} from "../../src/client/lobby/LobbySession";
import { FakeSupabaseBus, FakeSupabaseClient } from "../netcode/fakeSupabase";

const hostOptions = (client: FakeSupabaseClient, onRoster = vi.fn()) => ({
  roomCode: "ABC234",
  clientID: "host0001",
  nickname: "Host",
  client,
  onRoster,
});

const peerOptions = (
  client: FakeSupabaseClient,
  clientID: string,
  nickname: string,
  onRoster = vi.fn(),
) => ({ roomCode: "ABC234", clientID, nickname, client, onRoster });

function startInfo(): WireGameStartInfo {
  return {
    gameID: "Game0001",
    lobbyCreatedAt: 1,
    config: {
      gameMap: GameMapType.Africa,
      gameMapSize: GameMapSize.Normal,
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
    players: [
      { clientID: "host0001", username: "Host", clanTag: null },
      { clientID: "peer0001", username: "Peer", clanTag: null },
    ],
  };
}

describe("LobbySession", () => {
  afterEach(() => vi.useRealTimers());

  it("synchronizes a real host and peer roster over the lobby channel", async () => {
    const bus = new FakeSupabaseBus();
    const hostRoster = vi.fn();
    const peerRoster = vi.fn();
    const host = await LobbySession.createHost(
      hostOptions(new FakeSupabaseClient(bus, "host"), hostRoster),
    );
    const peer = await LobbySession.joinPeer(
      peerOptions(
        new FakeSupabaseClient(bus, "peer"),
        "peer0001",
        "Peer",
        peerRoster,
      ),
    );

    expect(host.roster.map(({ nickname }) => nickname)).toEqual([
      "Host",
      "Peer",
    ]);
    expect(peer.roster.map(({ nickname }) => nickname)).toEqual([
      "Host",
      "Peer",
    ]);
    expect(hostRoster).toHaveBeenLastCalledWith(host.roster);
    expect(peerRoster).toHaveBeenLastCalledWith(peer.roster);
    expect(
      bus.deliveries.every(
        ({ topic, event }) => topic === "game:ABC234" && event === "lobby",
      ),
    ).toBe(true);
    await peer.close();
    await host.close();
  });

  it("rejects a peer when the host roster reaches seven players", async () => {
    const bus = new FakeSupabaseBus();
    const host = await LobbySession.createHost(
      hostOptions(new FakeSupabaseClient(bus)),
    );
    const peers: LobbySession[] = [];
    for (let index = 0; index < 6; index++) {
      peers.push(
        await LobbySession.joinPeer(
          peerOptions(
            new FakeSupabaseClient(bus, `peer${index}`),
            `peer${String(index).padStart(4, "0")}`,
            `Peer ${index}`,
          ),
        ),
      );
    }
    await expect(
      LobbySession.joinPeer(
        peerOptions(
          new FakeSupabaseClient(bus, "overflow"),
          "over0001",
          "Overflow",
        ),
      ),
    ).rejects.toThrow("La sala está llena");
    expect(host.roster).toHaveLength(7);
    await Promise.all(peers.map((peer) => peer.close()));
    await host.close();
  });

  it("detects an existing host using the collision probe", async () => {
    const bus = new FakeSupabaseBus();
    const host = await LobbySession.createHost(
      hostOptions(new FakeSupabaseClient(bus, "first")),
    );
    await expect(
      LobbySession.createHost({
        ...hostOptions(new FakeSupabaseClient(bus, "second")),
        clientID: "host0002",
      }),
    ).rejects.toThrow("Room code is already used by another host");
    await host.close();
  });

  it("validates LobbyStart IDs and round-trips its gameStartInfo", async () => {
    const start = {
      type: "lobby_start" as const,
      v: 1 as const,
      roomCode: "ABC234",
      gameID: "Game0001",
      gameStartInfo: startInfo(),
      hostID: "host0001",
    };
    expect(LobbyStartSchema.parse(start)).toEqual(start);
    expect(
      LobbyStartSchema.safeParse({ ...start, gameID: "ABC234" }).success,
    ).toBe(false);
    expect(LobbyStartSchema.safeParse({ ...start, roomCode: "" }).success).toBe(
      false,
    );
  });

  it("publishes one frozen start and delivers it to host and peer", async () => {
    const bus = new FakeSupabaseBus();
    const hostStart = vi.fn();
    const peerStart = vi.fn();
    const host = await LobbySession.createHost({
      ...hostOptions(new FakeSupabaseClient(bus, "host")),
      onGameStart: hostStart,
    });
    const peer = await LobbySession.joinPeer({
      ...peerOptions(new FakeSupabaseClient(bus, "peer"), "peer0001", "Peer"),
      onGameStart: peerStart,
    });
    const info = startInfo();
    await host.startGame(info);
    expect(hostStart).toHaveBeenCalledWith(
      expect.objectContaining({ gameID: "Game0001", gameStartInfo: info }),
    );
    expect(peerStart).toHaveBeenCalledWith(
      expect.objectContaining({ gameID: "Game0001", gameStartInfo: info }),
    );
    expect(
      bus.deliveries.map(({ payload }) => JSON.parse(String(payload)).type),
    ).toContain("lobby_start");
    await peer.close();
    await host.close();
  });

  it("delivers a room-scoped lobby start to the peer and fires onGameStart", async () => {
    const bus = new FakeSupabaseBus();
    const peerStart = vi.fn();
    const host = await LobbySession.createHost(
      hostOptions(new FakeSupabaseClient(bus, "host")),
    );
    const peer = await LobbySession.joinPeer({
      ...peerOptions(new FakeSupabaseClient(bus, "peer"), "peer0001", "Peer"),
      onGameStart: peerStart,
    });
    const info = startInfo();
    await host.startGame(info);

    expect(peerStart).toHaveBeenCalledOnce();
    const delivered = peerStart.mock.calls[0]?.[0];
    expect(delivered).toMatchObject({
      type: "lobby_start",
      roomCode: "ABC234",
      gameID: "Game0001",
      hostID: "host0001",
    });
    expect(delivered.gameStartInfo).toEqual(info);
    await peer.close();
    await host.close();
  });

  it("times out when a room has no host to answer the join hello", async () => {
    vi.useFakeTimers();
    const sessionPromise = LobbySession.joinPeer(
      peerOptions(
        new FakeSupabaseClient(new FakeSupabaseBus(), "orphan"),
        "peer0001",
        "Peer",
      ),
    );
    const expectation = expect(sessionPromise).rejects.toThrow(
      "Sala no encontrada o host desconectado",
    );
    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS);
    await expectation;
  });

  it("notifies a peer when host heartbeats stop", async () => {
    vi.useFakeTimers();
    const bus = new FakeSupabaseBus();
    const hostPromise = LobbySession.createHost(
      hostOptions(new FakeSupabaseClient(bus, "host")),
    );
    await vi.advanceTimersByTimeAsync(500);
    const host = await hostPromise;
    const onHostLost = vi.fn();
    const peer = await LobbySession.joinPeer({
      ...peerOptions(new FakeSupabaseClient(bus, "peer"), "peer0001", "Peer"),
      onHostLost,
    });
    await host.close();
    await vi.advanceTimersByTimeAsync(LOBBY_HOST_TIMEOUT_MS);
    expect(onHostLost).toHaveBeenCalledOnce();
    await peer.close();
  });
});
