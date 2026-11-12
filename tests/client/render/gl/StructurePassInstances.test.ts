/**
 * Instance-buffer regression for the structure passes.
 *
 * The pixel renderer replaced the classic draw path, but the per-instance
 * layout must stay byte-identical: six floats, `x, y, ownerID,
 * underConstruction, spriteSlot, markedForDeletion`. The classic pass stores
 * the atlas column in float 4; the pixel pass stores a sprite slot. Everything
 * else — ordering, tile decoding, skipped units — has to match.
 *
 * The passes are exercised through their prototypes with a stubbed GL context,
 * the same pattern as UnitPassSmoothing.test.ts: the real updateStructures runs
 * and only the two WebGL calls it makes are captured.
 */

import { describe, expect, it, vi } from "vitest";
import { PixelStructurePass } from "../../../../src/client/render/gl/passes/PixelStructurePass";
import { StructurePass } from "../../../../src/client/render/gl/passes/StructurePass";
import {
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
} from "../../../../src/client/render/types";
import type { UnitState } from "../../../../src/client/render/types";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import { parsePalette } from "../../../../src/client/render/pixel/parsePalette";
import { parseSprites } from "../../../../src/client/render/pixel/parseSprites";
import {
  buildStructureSpriteTable,
  STRUCTURE_SPRITES,
  structureSpriteSlot,
} from "../../../../src/client/render/pixel/structureSprites";
import structuresRaw from "../../../../src/client/render/pixel/sprites/structures.txt?raw";

const FLOATS_PER_INSTANCE = 6;
const MAP_W = 100;

const palette = parsePalette(naturalRaw, "natural");
const sprites = parseSprites(
  [{ name: "structures.txt", text: structuresRaw }],
  new Map([[palette.name, palette]]),
);
const spriteTable = buildStructureSpriteTable(sprites);

interface PassHarness {
  pass: StructurePass | PixelStructurePass;
  f32: Float32Array;
  bufferSubData: ReturnType<typeof vi.fn>;
  ensureCapacity: ReturnType<typeof vi.fn>;
}

function makeHarness(kind: "classic" | "pixel"): PassHarness {
  const f32 = new Float32Array(64 * FLOATS_PER_INSTANCE);
  const bufferSubData = vi.fn();
  const ensureCapacity = vi.fn();
  const gl = {
    ARRAY_BUFFER: 0x8892,
    bindBuffer: vi.fn(),
    bufferSubData,
  };

  const pass =
    kind === "classic"
      ? (Object.create(StructurePass.prototype) as StructurePass)
      : (Object.create(PixelStructurePass.prototype) as PixelStructurePass);

  const fields: Record<string, unknown> = {
    gl,
    mapW: MAP_W,
    instanceCount: 0,
    instanceBuf: {
      float32: f32,
      buffer: {},
      ensureCapacity,
      dispose: vi.fn(),
    },
  };
  if (kind === "classic") {
    fields.typeToAtlasCol = new Map<string, number>([
      [UT_CITY, 0],
      [UT_PORT, 1],
      [UT_FACTORY, 2],
      [UT_DEFENSE_POST, 3],
      [UT_SAM_LAUNCHER, 4],
      [UT_MISSILE_SILO, 5],
    ]);
  } else {
    fields.table = spriteTable;
  }
  Object.assign(pass, fields);

  return { pass, f32, bufferSubData, ensureCapacity };
}

function unit(overrides: Partial<UnitState>): UnitState {
  return {
    id: 0,
    unitType: "",
    ownerID: 0,
    lastOwnerID: null,
    pos: 0,
    lastPos: 0,
    isActive: true,
    reachedTarget: false,
    retreating: false,
    targetable: true,
    waitTicks: 0,
    markedForDeletion: false,
    health: null,
    underConstruction: false,
    targetUnitId: null,
    targetTile: null,
    troops: 0,
    missileTimerQueue: [],
    level: 1,
    veterancy: 0,
    hasTrainStation: false,
    trainType: null,
    loaded: null,
    constructionStartTick: null,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
    ...overrides,
  };
}

function sampleUnits(): Map<number, UnitState> {
  const units = new Map<number, UnitState>();
  // y=2, x=5
  units.set(1, unit({ unitType: UT_CITY, pos: 2 * MAP_W + 5, ownerID: 7 }));
  // y=3, x=2 — under construction, level 2 (still the base sprite)
  units.set(
    2,
    unit({
      unitType: UT_PORT,
      pos: 3 * MAP_W + 2,
      ownerID: 3,
      underConstruction: true,
      level: 2,
    }),
  );
  // Not a structure: must be skipped without consuming a slot.
  units.set(3, unit({ unitType: "Transport", pos: 0, ownerID: 1 }));
  // Inactive: skipped.
  units.set(
    4,
    unit({ unitType: UT_CITY, pos: 1, ownerID: 1, isActive: false }),
  );
  // y=4, x=10 — queued for deletion
  units.set(
    5,
    unit({
      unitType: UT_FACTORY,
      pos: 4 * MAP_W + 10,
      ownerID: 9,
      markedForDeletion: 12,
    }),
  );
  return units;
}

function readInstances(f32: Float32Array, count: number): number[][] {
  return Array.from({ length: count }, (_, i) =>
    Array.from(f32.slice(i * FLOATS_PER_INSTANCE, (i + 1) * FLOATS_PER_INSTANCE)),
  );
}

describe("StructurePass instance layout", () => {
  it("writes six floats per structure in the documented order", () => {
    const h = makeHarness("classic");
    h.pass.updateStructures(sampleUnits());

    expect(readInstances(h.f32, 3)).toEqual([
      [5, 2, 7, 0, 0, 0],
      [2, 3, 3, 1, 1, 0],
      [10, 4, 9, 0, 2, 1],
    ]);
    expect(h.bufferSubData).toHaveBeenCalledTimes(1);
    expect(h.bufferSubData.mock.calls[0][4]).toBe(3 * FLOATS_PER_INSTANCE);
    expect(h.ensureCapacity).toHaveBeenCalledTimes(3);
  });
});

describe("PixelStructurePass instance layout", () => {
  it("keeps the classic layout and stores the sprite slot in float 4", () => {
    const h = makeHarness("pixel");
    h.pass.updateStructures(sampleUnits());

    expect(readInstances(h.f32, 3)).toEqual([
      [5, 2, 7, 0, structureSpriteSlot(spriteTable, UT_CITY, 1), 0],
      [2, 3, 3, 1, structureSpriteSlot(spriteTable, UT_PORT, 2), 0],
      [10, 4, 9, 0, structureSpriteSlot(spriteTable, UT_FACTORY, 1), 1],
    ]);
    expect(h.bufferSubData).toHaveBeenCalledTimes(1);
    expect(h.bufferSubData.mock.calls[0][4]).toBe(3 * FLOATS_PER_INSTANCE);
    expect(h.ensureCapacity).toHaveBeenCalledTimes(3);
  });

  it("does not upload when only non-structures or inactive units are present", () => {
    const h = makeHarness("pixel");
    const units = new Map<number, UnitState>();
    units.set(1, unit({ unitType: "Transport", pos: 0, ownerID: 1 }));
    units.set(
      2,
      unit({ unitType: UT_CITY, pos: 0, ownerID: 1, isActive: false }),
    );

    h.pass.updateStructures(units);

    expect(h.bufferSubData).not.toHaveBeenCalled();
    expect(h.ensureCapacity).not.toHaveBeenCalled();
    expect((h.pass as unknown as { instanceCount: number }).instanceCount).toBe(
      0,
    );
  });
});

describe("structure sprite coverage", () => {
  it("assigns a level-1 slot to every structure type", () => {
    for (const unitType of STRUCTURE_SPRITES.keys()) {
      expect(structureSpriteSlot(spriteTable, unitType, 1)).toBeDefined();
    }
    expect(spriteTable.slots.length).toBe(STRUCTURE_SPRITES.size);
  });
});
