// Manual smoke test for the Supabase broadcast transport.
//
// Run it with real credentials in .env.local:
//   npm run realtime:smoke
//
// It is deliberately excluded from the automated suite: it needs a live
// Supabase project, four channel connections and about a minute of wall clock.
// The goal is to prove binary framing, delivery and p50/p95 latency against the
// real service, not to replace the deterministic contract tests.
import type { TurnBatch } from "@openfront/shared/RealtimeSchemas";
import {
  decodeTurnBatch,
  encodeTurnBatch,
  hashTurnBatch,
} from "@openfront/shared/RealtimeWire";
import { generateID } from "@openfront/shared/SharedUtil";
import { createGameWireContext } from "@openfront/shared/ZbinWire";
import { config as loadEnv } from "dotenv";
import {
  createSupabaseRealtimeClient,
  SupabaseBroadcastTransport,
} from "../src/client/netcode/SupabaseBroadcastTransport";

loadEnv({ path: ".env.local", quiet: true });

const SECONDS = Number(process.env.SMOKE_SECONDS ?? 60);
const TURN_INTERVAL_MS = 200;
const ROOM = process.env.SMOKE_ROOM ?? generateID();

type Stats = {
  turns: number;
  bytes: number;
  lastHash: number;
  latencies: number[];
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function makeTransport(clientID: string): SupabaseBroadcastTransport {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (url === undefined || key === undefined || url === "" || key === "") {
    throw new Error(
      "Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local",
    );
  }
  return new SupabaseBroadcastTransport({
    client: createSupabaseRealtimeClient({ url, publishableKey: key }),
    gameID: ROOM,
    clientID,
    hostID: ROOM,
    eventsPerSecond: 80,
  });
}

async function main(): Promise<void> {
  if (!Number.isFinite(SECONDS) || SECONDS <= 0) {
    throw new Error(`invalid SMOKE_SECONDS: ${process.env.SMOKE_SECONDS}`);
  }

  const hostID = ROOM;
  const peerIDs = [generateID(), generateID(), generateID()];
  const players = [hostID, ...peerIDs];
  const ctx = createGameWireContext(players.map((clientID) => ({ clientID })));
  const host = makeTransport(hostID);
  const peers = peerIDs.map((id) => ({ id, transport: makeTransport(id) }));
  const stats = new Map<string, Stats>(
    peerIDs.map((id) => [
      id,
      { turns: 0, bytes: 0, lastHash: 0, latencies: [] },
    ]),
  );
  let sentAt = 0;

  await host.subscribe(hostID, () => {});
  for (const peer of peers) {
    await peer.transport.subscribe(peer.id, (packet) => {
      if (packet.kind !== "turn" || packet.bytes === undefined) return;
      const stat = stats.get(peer.id);
      if (stat === undefined) return;
      stat.turns++;
      stat.bytes += packet.bytes.byteLength;
      stat.latencies.push(
        Number(process.hrtime.bigint() / 1_000_000n) - sentAt,
      );
      // The smoke script only needs to prove that all clients saw the same
      // final chain. A full decode is covered by the deterministic tests.
      stat.lastHash = decodeTurnBatch(packet.bytes, ctx).hash;
    });
  }

  let lastHash = 0;
  let nextTurn = 0;
  const batches = Math.ceil((SECONDS * 1000) / TURN_INTERVAL_MS);
  console.log(
    `[smoke] room ${ROOM}, host ${hostID}, ${peers.length} clients, ${batches} batches`,
  );

  const cleanup = async () => {
    await host.close();
    await Promise.all(peers.map((peer) => peer.transport.close()));
  };
  process.once("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    for (let i = 0; i < batches; i++) {
      const batch: TurnBatch = {
        type: "turn_batch",
        v: 1,
        term: 1,
        hostID,
        fromTurn: nextTurn,
        turns: [
          { turnNumber: nextTurn, intents: [] },
          { turnNumber: nextTurn + 1, intents: [] },
        ],
        prevHash: lastHash,
        hash: 0,
      };
      batch.hash = hashTurnBatch(batch, ctx);
      lastHash = batch.hash;
      nextTurn += batch.turns.length;
      const bytes = encodeTurnBatch(batch, ctx);
      sentAt = Number(process.hrtime.bigint() / 1_000_000n);
      await host.broadcast({ kind: "turn", from: hostID, bytes });
      await new Promise((resolve) => setTimeout(resolve, TURN_INTERVAL_MS));
    }
  } finally {
    await cleanup();
  }

  let failed = false;
  for (const [id, stat] of stats) {
    const p50 = percentile(stat.latencies, 50);
    const p95 = percentile(stat.latencies, 95);
    const converged = stat.lastHash === lastHash;
    if (!converged || stat.turns !== batches) failed = true;
    console.log(
      `[smoke] ${id}: turns=${stat.turns}/${batches} bytes=${stat.bytes} ` +
        `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms converged=${converged}`,
    );
  }

  if (failed) {
    throw new Error("smoke test failed: missing turns or divergent hashes");
  }
  console.log("[smoke] OK");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
