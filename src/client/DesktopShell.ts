// The Electron desktop (Steam) shell exposes this global via a contextBridge
// preload script. Phase 1 removed the shell, so nothing sets it any more; the
// declaration stays because tests and the session-recovery path still type
// against it (see DesktopSessionRecovery.ts, deferred to Fase 2).
declare global {
  interface Window {
    openfrontDesktop?: unknown;
  }
}

/**
 * The desktop (Steam) shell no longer exists in this build: every caller that
 * used to branch on it now takes the web path, which is what the open web
 * already did. The function stays so those call sites do not have to change
 * in this phase.
 *
 * TODO Fase 2: remove this facade and the dead branches it keeps alive.
 */
export function isDesktopShell(): boolean {
  return false;
}

/** The locale Steam reported, or null when there was none. Always null now. */
export function desktopSteamLocale(): string | null {
  return null;
}

/** The shell's own version. Always null now, so callers fall back. */
export function desktopVersion(): Promise<string | null> {
  return Promise.resolve(null);
}

/**
 * Composes the version label shown in the nav bar. On the web the shell
 * version is always null, so this returns the game version unchanged; the
 * composition rule stays so the label keeps a single implementation.
 */
export function composeVersionDisplay(
  gameVersion: string,
  shellVersion: string | null,
): string {
  if (!shellVersion) return gameVersion;
  const trimmed = shellVersion.trim();
  if (trimmed === "") return gameVersion;
  const withV = /^\d+\.\d+\.\d+/.test(trimmed) ? `v${trimmed}` : trimmed;
  return `${gameVersion} (Steam ${withV})`;
}

export type DesktopUpdateStatus =
  | "checking"
  | "current"
  | "downloading"
  | "staged"
  | "blocked"
  | "failed";

export type DesktopUpdateErrorKind = "network" | "refused" | "verify" | "parse";

/**
 * A `kind` as it actually arrived over IPC. Kept permissive because it is the
 * shape of data from a different process, even though no shell ships any more.
 */
export type DesktopUpdateErrorKindWire = DesktopUpdateErrorKind | (string & {});

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  bytes: number;
  total: number;
  error?: { kind: DesktopUpdateErrorKindWire; message: string };
}

export interface DesktopUpdateBridge {
  subscribe: (cb: (state: DesktopUpdateState) => void) => () => void;
  apply: () => Promise<void>;
  retry: () => Promise<void>;
  setInGame?: (inGame: boolean) => Promise<void>;
}

/** The shell's runtime-update bridge. Always null now. */
export function desktopUpdate(): DesktopUpdateBridge | null {
  return null;
}

/** The shell's last published update state. Always null now. */
export function getDesktopUpdateState(): DesktopUpdateState | null {
  return null;
}

/** No shell publishes update state any more, so there is nothing to cache. */
export function publishDesktopUpdateState(_state: DesktopUpdateState): void {}

/**
 * Whether multiplayer is allowed in a given update state. Without a shell
 * there is nothing to update and nothing to gate, so this is always true --
 * which is what it answered on the open web.
 */
export function multiplayerAllowed(_state: DesktopUpdateState): boolean {
  return true;
}

export type DesktopSessionStatus =
  | "unknown"
  | "signed-in"
  | "retrying"
  | "signed-out";

export type SessionFailureKind =
  | "steam-unavailable"
  | "steam-wedged"
  | "steam-error"
  | "steam-ticket-rejected"
  | "steam-backend"
  | "network"
  | "needs-account";

export interface DesktopSessionState {
  status: DesktopSessionStatus;
  reason?: SessionFailureKind;
}

/**
 * Whether multiplayer is allowed in a given session state. On the web a
 * logged-out player passes Turnstile normally, so this is always true.
 */
export function multiplayerAllowedForSession(
  _state: DesktopSessionState | null,
): boolean {
  return true;
}

export interface DesktopLinkGateBridge {
  showLinkGate: () => Promise<void>;
}

/** The shell's account-linking gate. Always null now. */
export function desktopLinkGate(): DesktopLinkGateBridge | null {
  return null;
}

export interface DesktopQuitBridge {
  quit: () => Promise<void>;
}

/** The shell's in-app exit. Always null now. */
export function desktopQuit(): DesktopQuitBridge | null {
  return null;
}

/** Asks the shell to quit. Without a shell there is nobody to ask. */
export function requestDesktopQuit(): void {}
