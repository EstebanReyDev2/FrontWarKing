import type { TurnBatch } from "@openfront/shared/RealtimeSchemas";
import { isTurnBatchHashValid } from "@openfront/shared/RealtimeWire";
import type { TurnClock } from "src/client/netcode/TurnClock";
import { TurnMaker } from "src/client/netcode/TurnMaker";
import { describe, expect, it, vi } from "vitest";
import { makeContext, P1, P2 } from "./fixtures";

class FakeClock implements TurnClock {
  private callback: (() => void | Promise<void>) | null = null;
  startCalls = 0;
  stopCalls = 0;

  start(callback: () => void | Promise<void>): void {
    this.callback = callback;
    this.startCalls++;
  }

  stop(): void {
    this.callback = null;
    this.stopCalls++;
  }

  async tick(): Promise<void> {
    await this.callback?.();
  }
}

function harness(options: { lease?: () => boolean; maxQueue?: number } = {}) {
  const ctx = makeContext();
  const clock = new FakeClock();
  const batches: TurnBatch[] = [];
  const onLeaseLost = vi.fn();
  const onPublishError = vi.fn();
  const onQueueOverflow = vi.fn();
  let failNextPublish = false;
  const sink = {
    async publish(batch: TurnBatch): Promise<void> {
      if (failNextPublish) {
        failNextPublish = false;
        throw new Error("sink down");
      }
      batches.push(batch);
    },
  };
  const maker = new TurnMaker({
    term: 1,
    hostID: P1,
    turnsPerBatch: 2,
    maxIntentsPerTurn: 2,
    maxQueuedIntents: options.maxQueue,
    clock,
    sink,
    ctx,
    isLeaseValid: options.lease ?? (() => true),
    onLeaseLost,
    onPublishError,
    onQueueOverflow,
  });
  return {
    ctx,
    clock,
    batches,
    maker,
    onLeaseLost,
    onPublishError,
    onQueueOverflow,
    failNextPublish: () => {
      failNextPublish = true;
    },
  };
}

describe("TurnMaker", () => {
  it("builds two turns per tick and emits empty turns", async () => {
    const { ctx, clock, batches, maker } = harness();
    maker.start(0);
    await clock.tick();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      type: "turn_batch",
      term: 1,
      hostID: P1,
      fromTurn: 0,
      prevHash: 0,
    });
    expect(batches[0].turns.map((t) => t.turnNumber)).toEqual([0, 1]);
    expect(batches[0].turns[0].intents).toEqual([]);
    expect(isTurnBatchHashValid(batches[0], ctx)).toBe(true);
    expect(maker.nextTurn).toBe(2);
    expect(maker.lastHash).toBe(batches[0].hash);
  });

  it("stamps client ids and respects the per-turn intent cap", async () => {
    const { clock, batches, maker } = harness();
    maker.enqueue(P1, { type: "spawn", tile: 1 });
    maker.enqueue(P2, { type: "spawn", tile: 2 });
    maker.enqueue(P2, { type: "spawn", tile: 3 });
    maker.start(0);
    await clock.tick();

    expect(batches[0].turns[0].intents).toHaveLength(2);
    expect(batches[0].turns[0].intents[0]).toMatchObject({
      type: "spawn",
      clientID: P1,
      tile: 1,
    });
    expect(batches[0].turns[0].intents[1]).toMatchObject({
      type: "spawn",
      clientID: P2,
      tile: 2,
    });
    expect(batches[0].turns[1].intents).toHaveLength(1);
    expect(maker.queuedIntents).toBe(0);
  });

  it("numbers batches without duplicates", async () => {
    const { clock, batches, maker } = harness();
    maker.start(10);
    await clock.tick();
    await clock.tick();

    expect(batches.map((b) => b.fromTurn)).toEqual([10, 12]);
    expect(batches.map((b) => b.turns.map((t) => t.turnNumber))).toEqual([
      [10, 11],
      [12, 13],
    ]);
    expect(batches[1].prevHash).toBe(batches[0].hash);
    expect(maker.nextTurn).toBe(14);
  });

  it("does not publish when the lease is invalid and reports it once", async () => {
    const { clock, batches, maker, onLeaseLost } = harness({
      lease: () => false,
    });
    maker.start(0);
    await clock.tick();
    await clock.tick();

    expect(batches).toHaveLength(0);
    expect(maker.isLeaseLost).toBe(true);
    expect(maker.isRunning).toBe(false);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
  });

  it("pauses and resumes without losing its turn counter", async () => {
    const { clock, batches, maker } = harness();
    maker.start(0);
    maker.pause();
    await clock.tick();
    expect(batches).toHaveLength(0);

    maker.resume();
    await clock.tick();
    expect(batches).toHaveLength(1);
    expect(batches[0].fromTurn).toBe(0);
  });

  it("retries the same batch after a publish failure", async () => {
    const { clock, batches, maker, onPublishError, failNextPublish } =
      harness();
    maker.start(0);
    failNextPublish();
    await clock.tick();
    expect(batches).toHaveLength(0);
    expect(onPublishError).toHaveBeenCalledTimes(1);
    expect(maker.nextTurn).toBe(0);

    await clock.tick();
    expect(batches).toHaveLength(1);
    expect(batches[0].fromTurn).toBe(0);
    expect(maker.nextTurn).toBe(2);
  });

  it("drops the oldest intent when the queue overflows", async () => {
    const { clock, batches, maker, onQueueOverflow } = harness({ maxQueue: 2 });
    maker.enqueue(P1, { type: "spawn", tile: 1 });
    maker.enqueue(P1, { type: "spawn", tile: 2 });
    maker.enqueue(P1, { type: "spawn", tile: 3 });
    maker.start(0);
    await clock.tick();

    expect(onQueueOverflow).toHaveBeenCalledTimes(1);
    expect(
      batches[0].turns[0].intents.map((i) =>
        i.type === "spawn" ? i.tile : -1,
      ),
    ).toEqual([2, 3]);
  });

  it("ignores duplicate intent sequence numbers", () => {
    const { maker } = harness();
    maker.enqueueBatch(P1, 1, [{ type: "spawn", tile: 1 }]);
    maker.enqueueBatch(P1, 1, [{ type: "spawn", tile: 2 }]);
    maker.enqueueBatch(P1, 2, [{ type: "spawn", tile: 3 }]);
    expect(maker.queuedIntents).toBe(2);
  });

  it("starts and stops the injected clock", () => {
    const { clock, maker } = harness();
    maker.start(0);
    maker.stop();
    expect(clock.startCalls).toBe(1);
    expect(clock.stopCalls).toBe(1);
  });
});
