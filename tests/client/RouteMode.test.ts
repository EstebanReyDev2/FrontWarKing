import { describe, expect, it } from "vitest";
import { isPreviewRoute, isRealtimeDevRoute } from "../../src/client/RouteMode";

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
});
