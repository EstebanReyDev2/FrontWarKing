import { describe, expect, it, vi } from "vitest";

import { HostLobbyModal } from "../../src/client/HostLobbyModal";

describe("HostLobbyModal team count selection", () => {
  it("updates the lobby's team count and pushes the new config", () => {
    const modal = new HostLobbyModal() as any;
    const putGameConfig = vi.fn(); // network push stubbed out
    modal.putGameConfig = putGameConfig;

    modal.handleConfigTeamCountSelected(
      new CustomEvent("team-count-selected", { detail: { count: 5 } }),
    );

    expect(modal.teamCount).toBe(5);
    expect(putGameConfig).toHaveBeenCalledOnce();
  });
});
