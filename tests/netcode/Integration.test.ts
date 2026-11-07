import { describe, expect, it, vi } from "vitest";
import {
  FakeHost,
  FakePeer,
  FakeTransport,
  HOST_LOST_MESSAGE,
  pump,
} from "./fakeTransport";
import { makeContext, P1, P2, P3, P4, P5, P6 } from "./fixtures";

function createHost(network: FakeTransport): FakeHost {
  return new FakeHost({
    id: P1,
    term: 1,
    ctx: makeContext(),
    network,
    turnsPerBatch: 2,
    maxIntentsPerTurn: 4,
  });
}

function createPeer(
  network: FakeTransport,
  id: string,
  leaseTicks = 50,
): FakePeer {
  return new FakePeer({
    id,
    hostID: P1,
    term: 1,
    ctx: makeContext(),
    network,
    leaseTicks,
  });
}

describe("fake transport integration", () => {
  it("converges with six peers despite loss, duplicates and reordering", async () => {
    const network = new FakeTransport({
      seed: 0x5eed,
      loss: 0.12,
      duplicate: 0.08,
      maxLatency: 2,
    });
    const host = createHost(network);
    const peers = [
      createPeer(network, P2),
      createPeer(network, P3),
      createPeer(network, P4),
      createPeer(network, P5),
    ];
    host.start();

    let late: FakePeer | null = null;
    for (let tick = 0; tick < 36; tick++) {
      await host.tick();
      if (tick === 8) {
        // The sixth peer joins after the game has already produced turns. It
        // has no engine state, so it asks for history from turn 0 and then
        // switches to the live stream.
        late = createPeer(network, P6);
        late.startCatchUp(0);
        peers.push(late);
      }
      pump(network, peers);
    }

    // Let the host answer retries while the live stream keeps moving.
    for (let i = 0; i < 20; i++) {
      await host.tick();
      pump(network, peers);
    }
    for (let i = 0; i < 20; i++) pump(network, peers);
    network.flush();

    expect(late).not.toBeNull();
    const all = [host, ...peers];
    const expectedTurn = host.nextTurn;
    const expectedHash = host.lastHash;
    expect(expectedTurn).toBeGreaterThan(0);
    for (const peer of all) {
      expect(peer.nextTurn).toBe(expectedTurn);
      expect(peer.lastHash).toBe(expectedHash);
    }
  });

  it("ends F2a with a clear message when the host disappears", async () => {
    const network = new FakeTransport({
      seed: 0xc0ffee,
      loss: 0.05,
      duplicate: 0.05,
      maxLatency: 1,
    });
    const host = createHost(network);
    const lost = vi.fn();
    const peers = [P2, P3, P4, P5, P6].map(
      (id) =>
        new FakePeer({
          id,
          hostID: P1,
          term: 1,
          ctx: makeContext(),
          network,
          leaseTicks: 10,
          onHostLost: lost,
        }),
    );
    host.start();

    for (let tick = 0; tick < 10; tick++) {
      await host.tick();
      pump(network, peers);
    }

    host.stop();
    pump(network, peers, 20);

    expect(lost).toHaveBeenCalledTimes(peers.length);
    expect(lost).toHaveBeenCalledWith(HOST_LOST_MESSAGE);
    for (const peer of peers) {
      expect(peer.isHostLost).toBe(true);
    }
  });

  it("lets a late join catch up from an arbitrary history point", async () => {
    const network = new FakeTransport({
      seed: 0x1a7e,
      loss: 0,
      duplicate: 0,
      maxLatency: 1,
    });
    const host = createHost(network);
    const witnesses = [createPeer(network, P2), createPeer(network, P3)];
    host.start();
    for (let tick = 0; tick < 12; tick++) {
      await host.tick();
      pump(network, witnesses);
    }

    const late = createPeer(network, P4);
    late.startCatchUp(0);
    pump(network, [late]);
    pump(network, [late]);

    expect(late.nextTurn).toBe(host.nextTurn);
    expect(late.lastHash).toBe(host.lastHash);
  });
});
