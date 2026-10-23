// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  composeVersionDisplay,
  desktopLinkGate,
  desktopQuit,
  desktopSteamLocale,
  desktopUpdate,
  desktopVersion,
  getDesktopUpdateState,
  isDesktopShell,
  multiplayerAllowed,
  multiplayerAllowedForSession,
  publishDesktopUpdateState,
  requestDesktopQuit,
  type DesktopUpdateState,
} from "../src/client/DesktopShell";

// Phase 1 removed the desktop (Steam) shell. Every export keeps its shape so
// the call sites that branch on it do not have to change yet, but each one now
// answers the way the open web always did: "no shell, no bridge, no gating".

describe("composeVersionDisplay", () => {
  it("appends the Steam shell version as subtext", () => {
    expect(composeVersionDisplay("v0.33.1", "0.2.0")).toBe(
      "v0.33.1 (Steam v0.2.0)",
    );
  });

  // The web client must be entirely unaffected.
  it("returns the game version unchanged off the desktop shell", () => {
    expect(composeVersionDisplay("v0.33.1", null)).toBe("v0.33.1");
  });

  it("tolerates a shell version that already carries a v prefix", () => {
    expect(composeVersionDisplay("v0.33.1", "v0.2.0")).toBe(
      "v0.33.1 (Steam v0.2.0)",
    );
  });

  it("returns the game version unchanged for a blank shell version", () => {
    expect(composeVersionDisplay("v0.33.1", "")).toBe("v0.33.1");
  });

  it("does not prefix a shell commit with a v", () => {
    expect(composeVersionDisplay("bf739f8", "a1b2c3d")).toBe(
      "bf739f8 (Steam a1b2c3d)",
    );
  });
});

describe("desktop shell detection", () => {
  afterEach(() => {
    window.openfrontDesktop = undefined;
  });

  it("is never the desktop shell, even if the bridge global is present", () => {
    expect(isDesktopShell()).toBe(false);
    window.openfrontDesktop = { version: () => Promise.resolve("0.2.0") };
    expect(isDesktopShell()).toBe(false);
  });

  it("reports no Steam locale", () => {
    window.openfrontDesktop = { steamLocale: "pt-BR" };
    expect(desktopSteamLocale()).toBeNull();
  });

  it("reports no shell version", async () => {
    window.openfrontDesktop = { version: () => Promise.resolve("0.2.0") };
    await expect(desktopVersion()).resolves.toBeNull();
  });
});

describe("desktop update bridge", () => {
  it("is null even if the bridge global is present", () => {
    window.openfrontDesktop = { update: { subscribe: () => () => {} } };
    expect(desktopUpdate()).toBeNull();
  });

  it("has no cached update state, and publishing does not create one", () => {
    const state: DesktopUpdateState = {
      status: "staged",
      bytes: 1,
      total: 2,
    };
    expect(getDesktopUpdateState()).toBeNull();
    expect(() => publishDesktopUpdateState(state)).not.toThrow();
    expect(getDesktopUpdateState()).toBeNull();
  });

  it("never gates multiplayer on an update state", () => {
    for (const status of [
      "checking",
      "current",
      "downloading",
      "staged",
      "blocked",
      "failed",
    ] as const) {
      expect(
        multiplayerAllowed({ status, bytes: 0, total: 0 }),
        status,
      ).toBe(true);
    }
  });

  it("never gates multiplayer on a session state", () => {
    expect(multiplayerAllowedForSession(null)).toBe(true);
    expect(multiplayerAllowedForSession({ status: "signed-out" })).toBe(true);
    expect(
      multiplayerAllowedForSession({
        status: "signed-out",
        reason: "steam-unavailable",
      }),
    ).toBe(true);
  });
});

describe("desktop link gate and quit", () => {
  afterEach(() => {
    window.openfrontDesktop = undefined;
  });

  it("has no link gate, even with a bridge", () => {
    window.openfrontDesktop = { showLinkGate: async () => undefined };
    expect(desktopLinkGate()).toBeNull();
  });

  it("has no quit bridge, even with one", () => {
    window.openfrontDesktop = { quit: async () => undefined };
    expect(desktopQuit()).toBeNull();
  });

  it("requestDesktopQuit is a no-op", () => {
    expect(() => requestDesktopQuit()).not.toThrow();
  });
});
