/**
 * Structure sprite selection: (unitType, level) -> sprite name -> atlas slot.
 *
 * The pass only knows slot indexes, so this mapping is the contract between the
 * art file and the instance buffer. The level chain is tested with a synthetic
 * sprite set because F3b ships base art only; the real structures.txt is parsed
 * too, so a broken row or a missing type fails here instead of at runtime.
 */

import { describe, expect, it } from "vitest";
import { buildAtlas } from "../../../../src/client/render/pixel/buildAtlas";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import { parsePalette } from "../../../../src/client/render/pixel/parsePalette";
import {
  parseSprites,
  type SpriteDef,
  type SpriteSet,
} from "../../../../src/client/render/pixel/parseSprites";
import {
  buildStructureSpriteTable,
  clampStructureLevel,
  MAX_STRUCTURE_LEVEL,
  MAX_STRUCTURE_SPRITE_SLOTS,
  STRUCTURE_SPRITES,
  STRUCTURE_TYPE_COUNT,
  STRUCTURE_TYPE_NAMES,
  structureSpriteCandidates,
  structureSpriteKey,
  structureSpriteName,
  structureSpriteSlot,
} from "../../../../src/client/render/pixel/structureSprites";
import {
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  UT_TRANSPORT,
} from "../../../../src/client/render/types";
import structuresRaw from "../../../../src/client/render/pixel/sprites/structures.txt?raw";

const palette = parsePalette(naturalRaw, "natural");

function spriteSet(names: string[]): SpriteSet {
  return new Map(
    names.map((name) => [name, { name } as unknown as SpriteDef]),
  );
}

describe("structureSpriteCandidates", () => {
  it("returns only the base sprite at level 1", () => {
    expect(structureSpriteCandidates(UT_CITY, 1)).toEqual(["city"]);
  });

  it("walks level variants from the current level down to the base", () => {
    expect(structureSpriteCandidates(UT_CITY, 3)).toEqual([
      "city_l3",
      "city_l2",
      "city",
    ]);
  });

  it("returns an empty list for unknown types", () => {
    expect(structureSpriteCandidates(UT_TRANSPORT, 1)).toEqual([]);
    expect(structureSpriteCandidates("Nope", 2)).toEqual([]);
  });

  it("clamps levels into the supported range", () => {
    expect(clampStructureLevel(0)).toBe(1);
    expect(clampStructureLevel(Number.NaN)).toBe(1);
    expect(clampStructureLevel(2.9)).toBe(2);
    expect(clampStructureLevel(99)).toBe(MAX_STRUCTURE_LEVEL);
  });
});

describe("structureSpriteName", () => {
  const sprites = spriteSet(["city", "city_l2", "port"]);

  it("prefers the exact level variant", () => {
    expect(structureSpriteName(sprites, UT_CITY, 2)).toBe("city_l2");
  });

  it("falls back to the highest available variant below the level", () => {
    expect(structureSpriteName(sprites, UT_CITY, 3)).toBe("city_l2");
  });

  it("falls back to the base sprite", () => {
    expect(structureSpriteName(sprites, UT_CITY, 1)).toBe("city");
    expect(structureSpriteName(sprites, UT_PORT, 3)).toBe("port");
  });

  it("returns undefined when the type has no art at all", () => {
    expect(structureSpriteName(sprites, UT_FACTORY, 1)).toBeUndefined();
  });
});

describe("buildStructureSpriteTable", () => {
  const sprites = spriteSet([
    "city",
    "city_l2",
    "port",
    "factory",
    "defense_post",
    "sam",
    "silo",
  ]);
  const table = buildStructureSpriteTable(sprites);

  it("assigns one slot per distinct sprite, in type order", () => {
    expect(table.slots).toEqual([
      "city",
      "city_l2",
      "port",
      "factory",
      "defense_post",
      "sam",
      "silo",
    ]);
    expect(table.slotTypes).toEqual([0, 0, 1, 2, 3, 4, 5]);
  });

  it("maps every level to a slot, sharing fallbacks", () => {
    expect(structureSpriteSlot(table, UT_CITY, 1)).toBe(0);
    expect(structureSpriteSlot(table, UT_CITY, 2)).toBe(1);
    // No city_l3: level 3 falls back to city_l2.
    expect(structureSpriteSlot(table, UT_CITY, 3)).toBe(1);
    expect(structureSpriteSlot(table, UT_PORT, 1)).toBe(2);
    expect(structureSpriteSlot(table, UT_PORT, 3)).toBe(2);
  });

  it("returns undefined for non-structure types", () => {
    expect(structureSpriteSlot(table, UT_TRANSPORT, 1)).toBeUndefined();
  });

  it("keeps keys inside the reserved slot range", () => {
    const maxKey = structureSpriteKey(STRUCTURE_TYPE_COUNT - 1, MAX_STRUCTURE_LEVEL);
    expect(maxKey).toBe(MAX_STRUCTURE_SPRITE_SLOTS - 1);
  });
});

describe("structures.txt", () => {
  const sprites = parseSprites(
    [{ name: "structures.txt", text: structuresRaw }],
    new Map([[palette.name, palette]]),
  );
  const table = buildStructureSpriteTable(sprites);

  it("defines all six structures at 32x32", () => {
    expect(sprites.size).toBe(STRUCTURE_TYPE_COUNT);
    for (const name of STRUCTURE_SPRITES.values()) {
      const sprite = sprites.get(name);
      expect(sprite, name).toBeDefined();
      expect(sprite!.width).toBe(32);
      expect(sprite!.height).toBe(32);
      expect(sprite!.frames.length).toBe(1);
      expect(sprite!.tags).toContain("structure");
    }
  });

  it("builds an atlas with a rect for every slot", () => {
    const atlas = buildAtlas(sprites, palette);
    expect(table.slots.length).toBe(STRUCTURE_TYPE_COUNT);
    for (const name of table.slots) {
      expect(atlas.rects.get(name), name).toBeDefined();
    }
  });

  it("covers every structure type name used by the renderer", () => {
    expect([...STRUCTURE_SPRITES.keys()]).toEqual([
      UT_CITY,
      UT_PORT,
      UT_FACTORY,
      UT_DEFENSE_POST,
      UT_SAM_LAUNCHER,
      UT_MISSILE_SILO,
    ]);
    expect(STRUCTURE_TYPE_NAMES).toEqual([...STRUCTURE_SPRITES.keys()]);
  });
});
