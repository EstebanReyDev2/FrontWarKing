import { afterEach, describe, expect, it } from "vitest";
import { clientDevice, clientPlatform } from "../../src/client/ClientPlatform";

// Phase 1 removed the desktop (Steam) shell and the web game portals, so the
// only platform left is the open web. The value must still be one the wire
// schema accepts, because it travels in the join payload.
describe("clientPlatform", () => {
  afterEach(() => {
    delete (window as { openfrontDesktop?: unknown }).openfrontDesktop;
  });

  it("is web", () => {
    expect(clientPlatform()).toBe("web");
  });

  it("stays web even if the old shell global is present", () => {
    (window as { openfrontDesktop?: unknown }).openfrontDesktop = {};
    expect(clientPlatform()).toBe("web");
  });
});

describe("clientDevice", () => {
  it("is a schema value", () => {
    expect(["desktop", "mobile"]).toContain(clientDevice());
  });
});
