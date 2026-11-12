/**
 * Deterministic decoration placement for the pixel terrain.
 *
 * The pass only knows instance slots, so this is the contract between the
 * terrain bytes and what appears on screen. The tests use hand-built byte maps
 * so the land/impassable filter and the hash are checked without a GPU.
 */

import { describe, expect, it } from "vitest";
import { buildAtlas } from "../../../../src/client/render/pixel/buildAtlas";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import { parsePalette } from "../../../../src/client/render/pixel/parsePalette";
import { parseSprites } from "../../../../src/client/render/pixel/parseSprites";
import {
  buildScatterInstances,
  DECOR_KIND_COUNT,
  DECOR_SPRITE_NAMES,
  hashU32,
  TERRAIN_SEED,
} from "../../../../src/client/render/pixel/terrainScatter";
import worldRaw from "../../../../src/client/render/pixel/sprites/world.txt?raw";

const palette = parsePalette(naturalRaw, "natural");

/** Land, not shoreline, given magnitude. */
const land = (mag: number) => 0x80 | mag;
/** Water, not shoreline, given magnitude. */
const water = (mag: number) => mag;
const IMPASSABLE = 0x80 | 31;

describe("hashU32", () => {
  it("is a deterministic unsigned 32-bit value", () => {
    const a = hashU32(12, 34);
    expect(a).toBe(hashU32(12, 34));
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });

  it("changes with the tile, the axis and the seed", () => {
    expect(hashU32(1, 2)).not.toBe(hashU32(2, 1));
    expect(hashU32(1, 2)).not.toBe(hashU32(1, 3));
    expect(hashU32(1, 2)).not.toBe(hashU32(1, 2, TERRAIN_SEED ^ 1));
  });
});

describe("buildScatterInstances", () => {
  it("only decorates land tiles that are not impassable", () => {
    const bytes = new Uint8Array([
      water(2),
      land(4),
      IMPASSABLE,
      land(0),
    ]);
    const instances = buildScatterInstances(bytes, 2, 2, 4);
    expect(instances).toHaveLength(2);
    for (const inst of instances) {
      const x = Math.floor(inst.x);
      const y = Math.floor(inst.y);
      expect(y * 2 + x).not.toBe(0);
      expect(y * 2 + x).not.toBe(2);
    }
  });

  it("returns nothing when every tile is water or impassable", () => {
    const bytes = new Uint8Array([water(0), water(9), IMPASSABLE, IMPASSABLE]);
    expect(buildScatterInstances(bytes, 2, 2, 4)).toEqual([]);
  });

  it("is deterministic for the same input", () => {
    const bytes = new Uint8Array(64).fill(land(3));
    const a = buildScatterInstances(bytes, 8, 8, 16);
    const b = buildScatterInstances(bytes, 8, 8, 16);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("keeps the centre inside the tile and the kind in range", () => {
    const bytes = new Uint8Array(16 * 16).fill(land(2));
    const instances = buildScatterInstances(bytes, 16, 16, 64);
    expect(instances.length).toBeGreaterThan(0);
    for (const inst of instances) {
      expect(inst.x).toBeGreaterThanOrEqual(Math.floor(inst.x) + 0.2);
      expect(inst.x).toBeLessThanOrEqual(Math.floor(inst.x) + 0.8);
      expect(inst.y).toBeGreaterThanOrEqual(Math.floor(inst.y) + 0.2);
      expect(inst.y).toBeLessThanOrEqual(Math.floor(inst.y) + 0.8);
      expect(inst.kind).toBeGreaterThanOrEqual(0);
      expect(inst.kind).toBeLessThan(DECOR_KIND_COUNT);
      expect(inst.variant).toBeGreaterThanOrEqual(0);
      expect(inst.variant).toBeLessThanOrEqual(255);
    }
  });

  it("rejects a byte array shorter than the map", () => {
    expect(() => buildScatterInstances(new Uint8Array(3), 2, 2, 1)).toThrow();
  });
});

describe("world.txt", () => {
  const sprites = parseSprites(
    [{ name: "world.txt", text: worldRaw }],
    new Map([[palette.name, palette]]),
  );

  it("defines the three decor props at 16x16", () => {
    expect([...sprites.keys()].sort()).toEqual([...DECOR_SPRITE_NAMES].sort());
    for (const name of DECOR_SPRITE_NAMES) {
      const sprite = sprites.get(name);
      expect(sprite, name).toBeDefined();
      expect(sprite!.width, name).toBe(16);
      expect(sprite!.height, name).toBe(16);
      expect(sprite!.frames.length, name).toBe(1);
      expect(sprite!.tags, name).toContain("decor");
    }
  });

  it("uses a one-tile rock and two-tile tree/hut footprints", () => {
    expect(sprites.get("rock")!.world).toEqual([1, 1]);
    expect(sprites.get("tree")!.world).toEqual([2, 2]);
    expect(sprites.get("hut")!.world).toEqual([2, 2]);
  });

  it("builds an atlas with a rect for every prop", () => {
    const atlas = buildAtlas(sprites, palette);
    for (const name of DECOR_SPRITE_NAMES) {
      expect(atlas.rects.get(name), name).toBeDefined();
    }
  });
});
