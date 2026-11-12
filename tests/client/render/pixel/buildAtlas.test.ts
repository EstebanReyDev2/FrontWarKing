import { describe, expect, it } from "vitest";
import {
  ATLAS_CANDIDATE_SIZES,
  buildAtlas,
  frameOrigin,
  type AtlasRect,
} from "../../../../src/client/render/pixel/buildAtlas";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import {
  TRANSPARENT_INDEX,
  parsePalette,
} from "../../../../src/client/render/pixel/parsePalette";
import { parseSprites } from "../../../../src/client/render/pixel/parseSprites";
import devSpritesRaw from "../../../../src/client/render/pixel/sprites/dev.txt?raw";

const palette = parsePalette(naturalRaw, "natural");
const palettes = new Map([["natural", palette]]);

function devSprites() {
  return parseSprites([{ name: "dev.txt", text: devSpritesRaw }], palettes);
}

function rows(size = 16, fill = "."): string[] {
  return Array.from({ length: size }, () => fill.repeat(size));
}

function spriteText(name: string, extra: string[], size = 16): string[] {
  return [`@sprite ${name}`, ...extra, "@frame 0", ...rows(size)];
}

function overlap(a: AtlasRect, b: AtlasRect): boolean {
  const aw = a.w * a.frames;
  const bw = b.w * b.frames;
  return !(
    a.x + aw <= b.x ||
    b.x + bw <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

describe("buildAtlas", () => {
  it("is deterministic and matches the stored layout", () => {
    const sprites = devSprites();
    const first = buildAtlas(sprites, palette);
    const second = buildAtlas(sprites, palette);

    expect(first.indices).toEqual(second.indices);
    expect([...first.rects]).toEqual([...second.rects]);

    const layout = Object.fromEntries(
      [...first.rects].map(([name, rect]) => [name, { ...rect }]),
    );
    expect(layout).toMatchSnapshot();
  });

  it("uses a square power-of-two atlas", () => {
    const atlas = buildAtlas(devSprites(), palette);
    expect(atlas.width).toBe(atlas.height);
    expect(ATLAS_CANDIDATE_SIZES).toContain(atlas.width);
    expect((atlas.width & (atlas.width - 1)) === 0).toBe(true);
    expect(atlas.indices).toHaveLength(atlas.width * atlas.height);
  });

  it("never overlaps two sprites", () => {
    const atlas = buildAtlas(devSprites(), palette);
    const rects = [...atlas.rects.entries()];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(
          overlap(rects[i][1], rects[j][1]),
          `${rects[i][0]} overlaps ${rects[j][0]}`,
        ).toBe(false);
      }
    }
  });

  it("places 32x32 sprites before 16x16 ones regardless of name", () => {
    const text = [
      ...spriteText("zz32", ["@size 32 32"], 32),
      ...spriteText("aa16", []),
    ].join("\n");
    const atlas = buildAtlas(
      parseSprites([{ name: "order.txt", text }], palettes),
      palette,
    );
    const big = atlas.rects.get("zz32");
    const small = atlas.rects.get("aa16");
    expect(big).toEqual({ x: 0, y: 0, w: 32, h: 32, frames: 1 });
    expect(small?.x).toBe(32);
    expect(small?.y).toBe(0);
  });

  it("writes 255 for the transparent symbol", () => {
    const atlas = buildAtlas(devSprites(), palette);
    const rect = atlas.rects.get("test_static");
    expect(rect).toBeDefined();
    if (!rect) return;
    expect(atlas.indices[rect.y * atlas.width + rect.x]).toBe(
      TRANSPARENT_INDEX,
    );
  });

  it("lays every animation frame in its own cell", () => {
    const markers = ["k", "r", "y", "d"];
    const text = ["@sprite anim", "@fps 4"];
    for (let frame = 0; frame < markers.length; frame++) {
      const frameRows = rows();
      frameRows[1] = `.${markers[frame]}${frameRows[1].slice(2)}`;
      text.push(`@frame ${frame}`, ...frameRows);
    }
    const atlas = buildAtlas(
      parseSprites([{ name: "anim.txt", text: text.join("\n") }], palettes),
      palette,
    );
    const rect = atlas.rects.get("anim");
    expect(rect?.frames).toBe(4);
    if (!rect) return;

    for (let frame = 0; frame < markers.length; frame++) {
      const origin = frameOrigin(rect, frame);
      const index = palette.symbolToIndex.get(markers[frame]);
      expect(index).toBeDefined();
      expect(atlas.indices[(origin.y + 1) * atlas.width + origin.x + 1]).toBe(
        index,
      );
    }
  });
});
