import { describe, expect, it } from "vitest";

import { HostLobbyModal } from "../../src/client/HostLobbyModal";

describe("HostLobbyModal kick player", () => {
  it("dispatches a bubbling kick-player event carrying the target", () => {
    const modal = new HostLobbyModal() as any;
    const seen: CustomEvent[] = [];
    modal.addEventListener("kick-player", (e: Event) =>
      seen.push(e as CustomEvent),
    );

    modal.kickPlayer("cAbc1234");

    expect(seen).toHaveLength(1);
    expect(seen[0].detail).toEqual({ target: "cAbc1234" });
    // Main listens on document, so the event must escape the component.
    expect(seen[0].bubbles).toBe(true);
    expect(seen[0].composed).toBe(true);
  });
});
