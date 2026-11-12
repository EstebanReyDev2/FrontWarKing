import { describe, expect, it, vi } from "vitest";
import { pixelQuerySuffix } from "../../../../src/client/PixelFlag";
import {
  parsePixelStyle,
  PIXEL_FEATURES,
} from "../../../../src/client/render/pixel/PixelStyle";

describe("parsePixelStyle", () => {
  it("defaults to the pixel style everywhere", () => {
    const style = parsePixelStyle("");
    expect(style.mode).toBe("all");
    expect(style.enabled).toBe(true);
    for (const feature of PIXEL_FEATURES) {
      expect(style.includes(feature)).toBe(true);
    }
  });

  it("treats ?pixel=all and an empty value as all", () => {
    expect(parsePixelStyle("?pixel=all").mode).toBe("all");
    expect(parsePixelStyle("?pixel=").mode).toBe("all");
    expect(parsePixelStyle("?pixel=%20").mode).toBe("all");
  });

  it("turns everything off with ?pixel=off", () => {
    for (const value of ["off", "none", "false", "0", "OFF"]) {
      const style = parsePixelStyle(`?pixel=${value}`);
      expect(style.mode).toBe("off");
      expect(style.enabled).toBe(false);
      for (const feature of PIXEL_FEATURES) {
        expect(style.includes(feature)).toBe(false);
      }
    }
  });

  it("parses a comma-separated feature list", () => {
    const style = parsePixelStyle("?pixel=structures,units");
    expect(style.mode).toBe("list");
    expect(style.enabled).toBe(true);
    expect(style.includes("structures")).toBe(true);
    expect(style.includes("units")).toBe(true);
    expect(style.includes("terrain")).toBe(false);
    expect(style.features).toEqual(new Set(["structures", "units"]));
  });

  it("ignores unknown tokens and trims them", () => {
    const style = parsePixelStyle("?pixel=%20structures%20,%20nope%20");
    expect(style.features).toEqual(new Set(["structures"]));
    expect(parsePixelStyle("?pixel=nope").enabled).toBe(false);
  });

  it("keeps working next to the other dev routes", () => {
    expect(parsePixelStyle("?lobby-preview=1").mode).toBe("all");
    expect(parsePixelStyle("?realtime-dev=1").mode).toBe("all");
    expect(parsePixelStyle("?pixel=off&lobby-preview=1").mode).toBe("off");
    expect(
      parsePixelStyle("?pixel=structures&realtime-dev=1").includes(
        "structures",
      ),
    ).toBe(true);
  });
});

describe("pixelQuerySuffix", () => {
  it("returns nothing when the page has no pixel flag", () => {
    expect(pixelQuerySuffix("")).toBe("");
    expect(pixelQuerySuffix("?lobby-preview=1")).toBe("");
    expect(pixelQuerySuffix("?pixel=")).toBe("");
  });

  it("carries the flag into the game URL", () => {
    expect(pixelQuerySuffix("?pixel=off")).toBe("&pixel=off");
    expect(pixelQuerySuffix("?lobby-preview=1&pixel=structures,units")).toBe(
      "&pixel=structures%2Cunits",
    );
  });

  it("produces a URL the renderer parses back to the same style", () => {
    for (const search of ["?pixel=off", "?pixel=all", "?pixel=units"]) {
      const gameUrl = `?live${pixelQuerySuffix(search)}`;
      expect(parsePixelStyle(gameUrl).mode).toBe(
        parsePixelStyle(search).mode,
      );
    }
  });
});

describe("boot search snapshot", () => {
  it("keeps the flag after the join flow rewrites the address bar", async () => {
    const original = window.location.href;
    try {
      // The page loads with the flag...
      history.replaceState(null, "", "/?pixel=off");
      vi.resetModules();
      // Both modules are re-evaluated together: PixelStyle reads the boot
      // search that PixelFlag captured on import.
      const boot = await import(
        "../../../../src/client/render/pixel/PixelStyle"
      );
      const flag = await import("../../../../src/client/PixelFlag");
      // ...then the join flow replaces the URL with the game entry.
      history.replaceState(null, "", "/w0/game/abcdefgh?live");
      expect(window.location.search).toBe("?live");
      expect(flag.pixelQuerySuffix()).toBe("&pixel=off");
      expect(boot.parsePixelStyle().mode).toBe("off");
    } finally {
      history.replaceState(null, "", original);
    }
  });
});
