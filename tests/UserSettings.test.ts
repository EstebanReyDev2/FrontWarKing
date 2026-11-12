// @vitest-environment jsdom
import {
  CROWN_KEY,
  EFFECTS_KEY,
  FAVORITE_EMOJIS_KEY,
  FLAG_KEY,
  PATTERN_KEY,
  PLAYER_STATS_COLUMNS_KEY,
  TEAM_STATS_COLUMNS_KEY,
  USER_SETTINGS_CHANGED_EVENT,
  UserSettings,
  getDefaultKeybinds,
  keysMayBeShared,
} from "../src/client/UserSettings";

// UserSettings keeps a static in-memory cache and the active player id; reset
// both so each test reads fresh from the (cleared) localStorage as logged out.
function resetUserSettingsState() {
  localStorage.clear();
  const statics = UserSettings as unknown as {
    cache: Map<string, string | null>;
    playerId: string | null;
  };
  statics.cache.clear();
  statics.playerId = null;
}

describe("UserSettings effect selection", () => {
  beforeEach(resetUserSettingsState);

  it("sets and reads a per-effectType selection", () => {
    const s = new UserSettings();
    s.setSelectedEffectName("transportShipTrail", "spectrum");
    expect(s.getSelectedEffectName("transportShipTrail")).toBe("spectrum");
  });

  it("returns null when nothing is selected", () => {
    expect(
      new UserSettings().getSelectedEffectName("transportShipTrail"),
    ).toBeNull();
  });

  it("clearing the last selection removes the storage key", () => {
    const s = new UserSettings();
    s.setSelectedEffectName("transportShipTrail", "spectrum");
    s.setSelectedEffectName("transportShipTrail", undefined);
    expect(s.getSelectedEffectName("transportShipTrail")).toBeNull();
    expect(localStorage.getItem(EFFECTS_KEY)).toBeNull();
  });

  it("clearing one effectType leaves other types intact", () => {
    const s = new UserSettings();
    // Seed two types directly (only one real effectType exists today).
    localStorage.setItem(
      EFFECTS_KEY,
      JSON.stringify({ transportShipTrail: "spectrum", future: "x" }),
    );
    s.setSelectedEffectName("transportShipTrail", undefined);
    expect(s.getSelectedEffects()).toEqual({ future: "x" });
  });

  it("returns an empty map for a corrupt blob", () => {
    localStorage.setItem(EFFECTS_KEY, "not json");
    expect(new UserSettings().getSelectedEffects()).toEqual({});
  });

  it("keeps per-nukeType nuke-explosion slots independent", () => {
    const s = new UserSettings();
    s.setSelectedEffectName("atom", "atom_boom");
    s.setSelectedEffectName("hydro", "hydro_boom");
    expect(s.getSelectedEffectName("atom")).toBe("atom_boom");
    expect(s.getSelectedEffectName("hydro")).toBe("hydro_boom");
    // Clearing one bomb's slot leaves the others intact.
    s.setSelectedEffectName("atom", undefined);
    expect(s.getSelectedEffectName("atom")).toBeNull();
    expect(s.getSelectedEffectName("hydro")).toBe("hydro_boom");
  });
});

describe("UserSettings tutorial dismissal", () => {
  beforeEach(resetUserSettingsState);

  it("defaults to not dismissed and persists dismissal", () => {
    const s = new UserSettings();
    expect(s.tutorialDismissed()).toBe(false);

    s.setTutorialDismissed(true);
    expect(s.tutorialDismissed()).toBe(true);
    expect(localStorage.getItem("settings.tutorialDismissed")).toBe("true");

    s.setTutorialDismissed(false);
    expect(s.tutorialDismissed()).toBe(false);
  });
});

describe("UserSettings lobby start alerts", () => {
  beforeEach(resetUserSettingsState);

  it("defaults off and round-trips both choices", () => {
    const settings = new UserSettings();
    expect(settings.lobbyStartAlerts()).toBe(false);

    settings.setLobbyStartAlerts(true);
    expect(settings.lobbyStartAlerts()).toBe(true);
    expect(localStorage.getItem("settings.lobbyStartAlerts")).toBe("true");

    settings.setLobbyStartAlerts(false);
    expect(settings.lobbyStartAlerts()).toBe(false);
    expect(localStorage.getItem("settings.lobbyStartAlerts")).toBe("false");
  });

  it("falls back to off for malformed storage", () => {
    localStorage.setItem("settings.lobbyStartAlerts", "enabled");
    expect(new UserSettings().lobbyStartAlerts()).toBe(false);
  });
});

describe("UserSettings stats columns", () => {
  beforeEach(resetUserSettingsState);

  it("returns defaults when nothing is stored", () => {
    // The player table opens with the clan tag shown; a team has no tag.
    expect(new UserSettings().statsColumns("player")).toEqual([
      "clan",
      "tiles",
      "gold",
      "maxtroops",
    ]);
    expect(new UserSettings().statsColumns("team")).toEqual([
      "tiles",
      "gold",
      "maxtroops",
    ]);
  });

  it("round-trips a selection in registry order", () => {
    const s = new UserSettings();
    // Stored order is check order; getter returns registry (display) order.
    s.setStatsColumns("player", ["warships", "gold"]);
    expect(s.statsColumns("player")).toEqual(["gold", "warships"]);
  });

  it("filters unknown ids", () => {
    localStorage.setItem(
      PLAYER_STATS_COLUMNS_KEY,
      JSON.stringify(["gold", "bogus"]),
    );
    expect(new UserSettings().statsColumns("player")).toEqual(["gold"]);
  });

  it("drops the removed attacks column from persisted selections", () => {
    localStorage.setItem(
      PLAYER_STATS_COLUMNS_KEY,
      JSON.stringify(["attacks", "gold"]),
    );
    expect(new UserSettings().statsColumns("player")).toEqual(["gold"]);
  });

  it("falls back to defaults on corrupt JSON", () => {
    localStorage.setItem(PLAYER_STATS_COLUMNS_KEY, "not json");
    expect(new UserSettings().statsColumns("player")).toEqual([
      "clan",
      "tiles",
      "gold",
      "maxtroops",
    ]);
  });

  it("falls back to defaults when no valid ids remain", () => {
    localStorage.setItem(PLAYER_STATS_COLUMNS_KEY, JSON.stringify(["bogus"]));
    expect(new UserSettings().statsColumns("player")).toEqual([
      "clan",
      "tiles",
      "gold",
      "maxtroops",
    ]);
  });

  it("keeps player and team selections independent", () => {
    const s = new UserSettings();
    s.setStatsColumns("player", ["gold"]);
    s.setStatsColumns("team", ["warships"]);
    expect(s.statsColumns("player")).toEqual(["gold"]);
    expect(s.statsColumns("team")).toEqual(["warships"]);
    expect(localStorage.getItem(TEAM_STATS_COLUMNS_KEY)).toBe('["warships"]');
  });
});

describe("UserSettings per-player cosmetics (#4955)", () => {
  beforeEach(resetUserSettingsState);

  it("stores a logged-in player's selections under publicId-scoped keys", () => {
    UserSettings.setPlayerId("p1");
    const s = new UserSettings();
    s.setSelectedCrownName("golden");
    s.setFlag("flag:premium");
    expect(localStorage.getItem(`${CROWN_KEY}:p1`)).toBe("golden");
    expect(localStorage.getItem(`${FLAG_KEY}:p1`)).toBe("flag:premium");
    expect(localStorage.getItem(CROWN_KEY)).toBeNull();
    expect(localStorage.getItem(FLAG_KEY)).toBeNull();
  });

  it("restores a player's cosmetics after logout and login", () => {
    UserSettings.setPlayerId("p1");
    const s = new UserSettings();
    s.setSelectedCrownName("golden");
    s.setFlag("flag:premium");
    s.setSelectedPatternName("skin:cool");
    s.setSelectedEffectName("transportShipTrail", "spectrum");

    UserSettings.setPlayerId(null); // logout
    expect(s.getSelectedCrownName()).toBeNull();
    expect(s.getFlag()).toBeNull();
    expect(s.getSelectedSkinName()).toBeNull();
    expect(s.getSelectedEffectName("transportShipTrail")).toBeNull();

    UserSettings.setPlayerId("p1"); // login again
    expect(s.getSelectedCrownName()).toBe("golden");
    expect(s.getFlag()).toBe("flag:premium");
    expect(s.getSelectedSkinName()).toBe("cool");
    expect(s.getSelectedEffectName("transportShipTrail")).toBe("spectrum");
  });

  it("keeps different players' selections separate", () => {
    UserSettings.setPlayerId("p1");
    const s = new UserSettings();
    s.setSelectedCrownName("golden");

    UserSettings.setPlayerId(null);
    UserSettings.setPlayerId("p2");
    expect(s.getSelectedCrownName()).toBeNull();
    s.setSelectedCrownName("silver");

    UserSettings.setPlayerId(null);
    UserSettings.setPlayerId("p1");
    expect(s.getSelectedCrownName()).toBe("golden");
  });

  it("adopts pre-existing bare-key selections on login (legacy migration)", () => {
    // Builds that predate per-player keying wrote selections to bare keys.
    localStorage.setItem(CROWN_KEY, "golden");
    localStorage.setItem(FLAG_KEY, "flag:premium");
    localStorage.setItem(PATTERN_KEY, "skin:cool");
    localStorage.setItem(
      EFFECTS_KEY,
      JSON.stringify({ transportShipTrail: "spectrum" }),
    );

    UserSettings.setPlayerId("p1");
    const s = new UserSettings();
    expect(s.getSelectedCrownName()).toBe("golden");
    expect(s.getFlag()).toBe("flag:premium");
    expect(s.getSelectedSkinName()).toBe("cool");
    expect(s.getSelectedEffectName("transportShipTrail")).toBe("spectrum");

    // Moved, not copied: the logged-out scope no longer has them.
    UserSettings.setPlayerId(null);
    expect(s.getSelectedCrownName()).toBeNull();
    expect(localStorage.getItem(CROWN_KEY)).toBeNull();
  });

  it("a selection made while logged out wins over the stored one on login", () => {
    UserSettings.setPlayerId("p1");
    const s = new UserSettings();
    s.setSelectedCrownName("golden");

    UserSettings.setPlayerId(null);
    // e.g. picked (or purchased via #purchase-completed) before logging in
    s.setSelectedCrownName("silver");

    UserSettings.setPlayerId("p1");
    expect(s.getSelectedCrownName()).toBe("silver");
  });

  it("emits change events under the base key when the player changes", () => {
    const events: (string | null)[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener(
      `${USER_SETTINGS_CHANGED_EVENT}:${CROWN_KEY}`,
      listener,
    );
    try {
      UserSettings.setPlayerId("p1"); // nothing stored yet
      new UserSettings().setSelectedCrownName("golden");
      UserSettings.setPlayerId(null); // logout: guest scope is empty
      UserSettings.setPlayerId("p1"); // login: selection restored
      expect(events).toEqual([null, "golden", null, "golden"]);
    } finally {
      window.removeEventListener(
        `${USER_SETTINGS_CHANGED_EVENT}:${CROWN_KEY}`,
        listener,
      );
    }
  });

  it("does not scope non-cosmetic settings", () => {
    UserSettings.setPlayerId("p1");
    const s = new UserSettings();
    s.setAttackRatio(0.5);
    UserSettings.setPlayerId(null);
    expect(s.attackRatio()).toBe(0.5);
  });

  it("returns default nukeAllianceSafetyDuration of 5 and persists updates", () => {
    const s = new UserSettings();
    expect(s.nukeAllianceSafetyDuration()).toBe(5);

    s.setNukeAllianceSafetyDuration(15);
    expect(s.nukeAllianceSafetyDuration()).toBe(15);

    const s2 = new UserSettings();
    expect(s2.nukeAllianceSafetyDuration()).toBe(15);
  });

  it("clamps values to 0..30 in setNukeAllianceSafetyDuration", () => {
    const s = new UserSettings();
    s.setNukeAllianceSafetyDuration(-5);
    expect(s.nukeAllianceSafetyDuration()).toBe(0);

    s.setNukeAllianceSafetyDuration(45);
    expect(s.nukeAllianceSafetyDuration()).toBe(30);

    s.setNukeAllianceSafetyDuration(12.6);
    expect(s.nukeAllianceSafetyDuration()).toBe(13);
  });

  it("falls back to default 5 for malformed or out-of-range persisted values", () => {
    const s = new UserSettings();
    const invalidValues = [
      "Infinity",
      "-Infinity",
      "NaN",
      "invalid",
      "5.5",
      "-1",
      "31",
      "100",
      "",
    ];

    for (const invalid of invalidValues) {
      localStorage.setItem("settings.nukeAllianceSafetyDuration", invalid);
      const statics = UserSettings as unknown as {
        cache: Map<string, string | null>;
      };
      statics.cache.clear();

      expect(s.nukeAllianceSafetyDuration()).toBe(5);
    }
  });
});

describe("getDefaultKeybinds", () => {
  it("returns all essential keybindings for Windows/Linux", () => {
    const keybinds = getDefaultKeybinds(false);
    expect(keybinds.boxSelectWarships).toBe("ShiftLeft");
    expect(keybinds.resetGfx).toBe("KeyR");
    expect(keybinds.selectAllWarships).toBe("KeyX");
    expect(keybinds.emojiMenu).toBe("KeyF");
    expect(keybinds.quickChat).toBe("KeyR");
    expect(keybinds.targetPlayer).toBe("KeyN");
    expect(keybinds.buildMenuModifier).toBe("ControlLeft");
    expect(keybinds.moveUpArrow).toBe("ArrowUp");
    expect(keybinds.moveLeftArrow).toBe("ArrowLeft");
    expect(keybinds.moveDownArrow).toBe("ArrowDown");
    expect(keybinds.moveRightArrow).toBe("ArrowRight");
    expect(keybinds.zoomOutMinus).toBe("Minus");
    expect(keybinds.zoomOutNumpad).toBe("NumpadSubtract");
    expect(keybinds.zoomInEqual).toBe("Equal");
    expect(keybinds.zoomInNumpad).toBe("NumpadAdd");
  });

  it("never gives two actions the same letter key, except shared pairs", () => {
    const binds = Object.entries(getDefaultKeybinds(false)).filter(([, k]) =>
      /^Key[A-Z]$/.test(k),
    );
    for (const [a, keyA] of binds) {
      for (const [b, keyB] of binds) {
        if (a !== b && keyA === keyB) {
          expect(keysMayBeShared(a, b), `${a} and ${b}`).toBe(true);
        }
      }
    }
  });

  it("handles Mac-specific modifier keys correctly", () => {
    const macKeybinds = getDefaultKeybinds(true);
    expect(macKeybinds.buildMenuModifier).toBe("MetaLeft");
  });
});

describe("UserSettings audio volumes", () => {
  beforeEach(resetUserSettingsState);

  // The rest of the audio settings surface is covered by the branch's own
  // tests/UserSettings.audio.test.ts; only clamping on read is new here.
  it("clamps an out-of-range legacy value on read", () => {
    // setAudioVolume clamps, but the legacy keys it reads through to were
    // never bounded, and the tab renders 0-100.
    localStorage.setItem("settings.soundEffectsVolume", "1.5");
    expect(new UserSettings().audioVolume("effects")).toBe(1);

    localStorage.setItem("settings.backgroundMusicVolume", "-1");
    expect(new UserSettings().audioVolume("music")).toBe(0);
  });
});

describe("UserSettings replay viewer", () => {
  beforeEach(resetUserSettingsState);

  it("is off by default, and remembers being turned on", () => {
    expect(new UserSettings().replayViewer()).toBe(false);
    new UserSettings().setReplayViewer(true);
    expect(new UserSettings().replayViewer()).toBe(true);
    new UserSettings().setReplayViewer(false);
    expect(new UserSettings().replayViewer()).toBe(false);
  });
});

describe("UserSettings favorite emojis", () => {
  beforeEach(resetUserSettingsState);

  it("has no favorites by default", () => {
    expect(new UserSettings().favoriteEmojis()).toEqual([]);
  });

  it("round-trips slots, keeping empty ones in place", () => {
    new UserSettings().setFavoriteEmojis(["👍", null, "💀"]);
    expect(new UserSettings().favoriteEmojis()).toEqual(["👍", null, "💀"]);
  });

  it("reads unknown emojis as empty slots and corrupt storage as none", () => {
    localStorage.setItem(FAVORITE_EMOJIS_KEY, JSON.stringify(["🍕", "👍"]));
    expect(new UserSettings().favoriteEmojis()).toEqual([null, "👍"]);

    resetUserSettingsState();
    localStorage.setItem(FAVORITE_EMOJIS_KEY, "not json");
    expect(new UserSettings().favoriteEmojis()).toEqual([]);
  });
});

describe("UserSettings keybinds with new defaults", () => {
  beforeEach(resetUserSettingsState);

  const store = (binds: Record<string, unknown>) =>
    localStorage.setItem("settings.keybinds", JSON.stringify(binds));

  it("unbinds a default that lands on a key the player already uses", () => {
    store({ boatAttack: { value: "KeyX", key: "x" } });
    const keybinds = new UserSettings().keybinds(false);

    expect(keybinds.boatAttack).toBe("KeyX");
    expect(keybinds.selectAllWarships).toBeUndefined();
    // Saved as unbound, so the settings modal shows it that way too.
    expect(new UserSettings().parsedUserKeybinds().selectAllWarships).toEqual({
      value: "Null",
      key: "",
    });
  });

  it("keeps a player's own F for select-all-warships over the emoji menu", () => {
    store({ selectAllWarships: { value: "KeyF", key: "f" } });
    const keybinds = new UserSettings().keybinds(false);

    expect(keybinds.selectAllWarships).toBe("KeyF");
    expect(keybinds.emojiMenu).toBeUndefined();
  });

  it("leaves defaults alone when nothing clashes", () => {
    store({ boatAttack: { value: "KeyH", key: "h" } });
    const keybinds = new UserSettings().keybinds(false);

    expect(keybinds.emojiMenu).toBe("KeyF");
    expect(keybinds.selectAllWarships).toBe("KeyX");
    expect(
      new UserSettings().parsedUserKeybinds().selectAllWarships,
    ).toBeUndefined();
  });

  it("unbinds the new arrow and zoom defaults when saved bindings already use their keys", () => {
    store({
      boatAttack: { value: "ArrowUp", key: "ArrowUp" },
      attackRatioUp: { value: "Equal", key: "=" },
    });
    const settings = new UserSettings();
    const keybinds = settings.keybinds(false);

    expect(keybinds.boatAttack).toBe("ArrowUp");
    expect(keybinds.moveUpArrow).toBeUndefined();
    expect(keybinds.attackRatioUp).toBe("Equal");
    expect(keybinds.zoomInEqual).toBeUndefined();
    expect(settings.parsedUserKeybinds().moveUpArrow).toEqual({
      value: "Null",
      key: "",
    });
    expect(settings.parsedUserKeybinds().zoomInEqual).toEqual({
      value: "Null",
      key: "",
    });
  });

  it("keeps quick chat on R when the player saved reset graphics there", () => {
    store({ resetGfx: { value: "KeyR", key: "r" } });
    const keybinds = new UserSettings().keybinds(false);

    expect(keybinds.resetGfx).toBe("KeyR");
    expect(keybinds.quickChat).toBe("KeyR");
  });

  it("lets modifier keys stay shared", () => {
    store({ altKey: { value: "AltLeft", key: "Alt" } });
    expect(new UserSettings().keybinds(false).emojiMenuModifier).toBe(
      "AltLeft",
    );
  });
});
