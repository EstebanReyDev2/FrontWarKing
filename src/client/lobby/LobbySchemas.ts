import { GAME_ID_REGEX } from "@openfront/engine-api/Schemas";
import { WireGameStartInfoSchema } from "@openfront/shared/WireSchemas";
import { z } from "zod";
import { isValidRoomCode } from "./LobbyRules";

const RoomCodeSchema = z.string().refine(isValidRoomCode);
const ClientIDSchema = z.string().regex(/^[A-Za-z0-9]{8,10}$/);
const GameIDSchema = z.string().regex(GAME_ID_REGEX);

export const LobbyPlayerSchema = z.object({
  persistentID: ClientIDSchema,
  nickname: z.string().trim().min(1).max(24),
  host: z.boolean().optional(),
});

export const LobbyHelloSchema = z.object({
  type: z.literal("hello"),
  roomCode: RoomCodeSchema,
  clientID: ClientIDSchema,
  nickname: z.string().trim().min(1).max(24),
});

export const LobbyRosterSchema = z.object({
  type: z.literal("roster"),
  roomCode: RoomCodeSchema,
  hostID: ClientIDSchema,
  players: z.array(LobbyPlayerSchema).min(1).max(7),
  responseTo: ClientIDSchema.optional(),
  accepted: z.boolean().optional(),
  rejection: z.enum(["room_full", "game_started"]).optional(),
});

export const LobbyHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  roomCode: RoomCodeSchema,
  clientID: ClientIDSchema,
  hostID: ClientIDSchema,
  probe: z.boolean().optional(),
  starting: z.boolean().optional(),
});

export const LobbyStartSchema = z
  .object({
    type: z.literal("lobby_start"),
    v: z.literal(1),
    roomCode: RoomCodeSchema,
    gameID: GameIDSchema,
    gameStartInfo: WireGameStartInfoSchema,
    hostID: ClientIDSchema,
  })
  .refine((start) => start.gameID === start.gameStartInfo.gameID, {
    message: "LobbyStart gameID must match gameStartInfo.gameID",
  });

export const LobbyMessageSchema = z.discriminatedUnion("type", [
  LobbyHelloSchema,
  LobbyRosterSchema,
  LobbyHeartbeatSchema,
  LobbyStartSchema,
]);

export type LobbyPlayer = z.infer<typeof LobbyPlayerSchema>;
export type LobbyHello = z.infer<typeof LobbyHelloSchema>;
export type LobbyRoster = z.infer<typeof LobbyRosterSchema>;
export type LobbyHeartbeat = z.infer<typeof LobbyHeartbeatSchema>;
export type LobbyStart = z.infer<typeof LobbyStartSchema>;
export type LobbyMessage = z.infer<typeof LobbyMessageSchema>;
