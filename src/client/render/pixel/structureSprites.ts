/**
 * Structure sprite selection for the pixel renderer.
 *
 * The instance buffer is shared with the classic pass and its layout does not
 * change: six floats per structure, where the fifth one used to be the atlas
 * column and is now the sprite slot. This module owns the mapping from
 * `(unitType, level)` to that slot, and it is pure so the mapping can be tested
 * without a GPU.
 *
 * Levels resolve as `<base>_l<level>`, then `<base>_l<level-1>`, ... down to
 * `<base>`. Only the base art ships in F3b, so every level currently collapses
 * to the same sprite; adding `city_l2` to structures.txt is enough to light the
 * variant up. The level number itself keeps coming from StructureLevelPass.
 */

import type { SpriteSet } from "./parseSprites";
import {
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
} from "../types";

/**
 * Structure types in the order the slots are assigned. Kept in the classic
 * atlas order (StructurePass.STRUCTURE_ORDER) so both renderers agree on what
 * "structure index 0" means.
 */
export const STRUCTURE_SPRITES: ReadonlyMap<string, string> = new Map([
  [UT_CITY, "city"],
  [UT_PORT, "port"],
  [UT_FACTORY, "factory"],
  [UT_DEFENSE_POST, "defense_post"],
  [UT_SAM_LAUNCHER, "sam"],
  [UT_MISSILE_SILO, "silo"],
]);

/** Highest level with a dedicated variant slot. Levels above clamp to it. */
export const MAX_STRUCTURE_LEVEL = 3;

export const STRUCTURE_TYPE_COUNT = STRUCTURE_SPRITES.size;

/** Slots reserved in the shader's per-slot uniform arrays. */
export const MAX_STRUCTURE_SPRITE_SLOTS =
  STRUCTURE_TYPE_COUNT * MAX_STRUCTURE_LEVEL;

/** Unit type names in slot-assignment order. */
export const STRUCTURE_TYPE_NAMES: readonly string[] = [...STRUCTURE_SPRITES.keys()];

export interface StructureSpriteTable {
  /** Slot index -> sprite name. */
  readonly slots: readonly string[];
  /** Slot index -> structure type index (0..5). */
  readonly slotTypes: readonly number[];
  /** `structureSpriteKey(typeIndex, level)` -> slot index. */
  readonly lookup: ReadonlyMap<number, number>;
  /** Unit type -> structure type index. */
  readonly typeIndex: ReadonlyMap<string, number>;
}

/** Clamp a structure level into the range that has slots. */
export function clampStructureLevel(level: number): number {
  const integer = Math.floor(level);
  if (!Number.isFinite(integer)) return 1;
  return Math.min(MAX_STRUCTURE_LEVEL, Math.max(1, integer));
}

/** Stable numeric key for `(type index, level)`; avoids string maps per frame. */
export function structureSpriteKey(
  typeIndex: number,
  level: number,
): number {
  return typeIndex * MAX_STRUCTURE_LEVEL + clampStructureLevel(level) - 1;
}

/**
 * Sprite names to try for a structure, most specific first. Unknown types
 * return an empty list instead of guessing.
 */
export function structureSpriteCandidates(
  unitType: string,
  level: number,
): string[] {
  const base = STRUCTURE_SPRITES.get(unitType);
  if (base === undefined) return [];
  const top = clampStructureLevel(level);
  const names: string[] = [];
  for (let l = top; l > 1; l--) names.push(`${base}_l${l}`);
  names.push(base);
  return names;
}

/** First candidate present in `sprites`, or undefined when the type is unknown. */
export function structureSpriteName(
  sprites: SpriteSet,
  unitType: string,
  level: number,
): string | undefined {
  return structureSpriteCandidates(unitType, level).find((name) =>
    sprites.has(name),
  );
}

/**
 * Assign one slot per distinct sprite name, in type-then-level order. Levels
 * that fall back to an existing sprite share its slot, so the uniform arrays
 * stay as small as the art allows.
 */
export function buildStructureSpriteTable(
  sprites: SpriteSet,
): StructureSpriteTable {
  const slots: string[] = [];
  const slotTypes: number[] = [];
  const slotOf = new Map<string, number>();
  const lookup = new Map<number, number>();
  const typeIndex = new Map<string, number>();

  let index = 0;
  for (const unitType of STRUCTURE_TYPE_NAMES) {
    typeIndex.set(unitType, index);
    for (let level = 1; level <= MAX_STRUCTURE_LEVEL; level++) {
      const name = structureSpriteName(sprites, unitType, level);
      if (name === undefined) continue;
      let slot = slotOf.get(name);
      if (slot === undefined) {
        slot = slots.length;
        slotOf.set(name, slot);
        slots.push(name);
        slotTypes.push(index);
      }
      lookup.set(structureSpriteKey(index, level), slot);
    }
    index++;
  }

  return { slots, slotTypes, lookup, typeIndex };
}

/** Slot for a structure, or undefined when the type is not a structure. */
export function structureSpriteSlot(
  table: StructureSpriteTable,
  unitType: string,
  level: number,
): number | undefined {
  const typeIndex = table.typeIndex.get(unitType);
  if (typeIndex === undefined) return undefined;
  return table.lookup.get(structureSpriteKey(typeIndex, level));
}
