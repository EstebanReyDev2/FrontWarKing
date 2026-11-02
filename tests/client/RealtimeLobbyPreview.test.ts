import { afterEach, describe, expect, it, vi } from "vitest";
import { saveGuestNickname } from "../../src/client/lobby/GuestIdentity";
import { JOIN_TIMEOUT_MS } from "../../src/client/lobby/LobbyRules";
import { RealtimeLobbyPreview } from "../../src/client/lobby/RealtimeLobbyPreview";

describe("realtime lobby preview", () => {
  let element: RealtimeLobbyPreview;

  afterEach(() => {
    element?.remove();
    localStorage.clear();
    history.replaceState({}, "", "/");
    vi.useRealTimers();
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

    expect(element.textContent).toContain("Código de sala");
    expect(element.textContent).toContain("Office host");
    expect(element.textContent).toMatch(/[A-HJ-NP-Z2-9]{6}/);
    expect(element.textContent).toContain("1/7");
    expect(element.querySelector("button[disabled]")?.textContent).toContain(
      "Empezar",
    );
  });

  it("simulates joining from an invite link with fake host data", async () => {
    history.replaceState({}, "", "/?lobby-preview&room=ABC234");
    saveGuestNickname("Office peer");
    if (!customElements.get("realtime-lobby-preview")) {
      customElements.define("realtime-lobby-preview", RealtimeLobbyPreview);
    }
    element = document.createElement(
      "realtime-lobby-preview",
    ) as RealtimeLobbyPreview;
    document.body.append(element);
    await element.updateComplete;

    const joinButton = [...element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Unirme"),
    );
    joinButton?.click();
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 175));
    await element.updateComplete;

    expect(element.textContent).toContain("ABC234");
    expect(element.textContent).toContain("Host de prueba");
    expect(element.textContent).toContain("Office peer");
    expect(element.textContent).toContain("sala de demostración");
  });

  it("shows the not-found message when the host does not reply before timeout", async () => {
    vi.useFakeTimers();
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

    await vi.advanceTimersByTimeAsync(JOIN_TIMEOUT_MS);
    await element.updateComplete;

    expect(element.textContent).toContain(
      "Sala no encontrada o host desconectado",
    );
  });
});
