import {
  createSupabaseRealtimeClient,
  type SupabaseClientLike,
  type SupabaseChannelLike,
} from "../netcode/SupabaseBroadcastTransport";
import { supabaseRealtimeConfig } from "../netcode/SupabaseConfig";
import { JOIN_TIMEOUT_MS, MAX_PLAYERS } from "./LobbyRules";
import {
  LobbyMessageSchema,
  LobbyStartSchema,
  type LobbyHeartbeat,
  type LobbyMessage,
  type LobbyPlayer,
  type LobbyRoster,
  type LobbyStart,
} from "./LobbySchemas";

export const LOBBY_HEARTBEAT_MS = 2_000;
export const LOBBY_HOST_TIMEOUT_MS = 6_000;
export const ROOM_CLAIM_WINDOW_MS = 500;
export const LOBBY_BROADCAST_EVENT = "lobby";

export type LobbySessionOptions = {
  roomCode: string;
  clientID: string;
  nickname: string;
  client?: SupabaseClientLike;
  onRoster: (players: LobbyPlayer[]) => void;
  onHostLost?: () => void;
  onGameStart?: (start: LobbyStart) => void;
  onStartTimeout?: () => void;
  onError?: (error: Error) => void;
};

export class LobbyRoomCollisionError extends Error {
  constructor(readonly conflictingHostID: string) {
    super("Room code is already used by another host");
    this.name = "LobbyRoomCollisionError";
  }
}

/** Ephemeral pre-game roster and liveness only; game turns belong to RealtimeSession. */
export class LobbySession {
  private readonly channel: SupabaseChannelLike;
  private readonly client: SupabaseClientLike;
  private readonly isHost: boolean;
  private hostID: string;
  private players: LobbyPlayer[] = [];
  private readonly lastSeen = new Map<string, number>();
  private lastHostHeartbeat = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private probing = false;
  private conflictingHostID: string | null = null;
  private phase: "lobby" | "starting" = "lobby";
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingJoin:
    | {
        resolve: (roster: LobbyRoster) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private onRoster: LobbySessionOptions["onRoster"];
  private onHostLost?: LobbySessionOptions["onHostLost"];
  private onGameStart?: LobbySessionOptions["onGameStart"];
  private onStartTimeout?: LobbySessionOptions["onStartTimeout"];
  private onError?: LobbySessionOptions["onError"];

  private constructor(
    private readonly options: LobbySessionOptions,
    private readonly clientID: string,
    private readonly nickname: string,
    private readonly roomCode: string,
    private readonly role: "host" | "peer",
  ) {
    this.client = options.client ?? this.createClient();
    this.channel = this.client.channel(`game:${roomCode}`, {
      config: { broadcast: { self: false, ack: true } },
    });
    this.isHost = role === "host";
    this.hostID = this.isHost ? clientID : "";
    this.onRoster = options.onRoster;
    this.onHostLost = options.onHostLost;
    this.onGameStart = options.onGameStart;
    this.onStartTimeout = options.onStartTimeout;
    this.onError = options.onError;
    this.channel.on(
      "broadcast",
      { event: LOBBY_BROADCAST_EVENT },
      ({ payload }) => this.receive(payload),
    );
  }

  static async createHost(options: LobbySessionOptions): Promise<LobbySession> {
    const session = new LobbySession(
      options,
      options.clientID,
      options.nickname,
      options.roomCode,
      "host",
    );
    try {
      await session.subscribe();
      session.probing = true;
      await session.publish({
        type: "heartbeat",
        roomCode: options.roomCode,
        clientID: options.clientID,
        hostID: options.clientID,
        probe: true,
      });
      await new Promise((resolve) => setTimeout(resolve, ROOM_CLAIM_WINDOW_MS));
      session.probing = false;
      if (session.conflictingHostID !== null) {
        throw new LobbyRoomCollisionError(session.conflictingHostID);
      }

      session.players = [
        {
          persistentID: options.clientID,
          nickname: options.nickname.trim(),
          host: true,
        },
      ];
      session.lastSeen.set(options.clientID, Date.now());
      session.notifyRoster();
      await session.publishRoster();
      session.startHeartbeat();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  static async joinPeer(options: LobbySessionOptions): Promise<LobbySession> {
    const session = new LobbySession(
      options,
      options.clientID,
      options.nickname,
      options.roomCode,
      "peer",
    );
    try {
      await session.subscribe();
    } catch (error) {
      await session.close();
      throw error;
    }
    const response = new Promise<LobbyRoster>((resolve, reject) => {
      session.pendingJoin = { resolve, reject };
    });
    const timeout = setTimeout(() => {
      session.pendingJoin?.reject(
        new Error("Sala no encontrada o host desconectado"),
      );
    }, JOIN_TIMEOUT_MS);

    try {
      await session.publish({
        type: "hello",
        roomCode: options.roomCode,
        clientID: options.clientID,
        nickname: options.nickname.trim(),
      });
      const roster = await response;
      session.hostID = roster.hostID;
      session.players = roster.players;
      session.lastHostHeartbeat = Date.now();
      session.notifyRoster();
      session.startHeartbeat();
      return session;
    } catch (error) {
      await session.close();
      throw error;
    } finally {
      clearTimeout(timeout);
      session.pendingJoin = undefined;
    }
  }

  get roster(): LobbyPlayer[] {
    return this.players.map((player) => ({ ...player }));
  }

  get currentHostID(): string {
    return this.hostID;
  }

  async startGame(gameStartInfo: LobbyStart["gameStartInfo"]): Promise<void> {
    if (!this.isHost || this.closed || this.phase !== "lobby") {
      throw new Error("Only the lobby host can start the game once");
    }
    const canonicalPlayers = this.roster;
    const wirePlayers = gameStartInfo.players;
    if (
      canonicalPlayers.length !== wirePlayers.length ||
      canonicalPlayers.some(
        (player, index) =>
          player.persistentID !== wirePlayers[index]?.clientID ||
          player.nickname !== wirePlayers[index]?.username,
      )
    ) {
      throw new Error("Game start roster does not match the lobby roster");
    }
    if (gameStartInfo.gameID === this.roomCode) {
      throw new Error("Game ID must differ from the six-character room code");
    }

    this.phase = "starting";
    const start: LobbyStart = {
      type: "lobby_start",
      v: 1,
      roomCode: this.roomCode,
      gameID: gameStartInfo.gameID,
      gameStartInfo,
      hostID: this.clientID,
    };
    LobbyStartSchema.parse(start);
    try {
      await this.publish({
        type: "heartbeat",
        roomCode: this.roomCode,
        clientID: this.clientID,
        hostID: this.clientID,
        starting: true,
      });
      await this.publish(start);
      this.stopHeartbeat();
      this.onGameStart?.(start);
    } catch (error) {
      this.phase = "lobby";
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.startTimeout !== null) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }
    this.pendingJoin?.reject(new Error("Lobby connection closed"));
    await this.channel.unsubscribe();
    await this.client.removeChannel?.(this.channel);
  }

  private createClient(): SupabaseClientLike {
    const config = supabaseRealtimeConfig();
    if (config === null) {
      throw new Error(
        "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY",
      );
    }
    return createSupabaseRealtimeClient(config);
  }

  private async subscribe(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Timed out subscribing to lobby channel"));
      }, JOIN_TIMEOUT_MS);
      this.channel.subscribe((status, error) => {
        if (settled) return;
        if (status === "SUBSCRIBED") {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          settled = true;
          clearTimeout(timeout);
          reject(error ?? new Error(`Lobby channel ${status.toLowerCase()}`));
        }
      });
    });
  }

  private receive(payload: unknown): void {
    if (this.closed) return;
    let raw = payload;
    if (typeof payload === "string") {
      try {
        raw = JSON.parse(payload);
      } catch {
        return;
      }
    }
    const parsed = LobbyMessageSchema.safeParse(raw);
    if (!parsed.success || parsed.data.roomCode !== this.roomCode) return;
    const message = parsed.data as LobbyMessage;

    if (this.isHost && this.probing) {
      const otherHost =
        message.type === "roster"
          ? message.hostID
          : message.type === "heartbeat" && message.clientID === message.hostID
            ? message.hostID
            : null;
      if (otherHost !== null && otherHost !== this.clientID) {
        this.conflictingHostID = otherHost;
        return;
      }
    }

    switch (message.type) {
      case "hello":
        if (this.isHost)
          void this.acceptPeer(message.clientID, message.nickname).catch(
            () => {},
          );
        break;
      case "roster":
        this.receiveRoster(message);
        break;
      case "heartbeat":
        this.receiveHeartbeat(message);
        break;
      case "lobby_start":
        this.receiveStart(message);
        break;
    }
  }

  private receiveRoster(roster: LobbyRoster): void {
    if (
      this.isHost ||
      this.phase !== "lobby" ||
      roster.hostID === this.clientID
    )
      return;
    this.hostID = roster.hostID;
    this.players = roster.players;
    this.lastHostHeartbeat = Date.now();
    this.notifyRoster();
    if (roster.responseTo === this.clientID) {
      if (roster.accepted === true) {
        this.pendingJoin?.resolve(roster);
      } else {
        this.pendingJoin?.reject(
          new Error(
            roster.rejection === "room_full"
              ? "La sala está llena."
              : roster.rejection === "game_started"
                ? "Partida ya iniciada."
                : "No se pudo ingresar a la sala.",
          ),
        );
      }
    }
  }

  private receiveHeartbeat(heartbeat: LobbyHeartbeat): void {
    if (
      this.isHost &&
      heartbeat.probe === true &&
      heartbeat.clientID === heartbeat.hostID &&
      heartbeat.hostID !== this.clientID
    ) {
      void this.sendHeartbeat();
      return;
    }
    if (
      this.isHost &&
      heartbeat.hostID === this.clientID &&
      heartbeat.clientID !== this.clientID &&
      this.lastSeen.has(heartbeat.clientID)
    ) {
      this.lastSeen.set(heartbeat.clientID, Date.now());
      return;
    }
    if (
      !this.isHost &&
      heartbeat.clientID === heartbeat.hostID &&
      heartbeat.hostID === this.hostID
    ) {
      this.lastHostHeartbeat = Date.now();
      if (heartbeat.starting === true && this.startTimeout === null) {
        this.startTimeout = setTimeout(() => {
          this.startTimeout = null;
          if (this.phase !== "lobby" || this.closed) return;
          this.onStartTimeout?.();
          void this.close();
        }, LOBBY_HOST_TIMEOUT_MS);
      }
    }
  }

  private receiveStart(start: LobbyStart): void {
    if (
      this.isHost ||
      this.closed ||
      this.phase !== "lobby" ||
      start.hostID !== this.hostID ||
      start.gameID !== start.gameStartInfo.gameID
    ) {
      return;
    }
    this.phase = "starting";
    if (this.startTimeout !== null) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }
    this.stopHeartbeat();
    this.onGameStart?.(start);
  }

  private async acceptPeer(clientID: string, nickname: string): Promise<void> {
    if (clientID === this.clientID) return;
    if (this.phase !== "lobby") {
      await this.publishRoster({
        responseTo: clientID,
        accepted: false,
        rejection: "game_started",
      });
      return;
    }
    const existing = this.players.some(
      (player) => player.persistentID === clientID,
    );
    if (!existing && this.players.length >= MAX_PLAYERS) {
      await this.publishRoster({
        responseTo: clientID,
        accepted: false,
        rejection: "room_full",
      });
      return;
    }
    if (!existing) {
      this.players = [
        ...this.players,
        { persistentID: clientID, nickname, host: false },
      ];
    }
    this.lastSeen.set(clientID, Date.now());
    this.notifyRoster();
    await this.publishRoster({ responseTo: clientID, accepted: true });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    void this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      if (!this.isHost) {
        if (Date.now() - this.lastHostHeartbeat >= LOBBY_HOST_TIMEOUT_MS) {
          this.onHostLost?.();
          void this.close();
          return;
        }
        void this.sendHeartbeat();
        return;
      }
      const now = Date.now();
      const staleIDs = [...this.lastSeen.entries()]
        .filter(
          ([clientID, lastSeen]) =>
            clientID !== this.clientID &&
            now - lastSeen >= LOBBY_HOST_TIMEOUT_MS,
        )
        .map(([clientID]) => clientID);
      if (staleIDs.length > 0) {
        const stale = new Set(staleIDs);
        this.players = this.players.filter(
          (player) => !stale.has(player.persistentID),
        );
        for (const clientID of staleIDs) this.lastSeen.delete(clientID);
        this.notifyRoster();
        void this.publishRoster();
      }
      void this.sendHeartbeat();
    }, LOBBY_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async sendHeartbeat(): Promise<void> {
    const heartbeat: LobbyHeartbeat = {
      type: "heartbeat",
      roomCode: this.roomCode,
      clientID: this.clientID,
      hostID: this.hostID,
    };
    await this.publish(heartbeat);
  }

  private notifyRoster(): void {
    this.onRoster(this.roster);
  }

  private async publishRoster(
    response: Partial<
      Pick<LobbyRoster, "responseTo" | "accepted" | "rejection">
    > = {},
  ): Promise<void> {
    await this.publish({
      type: "roster",
      roomCode: this.roomCode,
      hostID: this.clientID,
      players: this.roster,
      ...response,
    });
  }

  private async publish(message: LobbyMessage): Promise<void> {
    if (this.closed) return;
    try {
      const result = await this.channel.send({
        type: "broadcast",
        event: LOBBY_BROADCAST_EVENT,
        payload: JSON.stringify(message),
      });
      if (result === "error" || result === "timed out") {
        throw new Error(`Lobby broadcast returned ${result}`);
      }
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.onError?.(normalized);
      throw normalized;
    }
  }
}
