// Dedicated timer for the host's turn clock. It deliberately does no work
// besides counting: the main thread still builds and publishes each batch.
type StartMessage = { type: "start"; intervalMs: number };
type StopMessage = { type: "stop" };
type Incoming = StartMessage | StopMessage;

const ctx = self as any;
let timer: ReturnType<typeof setInterval> | null = null;

function stopTimer(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

ctx.onmessage = (event: MessageEvent<Incoming>) => {
  const message = event.data;
  if (message?.type === "stop") {
    stopTimer();
    return;
  }
  if (message?.type !== "start") return;
  stopTimer();
  const interval = Number(message.intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return;
  timer = setInterval(() => {
    ctx.postMessage({ type: "tick" });
  }, interval);
};

// Keeps the module in the worker graph even if a bundler tree-shakes the
// onmessage assignment in analysis-only builds.
export {};
