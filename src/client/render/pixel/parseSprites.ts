/**
 * Parser for the text sprite format.
 *
 * One sprite is a declaration plus one or more frames:
 *
 *   @sprite house
 *   @size 16 16
 *   @palette natural
 *   @fps 0
 *   @frame 0
 *   ................
 *   ...16 rows of 16...
 *
 * Every character in a row is a symbol from the declared palette, not a
 * colour. The atlas stores the palette index, so changing the palette or a
 * player colour never rebuilds it.
 *
 * The parser is deliberately strict: a malformed row, an unknown symbol, an
 * out-of-order frame or a variant chain is an error that names file:line. The
 * files ship inside the bundle, so a broken sprite must fail the build, not
 * render as a silent hole.
 */

import { type Palette } from "./parsePalette";

export type SpriteAnchor = "center" | "bottom";

export interface SpriteSource {
  /** Used in error messages, e.g. "structures.txt". */
  name: string;
  text: string;
}

export interface SpriteFrame {
  width: number;
  height: number;
  /** Exactly `height` strings of exactly `width` characters. */
  rows: readonly string[];
}

export interface SpriteDef {
  name: string;
  width: number;
  height: number;
  palette: string;
  /** 0 means static; otherwise frames per second (1..30). */
  fps: number;
  loop: boolean;
  /** World footprint in tiles; FX use more than 1x1. */
  world: readonly [number, number];
  anchor: SpriteAnchor;
  tags: readonly string[];
  frames: readonly SpriteFrame[];
  /** Set when this sprite inherited metadata from another one. */
  variantOf?: string;
}

export type SpriteSet = ReadonlyMap<string, SpriteDef>;

export class SpriteParseError extends Error {
  constructor(
    readonly source: string,
    readonly line: number,
    message: string,
  ) {
    super(`${source}:${line}: ${message}`);
    this.name = "SpriteParseError";
  }
}

export const MAX_FRAMES = 8;
const NAME_RE = /^[a-z0-9_.]+$/;
const TAG_RE = /^[a-z0-9_-]+$/;

interface RawFrame {
  index: number;
  line: number;
  rows: string[];
}

interface RawSprite {
  name: string;
  source: string;
  line: number;
  size: readonly [number, number] | null;
  paletteName: string | null;
  fps: number | null;
  loop: boolean | null;
  world: readonly [number, number] | null;
  anchor: SpriteAnchor | null;
  tags: readonly string[] | null;
  variantOf: string | null;
  variantLine: number;
  frames: RawFrame[];
  openFrame: RawFrame | null;
}

function parseIntToken(
  source: string,
  line: number,
  token: string | undefined,
  what: string,
): number {
  if (token === undefined || !/^-?\d+$/.test(token)) {
    throw new SpriteParseError(
      source,
      line,
      `${what} must be an integer, got ${JSON.stringify(token ?? "")}`,
    );
  }
  return Number(token);
}

function finishFrame(sprite: RawSprite): void {
  if (sprite.openFrame === null) return;
  sprite.frames.push(sprite.openFrame);
  sprite.openFrame = null;
}

function finishSprite(
  sprite: RawSprite,
  byName: Map<string, RawSprite>,
  out: RawSprite[],
): void {
  finishFrame(sprite);
  if (sprite.frames.length === 0) {
    throw new SpriteParseError(
      sprite.source,
      sprite.line,
      `sprite ${JSON.stringify(sprite.name)} has no @frame`,
    );
  }
  const previous = byName.get(sprite.name);
  if (previous !== undefined) {
    throw new SpriteParseError(
      sprite.source,
      sprite.line,
      `duplicate sprite ${JSON.stringify(sprite.name)} (first defined at ${previous.source}:${previous.line})`,
    );
  }
  byName.set(sprite.name, sprite);
  out.push(sprite);
}

function applyDirective(
  sprite: RawSprite,
  source: string,
  line: number,
  directive: string,
  args: string[],
): void {
  switch (directive) {
    case "sprite":
      throw new Error("handled by caller");
    case "size": {
      const w = parseIntToken(source, line, args[0], "@size width");
      const h = parseIntToken(source, line, args[1], "@size height");
      if (w !== h || (w !== 16 && w !== 32)) {
        throw new SpriteParseError(
          source,
          line,
          `@size must be 16 16 or 32 32, got ${w} ${h}`,
        );
      }
      sprite.size = [w, h];
      return;
    }
    case "palette":
      if (args[0] === undefined) {
        throw new SpriteParseError(source, line, "@palette needs a name");
      }
      sprite.paletteName = args[0];
      return;
    case "fps": {
      const fps = parseIntToken(source, line, args[0], "@fps");
      if (fps < 0 || fps > 30) {
        throw new SpriteParseError(
          source,
          line,
          `@fps must be 0..30, got ${fps}`,
        );
      }
      sprite.fps = fps;
      return;
    }
    case "loop":
      if (args[0] !== "true" && args[0] !== "false") {
        throw new SpriteParseError(
          source,
          line,
          `@loop must be true or false, got ${JSON.stringify(args[0] ?? "")}`,
        );
      }
      sprite.loop = args[0] === "true";
      return;
    case "world": {
      const w = parseIntToken(source, line, args[0], "@world width");
      const h = parseIntToken(source, line, args[1], "@world height");
      if (w < 1 || h < 1) {
        throw new SpriteParseError(
          source,
          line,
          `@world must be positive, got ${w} ${h}`,
        );
      }
      sprite.world = [w, h];
      return;
    }
    case "anchor":
      if (args[0] !== "center" && args[0] !== "bottom") {
        throw new SpriteParseError(
          source,
          line,
          `@anchor must be center or bottom, got ${JSON.stringify(args[0] ?? "")}`,
        );
      }
      sprite.anchor = args[0];
      return;
    case "tags": {
      const tags = args
        .join(" ")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");
      for (const tag of tags) {
        if (!TAG_RE.test(tag)) {
          throw new SpriteParseError(
            source,
            line,
            `invalid tag ${JSON.stringify(tag)}`,
          );
        }
      }
      sprite.tags = tags;
      return;
    }
    case "variant":
      if (args[0] === undefined || !NAME_RE.test(args[0])) {
        throw new SpriteParseError(
          source,
          line,
          `@variant needs a sprite name, got ${JSON.stringify(args[0] ?? "")}`,
        );
      }
      sprite.variantOf = args[0];
      sprite.variantLine = line;
      return;
    case "frame": {
      const index = parseIntToken(source, line, args[0], "@frame");
      if (index < 0 || index >= MAX_FRAMES) {
        throw new SpriteParseError(
          source,
          line,
          `@frame must be 0..${MAX_FRAMES - 1}, got ${index}`,
        );
      }
      finishFrame(sprite);
      const expected = sprite.frames.length;
      if (index !== expected) {
        throw new SpriteParseError(
          source,
          line,
          `@frame ${index} out of order; expected ${expected}`,
        );
      }
      sprite.openFrame = { index, line, rows: [] };
      return;
    }
    default:
      throw new SpriteParseError(
        source,
        line,
        `unknown directive ${JSON.stringify(`@${directive}`)}`,
      );
  }
}

function parseSource(
  source: SpriteSource,
  byName: Map<string, RawSprite>,
  out: RawSprite[],
): void {
  const lines = source.text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let sprite: RawSprite | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (raw.startsWith("@")) {
      const [head, ...args] = trimmed.split(/\s+/);
      const directive = head.slice(1);
      if (directive === "sprite") {
        if (sprite !== null) finishSprite(sprite, byName, out);
        const name = args[0];
        if (name === undefined || !NAME_RE.test(name)) {
          throw new SpriteParseError(
            source.name,
            lineNo,
            `invalid sprite name ${JSON.stringify(name ?? "")}`,
          );
        }
        sprite = {
          name,
          source: source.name,
          line: lineNo,
          size: null,
          paletteName: null,
          fps: null,
          loop: null,
          world: null,
          anchor: null,
          tags: null,
          variantOf: null,
          variantLine: 0,
          frames: [],
          openFrame: null,
        };
        continue;
      }
      if (sprite === null) {
        throw new SpriteParseError(
          source.name,
          lineNo,
          `@${directive} outside a @sprite block`,
        );
      }
      applyDirective(sprite, source.name, lineNo, directive, args);
      continue;
    }

    if (sprite === null) {
      throw new SpriteParseError(
        source.name,
        lineNo,
        "sprite row outside a @sprite block",
      );
    }
    if (sprite.openFrame === null) {
      throw new SpriteParseError(
        source.name,
        lineNo,
        "sprite row outside a @frame block",
      );
    }
    sprite.openFrame.rows.push(raw);
  }

  if (sprite !== null) finishSprite(sprite, byName, out);
}

interface ResolvedMeta {
  width: number;
  height: number;
  paletteName: string;
  fps: number;
  loop: boolean;
  world: readonly [number, number];
  anchor: SpriteAnchor;
  tags: readonly string[];
}

function metaOf(sprite: RawSprite): ResolvedMeta {
  const width = sprite.size?.[0] ?? 16;
  return {
    width,
    height: sprite.size?.[1] ?? 16,
    paletteName: sprite.paletteName ?? "natural",
    fps: sprite.fps ?? 0,
    loop: sprite.loop ?? true,
    world: sprite.world ?? [1, 1],
    anchor: sprite.anchor ?? "center",
    tags: sprite.tags ?? [],
  };
}

export function parseSprites(
  sources: readonly SpriteSource[],
  palettes: ReadonlyMap<string, Palette>,
): Map<string, SpriteDef> {
  const byName = new Map<string, RawSprite>();
  const raw: RawSprite[] = [];
  for (const source of sources) parseSource(source, byName, raw);

  const resolved = new Map<string, SpriteDef>();
  for (const sprite of raw) {
    let meta = metaOf(sprite);
    if (sprite.variantOf !== null) {
      const target = byName.get(sprite.variantOf);
      if (target === undefined) {
        throw new SpriteParseError(
          sprite.source,
          sprite.variantLine,
          `@variant target ${JSON.stringify(sprite.variantOf)} does not exist`,
        );
      }
      if (target.variantOf !== null) {
        throw new SpriteParseError(
          sprite.source,
          sprite.variantLine,
          `@variant target ${JSON.stringify(sprite.variantOf)} is itself a variant`,
        );
      }
      const inherited = metaOf(target);
      meta = {
        width: sprite.size?.[0] ?? inherited.width,
        height: sprite.size?.[1] ?? inherited.height,
        paletteName: sprite.paletteName ?? inherited.paletteName,
        fps: sprite.fps ?? inherited.fps,
        loop: sprite.loop ?? true,
        world: sprite.world ?? [1, 1],
        anchor: sprite.anchor ?? inherited.anchor,
        tags: sprite.tags ?? inherited.tags,
      };
    }

    const palette = palettes.get(meta.paletteName);
    if (palette === undefined) {
      throw new SpriteParseError(
        sprite.source,
        sprite.line,
        `palette ${JSON.stringify(meta.paletteName)} does not exist`,
      );
    }

    const frames: SpriteFrame[] = sprite.frames.map((frame) => {
      if (frame.rows.length !== meta.height) {
        throw new SpriteParseError(
          sprite.source,
          frame.line,
          `frame ${frame.index} has ${frame.rows.length} rows; @size says ${meta.height}`,
        );
      }
      for (let y = 0; y < frame.rows.length; y++) {
        const row = frame.rows[y];
        if (row.length !== meta.width) {
          throw new SpriteParseError(
            sprite.source,
            frame.line + 1 + y,
            `row ${y} has ${row.length} characters; @size says ${meta.width}`,
          );
        }
        for (let x = 0; x < row.length; x++) {
          if (!palette.symbolToIndex.has(row[x])) {
            throw new SpriteParseError(
              sprite.source,
              frame.line + 1 + y,
              `character ${JSON.stringify(row[x])} at column ${x} is not in palette ${JSON.stringify(meta.paletteName)}`,
            );
          }
        }
      }
      return { width: meta.width, height: meta.height, rows: frame.rows };
    });

    resolved.set(sprite.name, {
      name: sprite.name,
      width: meta.width,
      height: meta.height,
      palette: meta.paletteName,
      fps: meta.fps,
      loop: meta.loop,
      world: meta.world,
      anchor: meta.anchor,
      tags: meta.tags,
      frames,
      ...(sprite.variantOf === null ? {} : { variantOf: sprite.variantOf }),
    });
  }

  return resolved;
}
