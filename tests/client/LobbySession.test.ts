import { afterEach, describe, expect, it, vi } from "vitest";
import { JOIN_TIMEOUT_MS } from "../../src/client/lobby/LobbyRules";
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
