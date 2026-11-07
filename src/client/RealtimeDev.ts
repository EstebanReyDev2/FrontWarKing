import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { generateID } from "@openfront/shared/SharedUtil";
import type { WireGameStartInfo } from "@openfront/shared/WireSchemas";
import type { JoinLobbyEvent } from "./Main";
import { supabaseRealtimeConfig } from "./netcode/SupabaseConfig";

/**
 * Minimal development entry point for the Phase 2 realtime transport.
 *
 * The real lobby lands in Block 3. This page only exists so two tabs can create
 * and join a room by code and exercise RealtimeSession end to end:
 *
 *   http://localhost:3000/?realtime-dev
 *
 * The host publishes the room code in its own URL. The peer opens that URL and
 * joins. No server route, auth flow or lobby record is involved.
 */
export function mountRealtimeDev(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("realtime-dev")) return false;

  const config = supabaseRealtimeConfig();
  const room = params.get("room")?.trim() ?? "";
  const isHost = room === "";
  const hostID = isHost ? generateID() : room;
  const clientID = isHost ? hostID : generateID();

  const panel = document.createElement("div");
  panel.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "width:min(360px,calc(100vw - 32px))",
    "padding:12px",
    "border:1px solid #6b7280",
    "border-radius:8px",
    "background:#111827",
    "color:#f9fafb",
    "font:13px/1.4 system-ui,sans-serif",
    "box-shadow:0 8px 24px rgba(0,0,0,.35)",
  ].join(";");

  const title = document.createElement("strong");
  title.textContent = isHost ? "Realtime dev: host" : "Realtime dev: join";
  title.style.display = "block";
  title.style.marginBottom = "8px";
  panel.append(title);

  if (config === null) {
    const warning = document.createElement("p");
    warning.textContent =
      "Falta VITE_SUPABASE_URL o VITE_SUPABASE_PUBLISHABLE_KEY en .env.local.";
    warning.style.color = "#fca5a5";
    panel.append(warning);
    document.body.append(panel);
    return true;
  }

  if (isHost) {
    const code = document.createElement("p");
    code.textContent = `Room: ${hostID}`;
    code.style.margin = "0 0 8px";
    panel.append(code);

    const link = document.createElement("a");
    const url = new URL(window.location.href);
    url.searchParams.set("room", hostID);
    link.href = url.toString();
    link.textContent = "Link para la segunda pestaña";
    link.style.color = "#93c5fd";
    link.style.display = "block";
    link.style.marginBottom = "8px";
    panel.append(link);

    const start = document.createElement("button");
    start.textContent = "Crear sala";
    start.style.width = "100%";
    start.addEventListener("click", () => {
      start.disabled = true;
      panel.style.display = "none";
      window.history.replaceState(null, "", url.toString());
      dispatchJoin({
        gameID: hostID,
        gameStartInfo: hostStartInfo(hostID),
        realtime: {
          clientID,
          hostID,
          allowGeneralHello: true,
        },
      });
    });
    panel.append(start);
  } else {
    const input = document.createElement("input");
    input.value = room;
    input.readOnly = true;
    input.style.cssText =
      "width:100%;box-sizing:border-box;margin-bottom:8px;padding:6px;background:#1f2937;color:#f9fafb;border:1px solid #4b5563;border-radius:4px";
    panel.append(input);

    const join = document.createElement("button");
    join.textContent = "Unirse a la sala";
    join.style.width = "100%";
    join.addEventListener("click", () => {
      join.disabled = true;
      dispatchJoin({
        gameID: room,
        realtime: {
          clientID,
          hostID,
          allowGeneralHello: true,
        },
      });
    });
    panel.append(join);
  }

  document.body.append(panel);
  return true;
}

function dispatchJoin(detail: JoinLobbyEvent): void {
  document.dispatchEvent(
    new CustomEvent<JoinLobbyEvent>("join-lobby", {
      detail: { ...detail, source: "private" },
    }),
  );
}

function hostStartInfo(hostID: string): WireGameStartInfo {
  return {
    gameID: hostID,
    lobbyCreatedAt: Date.now(),
    config: {
      gameMap: GameMapType.World,
      gameMapSize: GameMapSize.Compact,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
      bots: 0,
      nations: "disabled",
      maxPlayers: 2,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      donateGold: false,
      donateTroops: false,
      randomSpawn: false,
    },
    players: [
      {
        clientID: hostID,
        username: "Host",
        clanTag: null,
      },
    ],
  };
}
