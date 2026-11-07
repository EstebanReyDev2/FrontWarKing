import {
  Difficulty,
  GameMapSize,
  GameMode,
  GameType,
  type GameMapType,
} from "@openfront/engine-api/game/GameTypes";
import { generateID } from "@openfront/shared/SharedUtil";
import type { WireGameStartInfo } from "@openfront/shared/WireSchemas";

export interface PreviewRosterPlayer {
  persistentID: string;
  nickname: string;
}

export function canStartPreviewGame(isHost: boolean, rosterSize: number) {
  return isHost && rosterSize >= 2;
}

export function createPreviewGameStartInfo(
  map: GameMapType,
  players: readonly PreviewRosterPlayer[],
): WireGameStartInfo {
  const gameID = generateID();
  return {
    gameID,
    lobbyCreatedAt: Date.now(),
    config: {
      gameMap: map,
      gameMapSize: GameMapSize.Normal,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Medium,
      bots: 0,
      nations: "disabled",
      maxPlayers: players.length,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      donateGold: false,
      donateTroops: false,
      randomSpawn: false,
    },
    players: players.map((player) => ({
      clientID: player.persistentID,
      username: player.nickname,
      clanTag: null,
    })),
  };
}
