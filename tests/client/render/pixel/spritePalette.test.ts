import { describe, expect, it } from "vitest";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import {
  parsePalette,
  type Rgb,
} from "../../../../src/client/render/pixel/parsePalette";
import {
  ACCENT_LIGHTEN,
  buildSpritePalette,
  lightenRgb,
  NEUTRAL_BORDER,
  NEUTRAL_FILL,
  SPRITE_PALETTE_SOURCE_ROWS,
  SPRITE_PALETTE_WIDTH,
  writeSpritePaletteRow,
  type SpritePaletteRows,
} from "../../../../src/client/render/pixel/SpritePalette";

const palette = parsePalette(naturalRaw, "natural");
const borderBlock = SPRITE_PALETTE_SOURCE_ROWS * 4;

function makeData(): Float32Array {
  return new Float32Array(SPRITE_PALETTE_SOURCE_ROWS * 2 * 4);
}

function setPlayer(
  data: Float32Array,
  smallID: number,
  fill: Rgb,
  border: Rgb,
): void {
  const off = smallID * 4;
  data[off] = fill.r / 255;
  data[off + 1] = fill.g / 255;
  data[off + 2] = fill.b / 255;
  data[off + 3] = 150 / 255;
  const borderOff = borderBlock + smallID * 4;
  data[borderOff] = border.r / 255;
  data[borderOff + 1] = border.g / 255;
  data[borderOff + 2] = border.b / 255;
  data[borderOff + 3] = 1;
}

function pixel(
  rows: SpritePaletteRows,
  row: number,
  index: number,
): [number, number, number, number] {
  const off = (row * SPRITE_PALETTE_WIDTH + index) * 4;
  return [
    rows.data[off],
    rows.data[off + 1],
    rows.data[off + 2],
    rows.data[off + 3],
  ];
}

describe("buildSpritePalette", () => {
  it("derives fill, border and accent from paletteData", () => {
    const data = makeData();
    setPlayer(data, 1, { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });
    const rows = buildSpritePalette(data, palette, 3);

    expect(pixel(rows, 1, palette.playerIndexes.fill)).toEqual([
      255, 0, 0, 255,
    ]);
    expect(pixel(rows, 1, palette.playerIndexes.border)).toEqual([
      0, 0, 255, 255,
    ]);
    expect(pixel(rows, 1, palette.playerIndexes.accent)).toEqual([
      77, 77, 255, 255,
    ]);
  });

  it("keeps each smallID independent", () => {
    const data = makeData();
    setPlayer(data, 1, { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });
    setPlayer(data, 2, { r: 0, g: 255, b: 0 }, { r: 255, g: 255, b: 0 });
    const rows = buildSpritePalette(data, palette, 3);

    expect(pixel(rows, 2, palette.playerIndexes.fill)).toEqual([
      0, 255, 0, 255,
    ]);
    expect(pixel(rows, 2, palette.playerIndexes.border)).toEqual([
      255, 255, 0, 255,
    ]);
    expect(pixel(rows, 2, palette.playerIndexes.accent)).toEqual([
      255, 255, 77, 255,
    ]);
    // Row 1 is untouched by row 2.
    expect(pixel(rows, 1, palette.playerIndexes.fill)).toEqual([
      255, 0, 0, 255,
    ]);
  });

  it("writes the neutral world palette in row 0", () => {
    const rows = buildSpritePalette(makeData(), palette, 2);
    expect(pixel(rows, 0, palette.playerIndexes.fill)).toEqual([
      NEUTRAL_FILL.r,
      NEUTRAL_FILL.g,
      NEUTRAL_FILL.b,
      255,
    ]);
    expect(pixel(rows, 0, palette.playerIndexes.border)).toEqual([
      NEUTRAL_BORDER.r,
      NEUTRAL_BORDER.g,
      NEUTRAL_BORDER.b,
      255,
    ]);
    const accent = lightenRgb(NEUTRAL_BORDER, ACCENT_LIGHTEN);
    expect(pixel(rows, 0, palette.playerIndexes.accent)).toEqual([
      accent.r,
      accent.g,
      accent.b,
      255,
    ]);
  });

  it("writes the twelve fixed colours unchanged on every row", () => {
    const data = makeData();
    setPlayer(data, 1, { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });
    const rows = buildSpritePalette(data, palette, 2);
    expect(pixel(rows, 0, 0)).toEqual([0x17, 0x20, 0x22, 255]);
    expect(pixel(rows, 1, 0)).toEqual([0x17, 0x20, 0x22, 255]);
    for (let row = 0; row < 2; row++) {
      for (const slot of palette.colors.filter((s) => s.kind === "fixed")) {
        expect(pixel(rows, row, slot.index)[3]).toBe(255);
      }
    }
  });

  it("falls back to neutral colours when paletteData is short", () => {
    const rows = buildSpritePalette(new Float32Array(0), palette, 2);
    expect(pixel(rows, 1, palette.playerIndexes.fill)).toEqual([
      NEUTRAL_FILL.r,
      NEUTRAL_FILL.g,
      NEUTRAL_FILL.b,
      255,
    ]);
    expect(pixel(rows, 1, palette.playerIndexes.border)).toEqual([
      NEUTRAL_BORDER.r,
      NEUTRAL_BORDER.g,
      NEUTRAL_BORDER.b,
      255,
    ]);
  });

  it("rejects an empty texture height", () => {
    expect(() => buildSpritePalette(makeData(), palette, 0)).toThrow(
      /height must be >= 1/,
    );
  });
});

describe("writeSpritePaletteRow", () => {
  it("updates one row and leaves the others alone", () => {
    const data = makeData();
    setPlayer(data, 1, { r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 });
    const rows = buildSpritePalette(data, palette, 3);
    const before = pixel(rows, 1, palette.playerIndexes.fill);

    writeSpritePaletteRow(
      rows.data,
      2,
      palette,
      { r: 0, g: 255, b: 0 },
      { r: 255, g: 255, b: 0 },
    );

    expect(pixel(rows, 2, palette.playerIndexes.fill)).toEqual([
      0, 255, 0, 255,
    ]);
    expect(pixel(rows, 1, palette.playerIndexes.fill)).toEqual(before);
  });
});
