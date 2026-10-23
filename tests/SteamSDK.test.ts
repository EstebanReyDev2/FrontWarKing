// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { steamSDK } from "../src/client/SteamSDK";

beforeEach(() => {
  delete (window as any).openfrontDesktop;
});

// Phase 1 removed the desktop shell and with it the Steam bridge. The facade
// keeps the auth call shape but never reports a Steam client and never mints a
// ticket, so the Steam login flow simply stays unavailable.
describe("SteamSDK", () => {
  it("isOnSteam is false", () => {
    expect(steamSDK.isOnSteam()).toBe(false);
  });

  it("ignores a bridge global if one is present", () => {
    (window as any).openfrontDesktop = {
      steam: {
        getAuthTicket: async () => ({ ok: true, ticket: "deadbeef" }),
        getUser: async () => ({ steamId: "77", name: "Ada" }),
      },
    };
    expect(steamSDK.isOnSteam()).toBe(false);
  });

  it("reports no ticket as unavailable", async () => {
    await expect(steamSDK.getTicket()).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("reports no Steam user", async () => {
    await expect(steamSDK.getUser()).resolves.toBeNull();
  });
});
