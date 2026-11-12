import { TurnLog } from "src/client/netcode/TurnLog";
import { describe, expect, it } from "vitest";
import { encodeBatch, makeBatch, makeContext, P1 } from "./fixtures";

describe("TurnLog", () => {
  it("stores raw frames and reads from an arbitrary turn", () => {
    const ctx = makeContext();
    const log = new TurnLog();
    const first = makeBatch({ ctx, fromTurn: 0, turnCount: 2 });
    const second = makeBatch({ ctx, fromTurn: 2, turnCount: 2 });
    const third = makeBatch({ ctx, fromTurn: 4, turnCount: 2 });
    log.append(first, encodeBatch(first, ctx));
    log.append(second, encodeBatch(second, ctx));
    log.append(third, encodeBatch(third, ctx));

    expect(log.size).toBe(3);
    expect(log.lastTurn).toBe(5);
    expect(log.lastHash).toBe(third.hash);

    const read = log.read(2);
    expect(read).not.toBeNull();
    expect(read!.fromTurn).toBe(2);
    expect(read!.toTurn).toBe(5);
    expect(read!.frames).toHaveLength(2);
    expect(read!.more).toBe(false);
  });

  it("stops a chunk before it exceeds the byte limit", () => {
    const ctx = makeContext();
    const log = new TurnLog();
    const first = makeBatch({ ctx, fromTurn: 0, turnCount: 2 });
    const second = makeBatch({ ctx, fromTurn: 2, turnCount: 2 });
    const firstBytes = encodeBatch(first, ctx);
    const secondBytes = encodeBatch(second, ctx);
    log.append(first, firstBytes);
    log.append(second, secondBytes);

    const read = log.read(
      0,
      firstBytes.byteLength + secondBytes.byteLength - 1,
    );
    expect(read).not.toBeNull();
    expect(read!.frames).toHaveLength(1);
    expect(read!.toTurn).toBe(1);
    expect(read!.more).toBe(true);
  });

  it("does not expose its internal bytes", () => {
    const ctx = makeContext();
    const log = new TurnLog();
    const batch = makeBatch({ ctx });
    const bytes = encodeBatch(batch, ctx);
    const original = bytes[0];
    log.append(batch, bytes);

    bytes[0] = 0xff;
    const firstRead = log.read(0);
    expect(firstRead!.frames[0][0]).toBe(original);
    firstRead!.frames[0][0] = 0x00;
    expect(log.read(0)!.frames[0][0]).toBe(original);
  });

  it("disables late join instead of silently dropping history", () => {
    const ctx = makeContext();
    const log = new TurnLog(10);
    const batch = makeBatch({ ctx });
    const result = log.append(batch, encodeBatch(batch, ctx));

    expect(result).toEqual({ stored: false, lateJoinDisabled: true });
    expect(log.lateJoinDisabled).toBe(true);
    expect(log.byteLength).toBe(0);
    expect(log.read(0)).toBeNull();
  });

  it("treats an exact repeat as a duplicate and a different batch as a conflict", () => {
    const ctx = makeContext();
    const log = new TurnLog();
    const batch = makeBatch({ ctx, fromTurn: 4 });
    const bytes = encodeBatch(batch, ctx);
    expect(log.append(batch, bytes).stored).toBe(true);
    expect(log.append(batch, bytes).stored).toBe(false);
    expect(log.findOverlap(batch)).toBe("duplicate");

    const different = makeBatch({ ctx, fromTurn: 4, turnCount: 1 });
    expect(log.findOverlap(different)).toBe("conflict");
    expect(() => log.append(different, encodeBatch(different, ctx))).toThrow(
      /different batch/,
    );
  });

  it("reports no overlap for a disjoint batch", () => {
    const ctx = makeContext();
    const log = new TurnLog();
    const batch = makeBatch({ ctx, fromTurn: 10 });
    expect(log.findOverlap(batch)).toBe("none");
    expect(log.hasTurn(10)).toBe(false);
    log.append(batch, encodeBatch(batch, ctx));
    expect(log.hasTurn(10)).toBe(true);
    expect(log.hasTurn(11)).toBe(true);
    expect(log.hasTurn(12)).toBe(false);
  });

  it("rejects non-contiguous batches before storing them", () => {
    const ctx = makeContext();
    const log = new TurnLog();
    const batch = makeBatch({ ctx, fromTurn: 3 });
    batch.turns[1].turnNumber = 99;
    expect(() => log.append(batch, encodeBatch(batch, ctx))).toThrow(
      /does not follow/,
    );
  });

  it("keeps the host metadata with the raw frame", () => {
    const ctx = makeContext();
    const log = new TurnLog();
    const batch = makeBatch({ ctx, fromTurn: 0, hostID: P1, term: 1 });
    log.append(batch, encodeBatch(batch, ctx));
    expect(log.getEntry(0)).toMatchObject({
      fromTurn: 0,
      toTurn: 1,
      term: 1,
      hostID: P1,
      hash: batch.hash,
    });
  });
});
