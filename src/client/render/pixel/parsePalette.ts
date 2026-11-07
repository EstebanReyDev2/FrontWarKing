/**
 * Palette files for the pixel renderer.
 *
 * A palette is exactly 16 lines:
 *
 *   .  -            transparent
 *   k  #172022      ink
 *   ...
 *   P  @player-fill
 *   B  @player-border
 *   C  @player-accent
 *
 * The symbol is a single character and doubles as the index key in every
 * sprite matrix. Twelve fixed colours plus three player slots plus the
 * transparent slot is the whole art budget: 16 entries, which is what lets the
 * sprite atlas stay R8UI (one byte per pixel) instead of R16UI.
 *
 * Lines whose first non-space character is `#` are comments. A `#` after the
 * symbol is a hex colour, so comments must own the whole line.
 */

/** Total slots a palette file must declare. */
export const PALETTE_SLOT_COUNT = 16;

/** Atlas value that means "no pixel"; never a palette row. */
export const TRANSPARENT_INDEX = 255;

export const PLAYER_ROLES = ["fill", "border", "accent"] as const;
export type PlayerRole = (typeof PLAYER_ROLES)[number];

export type PaletteSlotKind = "transparent" | "fixed" | `player-${PlayerRole}`;

export interface PaletteSlot {
  /** Single character used in sprite matrices. */
  symbol: string;
  /**
   * Row index inside the sprite palette texture. Fixed and player slots are
   * numbered 0..14 in file order; the transparent slot keeps 255 and is never
   * sampled.
   */
  index: number;
  /** `#rrggbb` for fixed slots, null for transparent and player slots. */
  hex: string | null;
  kind: PaletteSlotKind;
  /** Free-form label at the end of the line (may be empty). */
  label: string;
}

export interface Palette {
  name: string;
  /** 16 slots in file order, including the transparent one. */
  slots: readonly PaletteSlot[];
  /** The 15 non-transparent slots, indexed 0..14. */
  colors: readonly PaletteSlot[];
  /** Symbol -> palette index (`.` and any transparent symbol map to 255). */
  symbolToIndex: ReadonlyMap<string, number>;
  /** Palette index of each dynamic player slot. */
  playerIndexes: Readonly<Record<PlayerRole, number>>;
  transparentSymbol: string;
}

export class PaletteParseError extends Error {
  constructor(
    readonly source: string,
    readonly line: number,
    message: string,
  ) {
    super(`${source}:${line}: ${message}`);
    this.name = "PaletteParseError";
  }
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

function roleFromToken(token: string): PlayerRole | null {
  if (token === "@player-fill") return "fill";
  if (token === "@player-border") return "border";
  if (token === "@player-accent") return "accent";
  return null;
}

export function parsePalette(text: string, source = "palette.txt"): Palette {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const slots: PaletteSlot[] = [];
  const symbols = new Set<string>();
  const roles = new Set<PlayerRole>();
  let transparentSymbol: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const lineNo = i + 1;
    const tokens = trimmed.split(/\s+/);
    const symbol = tokens[0];
    if ([...symbol].length !== 1) {
      throw new PaletteParseError(
        source,
        lineNo,
        `expected a single-character symbol, got ${JSON.stringify(symbol)}`,
      );
    }
    if (symbols.has(symbol)) {
      throw new PaletteParseError(
        source,
        lineNo,
        `duplicate symbol ${JSON.stringify(symbol)}`,
      );
    }
    symbols.add(symbol);

    const value = tokens[1];
    if (value === undefined) {
      throw new PaletteParseError(
        source,
        lineNo,
        `slot ${JSON.stringify(symbol)} has no colour or role`,
      );
    }

    const label = tokens.slice(2).join(" ");
    const role = roleFromToken(value);
    if (value === "-") {
      if (transparentSymbol !== null) {
        throw new PaletteParseError(
          source,
          lineNo,
          `duplicate transparent slot (already ${JSON.stringify(transparentSymbol)})`,
        );
      }
      transparentSymbol = symbol;
      slots.push({
        symbol,
        index: TRANSPARENT_INDEX,
        hex: null,
        kind: "transparent",
        label,
      });
      continue;
    }

    if (role !== null) {
      if (roles.has(role)) {
        throw new PaletteParseError(
          source,
          lineNo,
          `duplicate @player-${role} role`,
        );
      }
      roles.add(role);
      slots.push({
        symbol,
        index: -1,
        hex: null,
        kind: `player-${role}`,
        label,
      });
      continue;
    }

    if (!HEX_RE.test(value)) {
      throw new PaletteParseError(
        source,
        lineNo,
        `expected #rrggbb, "-" or a @player-* role, got ${JSON.stringify(value)}`,
      );
    }

    slots.push({
      symbol,
      index: -1,
      hex: value.toLowerCase(),
      kind: "fixed",
      label,
    });
  }

  if (slots.length !== PALETTE_SLOT_COUNT) {
    throw new PaletteParseError(
      source,
      lines.length,
      `expected ${PALETTE_SLOT_COUNT} slots, got ${slots.length}`,
    );
  }
  if (transparentSymbol === null) {
    throw new PaletteParseError(source, 0, "no transparent slot (`-`)");
  }
  for (const role of PLAYER_ROLES) {
    if (!roles.has(role)) {
      throw new PaletteParseError(source, 0, `missing @player-${role} slot`);
    }
  }

  const colors: PaletteSlot[] = [];
  const symbolToIndex = new Map<string, number>();
  const playerIndexes = {} as Record<PlayerRole, number>;

  for (const slot of slots) {
    if (slot.kind === "transparent") {
      symbolToIndex.set(slot.symbol, TRANSPARENT_INDEX);
      continue;
    }
    const index = colors.length;
    colors.push({ ...slot, index });
    symbolToIndex.set(slot.symbol, index);
    if (slot.kind.startsWith("player-")) {
      playerIndexes[slot.kind.slice("player-".length) as PlayerRole] = index;
    }
  }

  return {
    name: source,
    slots,
    colors,
    symbolToIndex,
    playerIndexes,
    transparentSymbol,
  };
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` -> byte channels. Throws on anything parsePalette would reject. */
export function hexToRgb(hex: string): Rgb {
  if (!HEX_RE.test(hex)) {
    throw new Error(`invalid colour ${JSON.stringify(hex)}`);
  }
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

export function rgbToHex(rgb: Rgb): string {
  const channel = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}
