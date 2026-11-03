import { z } from "zod";
import { isValidRoomCode } from "./LobbyRules";

const RoomCodeSchema = z.string().refine(isValidRoomCode);
const ClientIDSchema = z.string().regex(/^[A-Za-z0-9]{8,10}$/);

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
  rejection: z.literal("room_full").optional(),
});

export const LobbyHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  roomCode: RoomCodeSchema,
  clientID: ClientIDSchema,
  hostID: ClientIDSchema,
  probe: z.boolean().optional(),
});

export const LobbyMessageSchema = z.discriminatedUnion("type", [
  LobbyHelloSchema,
  LobbyRosterSchema,
  LobbyHeartbeatSchema,
]);

export type LobbyPlayer = z.infer<typeof LobbyPlayerSchema>;
export type LobbyHello = z.infer<typeof LobbyHelloSchema>;
export type LobbyRoster = z.infer<typeof LobbyRosterSchema>;
export type LobbyHeartbeat = z.infer<typeof LobbyHeartbeatSchema>;
export type LobbyMessage = z.infer<typeof LobbyMessageSchema>;
