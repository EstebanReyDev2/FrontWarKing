import { describe, expect, it } from "vitest";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import { parsePalette } from "../../../../src/client/render/pixel/parsePalette";
import {
  parseSprites,
  SpriteParseError,
  type SpriteSource,
} from "../../../../src/client/render/pixel/parseSprites";

const palette = parsePalette(naturalRaw, "natural");
const palettes = new Map([["natural", palette]]);

function rows(size = 16, fill = "."): string[] {
  return Array.from({ length: size }, () => fill.repeat(size));
}

function spriteText(name: string, extra: string[] = []): string {
  return [`@sprite ${name}`, ...extra, "@frame 0", ...rows()].join("\n");
}

function parse(text: string): ReturnType<typeof parseSprites> {
  return parseSprites([{ name: "test.txt", text }], palettes);
}

describe("parseSprites", () => {
  it("parses a valid static sprite", () => {
    const sprites = parse(spriteText("house", ["@tags structure,city"]));
    const house = sprites.get("house");
    expect(house).toBeDefined();
    expect(house?.width).toBe(16);
    expect(house?.height).toBe(16);
    expect(house?.palette).toBe("natural");
    expect(house?.fps).toBe(0);
    expect(house?.loop).toBe(true);
    expect(house?.anchor).toBe("center");
    expect(house?.world).toEqual([1, 1]);
    expect(house?.tags).toEqual(["structure", "city"]);
    expect(house?.frames).toHaveLength(1);
    expect(house?.frames[0].rows).toHaveLength(16);
  });

  it("parses an animation with every metadata field", () => {
    const text = [
      "@sprite walk",
      "@fps 6",
      "@loop false",
      "@world 2 3",
      "@anchor bottom",
      "@tags unit,infantry",
      "@frame 0",
      ...rows(),
      "@frame 1",
      ...rows(),
      "@frame 2",
      ...rows(),
    ].join("\n");
    const walk = parse(text).get("walk");
    expect(walk?.fps).toBe(6);
    expect(walk?.loop).toBe(false);
    expect(walk?.world).toEqual([2, 3]);
    expect(walk?.anchor).toBe("bottom");
    expect(walk?.frames).toHaveLength(3);
  });

  it("tolerates CRLF, a BOM, comments and blank lines between frames", () => {
    const text =
      "\uFEFF# header\r\n" +
      [
        "@sprite walk",
        "# comment",
        "@frame 0",
        ...rows(),
        "",
        "@frame 1",
        ...rows(),
      ].join("\r\n");
    expect(parse(text).get("walk")?.frames).toHaveLength(2);
  });

  it("resolves a variant by inheriting size, palette, anchor, fps and tags", () => {
    const text = [
      "@sprite base",
      "@anchor bottom",
      "@fps 5",
      "@tags structure,city",
      "@frame 0",
      ...rows(),
      "@sprite variant",
      "@variant base",
      "@frame 0",
      ...rows(),
    ].join("\n");
    const sprites = parse(text);
    const variant = sprites.get("variant");
    expect(variant?.variantOf).toBe("base");
    expect(variant?.anchor).toBe("bottom");
    expect(variant?.fps).toBe(5);
    expect(variant?.tags).toEqual(["structure", "city"]);
    expect(variant?.palette).toBe("natural");
    expect(variant?.width).toBe(16);
  });

  it("lets a variant override an inherited field", () => {
    const text = [
      "@sprite base",
      "@fps 5",
      "@tags structure,city",
      "@frame 0",
      ...rows(),
      "@sprite variant",
      "@variant base",
      "@fps 2",
      "@frame 0",
      ...rows(),
    ].join("\n");
    expect(parse(text).get("variant")?.fps).toBe(2);
  });

  it("rejects a size other than 16x16 or 32x32", () => {
    expect(() => parse(spriteText("x", ["@size 24 24"]))).toThrow(
      /@size must be 16 16 or 32 32/,
    );
    expect(() => parse(spriteText("x", ["@size 16 32"]))).toThrow(
      /@size must be 16 16 or 32 32/,
    );
  });

  it("rejects a row with the wrong width", () => {
    const bad = rows();
    bad[3] = bad[3].slice(1);
    expect(() => parse([`@sprite x`, "@frame 0", ...bad].join("\n"))).toThrow(
      /row 3 has 15 characters; @size says 16/,
    );
  });

  it("rejects a frame with the wrong number of rows", () => {
    expect(() =>
      parse([`@sprite x`, "@frame 0", ...rows().slice(0, 15)].join("\n")),
    ).toThrow(/has 15 rows; @size says 16/);
  });

  it("rejects frames out of order", () => {
    expect(() =>
      parse([`@sprite x`, "@frame 1", ...rows()].join("\n")),
    ).toThrow(/@frame 1 out of order; expected 0/);
  });

  it("rejects duplicate names across files", () => {
    const sources: SpriteSource[] = [
      { name: "a.txt", text: spriteText("same") },
      { name: "b.txt", text: spriteText("same") },
    ];
    expect(() => parseSprites(sources, palettes)).toThrow(
      /duplicate sprite "same"/,
    );
  });

  it("rejects a character outside the declared palette", () => {
    const bad = rows();
    bad[2] = `?${bad[2].slice(1)}`;
    expect(() => parse([`@sprite x`, "@frame 0", ...bad].join("\n"))).toThrow(
      /character "\?" at column 0 is not in palette "natural"/,
    );
  });

  it("rejects an unknown palette", () => {
    expect(() => parse(spriteText("x", ["@palette missing"]))).toThrow(
      /palette "missing" does not exist/,
    );
  });

  it("rejects a variant whose target does not exist", () => {
    expect(() => parse(spriteText("variant", ["@variant nope"]))).toThrow(
      /@variant target "nope" does not exist/,
    );
  });

  it("rejects a variant chain", () => {
    const text = [
      "@sprite base",
      "@frame 0",
      ...rows(),
      "@sprite one",
      "@variant base",
      "@frame 0",
      ...rows(),
      "@sprite two",
      "@variant one",
      "@frame 0",
      ...rows(),
    ].join("\n");
    expect(() => parse(text)).toThrow(/is itself a variant/);
  });

  it("rejects a sprite with no frame", () => {
    expect(() => parse("@sprite empty")).toThrow(/has no @frame/);
  });

  it("rejects directives and rows outside their block", () => {
    expect(() => parse("@frame 0")).toThrow(/outside a @sprite block/);
    expect(() => parse(`@sprite x\n....`)).toThrow(/outside a @frame block/);
    expect(() => parse(spriteText("x", ["@bogus 1"]))).toThrow(
      /unknown directive "@bogus"/,
    );
  });

  it("rejects a ninth frame", () => {
    const frames = Array.from({ length: 9 }, (_, index) => [
      `@frame ${index}`,
      ...rows(),
    ]).flat();
    expect(() => parse([`@sprite x`, ...frames].join("\n"))).toThrow(
      /@frame must be 0\.\.7, got 8/,
    );
  });

  it("names the source and line on an error", () => {
    try {
      parse(spriteText("x", ["@size 24 24"]));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SpriteParseError);
      expect((error as SpriteParseError).source).toBe("test.txt");
      expect((error as SpriteParseError).line).toBe(2);
    }
  });
});
