export type SteamTicketFailure =
  | "unavailable"
  | "timeout"
  | "error"
  | "needs-account"
  | "ticket-rejected"
  | "api-unreachable";

export type SteamTicketResult =
  | { ok: true; ticket: string }
  | { ok: false; reason: SteamTicketFailure };

/**
 * The Steam client that used to back the desktop shell.
 *
 * Phase 1 removed the shell (and with it Steam), so there is no ticket to
 * mint and no Steam user to report. Callers keep their shape; the auth paths
 * that consume this are rewritten in Fase 2.
 *
 * TODO Fase 2: delete this facade together with the Steam login flow.
 */
export const steamSDK = {
  isOnSteam: (): boolean => false,
  getTicket: async (): Promise<SteamTicketResult> => ({
    ok: false,
    reason: "unavailable",
  }),
  getUser: async (): Promise<{ steamId: string; name: string } | null> => null,
};
