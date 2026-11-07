import { describe, expect, it } from "vitest";

import { HostLobbyModal } from "../../src/client/HostLobbyModal";

describe("HostLobbyModal start button", () => {
  it("blocks Start for a lone host only while no countdown is running", () => {
    const modal = new HostLobbyModal() as any;

    modal.clients = [{ clientID: "host" }];
    expect(modal.startDisabled).toBe(true);

    modal.clients = [{ clientID: "host" }, { clientID: "guest" }];
    expect(modal.startDisabled).toBe(false);

    modal.clients = [{ clientID: "host" }];
    modal.lobbyStartAt = 123;
    expect(modal.startDisabled).toBe(false);
  });
});
