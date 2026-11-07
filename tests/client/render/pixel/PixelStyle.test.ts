import { describe, expect, it } from "vitest";
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
