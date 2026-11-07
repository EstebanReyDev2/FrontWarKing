import { describe, expect, it } from "vitest";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import {
  hexToRgb,
  PALETTE_SLOT_COUNT,
  parsePalette,
  PaletteParseError,
  rgbToHex,
  TRANSPARENT_INDEX,
} from "../../../../src/client/render/pixel/parsePalette";

const palette = parsePalette(naturalRaw, "natural");

function withoutLine(match: string): string {
  return naturalRaw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(match))
    .join("\n");
}

describe("parsePalette", () => {
  it("reads the shipped palette as 16 named slots", () => {
    expect(palette.slots).toHaveLength(PALETTE_SLOT_COUNT);
    expect(palette.colors).toHaveLength(15);
    expect(palette.name).toBe("natural");
    expect(new Set(palette.slots.map((slot) => slot.symbol)).size).toBe(
      PALETTE_SLOT_COUNT,
    );
  });

  it("has exactly one transparent slot mapping to atlas 255", () => {
    const transparent = palette.slots.filter(
      (slot) => slot.kind === "transparent",
    );
    expect(transparent).toHaveLength(1);
    expect(transparent[0].symbol).toBe(".");
    expect(palette.symbolToIndex.get(".")).toBe(TRANSPARENT_INDEX);
    expect(transparent[0].index).toBe(TRANSPARENT_INDEX);
  });

  it("has three distinct dynamic player slots", () => {
    expect(palette.playerIndexes.fill).not.toBe(palette.playerIndexes.border);
    expect(palette.playerIndexes.border).not.toBe(palette.playerIndexes.accent);
    expect(palette.playerIndexes.fill).not.toBe(palette.playerIndexes.accent);
    for (const index of Object.values(palette.playerIndexes)) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(15);
    }
    expect(
      palette.colors.filter((slot) => slot.kind.startsWith("player-")),
    ).toHaveLength(3);
  });

  it("numbers fixed and player slots 0..14 in file order", () => {
    expect(palette.colors.map((slot) => slot.index)).toEqual(
      Array.from({ length: 15 }, (_, index) => index),
    );
  });

  it("accepts a second palette with the same symbols and different colours", () => {
    const recoloured = naturalRaw.replace(/#[0-9a-f]{6}/gi, "#010203");
    const other = parsePalette(recoloured, "other");
    expect([...other.symbolToIndex.keys()]).toEqual([
      ...palette.symbolToIndex.keys(),
    ]);
    expect(hexToRgb(other.colors[0].hex as string)).toEqual({
      r: 1,
      g: 2,
      b: 3,
    });
  });

  it("tolerates CRLF and a BOM", () => {
    const text = `\uFEFF${naturalRaw.replace(/\n/g, "\r\n")}`;
    expect(parsePalette(text, "natural").slots).toHaveLength(16);
  });

  it("rejects the wrong number of slots", () => {
    expect(() => parsePalette(withoutLine("y  #e0bd57"), "short")).toThrow(
      /expected 16 slots, got 15/,
    );
    expect(() =>
      parsePalette(`${naturalRaw}\nz  #111111  extra`, "long"),
    ).toThrow(/expected 16 slots, got 17/);
  });

  it("rejects duplicate symbols", () => {
    const text = naturalRaw.replace(/^g\s+#70844b.*$/m, "k  #70844b grass");
    expect(() => parsePalette(text, "dupe")).toThrow(/duplicate symbol "k"/);
  });

  it("rejects a palette without a transparent slot", () => {
    const text = naturalRaw.replace(/^\.\s+-.*$/m, "z  #000000 opaque");
    expect(() => parsePalette(text, "opaque")).toThrow(/no transparent slot/);
  });

  it("rejects two transparent slots", () => {
    const text = naturalRaw.replace(/^k\s+#172022.*$/m, "k  -  second");
    expect(() => parsePalette(text, "twice")).toThrow(
      /duplicate transparent slot/,
    );
  });

  it("rejects a missing player role", () => {
    const text = naturalRaw.replace(
      /^P\s+@player-fill.*$/m,
      "P  #123456 not-a-role",
    );
    expect(() => parsePalette(text, "norole")).toThrow(/missing @player-fill/);
  });

  it("rejects a duplicated player role", () => {
    const text = naturalRaw.replace(
      /^B\s+@player-border.*$/m,
      "B  @player-fill again",
    );
    expect(() => parsePalette(text, "duperole")).toThrow(
      /duplicate @player-fill/,
    );
  });

  it("rejects malformed colours and multi-character symbols", () => {
    expect(() =>
      parsePalette(naturalRaw.replace("#172022", "#12345"), "hex"),
    ).toThrow(/expected #rrggbb/);
    expect(() =>
      parsePalette(naturalRaw.replace(/^k\s+/m, "kk "), "symbol"),
    ).toThrow(/single-character symbol/);
  });

  it("reports the source and line of an error", () => {
    try {
      parsePalette(withoutLine("y  #e0bd57"), "broken.txt");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PaletteParseError);
      expect((error as PaletteParseError).source).toBe("broken.txt");
      expect((error as PaletteParseError).line).toBeGreaterThan(0);
    }
  });
});

describe("hex helpers", () => {
  it("round-trips a colour", () => {
    expect(rgbToHex(hexToRgb("#172022"))).toBe("#172022");
  });

  it("rejects a malformed colour", () => {
    expect(() => hexToRgb("172022")).toThrow(/invalid colour/);
  });
});
