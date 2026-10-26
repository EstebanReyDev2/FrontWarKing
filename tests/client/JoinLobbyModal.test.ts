import { render } from "lit";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const alertMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  play: vi.fn(),
}));

vi.mock("howler", () => ({
  Howl: class {
    constructor(options: unknown) {
      alertMocks.construct(options);
    }

    play() {
      return alertMocks.play();
    }
  },
}));

import {
  Difficulty,
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { ClientEnv } from "../../src/client/ClientEnv";
import { JoinLobbyModal } from "../../src/client/JoinLobbyModal";
import { UserSettings } from "../../src/client/UserSettings";

function resetUserSettingsState() {
  localStorage.clear();
  const statics = UserSettings as unknown as {
    cache: Map<string, string | null>;
    playerId: string | null;
  };
  statics.cache.clear();
  statics.playerId = null;
}

describe("JoinLobbyModal lobby start alert default", () => {
  beforeEach(() => {
    resetUserSettingsState();
    alertMocks.construct.mockReset();
    alertMocks.play.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function trackingModal() {
    const modal = new JoinLobbyModal();
    (modal as any).startLobbyUpdates = vi.fn();
    return modal;
  }

  function bellButton(modal: JoinLobbyModal): HTMLButtonElement {
    const container = document.createElement("div");
    render((modal as any).gameStartAlert.renderBell(), container);
    return container.querySelector("button")!;
  }

  function showMessageEvents(spy: MockInstance<Window["dispatchEvent"]>) {
    return spy.mock.calls.filter(([event]) => event.type === "show-message");
  }

  it("keeps the existing off default without preloading", () => {
    const modal = trackingModal();

    (modal as any).startTrackingLobby("first");

    expect(bellButton(modal).getAttribute("aria-pressed")).toBe("false");
    expect(alertMocks.construct).not.toHaveBeenCalled();
  });

  it("auto-arms and preloads without showing the manual-arm toast", () => {
    new UserSettings().setLobbyStartAlerts(true);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const modal = trackingModal();

    (modal as any).startTrackingLobby("first");

    expect(bellButton(modal).getAttribute("aria-pressed")).toBe("true");
    expect(alertMocks.construct).toHaveBeenCalledOnce();
    expect(showMessageEvents(dispatchSpy)).toHaveLength(0);
  });

  it("keeps bell overrides local to one lobby", () => {
    new UserSettings().setLobbyStartAlerts(true);
    const modal = trackingModal();
    (modal as any).startTrackingLobby("first");

    bellButton(modal).click();
    expect(bellButton(modal).getAttribute("aria-pressed")).toBe("false");
    expect(new UserSettings().lobbyStartAlerts()).toBe(true);

    (modal as any).startTrackingLobby("second");
    expect(bellButton(modal).getAttribute("aria-pressed")).toBe("true");
  });

  it("still plays the chime when notification permission is denied", () => {
    new UserSettings().setLobbyStartAlerts(true);
    const modal = trackingModal();
    (modal as any).startTrackingLobby("first");
    (modal as any).currentLobbyId = "first";
    vi.stubGlobal("Notification", { permission: "denied" });

    (modal as any).gameStartAlert.handleGameStarting();

    expect(alertMocks.play).toHaveBeenCalledOnce();
  });
});

describe("JoinLobbyModal server time offset", () => {
  let nowMs = 0;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates serverTimeOffset from lobby serverTime", () => {
    const modal = new JoinLobbyModal();
    (modal as any).syncCountdownTimer = vi.fn();

    nowMs = 220_000;
    (modal as any).updateFromLobby({
      gameID: "g1",
      serverTime: 200_000,
      startsAt: 230_000,
      clients: [],
    });

    expect((modal as any).serverTimeOffset).toBe(-20_000);
    expect((modal as any).lobbyStartAt).toBe(230_000);
  });

  it("does not trigger join timeout early when local clock is ahead", () => {
    const modal = new JoinLobbyModal();
    const closeSpy = vi
      .spyOn(modal, "closeAndLeave")
      .mockImplementation(() => undefined);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    (modal as any).isModalOpen = true;
    (modal as any).isConnecting = true;
    (modal as any).handledJoinTimeout = false;

    // Local clock is +60s ahead of server clock.
    nowMs = 160_000;
    (modal as any).lobbyStartAt = 105_000;
    (modal as any).serverTimeOffset = -60_000;

    (modal as any).checkForJoinTimeout();

    expect(closeSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect((modal as any).handledJoinTimeout).toBe(false);
  });

  it("triggers join timeout once adjusted server time reaches lobbyStartAt", () => {
    const modal = new JoinLobbyModal();
    const closeSpy = vi
      .spyOn(modal, "closeAndLeave")
      .mockImplementation(() => undefined);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    (modal as any).isModalOpen = true;
    (modal as any).isConnecting = true;
    (modal as any).handledJoinTimeout = false;
    (modal as any).lobbyStartAt = 105_000;
    (modal as any).serverTimeOffset = -60_000;

    nowMs = 165_000;
    (modal as any).checkForJoinTimeout();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((modal as any).handledJoinTimeout).toBe(true);
  });
});

describe("JoinLobbyModal spectate link", () => {
  // A spectate URL is the same lobby link with ?spectate: it must reach the
  // server as a spectator join, and fall through to the archive once the game
  // is over exactly as the play link does.
  const modalWith = (exists: boolean, archived: string) => {
    const modal = new JoinLobbyModal();
    (modal as any).startTrackingLobby = vi.fn();
    (modal as any).resetTrackingState = vi.fn();
    (modal as any).showMessage = vi.fn();
    (modal as any).checkActiveLobby = vi.fn().mockResolvedValue(exists);
    (modal as any).checkArchivedGame = vi.fn().mockResolvedValue(archived);
    return modal;
  };

  it("joins a live lobby as a spectator", async () => {
    const modal = modalWith(true, "not_found");
    await (modal as any).handleUrlJoin("AbCd1234", true);
    expect((modal as any).checkActiveLobby).toHaveBeenCalledWith(
      "AbCd1234",
      true,
    );
    expect((modal as any).checkArchivedGame).not.toHaveBeenCalled();
  });

  it("joins as a player without the flag", async () => {
    const modal = modalWith(true, "not_found");
    await (modal as any).handleUrlJoin("AbCd1234");
    expect((modal as any).checkActiveLobby).toHaveBeenCalledWith(
      "AbCd1234",
      false,
    );
  });

  it("becomes the replay once the game is over", async () => {
    const modal = modalWith(false, "success");
    await (modal as any).handleUrlJoin("AbCd1234", true);
    expect((modal as any).checkArchivedGame).toHaveBeenCalledWith("AbCd1234");
    expect((modal as any).showMessage).not.toHaveBeenCalled();
  });
});

describe("JoinLobbyModal header copy button", () => {
  function renderHeader(modal: JoinLobbyModal): HTMLElement {
    const container = document.createElement("div");
    render(
      (
        modal as unknown as { renderHeaderSlot(): unknown }
      ).renderHeaderSlot() as never,
      container,
    );
    return container;
  }

  function lobbyModal(config: {
    gameType: GameType;
    gameMode: GameMode;
  }): JoinLobbyModal {
    const modal = new JoinLobbyModal();
    (modal as unknown as { currentLobbyId: string }).currentLobbyId =
      "ABCD1234";
    (modal as unknown as { gameConfig: unknown }).gameConfig = config;
    return modal;
  }

  it("shows the copy button in a public team lobby", () => {
    const modal = lobbyModal({
      gameType: GameType.Public,
      gameMode: GameMode.Team,
    });

    const copy = renderHeader(modal).querySelector("copy-button") as
      | (HTMLElement & { lobbyId?: string })
      | null;

    expect(copy?.lobbyId).toBe("ABCD1234");
  });

  it("hides the copy button in a public FFA lobby", () => {
    const modal = lobbyModal({
      gameType: GameType.Public,
      gameMode: GameMode.FFA,
    });

    expect(renderHeader(modal).querySelector("copy-button")).toBeNull();
  });
});

describe("JoinLobbyModal map preview", () => {
  const PREVIEW = "[data-test-map-preview]";
  const SETTINGS = "[data-test-lobby-settings]";

  function renderConfig(config: Record<string, unknown>): HTMLElement {
    const modal = new JoinLobbyModal();
    (modal as unknown as { gameConfig: unknown }).gameConfig = {
      gameMap: GameMapType.World,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      difficulty: Difficulty.Easy,
      disabledUnits: [],
      ...config,
    };
    const container = document.createElement("div");
    render(
      (
        modal as unknown as { renderGameConfig(): unknown }
      ).renderGameConfig() as never,
      container,
    );
    return container;
  }

  it("shows the thumbnail of the lobby's map", () => {
    const image = renderConfig({
      gameMap: GameMapType.Africa,
    }).querySelector<HTMLImageElement>(`${PREVIEW} img`);

    expect(image?.getAttribute("src")).toContain("maps/africa/thumbnail.webp");
  });

  // The preview used to be an 80px square with object-cover, which cropped
  // every non-square map (World showed only its central half). It must show
  // the whole map, so it scales to fit instead of filling a fixed box.
  it("fits the whole map instead of cropping it to a fixed square", () => {
    const classes =
      renderConfig({}).querySelector(`${PREVIEW} img`)?.getAttribute("class") ??
      "";

    expect(classes).toContain("object-contain");
    expect(classes).not.toContain("object-cover");
  });

  it("hides itself when the thumbnail fails to load", () => {
    const preview = renderConfig({}).querySelector<HTMLElement>(PREVIEW)!;

    preview.querySelector("img")!.dispatchEvent(new Event("error"));

    expect(preview.style.display).toBe("none");
  });

  // Tags, not one card per setting: a lobby with many settings has to stay
  // readable next to the preview without pushing the player list away.
  it("lists each notable setting as one tag next to the preview", () => {
    const tags = (config: Record<string, unknown>) =>
      renderConfig(config).querySelectorAll(`${SETTINGS} > span`).length;

    expect(tags({ infiniteGold: true, instantBuild: true })).toBe(tags({}) + 2);
  });
});

describe("JoinLobbyModal checkActiveLobby resilience", () => {
  beforeEach(() => {
    ClientEnv.reset();
    (window as any).BOOTSTRAP_CONFIG = {
      gameEnv: "prod",
      numWorkers: 1,
      turnstileSiteKey: "x",
      jwtAudience: "openfront.io",
      instanceId: "test",
      gitCommit: "test",
      serverHost: "blue.openfront.io",
    };
  });

  afterEach(() => {
    delete (window as any).BOOTSTRAP_CONFIG;
    ClientEnv.reset();
    vi.restoreAllMocks();
  });

  it("returns false instead of throwing when /exists fetch throws", async () => {
    const modal = new JoinLobbyModal();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/exists")) {
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({ servers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await (modal as any).checkActiveLobby("AbCd1234");
    expect(result).toBe(false);
  });

  it("returns false instead of throwing when resolving the server throws", async () => {
    ClientEnv.reset();
    const modal = new JoinLobbyModal();
    (window as any).BOOTSTRAP_CONFIG = {
      gameEnv: "prod",
      turnstileSiteKey: "x",
      jwtAudience: "openfront.io",
      instanceId: "test",
      gitCommit: "test",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ servers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const gameHttpBaseSpy = vi
      .spyOn(ClientEnv, "gameHttpBase")
      .mockImplementation(() => {
        throw new Error("server resolution failed");
      });

    const result = await (modal as any).checkActiveLobby("AbCd1234");
    expect(result).toBe(false);
    expect(gameHttpBaseSpy).toHaveBeenCalledWith("AbCd1234");
  });

  it("falls through to checkArchivedGame when /exists fetch throws during handleUrlJoin", async () => {
    const modal = new JoinLobbyModal();
    (modal as any).startTrackingLobby = vi.fn();
    (modal as any).checkArchivedGame = vi.fn().mockResolvedValue("success");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/exists")) {
        throw new TypeError("Failed to fetch");
      }
      return new Response(JSON.stringify({ servers: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await (modal as any).handleUrlJoin("AbCd1234");
    expect((modal as any).checkArchivedGame).toHaveBeenCalledWith("AbCd1234");
  });
});
