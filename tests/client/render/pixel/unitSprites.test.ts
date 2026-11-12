/**
 * Unit sprite selection: engine unit -> sprite name -> atlas slot.
 *
 * The pass only knows slot indexes, so this mapping is the contract between the
 * art file and the instance buffer. The train sub-type resolution is tested
 * separately because `Train` is the only engine type with several sprites. The
 * real units.txt is parsed too, so a broken row or a missing type fails here
 * instead of at runtime.
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
  buildUnitSpriteTable,
  MAX_UNIT_SPRITE_SLOTS,
  TRAIN_CARRIAGE_KEY,
  TRAIN_CARRIAGE_LOADED_KEY,
  TRAIN_ENGINE_KEY,
  UNIT_SPRITE_KEYS,
  UNIT_SPRITES,
  unitSpriteKey,
  unitSpriteSlot,
} from "../../../../src/client/render/pixel/unitSprites";
import {
  TrainType,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_TRADE_SHIP,
  UT_TRAIN,
  UT_TRANSPORT,
  UT_WARSHIP,
} from "../../../../src/client/render/types";
import unitsRaw from "../../../../src/client/render/pixel/sprites/units.txt?raw";

const palette = parsePalette(naturalRaw, "natural");

function spriteSet(names: string[]): SpriteSet {
  return new Map(
    names.map((name) => [name, { name } as unknown as SpriteDef]),
  );
}

describe("UNIT_SPRITES", () => {
  it("maps every renderable engine type to an art name", () => {
    expect(UNIT_SPRITES.get(UT_TRANSPORT)).toBe("submarine");
    expect(UNIT_SPRITES.get(UT_TRADE_SHIP)).toBe("trade_ship");
    expect(UNIT_SPRITES.get(UT_WARSHIP)).toBe("warship");
    expect(UNIT_SPRITES.get(UT_ATOM_BOMB)).toBe("bomb");
    expect(UNIT_SPRITES.get(UT_HYDROGEN_BOMB)).toBe("nuke");
    expect(UNIT_SPRITES.get(UT_MIRV)).toBe("missile");
    expect(UNIT_SPRITES.get(UT_SAM_MISSILE)).toBe("torpedo");
    expect(UNIT_SPRITES.get(UT_SHELL)).toBe("shell");
    expect(UNIT_SPRITES.get(UT_MIRV_WARHEAD)).toBe("flak");
    expect(UNIT_SPRITES.get(TRAIN_ENGINE_KEY)).toBe("train_locomotive");
    expect(UNIT_SPRITES.get(TRAIN_CARRIAGE_KEY)).toBe("train_car");
    expect(UNIT_SPRITES.get(TRAIN_CARRIAGE_LOADED_KEY)).toBe("train_wagon");
  });

  it("reserves one slot per sprite", () => {
    expect(UNIT_SPRITES.size).toBe(12);
    expect(MAX_UNIT_SPRITE_SLOTS).toBe(12);
    expect(UNIT_SPRITE_KEYS).toEqual([...UNIT_SPRITES.keys()]);
  });
});

describe("unitSpriteKey", () => {
  it("returns the engine type for non-train units", () => {
    expect(unitSpriteKey(UT_WARSHIP, null, null)).toBe(UT_WARSHIP);
    expect(unitSpriteKey(UT_TRANSPORT, null, null)).toBe(UT_TRANSPORT);
  });

  it("resolves both train engine cars to the locomotive", () => {
    expect(unitSpriteKey(UT_TRAIN, TrainType.Engine, null)).toBe(
      TRAIN_ENGINE_KEY,
    );
    expect(unitSpriteKey(UT_TRAIN, TrainType.TailEngine, null)).toBe(
      TRAIN_ENGINE_KEY,
    );
  });

  it("uses the loaded wagon only for loaded carriages", () => {
    expect(unitSpriteKey(UT_TRAIN, TrainType.Carriage, true)).toBe(
      TRAIN_CARRIAGE_LOADED_KEY,
    );
    expect(unitSpriteKey(UT_TRAIN, TrainType.Carriage, false)).toBe(
      TRAIN_CARRIAGE_KEY,
    );
    expect(unitSpriteKey(UT_TRAIN, null, null)).toBe(TRAIN_CARRIAGE_KEY);
  });

  it("returns undefined for units with no art", () => {
    expect(unitSpriteKey("City", null, null)).toBeUndefined();
    expect(unitSpriteKey("Nope", null, null)).toBeUndefined();
  });
});

describe("buildUnitSpriteTable", () => {
  const sprites = spriteSet([...UNIT_SPRITES.values()]);
  const table = buildUnitSpriteTable(sprites);

  it("assigns slots in UNIT_SPRITES order", () => {
    expect(table.slots).toEqual([
      "submarine",
      "trade_ship",
      "warship",
      "bomb",
      "nuke",
      "missile",
      "torpedo",
      "shell",
      "flak",
      "train_locomotive",
      "train_car",
      "train_wagon",
    ]);
  });

  it("maps every unit key to its slot", () => {
    expect(unitSpriteSlot(table, UT_TRANSPORT, null, null)).toBe(0);
    expect(unitSpriteSlot(table, UT_TRADE_SHIP, null, null)).toBe(1);
    expect(unitSpriteSlot(table, UT_WARSHIP, null, null)).toBe(2);
    expect(unitSpriteSlot(table, UT_ATOM_BOMB, null, null)).toBe(3);
    expect(unitSpriteSlot(table, UT_HYDROGEN_BOMB, null, null)).toBe(4);
    expect(unitSpriteSlot(table, UT_MIRV, null, null)).toBe(5);
    expect(unitSpriteSlot(table, UT_SAM_MISSILE, null, null)).toBe(6);
    expect(unitSpriteSlot(table, UT_SHELL, null, null)).toBe(7);
    expect(unitSpriteSlot(table, UT_MIRV_WARHEAD, null, null)).toBe(8);
    expect(unitSpriteSlot(table, UT_TRAIN, TrainType.Engine, null)).toBe(9);
    expect(unitSpriteSlot(table, UT_TRAIN, TrainType.Carriage, false)).toBe(10);
    expect(unitSpriteSlot(table, UT_TRAIN, TrainType.Carriage, true)).toBe(11);
  });

  it("returns undefined for non-unit types", () => {
    expect(unitSpriteSlot(table, "City", null, null)).toBeUndefined();
  });

  it("skips missing art instead of inventing a slot", () => {
    const partial = buildUnitSpriteTable(spriteSet(["warship"]));
    expect(partial.slots).toEqual(["warship"]);
    expect(unitSpriteSlot(partial, UT_WARSHIP, null, null)).toBe(0);
    expect(unitSpriteSlot(partial, UT_TRANSPORT, null, null)).toBeUndefined();
  });
});

describe("units.txt", () => {
  const sprites = parseSprites(
    [{ name: "units.txt", text: unitsRaw }],
    new Map([[palette.name, palette]]),
  );
  const table = buildUnitSpriteTable(sprites);

  it("defines all twelve sprites at the expected size", () => {
    expect(sprites.size).toBe(UNIT_SPRITES.size);
    for (const name of UNIT_SPRITES.values()) {
      const sprite = sprites.get(name);
      expect(sprite, name).toBeDefined();
      const expected = name === "nuke" ? 32 : 16;
      expect(sprite!.width, name).toBe(expected);
      expect(sprite!.height, name).toBe(expected);
      expect(sprite!.frames.length, name).toBe(1);
      expect(sprite!.tags, name).toContain("unit");
    }
  });

  it("builds an atlas with a rect for every slot", () => {
    const atlas = buildAtlas(sprites, palette);
    expect(table.slots.length).toBe(UNIT_SPRITES.size);
    for (const name of table.slots) {
      expect(atlas.rects.get(name), name).toBeDefined();
    }
  });
});
