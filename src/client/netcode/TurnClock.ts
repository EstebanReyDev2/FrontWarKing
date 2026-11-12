export interface TurnClock {
  start(onTick: () => void | Promise<void>): void;
  stop(): void;
}

export type TurnClockWorkerPort = {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
};

export type TurnClockWorkerFactory = () => TurnClockWorkerPort;

export const DEFAULT_TURN_CLOCK_INTERVAL_MS = 200;

/**
 * The host's turn timer, isolated from the rendering thread.
 *
 * The worker only says "the interval elapsed". TurnMaker still builds and
 * publishes the batch on the main thread, so the engine, the UI and Supabase
 * keep running on the same thread they already use.
 */
export class WorkerTurnClock implements TurnClock {
  private worker: TurnClockWorkerPort | null = null;

  constructor(
    private readonly intervalMs = DEFAULT_TURN_CLOCK_INTERVAL_MS,
    private readonly createWorker: TurnClockWorkerFactory = defaultWorkerFactory,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`invalid turn clock interval: ${intervalMs}`);
    }
  }

  start(onTick: () => void | Promise<void>): void {
    this.stop();
    const worker = this.createWorker();
    worker.addEventListener("message", (event) => {
      const data = event.data as { type?: unknown } | null;
      if (data?.type === "tick") void onTick();
    });
    this.worker = worker;
    worker.postMessage({ type: "start", intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.worker === null) return;
    this.worker.postMessage({ type: "stop" });
    this.worker.terminate();
    this.worker = null;
  }
}

function defaultWorkerFactory(): TurnClockWorkerPort {
  return new Worker(new URL("./TurnClock.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as TurnClockWorkerPort;
}
