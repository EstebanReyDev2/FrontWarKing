import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveGuestNickname } from "../../src/client/lobby/GuestIdentity";
import { LaunchRealtimeGameEvent } from "../../src/client/lobby/LobbyEvents";
import { LobbySession } from "../../src/client/lobby/LobbySession";
import { RealtimeLobbyPreview } from "../../src/client/lobby/RealtimeLobbyPreview";

describe("realtime lobby preview", () => {
  let element: RealtimeLobbyPreview;

  beforeEach(() => {
    history.replaceState({}, "", "/?lobby-preview");
    vi.spyOn(LobbySession, "createHost").mockImplementation(async (options) => {
      options.onRoster([
        {
          persistentID: options.clientID,
          nickname: options.nickname,
          host: true,
        },
      ]);
      return {
        close: vi.fn(),
        get roster() {
          return [
            {
              persistentID: options.clientID,
              nickname: options.nickname,
              host: true,
            },
          ];
        },
        startGame: vi.fn(),
      } as unknown as LobbySession;
    });
    vi.spyOn(LobbySession, "joinPeer").mockRejectedValue(
      new Error("Sala no encontrada o host desconectado"),
    );
  });

  afterEach(() => {
    element?.remove();
    localStorage.clear();
    history.replaceState({}, "", "/");
    delete window.__debugGameStartInfo;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a room with the guest and displays its share code", async () => {
    if (!customElements.get("realtime-lobby-preview")) {
      customElements.define("realtime-lobby-preview", RealtimeLobbyPreview);
    }
    saveGuestNickname("Office host");
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;

    const optionsGrid = element.querySelector(".grid");
    expect(optionsGrid?.className).toContain("grid-cols-1");
    expect(optionsGrid?.className).toContain("md:grid-cols-2");
    expect(optionsGrid?.className).toContain("auto-rows-min");
    expect(
      [...(optionsGrid?.querySelectorAll("form") ?? [])].every((form) =>
        form.classList.contains("min-w-0"),
      ),
    ).toBe(true);

    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    expect(element.textContent).toContain("Código de sala");
    expect(element.textContent).toContain("Office host");
    expect(element.textContent).toMatch(/[A-HJ-NP-Z2-9]{6}/);
    expect(element.textContent).toContain("1/7");
    expect(element.querySelector("button[disabled]")?.textContent).toContain(
      "Empezar",
    );
    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      "Necesitás al menos 2 jugadores para empezar",
    );
    expect(element.querySelector("select")?.options).toHaveLength(16);
  });

  it("changes the selected map and expands/collapses the complete catalog", async () => {
    saveGuestNickname("Office host");
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    const mapSelect = element.querySelector<HTMLSelectElement>("select");
    if (!mapSelect) throw new Error("map selector not found");
    [...element.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Ver todos los mapas"))
      ?.click();
    await element.updateComplete;
    expect(mapSelect.options).toHaveLength(135);
    expect(mapSelect.value).toBe("Africa");

    mapSelect.value = "World";
    mapSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(mapSelect.value).toBe("World");

    [...element.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Ver mapas recomendados"))
      ?.click();
    await element.updateComplete;
    expect(mapSelect.options).toHaveLength(16);
    expect(mapSelect.value).toBe("World");
  });

  it("updates the map preview when the selection changes", async () => {
    saveGuestNickname("Office host");
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    const preview = () =>
      element.querySelector<HTMLImageElement>(
        'img[alt="Vista previa del mapa"]',
      );
    expect(preview()?.getAttribute("src")).toContain(
      "maps/africa/thumbnail.webp",
    );

    const mapSelect = element.querySelector<HTMLSelectElement>("select");
    if (!mapSelect) throw new Error("map selector not found");
    mapSelect.value = "Europe";
    mapSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;

    expect(preview()?.getAttribute("src")).toContain(
      "maps/europe/thumbnail.webp",
    );
  });

  it("shows the large-map badge for World in the curated list", async () => {
    saveGuestNickname("Office host");
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    const mapSelect = element.querySelector<HTMLSelectElement>("select");
    if (!mapSelect) throw new Error("map selector not found");
    mapSelect.value = "World";
    mapSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;

    expect(element.textContent).toContain("Mapa grande");
    expect(
      element
        .querySelector<HTMLImageElement>('img[alt="Vista previa del mapa"]')
        ?.getAttribute("src"),
    ).toContain("maps/world/thumbnail.webp");
  });

  it("does not count UI-only fake peers toward the realtime start requirement", async () => {
    saveGuestNickname("Office host");
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    const startButton = [...element.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Empezar",
    );
    expect(startButton?.disabled).toBe(true);
    expect(window.__debugGameStartInfo).toBeUndefined();

    [...element.querySelectorAll("button")]
      .find((button) =>
        button.textContent?.includes("Agregar jugador de prueba"),
      )
      ?.click();
    await element.updateComplete;
    expect(element.textContent).toContain("2/7");
    expect(startButton?.disabled).toBe(true);
    expect(element.querySelector('[role="status"]')?.textContent).toContain(
      "al menos 2 jugadores",
    );
    expect(window.__debugGameStartInfo).toBeUndefined();
  });

  it("starts with the canonical roster, a distinct game ID, and emits the launch event", async () => {
    const realRoster = [
      { persistentID: "host0001", nickname: "Office host", host: true },
      { persistentID: "peer0001", nickname: "Office peer" },
    ];
    vi.mocked(LobbySession.createHost).mockImplementation(async (options) => {
      options.onRoster(realRoster);
      return {
        close: vi.fn(),
        get roster() {
          return realRoster;
        },
        startGame: vi.fn(async (info) => {
          options.onGameStart?.({
            type: "lobby_start",
            v: 1,
            roomCode: options.roomCode,
            gameID: info.gameID,
            hostID: options.clientID,
            gameStartInfo: info,
          });
        }),
      } as unknown as LobbySession;
    });
    saveGuestNickname("Office host");
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    const eventBus = new EventBus();
    element.eventBus = eventBus;
    const launched = vi.fn();
    eventBus.on(LaunchRealtimeGameEvent, launched);
    document.body.append(element);
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    const startButton = [...element.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Empezar",
    );
    expect(startButton?.disabled).toBe(false);
    [...element.querySelectorAll("button")]
      .find((button) =>
        button.textContent?.includes("Agregar jugador de prueba"),
      )
      ?.click();
    await element.updateComplete;
    startButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = launched.mock.calls[0]?.[0] as LaunchRealtimeGameEvent;
    expect(event).toBeInstanceOf(LaunchRealtimeGameEvent);
    expect(event.start.gameID).toMatch(/^[A-Za-z0-9]{8,10}$/);
    expect(event.start.gameID).not.toBe(
      element.textContent?.match(/[A-HJ-NP-Z2-9]{6}/)?.[0],
    );
    expect(event.start.gameStartInfo.config).toMatchObject({
      gameMap: "Africa",
      gameMode: "Free For All",
      maxPlayers: 2,
      bots: 0,
      nations: "disabled",
      randomSpawn: false,
    });
    expect(
      event.start.gameStartInfo.players.map(({ clientID }) => clientID),
    ).toEqual(["host0001", "peer0001"]);
    expect(
      event.start.gameStartInfo.players.map(({ clientID }) => clientID),
    ).not.toContain("test-peer-2");
  });

  it("adds fake peers to the player limit and removes them again", async () => {
    saveGuestNickname("Office host");
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    const addButton = [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Agregar jugador de prueba"),
    );
    for (let index = 0; index < 6; index++) {
      addButton?.click();
      await element.updateComplete;
    }
    expect(element.textContent).toContain("7/7");
    expect(addButton?.disabled).toBe(true);
    expect(element.textContent).toContain("Límite de 7 jugadores alcanzado");

    for (let index = 0; index < 6; index++) {
      const removeButton = element.querySelector<HTMLButtonElement>(
        'button[aria-label^="Quitar"]',
      );
      removeButton?.click();
      await element.updateComplete;
    }
    expect(element.textContent).toContain("1/7");
    expect(
      [...element.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Empezar",
      )?.disabled,
    ).toBe(true);
  });

  it.each(["/", "/?realtime-dev&room=ABC234"])(
    "does not show the test-peer control on %s",
    async (url) => {
      history.replaceState({}, "", url);
      saveGuestNickname("Office host");
      element = document.createElement(
        "realtime-lobby-preview",
      ) as RealtimeLobbyPreview;
      document.body.append(element);
      await element.updateComplete;
      element
        .querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.click();
      await element.updateComplete;

      expect(element.textContent).not.toContain("Agregar jugador de prueba");
    },
  );

  it("joins the invite room through the LobbySession handshake", async () => {
    history.replaceState({}, "", "/?lobby-preview&room=ABC234");
    saveGuestNickname("Office peer");
    vi.mocked(LobbySession.joinPeer).mockImplementation(async (options) => {
      const roster = [
        { persistentID: "host0001", nickname: "Office host", host: true },
        { persistentID: options.clientID, nickname: options.nickname },
      ];
      options.onRoster(roster);
      return {
        close: vi.fn(),
        get roster() {
          return roster;
        },
      } as unknown as LobbySession;
    });
    if (!customElements.get("realtime-lobby-preview")) {
      customElements.define("realtime-lobby-preview", RealtimeLobbyPreview);
    }
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    await element.updateComplete;

    expect(element.textContent).toContain("ABC234");
    expect(element.textContent).toContain("Office host");
    expect(element.textContent).toContain("Office peer");
    expect(LobbySession.joinPeer).toHaveBeenCalledWith(
      expect.objectContaining({ roomCode: "ABC234", nickname: "Office peer" }),
    );
    expect(
      [...element.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Empezar",
      ),
    ).toBe(false);
  });

  it("shows the not-found message when the lobby handshake fails", async () => {
    saveGuestNickname("Office peer");
    if (!customElements.get("realtime-lobby-preview")) {
      customElements.define("realtime-lobby-preview", RealtimeLobbyPreview);
    }
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;

    const codeInput = element.querySelector<HTMLInputElement>(
      'input[placeholder="ABC234"]',
    );
    if (codeInput === null) throw new Error("room code input not found");
    codeInput.value = "ABC234";
    codeInput.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    [...element.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Unirme"))
      ?.click();
    await element.updateComplete;
    await Promise.resolve();
    await element.updateComplete;

    expect(element.textContent).toContain(
      "Sala no encontrada o host desconectado",
    );
  });
});
