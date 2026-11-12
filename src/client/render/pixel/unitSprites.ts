/**
 * Unit sprite selection for the pixel renderer.
 *
 * The instance buffer is shared with the classic pass and its layout does not
 * change: four floats per unit, where the byte that used to be the atlas column
 * is now a sprite slot. This module owns the mapping from an engine unit (plus
 * the train sub-type) to that slot, and it is pure so the mapping can be tested
 * without a GPU.
 *
 * The art file uses names that describe the drawing (submarine, torpedo, flak)
 * while the engine only knows Transport, SAMMissile and MIRV Warhead. Keeping
 * the translation here means the art can grow before the engine gains those
 * unit types, and the shader never sees an engine string.
 */

import type { SpriteSet } from "./parseSprites";
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
} from "../types";

/** Synthetic keys for the three train sub-types. */
export const TRAIN_ENGINE_KEY = "TrainEngine";
export const TRAIN_CARRIAGE_KEY = "TrainCarriage";
export const TRAIN_CARRIAGE_LOADED_KEY = "TrainCarriageLoaded";

/**
 * Engine unit type (or train sub-type key) -> sprite name in units.txt.
 *
 * Order matches the classic atlas (UnitPass.UNIT_ORDER) so both renderers agree
 * on what "unit slot 0" means.
 */
export const UNIT_SPRITES: ReadonlyMap<string, string> = new Map([
  [UT_TRANSPORT, "submarine"],
  [UT_TRADE_SHIP, "trade_ship"],
  [UT_WARSHIP, "warship"],
  [UT_ATOM_BOMB, "bomb"],
  [UT_HYDROGEN_BOMB, "nuke"],
  [UT_MIRV, "missile"],
  [UT_SAM_MISSILE, "torpedo"],
  [UT_SHELL, "shell"],
  [UT_MIRV_WARHEAD, "flak"],
  [TRAIN_ENGINE_KEY, "train_locomotive"],
  [TRAIN_CARRIAGE_KEY, "train_car"],
  [TRAIN_CARRIAGE_LOADED_KEY, "train_wagon"],
]);

/** Slots reserved in the shader's per-slot uniform arrays. */
export const MAX_UNIT_SPRITE_SLOTS = UNIT_SPRITES.size;

/** Keys in slot-assignment order. */
export const UNIT_SPRITE_KEYS: readonly string[] = [...UNIT_SPRITES.keys()];

export interface UnitSpriteTable {
  /** Slot index -> sprite name. */
  readonly slots: readonly string[];
  /** Unit key (engine type or train sub-type) -> slot index. */
  readonly lookup: ReadonlyMap<string, number>;
}

/**
 * Resolve an engine unit to its sprite-table key.
 *
 * `Train` is the only type with sub-kinds: the two engine cars use the
 * locomotive, and carriages use the loaded wagon when they carry troops.
 * Returns undefined for units the pixel renderer has no art for.
 */
export function unitSpriteKey(
  unitType: string,
  trainType: number | null,
  loaded: boolean | null,
): string | undefined {
  if (unitType === UT_TRAIN) {
    if (trainType === TrainType.Engine || trainType === TrainType.TailEngine) {
      return TRAIN_ENGINE_KEY;
    }
    return loaded ? TRAIN_CARRIAGE_LOADED_KEY : TRAIN_CARRIAGE_KEY;
  }
  return UNIT_SPRITES.has(unitType) ? unitType : undefined;
}

/**
 * Assign one slot per sprite present in `sprites`, in UNIT_SPRITES order.
 * Missing art is skipped instead of guessed; the pass validates completeness
 * once at construction.
 */
export function buildUnitSpriteTable(sprites: SpriteSet): UnitSpriteTable {
  const slots: string[] = [];
  const lookup = new Map<string, number>();

  for (const key of UNIT_SPRITE_KEYS) {
    const name = UNIT_SPRITES.get(key);
    if (name === undefined || !sprites.has(name)) continue;
    lookup.set(key, slots.length);
    slots.push(name);
  }

  return { slots, lookup };
}

/** Slot for a unit, or undefined when the renderer has no sprite for it. */
export function unitSpriteSlot(
  table: UnitSpriteTable,
  unitType: string,
  trainType: number | null,
  loaded: boolean | null,
): number | undefined {
  const key = unitSpriteKey(unitType, trainType, loaded);
  if (key === undefined) return undefined;
  return table.lookup.get(key);
}
