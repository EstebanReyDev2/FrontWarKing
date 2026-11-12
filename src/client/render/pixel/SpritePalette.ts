/**
 * The 16-wide sprite palette texture, derived from the renderer's existing
 * `paletteData` instead of changing `PlayerPalette`.
 *
 * `paletteData` is `Float32Array(PALETTE_SIZE * 2 * 4)`: a fill RGBA block and
 * a border RGBA block, both indexed by `smallID` (see
 * `gl/utils/PlayerPalette.ts`). This module turns each player's fill/border
 * into the three dynamic sprite slots:
 *
 *   P = fill
 *   B = border
 *   C = border lightened (the accent; F7 can replace it with a civ colour)
 *
 * Row 0 is the world palette with neutral dynamic colours; rows 1..4095 are
 * one player each. The texture is RGBA8 16x4096 = 256 KB and is written once
 * per palette change, not per frame.
 */

import { hexToRgb, type Palette, type Rgb } from "./parsePalette";

/** Width of the sprite palette texture: one texel per palette slot. */
export const SPRITE_PALETTE_WIDTH = 16;

/** Rows in the sprite palette texture, matching `ColorUtils.PALETTE_SIZE`. */
export const SPRITE_PALETTE_SOURCE_ROWS = 4096;

/** How far the accent moves the border toward white. */
export const ACCENT_LIGHTEN = 0.3;

export const NEUTRAL_FILL: Rgb = { r: 0x8a, g: 0x8a, b: 0x8a };
export const NEUTRAL_BORDER: Rgb = { r: 0xd8, g: 0xd8, b: 0xd8 };

export interface SpritePaletteRows {
  width: number;
  height: number;
  /** RGBA8, `width * height * 4` bytes. */
  data: Uint8Array;
}

/** Mix `rgb` toward white by `amount` (0..1), rounding to bytes. */
export function lightenRgb(rgb: Rgb, amount = ACCENT_LIGHTEN): Rgb {
  const mix = (channel: number) =>
    Math.round(channel + (255 - channel) * amount);
  return { r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) };
}

function byteChannel(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

/**
 * Write one row: the 12 fixed colours from the palette plus the three dynamic
 * slots resolved from `fill`/`border`. The transparent slot has no texel and
 * slot 15 stays zeroed (shaders discard indices above 14 anyway).
 */
export function writeSpritePaletteRow(
  data: Uint8Array,
  row: number,
  palette: Palette,
  fill: Rgb,
  border: Rgb,
): void {
  const rowBase = row * SPRITE_PALETTE_WIDTH * 4;
  data.fill(0, rowBase, rowBase + SPRITE_PALETTE_WIDTH * 4);

  const accent = lightenRgb(border);
  for (const slot of palette.colors) {
    let rgb: Rgb;
    switch (slot.kind) {
      case "player-fill":
        rgb = fill;
        break;
      case "player-border":
        rgb = border;
        break;
      case "player-accent":
        rgb = accent;
        break;
      case "fixed":
        rgb = hexToRgb(slot.hex as string);
        break;
      default:
        continue;
    }
    const off = rowBase + slot.index * 4;
    data[off] = rgb.r;
    data[off + 1] = rgb.g;
    data[off + 2] = rgb.b;
    data[off + 3] = 255;
  }
}

function readPaletteColor(
  paletteData: Float32Array,
  offset: number,
): Rgb | null {
  if (offset + 2 >= paletteData.length) return null;
  return {
    r: byteChannel(paletteData[offset]),
    g: byteChannel(paletteData[offset + 1]),
    b: byteChannel(paletteData[offset + 2]),
  };
}

/**
 * Build the full sprite palette texture. `height` defaults to the renderer's
 * palette size and exists mainly so tests can build a short texture.
 */
export function buildSpritePalette(
  paletteData: Float32Array,
  palette: Palette,
  height = SPRITE_PALETTE_SOURCE_ROWS,
): SpritePaletteRows {
  if (height < 1) throw new Error(`sprite palette height must be >= 1`);

  const data = new Uint8Array(SPRITE_PALETTE_WIDTH * height * 4);
  writeSpritePaletteRow(data, 0, palette, NEUTRAL_FILL, NEUTRAL_BORDER);

  const borderBlock = SPRITE_PALETTE_SOURCE_ROWS * 4;
  for (let smallID = 1; smallID < height; smallID++) {
    const fill = readPaletteColor(paletteData, smallID * 4) ?? NEUTRAL_FILL;
    const border =
      readPaletteColor(paletteData, borderBlock + smallID * 4) ??
      NEUTRAL_BORDER;
    writeSpritePaletteRow(data, smallID, palette, fill, border);
  }

  return { width: SPRITE_PALETTE_WIDTH, height, data };
}
