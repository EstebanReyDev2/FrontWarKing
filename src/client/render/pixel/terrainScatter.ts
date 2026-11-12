/**
 * Deterministic terrain decoration placement.
 *
 * The terrain shader derives its dither from an integer hash; decoration must
 * use the same hash so a tile looks the same on every client, in live play and
 * in a replay. Nothing here touches the engine, the RNG or `Math.random`: the
 * output is a pure function of the terrain bytes, the map size and a fixed
 * project seed.
 *
 * Positions are picked once per map, at load. The pass keeps them in a static
 * instance buffer and draws them with one instanced call; a water nuke that
 * turns a decorated tile into water is handled in the vertex shader, which
 * re-reads the shared R8UI terrain texture and collapses the instance.
 */

/** Fixed style seed ("FWKS"). Presentation only — never reaches the engine. */
export const TERRAIN_SEED = 0x46574b53;

/** Decor sprite names, in kind order. Must match world.txt. */
export const DECOR_SPRITE_NAMES = ["tree", "rock", "hut"] as const;

export const DECOR_KIND_COUNT = DECOR_SPRITE_NAMES.length;

/** Approximate instances for a full map; the actual count follows land area. */
export const DEFAULT_SCATTER_TARGET = 2000;

export interface ScatterInstance {
  /** World-space centre of the prop, in tiles. */
  x: number;
  y: number;
  /** Index into DECOR_SPRITE_NAMES. */
  kind: number;
  /** 0..255; bit 0 flips the sprite horizontally. */
  variant: number;
}

/**
 * 32-bit integer hash. `Math.imul` keeps every multiply in the same wrapped
 * 32-bit domain as the shader's `uint` arithmetic, so the CPU and GPU can use
 * the identical constants.
 */
export function hashU32(
  x: number,
  y: number,
  seed: number = TERRAIN_SEED,
): number {
  let h = seed >>> 0;
  h = (h ^ Math.imul(x | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = (h ^ Math.imul(y | 0, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** True for land tiles that are not the impassable sentinel (mag 31). */
function isDecoratable(b: number): boolean {
  return (b & 0x80) !== 0 && (b & 0x1f) !== 31;
}

/**
 * Pick decoration instances from the raw terrain bytes.
 *
 * `targetCount` is a budget, not a promise: the acceptance rate is derived from
 * the whole map area, so a map with little land gets fewer props instead of a
 * denser carpet. The loop is a single pass over the map and is deterministic
 * for a given byte array, size, seed and target.
 */
export function buildScatterInstances(
  terrainBytes: Uint8Array,
  mapW: number,
  mapH: number,
  targetCount: number = DEFAULT_SCATTER_TARGET,
  seed: number = TERRAIN_SEED,
): ScatterInstance[] {
  if (mapW <= 0 || mapH <= 0) return [];
  if (terrainBytes.length < mapW * mapH) {
    throw new Error(
      `terrain bytes ${terrainBytes.length} shorter than ${mapW}x${mapH}`,
    );
  }

  const target = Math.max(1, Math.floor(targetCount));
  const rate = Math.max(1, Math.floor((mapW * mapH) / target));
  // Hard stop only protects against a pathological target; a uniform map
  // cannot exceed `target` in expectation, so this never biases normal maps.
  const maxInstances = target * 4;
  const out: ScatterInstance[] = [];

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      if (!isDecoratable(terrainBytes[y * mapW + x])) continue;

      const h = hashU32(x, y, seed);
      if (h % rate !== 0) continue;

      // High bits are independent of the low-bit acceptance test above.
      const kind = (h >>> 16) % DECOR_KIND_COUNT;
      const variant = (h >>> 8) & 0xff;
      // Keep the centre inside the middle 60% of the tile so props do not
      // visibly snap to tile corners at high zoom.
      const ox = ((h >>> 4) & 0x3f) / 63;
      const oy = ((h >>> 10) & 0x3f) / 63;

      out.push({
        x: x + 0.2 + ox * 0.6,
        y: y + 0.2 + oy * 0.6,
        kind,
        variant,
      });
      if (out.length >= maxInstances) return out;
    }
  }

  return out;
}
