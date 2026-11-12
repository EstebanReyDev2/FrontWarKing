import type { StampedIntent, Turn } from "@openfront/engine-api/Schemas";
import type { TurnBatch } from "@openfront/shared/RealtimeSchemas";
import { encodeTurnBatch, hashTurnBatch } from "@openfront/shared/RealtimeWire";
import { createGameWireContext } from "@openfront/shared/ZbinWire";
import type { ZbContext } from "@openfront/zbin";

export const PLAYERS = [
  { clientID: "aB3dEf7h" },
  { clientID: "Xk9mNp2q" },
  { clientID: "Zz8wVu5t" },
  { clientID: "Qq4rS6tU" },
  { clientID: "Mm2nB8vC" },
  { clientID: "Hh7jK9lP" },
];

export const [P1, P2, P3, P4, P5, P6] = PLAYERS.map((p) => p.clientID);

export function makeContext(): ZbContext {
  return createGameWireContext(PLAYERS);
}

export function makeTurn(turnNumber: number, clientID = P1): Turn {
  const intent: StampedIntent = {
    type: "spawn",
    clientID,
    tile: turnNumber + 1,
  };
  return { turnNumber, intents: [intent] };
}

export function makeBatch(options: {
  ctx: ZbContext;
  fromTurn?: number;
  turnCount?: number;
  term?: number;
  hostID?: string;
  prevHash?: number;
}): TurnBatch {
  const fromTurn = options.fromTurn ?? 0;
  const turnCount = options.turnCount ?? 2;
  const turns = Array.from({ length: turnCount }, (_, i) =>
    makeTurn(fromTurn + i),
  );
  const batch: TurnBatch = {
    type: "turn_batch",
    v: 1,
    term: options.term ?? 1,
    hostID: options.hostID ?? P1,
    fromTurn,
    turns,
    prevHash: options.prevHash ?? 0,
    hash: 0,
  };
  batch.hash = hashTurnBatch(batch, options.ctx);
  return batch;
}

export function encodeBatch(batch: TurnBatch, ctx: ZbContext): Uint8Array {
  return encodeTurnBatch(batch, ctx);
}
