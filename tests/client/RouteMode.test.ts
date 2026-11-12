import { describe, expect, it } from "vitest";
import {
  isPixelDevRoute,
  isPreviewRoute,
  isRealtimeDevRoute,
  shouldLoadInitialAuth,
  shouldLoadTurnstile,
  shouldStartLegacyLobbyFeed,
} from "../../src/client/RouteMode";

describe("route mode query parsing", () => {
  it.each([
    ["", false, false],
    ["?lobby-preview", true, false],
    ["?realtime-dev", false, true],
    ["?realtime-dev&room=X", false, true],
    ["?lobby-preview&foo=bar", true, false],
  ])("parses %s", (search, preview, realtimeDev) => {
    expect(isPreviewRoute(search)).toBe(preview);
    expect(isRealtimeDevRoute(search)).toBe(realtimeDev);
  });

  it("keeps legacy services off preview and realtime-dev, but preserves realtime-dev auth", () => {
    expect(shouldStartLegacyLobbyFeed("?lobby-preview")).toBe(false);
    expect(shouldStartLegacyLobbyFeed("?realtime-dev&room=X")).toBe(false);
    expect(shouldStartLegacyLobbyFeed("?pixel-dev")).toBe(false);
    expect(shouldLoadInitialAuth("?lobby-preview")).toBe(false);
    expect(shouldLoadInitialAuth("?realtime-dev")).toBe(true);
    expect(shouldLoadInitialAuth("?pixel-dev")).toBe(false);
    expect(shouldLoadTurnstile("?lobby-preview")).toBe(false);
    expect(shouldLoadTurnstile("?realtime-dev")).toBe(false);
    expect(shouldLoadTurnstile("?pixel-dev")).toBe(false);
    expect(shouldStartLegacyLobbyFeed("")).toBe(true);
    expect(shouldLoadInitialAuth("")).toBe(true);
    expect(shouldLoadTurnstile("")).toBe(true);
  });

  it("detects the pixel-dev route without matching ?pixel", () => {
    expect(isPixelDevRoute("?pixel-dev")).toBe(true);
    expect(isPixelDevRoute("?pixel-dev&x=1")).toBe(true);
    expect(isPixelDevRoute("?pixel=off")).toBe(false);
    expect(isPixelDevRoute("")).toBe(false);
  });
});
