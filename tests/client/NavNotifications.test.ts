import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getCosmeticsHash, getGamesPlayed } = vi.hoisted(() => ({
  getCosmeticsHash: vi.fn(async () => "hash-2"),
  getGamesPlayed: vi.fn(() => 0),
}));
vi.mock("../../src/client/Cosmetics", () => ({ getCosmeticsHash }));
vi.mock("../../src/client/Utils", () => ({ getGamesPlayed }));

import {
  NavNotificationsController,
  navNotifications,
} from "../../src/client/components/NavNotificationsController";

// Two components with their own controller — the help dot lives in
// <nav-utility-icons>, the store dot in the nav bars.
function host() {
  const requestUpdate = vi.fn();
  const stub = {
    requestUpdate,
    addController: () => {},
    removeController: () => {},
    updateComplete: Promise.resolve(true),
  };
  const controller = new NavNotificationsController(stub as never);
  controller.hostConnected();
  return { controller, requestUpdate };
}

describe("nav notifications", () => {
  beforeEach(() => {
    navNotifications.reset();
    localStorage.clear();
    // Seen an older cosmetics hash: the store has something new.
    localStorage.setItem("storeSeenHash", "hash-1");
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("shares state across components, so dismissing the store reveals the help dot", async () => {
    const icons = host();
    const navBar = host();
    // Let the cosmetics-hash fetch settle.
    await Promise.resolve();
    await Promise.resolve();

    // Store outranks help, so only the store shows a dot.
    expect(navBar.controller.showStoreDot()).toBe(true);
    expect(icons.controller.showHelpDot()).toBe(false);

    // Dismissing the store used to leave the other component's own copy of
    // hasNewCosmetics set, suppressing the help dot until a reload.
    navBar.controller.onStoreClick();

    expect(navBar.controller.showStoreDot()).toBe(false);
    expect(icons.controller.showHelpDot()).toBe(true);
    // Both components re-render off the shared state.
    expect(icons.requestUpdate).toHaveBeenCalled();
  });

  it("keeps help last in the priority chain", async () => {
    const icons = host();
    await Promise.resolve();
    await Promise.resolve();

    expect(icons.controller.showHelpDot()).toBe(false); // store still pending
    icons.controller.onStoreClick();
    expect(icons.controller.showHelpDot()).toBe(true);
  });
});
