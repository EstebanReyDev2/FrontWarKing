import {
  WorkerTurnClock,
  type TurnClockWorkerPort,
} from "src/client/netcode/TurnClock";
import { describe, expect, it, vi } from "vitest";

function fakePort() {
  let listener: ((event: MessageEvent) => void) | null = null;
  const postMessage = vi.fn();
  const terminate = vi.fn();
  const port: TurnClockWorkerPort = {
    postMessage,
    terminate,
    addEventListener: (type, callback) => {
      if (type === "message") listener = callback;
    },
  };
  return {
    port,
    postMessage,
    terminate,
    fireTick: () => listener?.({ data: { type: "tick" } } as MessageEvent),
  };
}

describe("WorkerTurnClock", () => {
  it("starts the worker with the configured interval", () => {
    const fake = fakePort();
    const clock = new WorkerTurnClock(200, () => fake.port);
    clock.start(() => {});
    expect(fake.postMessage).toHaveBeenCalledWith({
      type: "start",
      intervalMs: 200,
    });
  });

  it("forwards worker ticks to the main-thread callback", async () => {
    const fake = fakePort();
    const clock = new WorkerTurnClock(200, () => fake.port);
    const onTick = vi.fn();
    clock.start(onTick);
    fake.fireTick();
    await Promise.resolve();
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it("stops and terminates the worker", () => {
    const fake = fakePort();
    const clock = new WorkerTurnClock(200, () => fake.port);
    clock.start(() => {});
    clock.stop();
    expect(fake.postMessage).toHaveBeenCalledWith({ type: "stop" });
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not keep two workers when started twice", () => {
    const first = fakePort();
    const second = fakePort();
    const workers = [first, second];
    const clock = new WorkerTurnClock(200, () => workers.shift()!.port);
    clock.start(() => {});
    clock.start(() => {});
    expect(first.terminate).toHaveBeenCalledTimes(1);
    expect(second.terminate).not.toHaveBeenCalled();
  });
});
