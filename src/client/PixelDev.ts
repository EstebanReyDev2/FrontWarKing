/**
 * `?pixel-dev` — F3a sprite infrastructure preview.
 *
 * This page is the only thing F3a wires up: it parses the real palette and
 * sprite files, builds the real runtime atlas and paints the result with a 2D
 * canvas at integer scales. No game pass reads the atlas yet, so the game
 * renderer is untouched.
 *
 * It is mounted as a full-screen overlay, the same opt-in style as
 * `RealtimeDev`, and it is routed before auth in RouteMode/Main.
 */

import { buildAtlas, type SpriteAtlas } from "./render/pixel/buildAtlas";
import naturalRaw from "./render/pixel/palettes/natural.txt?raw";
import {
  hexToRgb,
  parsePalette,
  rgbToHex,
  type Palette,
  type Rgb,
} from "./render/pixel/parsePalette";
import {
  parseSprites,
  type SpriteDef,
  type SpriteSet,
} from "./render/pixel/parseSprites";
import {
  buildSpritePalette,
  lightenRgb,
  SPRITE_PALETTE_SOURCE_ROWS,
  SPRITE_PALETTE_WIDTH,
  writeSpritePaletteRow,
  type SpritePaletteRows,
} from "./render/pixel/SpritePalette";
import devSpritesRaw from "./render/pixel/sprites/dev.txt?raw";
import { frameIndexAt } from "./render/pixel/spriteSelect";

const PLAYER_ROW = 1;
const STYLES = `
.pixel-dev-root {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  overflow: auto;
  background: #10161a;
  color: #e8e3d9;
  font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.pixel-dev-root * { box-sizing: border-box; }
.pixel-dev-inner { max-width: 1180px; margin: 0 auto; padding: 24px 22px 56px; }
.pixel-dev-header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; border-bottom: 1px solid #2b3a42; padding-bottom: 12px; margin-bottom: 20px; }
.pixel-dev-header h1 { margin: 0; font-size: 18px; letter-spacing: .08em; text-transform: uppercase; }
.pixel-dev-tag { color: #8fb3c0; }
.pixel-dev-section { margin: 0 0 26px; }
.pixel-dev-section h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #8fb3c0; margin: 0 0 10px; }
.pixel-dev-palette { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.pixel-dev-swatch { display: flex; align-items: center; gap: 8px; background: #182228; border: 1px solid #2b3a42; padding: 6px; }
.pixel-dev-chip { width: 30px; height: 30px; flex: 0 0 auto; border: 1px solid #00000066; }
.pixel-dev-transparent { background-image: linear-gradient(45deg, #334 25%, transparent 25%), linear-gradient(-45deg, #334 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #334 75%), linear-gradient(-45deg, transparent 75%, #334 75%); background-size: 10px 10px; background-position: 0 0, 0 5px, 5px -5px, -5px 0; }
.pixel-dev-swatch code { color: #e0bd57; }
.pixel-dev-swatch small { display: block; color: #9fb2ba; }
.pixel-dev-controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; background: #182228; border: 1px solid #2b3a42; padding: 12px; }
.pixel-dev-controls input[type=range] { width: min(420px, 60vw); }
.pixel-dev-colors { display: flex; gap: 10px; flex-wrap: wrap; }
.pixel-dev-colors span { display: inline-flex; align-items: center; gap: 6px; }
.pixel-dev-colors i { width: 16px; height: 16px; display: inline-block; border: 1px solid #00000066; }
.pixel-dev-table { width: 100%; border-collapse: collapse; }
.pixel-dev-table th, .pixel-dev-table td { text-align: left; padding: 8px; border-bottom: 1px solid #223039; vertical-align: middle; }
.pixel-dev-table th { color: #8fb3c0; font-weight: normal; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
.pixel-dev-scale { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.pixel-dev-scale figure { margin: 0; text-align: center; }
.pixel-dev-scale figcaption { color: #9fb2ba; font-size: 10px; margin-top: 4px; }
.pixel-dev-scale canvas { image-rendering: pixelated; display: block; background: #0b1114; border: 1px solid #2b3a42; }
.pixel-dev-anim { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.pixel-dev-meta { color: #9fb2ba; }
.pixel-dev-error { color: #fca5a5; background: #2a1414; border: 1px solid #7f1d1d; padding: 14px; white-space: pre-wrap; }
.pixel-dev-footer { color: #6f8792; border-top: 1px solid #2b3a42; padding-top: 12px; margin-top: 28px; }
`;

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const [r, g, b] = rgb;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function cssRgb(rgb: Rgb): string {
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

/** Paint one frame of a sprite at an integer scale from the atlas indices. */
function paintSprite(
  canvas: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
  sprite: SpriteDef,
  frame: number,
  scale: number,
  palette: Palette,
  rows: SpritePaletteRows,
): void {
  const width = sprite.width;
  const height = sprite.height;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  scratch.width = width;
  scratch.height = height;
  const scratchCtx = scratch.getContext("2d");
  if (scratchCtx === null) return;
  scratchCtx.imageSmoothingEnabled = false;
  const image = scratchCtx.createImageData(width, height);
  const source = sprite.frames[frame].rows;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = palette.symbolToIndex.get(source[y][x]);
      if (index === undefined || index === 255) continue;
      const src = (PLAYER_ROW * SPRITE_PALETTE_WIDTH + index) * 4;
      const dst = (y * width + x) * 4;
      image.data[dst] = rows.data[src];
      image.data[dst + 1] = rows.data[src + 1];
      image.data[dst + 2] = rows.data[src + 2];
      image.data[dst + 3] = rows.data[src + 3];
    }
  }
  scratchCtx.putImageData(image, 0, 0);
  ctx.drawImage(
    scratch,
    0,
    0,
    width,
    height,
    0,
    0,
    width * scale,
    height * scale,
  );
}

function paletteRgb(
  palette: Palette,
  slotSymbol: string,
  fill: Rgb,
  border: Rgb,
): Rgb | null {
  const slot = palette.slots.find((entry) => entry.symbol === slotSymbol);
  if (slot === undefined || slot.kind === "transparent") return null;
  switch (slot.kind) {
    case "fixed":
      return hexToRgb(slot.hex as string);
    case "player-fill":
      return fill;
    case "player-border":
      return border;
    case "player-accent":
      return lightenRgb(border);
  }
}

interface DevAssets {
  palette: Palette;
  sprites: SpriteSet;
  atlas: SpriteAtlas;
}

function loadAssets(): DevAssets {
  const palette = parsePalette(naturalRaw, "natural");
  const sprites = parseSprites(
    [{ name: "dev.txt", text: devSpritesRaw }],
    new Map([[palette.name, palette]]),
  );
  const atlas = buildAtlas(sprites, palette);
  return { palette, sprites, atlas };
}

export function mountPixelDev(): boolean {
  if (!new URLSearchParams(window.location.search).has("pixel-dev")) {
    return false;
  }

  const root = element("div", "pixel-dev-root");
  const inner = element("div", "pixel-dev-inner");
  root.append(inner);
  document.body.append(root);

  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.append(style);

  const header = element("header", "pixel-dev-header");
  const title = element("h1");
  title.textContent = "Pixel dev · F3a";
  const tag = element("span", "pixel-dev-tag");
  tag.textContent = "sprite parser · runtime atlas · palette";
  header.append(title, tag);
  inner.append(header);

  let assets: DevAssets;
  try {
    assets = loadAssets();
  } catch (error) {
    const failure = element("pre", "pixel-dev-error");
    failure.textContent =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    inner.append(failure);
    return true;
  }

  const { palette, sprites, atlas } = assets;
  document.title = "Pixel dev · F3a";

  // Real palette texture row for a player, derived from a synthetic
  // paletteData with smallID 1 filled. This is the same code path the live
  // renderer will use in F3e.
  const paletteData = new Float32Array(SPRITE_PALETTE_SOURCE_ROWS * 2 * 4);
  const paletteRows = buildSpritePalette(paletteData, palette);
  const borderBlock = SPRITE_PALETTE_SOURCE_ROWS * 4;

  let fill = hslToRgb(352, 0.62, 0.5);
  let border = hslToRgb(352, 0.7, 0.28);

  const applyPlayerColor = (): void => {
    const off = PLAYER_ROW * 4;
    paletteData[off] = fill.r / 255;
    paletteData[off + 1] = fill.g / 255;
    paletteData[off + 2] = fill.b / 255;
    paletteData[off + 3] = 150 / 255;
    const borderOff = borderBlock + PLAYER_ROW * 4;
    paletteData[borderOff] = border.r / 255;
    paletteData[borderOff + 1] = border.g / 255;
    paletteData[borderOff + 2] = border.b / 255;
    paletteData[borderOff + 3] = 1;
    writeSpritePaletteRow(paletteRows.data, PLAYER_ROW, palette, fill, border);
  };
  applyPlayerColor();

  // --- Palette -----------------------------------------------------------
  const paletteSection = element("section", "pixel-dev-section");
  const paletteTitle = element("h2");
  paletteTitle.textContent = `01 · Palette ${palette.name} / ${palette.slots.length} slots`;
  const paletteGrid = element("div", "pixel-dev-palette");
  paletteSection.append(paletteTitle, paletteGrid);
  inner.append(paletteSection);

  const swatchChips = new Map<
    string,
    { chip: HTMLElement; value: HTMLElement }
  >();
  for (const slot of palette.slots) {
    const swatch = element("div", "pixel-dev-swatch");
    const chip = element("div", "pixel-dev-chip");
    if (slot.kind === "transparent")
      chip.classList.add("pixel-dev-transparent");
    const text = element("div");
    const symbol = element("code");
    symbol.textContent = slot.symbol;
    const value = element("small");
    value.textContent = slot.label;
    text.append(symbol, document.createElement("br"), value);
    swatch.append(chip, text);
    paletteGrid.append(swatch);
    swatchChips.set(slot.symbol, { chip, value });
  }

  const paintPaletteSwatches = (): void => {
    for (const slot of palette.slots) {
      const entry = swatchChips.get(slot.symbol);
      if (entry === undefined) continue;
      if (slot.kind === "transparent") {
        entry.value.textContent = `${slot.label || "transparent"} · 255`;
        continue;
      }
      const rgb = paletteRgb(palette, slot.symbol, fill, border);
      if (rgb === null) continue;
      entry.chip.style.background = cssRgb(rgb);
      entry.value.textContent = `${slot.hex ?? rgbToHex(rgb)} · ${slot.kind}`;
    }
  };
  paintPaletteSwatches();

  // --- Player colour slider ---------------------------------------------
  const controlsSection = element("section", "pixel-dev-section");
  const controlsTitle = element("h2");
  controlsTitle.textContent = "02 · Player colour (fill / border / accent)";
  const controls = element("div", "pixel-dev-controls");
  const slider = element("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "359";
  slider.value = "352";
  slider.step = "1";
  const colors = element("div", "pixel-dev-colors");
  const swatches = {
    fill: element("i"),
    border: element("i"),
    accent: element("i"),
  };
  const labels = {
    fill: element("span"),
    border: element("span"),
    accent: element("span"),
  };
  labels.fill.append(swatches.fill, "fill");
  labels.border.append(swatches.border, "border");
  labels.accent.append(swatches.accent, "accent");
  colors.append(labels.fill, labels.border, labels.accent);
  controls.append(slider, colors);
  controlsSection.append(controlsTitle, controls);
  inner.append(controlsSection);

  // --- Sprites at 1x/2x/4x ----------------------------------------------
  const spriteSection = element("section", "pixel-dev-section");
  const spriteTitle = element("h2");
  spriteTitle.textContent = "03 · Sprites at 1x / 2x / 4x";
  const spriteTable = element("table", "pixel-dev-table");
  const spriteHead = element("thead");
  const headRow = element("tr");
  for (const label of ["sprite", "1x", "2x", "4x", "meta"]) {
    const th = element("th");
    th.textContent = label;
    headRow.append(th);
  }
  spriteHead.append(headRow);
  const spriteBody = element("tbody");
  spriteTable.append(spriteHead, spriteBody);
  spriteSection.append(spriteTitle, spriteTable);
  inner.append(spriteSection);

  const scratch = document.createElement("canvas");
  const spriteCanvases = new Map<
    string,
    { frame: number; canvases: HTMLCanvasElement[]; sprite: SpriteDef }
  >();

  for (const sprite of [...sprites.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const row = element("tr");
    const nameCell = element("td");
    nameCell.textContent = sprite.name;
    row.append(nameCell);
    const canvases: HTMLCanvasElement[] = [];
    for (const scale of [1, 2, 4]) {
      const cell = element("td");
      const canvas = document.createElement("canvas");
      canvas.style.imageRendering = "pixelated";
      cell.append(canvas);
      row.append(cell);
      canvases.push(canvas);
      paintSprite(canvas, scratch, sprite, 0, scale, palette, paletteRows);
    }
    const metaCell = element("td", "pixel-dev-meta");
    metaCell.textContent = `${sprite.width}x${sprite.height} · ${sprite.frames.length} frame(s) · ${sprite.fps} fps${sprite.variantOf ? ` · variant of ${sprite.variantOf}` : ""}`;
    row.append(metaCell);
    spriteBody.append(row);
    spriteCanvases.set(sprite.name, { frame: 0, canvases, sprite });
  }

  // --- Animation ---------------------------------------------------------
  const animated = [...sprites.values()].filter(
    (sprite) => sprite.frames.length > 1,
  );
  const animSection = element("section", "pixel-dev-section");
  const animTitle = element("h2");
  animTitle.textContent = "04 · Animation";
  animSection.append(animTitle);
  const animEntries: {
    sprite: SpriteDef;
    canvas: HTMLCanvasElement;
    label: HTMLElement;
    startedAt: number;
  }[] = [];

  for (const sprite of animated) {
    const wrap = element("div", "pixel-dev-anim");
    const canvas = document.createElement("canvas");
    canvas.style.imageRendering = "pixelated";
    const info = element("div");
    const label = element("div");
    label.className = "pixel-dev-meta";
    const meta = element("div");
    meta.className = "pixel-dev-meta";
    meta.textContent = `${sprite.name} · ${sprite.frames.length} frames · ${sprite.fps} fps · ${sprite.loop ? "loop" : "once"}`;
    info.append(label, meta);
    wrap.append(canvas, info);
    animSection.append(wrap);
    animEntries.push({
      sprite,
      canvas,
      label,
      startedAt: performance.now(),
    });
  }
  inner.append(animSection);

  const repaintAnimated = (now: number): void => {
    for (const entry of animEntries) {
      const frame = frameIndexAt(
        now - entry.startedAt,
        entry.sprite.fps,
        entry.sprite.frames.length,
        entry.sprite.loop,
      );
      paintSprite(
        entry.canvas,
        scratch,
        entry.sprite,
        frame,
        4,
        palette,
        paletteRows,
      );
      entry.label.textContent = `frame ${frame + 1}/${entry.sprite.frames.length}`;
    }
  };

  // --- Atlas summary -----------------------------------------------------
  const atlasSection = element("section", "pixel-dev-section");
  const atlasTitle = element("h2");
  atlasTitle.textContent = "05 · Runtime atlas";
  const atlasInfo = element("div", "pixel-dev-meta");
  atlasInfo.textContent = `${atlas.width}x${atlas.height} · ${(atlas.indices.length / 1024).toFixed(1)} KB · ${atlas.rects.size} sprites · R8UI indices (255 = transparent)`;
  const rects = element("table", "pixel-dev-table");
  const rectsBody = element("tbody");
  for (const [name, rect] of atlas.rects) {
    const row = element("tr");
    const nameCell = element("td");
    nameCell.textContent = name;
    const cell = element("td");
    cell.textContent = `x=${rect.x} y=${rect.y} · ${rect.w}x${rect.h} · ${rect.frames} frame(s)`;
    row.append(nameCell, cell);
    rectsBody.append(row);
  }
  rects.append(rectsBody);
  atlasSection.append(atlasTitle, atlasInfo, rects);
  inner.append(atlasSection);

  // --- Footer ------------------------------------------------------------
  const footer = element("div", "pixel-dev-footer");
  footer.textContent =
    "F3a: this page is the only consumer. No pass, shader or MapRenderer reads the atlas yet.";
  inner.append(footer);

  // --- Wiring ------------------------------------------------------------
  const updateColors = (): void => {
    fill = hslToRgb(Number(slider.value), 0.62, 0.5);
    border = hslToRgb(Number(slider.value), 0.7, 0.28);
    applyPlayerColor();
    paintPaletteSwatches();
    swatches.fill.style.background = cssRgb(fill);
    swatches.border.style.background = cssRgb(border);
    swatches.accent.style.background = cssRgb(lightenRgb(border));
    for (const entry of spriteCanvases.values()) {
      paintSprite(
        entry.canvases[0],
        scratch,
        entry.sprite,
        0,
        1,
        palette,
        paletteRows,
      );
      paintSprite(
        entry.canvases[1],
        scratch,
        entry.sprite,
        0,
        2,
        palette,
        paletteRows,
      );
      paintSprite(
        entry.canvases[2],
        scratch,
        entry.sprite,
        0,
        4,
        palette,
        paletteRows,
      );
    }
  };
  swatches.fill.style.background = cssRgb(fill);
  swatches.border.style.background = cssRgb(border);
  swatches.accent.style.background = cssRgb(lightenRgb(border));
  slider.addEventListener("input", updateColors);

  const tick = (now: number): void => {
    repaintAnimated(now);
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);

  (
    window as unknown as {
      __pixelDev?: { palette: Palette; sprites: SpriteSet; atlas: SpriteAtlas };
    }
  ).__pixelDev = { palette, sprites, atlas };

  return true;
}
