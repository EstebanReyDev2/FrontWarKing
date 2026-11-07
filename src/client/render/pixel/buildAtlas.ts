/**
 * Runtime sprite atlas.
 *
 * Sprites are packed into a square power-of-two index grid (one byte per
 * pixel, 255 = transparent). Nothing here touches a GPU: the output is a plain
 * `Uint8Array`, which is what makes the atlas testable in Node and what lets
 * the shader resolve colours through a palette texture later.
 *
 * Packing is a deterministic shelf layout: 32x32 sprites first, then 16x16,
 * and names ascending inside each group. GIF frames are laid out left to right
 * inside the sprite's cell.
 */

import { TRANSPARENT_INDEX, type Palette } from "./parsePalette";
import type { SpriteDef, SpriteSet } from "./parseSprites";

export interface AtlasRect {
  x: number;
  y: number;
  /** Width of one frame, not of the whole animation strip. */
  w: number;
  h: number;
  frames: number;
}

export interface SpriteAtlas {
  /** Row-major indices, `width * height` bytes. 255 is transparent. */
  indices: Uint8Array;
  width: number;
  height: number;
  rects: ReadonlyMap<string, AtlasRect>;
}

export const ATLAS_CANDIDATE_SIZES = [256, 512, 1024] as const;

export class AtlasBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlasBuildError";
  }
}

/**
 * 32x32 cells make use of the first shelf, so they must be placed first or a
 * tall 16x16 shelf could push them out of the smallest atlas that would
 * otherwise fit.
 */
function packOrder(sprites: Iterable<SpriteDef>): SpriteDef[] {
  return [...sprites].sort((a, b) => {
    if (a.width !== b.width) return b.width - a.width;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function shelfPack(
  sprites: readonly SpriteDef[],
  size: number,
): Map<string, AtlasRect> | null {
  const rects = new Map<string, AtlasRect>();
  let x = 0;
  let y = 0;
  let shelfHeight = 0;

  for (const sprite of sprites) {
    const frames = sprite.frames.length;
    const cellWidth = sprite.width * frames;
    const cellHeight = sprite.height;
    if (cellWidth > size || cellHeight > size) return null;

    if (x > 0 && x + cellWidth > size) {
      y += shelfHeight;
      x = 0;
      shelfHeight = 0;
    }
    if (y + cellHeight > size) return null;

    rects.set(sprite.name, {
      x,
      y,
      w: sprite.width,
      h: sprite.height,
      frames,
    });
    x += cellWidth;
    shelfHeight = Math.max(shelfHeight, cellHeight);
  }

  return rects;
}

/**
 * Build the atlas indices and layout for a sprite set. The smallest candidate
 * size that fits wins; if even the largest does not fit, this throws instead
 * of returning a clipped atlas.
 */
export function buildAtlas(
  sprites: SpriteSet | Iterable<SpriteDef>,
  palette: Palette,
): SpriteAtlas {
  const ordered = packOrder(
    typeof (sprites as SpriteSet).values === "function"
      ? (sprites as SpriteSet).values()
      : (sprites as Iterable<SpriteDef>),
  );

  for (const size of ATLAS_CANDIDATE_SIZES) {
    const rects = shelfPack(ordered, size);
    if (rects === null) continue;

    const indices = new Uint8Array(size * size);
    indices.fill(TRANSPARENT_INDEX);

    for (const sprite of ordered) {
      const rect = rects.get(sprite.name);
      if (rect === undefined) continue;
      for (let frame = 0; frame < sprite.frames.length; frame++) {
        const rows = sprite.frames[frame].rows;
        for (let row = 0; row < sprite.height; row++) {
          const line = rows[row];
          const targetRow = rect.y + row;
          const targetBase = targetRow * size + rect.x + frame * rect.w;
          for (let col = 0; col < sprite.width; col++) {
            const symbol = line[col];
            const index = palette.symbolToIndex.get(symbol);
            if (index === undefined) {
              // parseSprites already validated this; a missing symbol here
              // means the sprite set and the palette disagree.
              throw new AtlasBuildError(
                `sprite ${JSON.stringify(sprite.name)} uses ${JSON.stringify(symbol)}, absent from palette ${JSON.stringify(palette.name)}`,
              );
            }
            indices[targetBase + col] = index;
          }
        }
      }
    }

    return { indices, width: size, height: size, rects };
  }

  throw new AtlasBuildError(
    `sprites do not fit in the largest atlas (${ATLAS_CANDIDATE_SIZES[ATLAS_CANDIDATE_SIZES.length - 1]}x${ATLAS_CANDIDATE_SIZES[ATLAS_CANDIDATE_SIZES.length - 1]})`,
  );
}

/** Byte offset of `frame` inside a rect, for tests and callers. */
export function frameOrigin(
  rect: AtlasRect,
  frame: number,
): { x: number; y: number } {
  return { x: rect.x + frame * rect.w, y: rect.y };
}
