import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserMe } from "../../src/client/Api";
import {
  cosmeticsJsonUrl,
  fetchCosmetics,
  getCachedCosmetics,
  getPlayerCosmetics,
  getPlayerCosmeticsRefs,
  invalidateCosmetics,
} from "../../src/client/Cosmetics";
import { UserSettings } from "../../src/client/UserSettings";

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  // Resolving the real API base needs runtime config this test does not boot.
  getApiBase: () => "https://api.test",
  getUserMe: vi.fn(),
}));

// A catalog small enough to read at a glance but shaped like the real one.
const catalog = {
  patterns: {
    stripes: {
      name: "stripes",
      pattern: "AAAAAA",
      product: null,
      rarity: "rare",
    },
  },
  colorPalettes: {
    fire: {
      name: "fire",
      primaryColor: "#ff0000",
      secondaryColor: "#ffff00",
    },
  },
  flags: {
    donator: {
      name: "donator",
      url: "https://cdn.test/flags/donator.svg",
      product: null,
      rarity: "rare",
    },
  },
  skins: {
    cool: {
      name: "cool",
      url: "https://cdn.test/skins/cool.png",
      product: null,
      rarity: "rare",
    },
  },
  crowns: {
    golden: {
      name: "golden",
      url: "https://cdn.test/crowns/golden.png",
      product: null,
      rarity: "rare",
    },
  },
  effects: {
    transportShipTrail: {
      spectrum: {
        name: "spectrum",
        effectType: "transportShipTrail",
        url: "https://cdn.test/trails/spectrum.png",
        product: null,
        rarity: "rare",
        attributes: {
          type: "gradient",
          colors: ["#ffffff"],
          colorSize: 1,
          movementSpeed: 1,
        },
      },
    },
  },
};

function userWithFlares(flares: string[]): UserMeResponse {
  return {
    player: { publicId: "player-1", flares },
  } as unknown as UserMeResponse;
}

// UserSettings memoises reads in a static cache, so clearing localStorage
// alone leaves the previous test's values visible.
function resetSettings(): void {
  UserSettings.setPlayerId(null);
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
}

function stubCatalogFetch() {
  const fetchMock = vi.fn(
    async (_input: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => catalog,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Cosmetics characterization", () => {
  beforeEach(() => {
    invalidateCosmetics();
    resetSettings();
    vi.mocked(getUserMe).mockResolvedValue(
      userWithFlares([
        "pattern:stripes:fire",
        "flag:donator",
        "skin:cool",
        "crown:golden",
        "effect:spectrum",
      ]),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    invalidateCosmetics();
    resetSettings();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("has no cached catalog before the first successful fetch", () => {
    expect(getCachedCosmetics()).toBeNull();
  });

  it("fetches the web listing once and keeps it in the sync cache", async () => {
    const fetchMock = stubCatalogFetch();

    expect(cosmeticsJsonUrl()).toBe(
      "https://api.test/cosmetics.json?rail=web",
    );

    const first = await fetchCosmetics();
    const second = await fetchCosmetics();

    expect(first).toEqual(catalog);
    expect(second).toBe(first);
    expect(getCachedCosmetics()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.test/cosmetics.json?rail=web",
    );

    // Invalidation only drops the in-flight promise; the synchronous cache
    // keeps the last catalog until a later fetch replaces it.
    invalidateCosmetics();
    expect(getCachedCosmetics()).toBe(first);
  });

  it("returns the selected refs that the profile is entitled to", async () => {
    stubCatalogFetch();
    const settings = new UserSettings();
    settings.setSelectedPatternName("pattern:stripes:fire");
    settings.setFlag("flag:donator");
    settings.setSelectedCrownName("golden");
    settings.setSelectedEffectName("transportShipTrail", "spectrum");

    const refs = await getPlayerCosmeticsRefs({ verified: true });

    expect(refs).toEqual({
      flag: "flag:donator",
      patternName: "stripes",
      patternColorPaletteName: "fire",
      skinName: undefined,
      crownName: "golden",
      effects: { transportShipTrail: "spectrum" },
      verified: true,
    });
  });

  it("drops and clears a saved skin that the catalog no longer lists", async () => {
    stubCatalogFetch();
    const settings = new UserSettings();
    settings.setSelectedPatternName("skin:missing");

    const refs = await getPlayerCosmeticsRefs();

    expect(refs.skinName).toBeUndefined();
    expect(new UserSettings().getSelectedSkinName()).toBeNull();
  });

  it("expands refs into the full PlayerCosmetics payload", async () => {
    stubCatalogFetch();
    const settings = new UserSettings();
    settings.setSelectedPatternName("pattern:stripes:fire");
    settings.setFlag("flag:donator");
    settings.setSelectedCrownName("golden");
    settings.setSelectedEffectName("transportShipTrail", "spectrum");

    const cosmetics = await getPlayerCosmetics({ verified: true });

    expect(cosmetics).toEqual({
      flag: "https://cdn.test/flags/donator.svg",
      pattern: {
        name: "stripes",
        patternData: "AAAAAA",
        colorPalette: {
          name: "fire",
          primaryColor: "#ff0000",
          secondaryColor: "#ffff00",
        },
      },
      crown: {
        name: "golden",
        url: "https://cdn.test/crowns/golden.png",
      },
      effects: {
        transportShipTrail: {
          name: "spectrum",
          effectType: "transportShipTrail",
        },
      },
      verified: true,
    });
  });
});
