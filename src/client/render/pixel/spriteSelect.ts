/**
 * Pure selection helpers for the pixel renderer: which sprite variant a tile
 * gets, whether a zoom level is detailed enough for a sprite, and which frame
 * an animation is on.
 *
 * Everything is deterministic and GPU-free. The hash is 32-bit integer
 * arithmetic, the same shape as `flickerHashByte` in UnitPass, so two clients
 * (or a live game and its replay) pick the same variant for the same tile.
 */

import type { SpriteDef, SpriteSet } from "./parseSprites";

/** "FWKS" — a project constant, never derived from the engine or the turn. */
export const FW_PIXEL_SEED = 0x46574b53;

/** Below this zoom structures collapse to the existing colour dot. */
export const STRUCTURE_DOTS_ZOOM = 1.2;

/** A sprite smaller than this many screen pixels is not worth drawing. */
export const SPRITE_MIN_PIXELS = 4;

/** Nominal sprite size in source pixels (16x16 is the base format). */
export const SPRITE_SOURCE_PIXELS = 16;

export type SpriteLod = "dot" | "sprite";

/**
 * 32-bit unsigned hash of a tile position. Uses `Math.imul` throughout so the
 * result is exact on every JS engine; `fract(sin())` style hashes are not.
 */
export function hashU(
  x: number,
  y: number,
  seed: number = FW_PIXEL_SEED,
): number {
  let n =
    (Math.imul(x | 0, 374761393) +
      Math.imul(y | 0, 668265263) +
      Math.imul(seed | 0, 1442695041)) |
    0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
}

/** Hash normalised to [0, 1). */
export function hashUnit(
  x: number,
  y: number,
  seed: number = FW_PIXEL_SEED,
): number {
  return hashU(x, y, seed) / 0x1_0000_0000;
}

/**
 * Structures keep the renderer's existing dot LOD: below 1.2 they are a
 * coloured point, above it a sprite.
 */
export function structureLod(zoom: number): SpriteLod {
  return zoom < STRUCTURE_DOTS_ZOOM ? "dot" : "sprite";
}

/**
 * Units and FX: a 16px sprite compressed under 4 screen pixels vibrates when
 * the camera moves, so the pass draws a 2x2 silhouette or a colour dot
 * instead. `dpr` is included because screen pixels are physical pixels.
 */
export function spriteLod(
  zoom: number,
  dpr = 1,
  sourcePixels: number = SPRITE_SOURCE_PIXELS,
): SpriteLod {
  return sourcePixels * zoom * dpr < SPRITE_MIN_PIXELS ? "dot" : "sprite";
}

/**
 * Frame for an animation at `elapsedMs`. Static sprites (fps 0) and
 * single-frame sprites always return frame 0. Non-looping animations clamp on
 * the last frame instead of wrapping.
 */
export function frameIndexAt(
  elapsedMs: number,
  fps: number,
  frameCount: number,
  loop: boolean,
): number {
  if (frameCount <= 1 || fps <= 0) return 0;
  const advance = Math.floor((Math.max(0, elapsedMs) * fps) / 1000);
  return loop ? advance % frameCount : Math.min(frameCount - 1, advance);
}

/** Sprites carrying `tag`, sorted by name with plain code-unit comparison. */
export function spritesWithTag(sprites: SpriteSet, tag: string): SpriteDef[] {
  return [...sprites.values()]
    .filter((sprite) => sprite.tags.includes(tag))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Pick one of the sprites carrying `tag` from the tile hash. Returns
 * undefined when nothing is tagged; callers then keep the current look.
 */
export function pickTaggedSprite(
  sprites: SpriteSet,
  tag: string,
  x: number,
  y: number,
  seed: number = FW_PIXEL_SEED,
): SpriteDef | undefined {
  const candidates = spritesWithTag(sprites, tag);
  if (candidates.length === 0) return undefined;
  return candidates[hashU(x, y, seed) % candidates.length];
}
