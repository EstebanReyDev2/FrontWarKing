import { TurnLog } from "src/client/netcode/TurnLog";
import { TurnReceiver } from "src/client/netcode/TurnReceiver";
import { describe, expect, it, vi } from "vitest";
import { encodeBatch, makeBatch, makeContext, P1, P2 } from "./fixtures";

function receiverHarness(
  options: { allowTermChange?: boolean; maxPendingBatches?: number } = {},
) {
  const ctx = makeContext();
  const log = new TurnLog();
  const onApply = vi.fn();
  const onGap = vi.fn();
  const onConflict = vi.fn();
  const onDuplicate = vi.fn();
  const receiver = new TurnReceiver({
    term: 1,
    hostID: P1,
    nextTurn: 0,
    lastHash: 0,
    ctx,
    log,
    allowTermChange: options.allowTermChange,
    maxPendingBatches: options.maxPendingBatches,
    onApply: (batch) => {
      onApply(batch);
      log.append(batch, encodeBatch(batch, ctx));
    },
    onGap,
    onConflict,
    onDuplicate,
  });
  return { ctx, log, receiver, onApply, onGap, onConflict, onDuplicate };
}

describe("TurnReceiver", () => {
  it("applies consecutive batches and advances the chain", () => {
    const { ctx, log, receiver, onApply } = receiverHarness();
    const first = makeBatch({ ctx, fromTurn: 0 });
    const second = makeBatch({ ctx, fromTurn: 2, prevHash: first.hash });

    expect(receiver.accept(first)).toBe("applied");
    expect(receiver.accept(second)).toBe("applied");
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(receiver.nextTurn).toBe(4);
    expect(receiver.lastHash).toBe(second.hash);
    expect(log.lastTurn).toBe(3);
  });

  it("buffers out-of-order batches and drains them when the gap closes", () => {
    const { ctx, receiver, onGap } = receiverHarness();
    const first = makeBatch({ ctx, fromTurn: 0 });
    const second = makeBatch({ ctx, fromTurn: 2, prevHash: first.hash });
    const third = makeBatch({ ctx, fromTurn: 4, prevHash: second.hash });

    expect(receiver.accept(third)).toBe("pending");
    expect(receiver.accept(second)).toBe("pending");
    expect(onGap).toHaveBeenCalledWith(0);
    expect(receiver.pendingCount).toBe(2);

    expect(receiver.accept(first)).toBe("applied");
    expect(receiver.pendingCount).toBe(0);
    expect(receiver.nextTurn).toBe(6);
    expect(receiver.lastHash).toBe(third.hash);
  });

  it("ignores a duplicate proven by the log", () => {
    const { ctx, receiver, onDuplicate } = receiverHarness();
    const first = makeBatch({ ctx, fromTurn: 0 });
    receiver.accept(first);
    expect(receiver.accept(first)).toBe("ignored");
    expect(onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("pauses on a batch whose hash does not match its contents", () => {
    const { ctx, receiver, onConflict } = receiverHarness();
    const first = makeBatch({ ctx, fromTurn: 0 });
    first.turns[0].intents[0] = {
      type: "spawn",
      clientID: P1,
      tile: 999,
    };
    expect(receiver.accept(first)).toBe("conflict");
    expect(receiver.isPaused).toBe(true);
    expect(onConflict).toHaveBeenCalledTimes(1);
  });

  it("pauses on a broken prevHash", () => {
    const { ctx, receiver } = receiverHarness();
    const first = makeBatch({ ctx, fromTurn: 0 });
    receiver.accept(first);
    const second = makeBatch({ ctx, fromTurn: 2, prevHash: 999 });
    expect(receiver.accept(second)).toBe("conflict");
    expect(receiver.isPaused).toBe(true);
  });

  it("rejects a term change unless the caller enables F2b semantics", () => {
    const ctx = makeContext();
    const first = makeBatch({ ctx, fromTurn: 0, term: 2, hostID: P2 });
    const fixed = new TurnReceiver({
      term: 1,
      hostID: P1,
      nextTurn: 0,
      lastHash: 0,
      ctx,
    });
    expect(fixed.accept(first)).toBe("conflict");

    const changing = new TurnReceiver({
      term: 1,
      hostID: P1,
      nextTurn: 0,
      lastHash: 0,
      ctx,
      allowTermChange: true,
    });
    expect(changing.accept(first)).toBe("applied");
    expect(changing.term).toBe(2);
    expect(changing.hostID).toBe(P2);
  });

  it("ignores an older term", () => {
    const { ctx, receiver } = receiverHarness();
    const old = makeBatch({ ctx, fromTurn: 0, term: 0 });
    expect(receiver.accept(old)).toBe("ignored");
  });

  it("rejects a different host in the same term", () => {
    const { ctx, receiver } = receiverHarness();
    const otherHost = makeBatch({ ctx, fromTurn: 0, hostID: P2 });
    expect(receiver.accept(otherHost)).toBe("conflict");
  });

  it("caps the pending buffer", () => {
    const { ctx, receiver } = receiverHarness({ maxPendingBatches: 1 });
    const far = makeBatch({ ctx, fromTurn: 4 });
    const farther = makeBatch({ ctx, fromTurn: 6 });
    expect(receiver.accept(far)).toBe("pending");
    expect(receiver.accept(farther)).toBe("conflict");
  });

  it("rejects an empty batch", () => {
    const { ctx, receiver } = receiverHarness();
    const empty = makeBatch({ ctx, fromTurn: 0 });
    empty.turns = [];
    expect(receiver.accept(empty)).toBe("conflict");
  });
});
