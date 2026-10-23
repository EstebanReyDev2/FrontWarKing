/** A signed-in portal account, as the portals used to report it. */
export interface PortalUser {
  username: string;
  profilePictureUrl: string;
}

export type GamePortalName = "crazygames" | "poki";

/**
 * The web game portal (CrazyGames or Poki) that used to frame us.
 *
 * Phase 1 removed both portal integrations, so every call here is now a
 * no-op and every query answers "not on a portal" -- exactly what these APIs
 * returned on the open web before. The public shape is kept unchanged so the
 * thirty-odd call sites can be cleaned up in a later phase instead of in this
 * one.
 *
 * TODO Fase 2: delete this facade and its call sites together with the
 * GameServer replacement.
 */
export const gamePortal = {
  name: (): GamePortalName | null => null,
  isOnGamePortal: (): boolean => false,
  maybeInit: async (): Promise<void> => {},
  getUsername: async (): Promise<string | null> => null,
  getUserToken: async (): Promise<string | null> => null,
  getUserProfile: async (): Promise<PortalUser | null> => null,
  showAuthPrompt: async (): Promise<void> => {},
  addAuthListener: async (
    _listener: (user: PortalUser | null) => void,
  ): Promise<void> => {},
  isInstantMultiplayer: async (): Promise<boolean> => false,
  gameplayStart: async (): Promise<void> => {},
  gameplayStop: async (): Promise<void> => {},
  happytime: async (): Promise<void> => {},
  loadingStart: (): void => {},
  loadingStop: (): void => {},
  showInviteButton: (_gameId: string): void => {},
  hideInviteButton: (): void => {},
  createInviteLink: async (_gameId: string): Promise<string | null> => null,
  getInviteGameId: async (): Promise<string | null> => null,
  requestMidgameAd: async (): Promise<void> => {},
};
