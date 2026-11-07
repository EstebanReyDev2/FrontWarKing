import { describe, expect, it } from "vitest";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import { parsePalette } from "../../../../src/client/render/pixel/parsePalette";
import { parseSprites } from "../../../../src/client/render/pixel/parseSprites";
import {
  frameIndexAt,
  hashU,
  hashUnit,
  pickTaggedSprite,
  spriteLod,
  spritesWithTag,
  structureLod,
  FW_PIXEL_SEED,
} from "../../../../src/client/render/pixel/spriteSelect";

const palette = parsePalette(naturalRaw, "natural");

function rows(size = 16, fill = "."): string[] {
  return Array.from({ length: size }, () => fill.repeat(size));
}

function taggedSprites() {
  const text = [
    "@sprite bravo",
    "@tags structure",
    "@frame 0",
    ...rows(),
    "@sprite alpha",
    "@tags structure,city",
    "@frame 0",
    ...rows(),
    "@sprite unit",
    "@tags unit",
    "@frame 0",
    ...rows(),
  ].join("\n");
  return parseSprites(
    [{ name: "tags.txt", text }],
    new Map([["natural", palette]]),
  );
}

describe("hashU", () => {
  it("is a deterministic unsigned 32-bit hash", () => {
    expect(hashU(12, 34)).toBe(hashU(12, 34));
    expect(hashU(12, 34)).toBeGreaterThanOrEqual(0);
    expect(hashU(12, 34)).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(hashU(12, 34))).toBe(true);
  });

  it("changes with position and seed", () => {
    expect(hashU(12, 34)).not.toBe(hashU(13, 34));
    expect(hashU(12, 34)).not.toBe(hashU(12, 35));
    expect(hashU(12, 34)).not.toBe(hashU(12, 34, FW_PIXEL_SEED + 1));
  });

  it("spreads tiles over the 16 buckets", () => {
    const buckets = new Array(16).fill(0);
    for (let x = 0; x < 100; x++) {
      for (let y = 0; y < 100; y++) buckets[hashU(x, y) % 16]++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(450);
      expect(count).toBeLessThan(800);
    }
  });

  it("normalises to [0, 1)", () => {
    for (const [x, y] of [
      [0, 0],
      [3, 5],
      [999, 1000],
    ]) {
      const value = hashUnit(x, y);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("level of detail", () => {
  it("collapses structures to dots below the existing threshold", () => {
    expect(structureLod(0.5)).toBe("dot");
    expect(structureLod(1.19)).toBe("dot");
    expect(structureLod(1.2)).toBe("sprite");
    expect(structureLod(4)).toBe("sprite");
  });

  it("drops a 16px sprite under four screen pixels", () => {
    expect(spriteLod(0.2)).toBe("dot"); // 3.2 px
    expect(spriteLod(0.25)).toBe("sprite"); // 4 px
    expect(spriteLod(0.2, 2)).toBe("sprite"); // DPR counts
    expect(spriteLod(0.1, 2)).toBe("dot");
    expect(spriteLod(1)).toBe("sprite");
  });
});

describe("frameIndexAt", () => {
  it("loops an animation", () => {
    expect(frameIndexAt(0, 4, 4, true)).toBe(0);
    expect(frameIndexAt(249, 4, 4, true)).toBe(0);
    expect(frameIndexAt(250, 4, 4, true)).toBe(1);
    expect(frameIndexAt(999, 4, 4, true)).toBe(3);
    expect(frameIndexAt(1000, 4, 4, true)).toBe(0);
  });

  it("clamps a non-looping animation on its last frame", () => {
    expect(frameIndexAt(0, 4, 4, false)).toBe(0);
    expect(frameIndexAt(750, 4, 4, false)).toBe(3);
    expect(frameIndexAt(5000, 4, 4, false)).toBe(3);
  });

  it("stays on frame 0 for static or single-frame sprites", () => {
    expect(frameIndexAt(5000, 0, 4, true)).toBe(0);
    expect(frameIndexAt(5000, 4, 1, true)).toBe(0);
  });

  it("does not advance on negative elapsed time", () => {
    expect(frameIndexAt(-1000, 4, 4, true)).toBe(0);
  });
});

describe("tag selection", () => {
  it("returns tagged sprites sorted by name", () => {
    const sprites = taggedSprites();
    expect(spritesWithTag(sprites, "structure").map((s) => s.name)).toEqual([
      "alpha",
      "bravo",
    ]);
    expect(spritesWithTag(sprites, "unit").map((s) => s.name)).toEqual([
      "unit",
    ]);
    expect(spritesWithTag(sprites, "missing")).toEqual([]);
  });

  it("picks the same tagged sprite for the same tile", () => {
    const sprites = taggedSprites();
    const first = pickTaggedSprite(sprites, "structure", 42, 77);
    const second = pickTaggedSprite(sprites, "structure", 42, 77);
    expect(first?.name).toBe(second?.name);
    expect(first?.tags).toContain("structure");
  });

  it("returns undefined when nothing carries the tag", () => {
    expect(pickTaggedSprite(taggedSprites(), "fx", 1, 2)).toBeUndefined();
  });
});
