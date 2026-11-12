export type RateLimitEvent = {
  cost: number;
  available: number;
  capacity: number;
  waitMs: number;
};

export type EventRateLimiterOptions = {
  /** Maximum burst. Supabase Free allows 100 events/s; keep headroom. */
  capacity?: number;
  /** Steady-state events per second. */
  refillPerSecond?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onLimit?: (event: RateLimitEvent) => void;
};

export const DEFAULT_RATE_LIMIT_EVENTS_PER_SECOND = 80;

/**
 * Token bucket for Supabase broadcast deliveries.
 *
 * A sender that exceeds the bucket waits instead of dropping a turn. Losing a
 * turn would break lockstep, so backpressure is the only safe failure mode.
 */
export class EventRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onLimit?: (event: RateLimitEvent) => void;
  private tokens: number;
  private lastRefill: number;

  constructor(options: EventRateLimiterOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_RATE_LIMIT_EVENTS_PER_SECOND;
    this.refillPerSecond =
      options.refillPerSecond ?? DEFAULT_RATE_LIMIT_EVENTS_PER_SECOND;
    if (this.capacity <= 0 || this.refillPerSecond <= 0) {
      throw new RangeError("rate limiter capacity and refill must be positive");
    }
    if (this.capacity < 1 || this.refillPerSecond < 1) {
      throw new RangeError("rate limiter values must be at least 1");
    }
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.onLimit = options.onLimit;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Waits until `cost` deliveries fit in the bucket, then consumes them.
   * A single packet cannot cost more than the bucket capacity; a roster large
   * enough to break that assumption is outside the F2a target (2-20 players).
   */
  async acquire(cost = 1): Promise<void> {
    if (!Number.isFinite(cost) || cost <= 0) return;
    if (cost > this.capacity) {
      throw new RangeError(
        `rate limit cost ${cost} exceeds capacity ${this.capacity}`,
      );
    }

    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }

      const missing = cost - this.tokens;
      const waitMs = Math.max(
        1,
        Math.ceil((missing / this.refillPerSecond) * 1000),
      );
      this.onLimit?.({
        cost,
        available: this.tokens,
        capacity: this.capacity,
        waitMs,
      });
      await this.sleep(waitMs);
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed === 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed / 1000) * this.refillPerSecond,
    );
  }
}
