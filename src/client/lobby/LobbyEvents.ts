import type { GameEvent } from "@openfront/shared/EventBus";
import type { LobbyStart } from "./LobbySchemas";

export class LaunchRealtimeGameEvent implements GameEvent {
  constructor(
    public readonly start: LobbyStart,
    public readonly clientID: string,
    public readonly nickname: string,
  ) {}
}
