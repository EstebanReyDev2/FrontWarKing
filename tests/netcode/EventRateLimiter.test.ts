import {
  EventRateLimiter,
  type RateLimitEvent,
} from "src/client/netcode/EventRateLimiter";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});

describe("EventRateLimiter", () => {
  it("allows the configured burst and then waits for refill", async () => {
    vi.useFakeTimers();
    const limited: RateLimitEvent[] = [];
    const limiter = new EventRateLimiter({
      capacity: 2,
      refillPerSecond: 2,
      onLimit: (event) => limited.push(event),
    });

    await limiter.acquire(1);
    await limiter.acquire(1);
    const pending = limiter.acquire(1);
    expect(limited).toHaveLength(1);
    expect(limited[0].waitMs).toBe(500);

    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(limited).toHaveLength(1);
  });

  it("charges a broadcast as a single acquisition cost", async () => {
    const limiter = new EventRateLimiter({
      capacity: 10,
      refillPerSecond: 10,
    });
    await limiter.acquire(6);
    expect(limiter.available).toBeGreaterThanOrEqual(3.9);
    expect(limiter.available).toBeLessThanOrEqual(4);
  });

  it("rejects a single cost larger than the bucket", async () => {
    const limiter = new EventRateLimiter({
      capacity: 4,
      refillPerSecond: 4,
    });
    await expect(limiter.acquire(5)).rejects.toThrow(RangeError);
  });

  it("ignores non-positive costs", async () => {
    const limiter = new EventRateLimiter({
      capacity: 2,
      refillPerSecond: 2,
      sleep: () => Promise.resolve(),
    });
    await limiter.acquire(0);
    await limiter.acquire(-1);
    expect(limiter.available).toBe(2);
  });
});
