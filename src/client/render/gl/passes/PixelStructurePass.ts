/**
 * PixelStructurePass — structures drawn from the runtime sprite atlas.
 *
 * Drop-in replacement for StructurePass, selected once in the Renderer
 * constructor from `?pixel=structures` / `?pixel=all`. It keeps the classic
 * pass's public API, LOD rules and instance layout:
 *
 *   x, y, ownerID, underConstruction, spriteSlot, markedForDeletion
 *
 * The only semantic change is float 4: it used to be the 0..5 atlas column and
 * is now a sprite slot index (see pixel/structureSprites.ts). The sprite's
 * pixel rect and its type are static per slot, so they go up as uniforms once.
 *
 * Colours come from the sprite palette texture (SpritePalette), not from the
 * legacy fill/border palette: the atlas stores palette indexes, the palette
 * resolves P/B/C per owner. That is also why the local-player border special
 * case of the classic shader has nothing to do here.
 */

import type { GhostPreviewData, RendererConfig, UnitState } from "../../types";
import { buildAtlas, type SpriteAtlas } from "../../pixel/buildAtlas";
import { parsePalette, type Palette } from "../../pixel/parsePalette";
import { parseSprites } from "../../pixel/parseSprites";
import { buildSpritePalette } from "../../pixel/SpritePalette";
import {
  buildStructureSpriteTable,
  MAX_STRUCTURE_SPRITE_SLOTS,
  STRUCTURE_SPRITES,
  STRUCTURE_TYPE_NAMES,
  structureSpriteSlot,
  type StructureSpriteTable,
} from "../../pixel/structureSprites";
import {
  disposePixelAssets,
  uploadPixelAssets,
  type PixelGpuAssets,
} from "../../pixel/uploadPixelAssets";
import { DynamicInstanceBuffer } from "../DynamicBuffer";
import type { RenderSettings } from "../RenderSettings";
import { getPaletteSize } from "../utils/ColorUtils";
import { createProgram, shaderSrc } from "../utils/GlUtils";

import naturalRaw from "../../pixel/palettes/natural.txt?raw";
import structuresRaw from "../../pixel/sprites/structures.txt?raw";
import pixelStructureFragSrc from "../shaders/pixel-structure/pixel-structure.frag.glsl?raw";
import pixelStructureVertSrc from "../shaders/pixel-structure/pixel-structure.vert.glsl?raw";

// Per-instance: x, y, ownerID, underConstruction, spriteSlot, markedForDeletion
const FLOATS_PER_INSTANCE = 6;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

export class PixelStructurePass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;
  private program: WebGLProgram;
  private mapW: number;

  private palette: Palette;
  private table: StructureSpriteTable;
  private atlas: SpriteAtlas;
  private assets: PixelGpuAssets;

  private uCamera: WebGLUniformLocation;
  private uZoom: WebGLUniformLocation;
  private uIconSize: WebGLUniformLocation;
  private uDotsThreshold: WebGLUniformLocation;
  private uDotScale: WebGLUniformLocation;
  private uScaleFactor: WebGLUniformLocation;
  private uIconGrowZoom: WebGLUniformLocation;
  private uSlotScales: WebGLUniformLocation;
  private uSpriteRects: WebGLUniformLocation;
  private uSlotTypes: WebGLUniformLocation;
  private uFillSlot: WebGLUniformLocation;
  private uGhostAlpha: WebGLUniformLocation;
  private uOutlineColor: WebGLUniformLocation;
  private uAltView: WebGLUniformLocation;
  private uHighlightMask: WebGLUniformLocation;
  private uHighlightDimAlpha: WebGLUniformLocation;
  private uIconAlpha: WebGLUniformLocation;
  private uFillDarken: WebGLUniformLocation;

  private vao: WebGLVertexArrayObject;
  private instanceBuf: DynamicInstanceBuffer;
  private ghostInstanceBuf: WebGLBuffer;

  private affiliationTex: WebGLTexture | null = null;
  private altView = false;

  private instanceCount = 0;
  private highlightMask = 0;

  private ghost: GhostPreviewData | null = null;
  private readonly ghostBuf = new Float32Array(FLOATS_PER_INSTANCE);

  /** Per-slot shape scale, rebuilt on draw because the debug sliders mutate it. */
  private readonly slotScales = new Float32Array(MAX_STRUCTURE_SPRITE_SLOTS);
  /** Per-slot structure type index, uploaded once. */
  private readonly slotTypes = new Float32Array(MAX_STRUCTURE_SPRITE_SLOTS);

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    paletteData: Float32Array,
    settings: RenderSettings,
  ) {
    this.gl = gl;
    this.settings = settings;
    this.mapW = header.mapWidth;

    // --- Sprite assets (parsed once, from the files bundled at build time) ---
    this.palette = parsePalette(naturalRaw, "natural");
    const sprites = parseSprites(
      [{ name: "structures.txt", text: structuresRaw }],
      new Map([[this.palette.name, this.palette]]),
    );
    this.table = buildStructureSpriteTable(sprites);
    for (const unitType of STRUCTURE_SPRITES.keys()) {
      if (structureSpriteSlot(this.table, unitType, 1) === undefined) {
        throw new Error(
          `PixelStructurePass: structures.txt has no sprite for ${JSON.stringify(unitType)}`,
        );
      }
    }
    this.atlas = buildAtlas(sprites, this.palette);

    gl.activeTexture(gl.TEXTURE0);
    this.assets = uploadPixelAssets(
      gl,
      this.atlas,
      buildSpritePalette(paletteData, this.palette, getPaletteSize()),
    );
    // uploadPixelAssets packs the R8UI atlas with alignment 1; restore the
    // default so later RGBA uploads keep their expected row padding.
    if (typeof gl.pixelStorei === "function") {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }

    // --- Program ---
    this.program = createProgram(
      gl,
      shaderSrc(pixelStructureVertSrc, {
        MAX_SPRITE_SLOTS: MAX_STRUCTURE_SPRITE_SLOTS,
      }),
      shaderSrc(pixelStructureFragSrc, {
        MAX_SPRITE_SLOTS: MAX_STRUCTURE_SPRITE_SLOTS,
      }),
      "PixelStructurePass",
    );

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uZoom = gl.getUniformLocation(this.program, "uZoom")!;
    this.uIconSize = gl.getUniformLocation(this.program, "uIconSize")!;
    this.uDotsThreshold = gl.getUniformLocation(
      this.program,
      "uDotsThreshold",
    )!;
    this.uDotScale = gl.getUniformLocation(this.program, "uDotScale")!;
    this.uScaleFactor = gl.getUniformLocation(this.program, "uScaleFactor")!;
    this.uIconGrowZoom = gl.getUniformLocation(this.program, "uIconGrowZoom")!;
    this.uSlotScales = gl.getUniformLocation(this.program, "uSlotScales")!;
    this.uSpriteRects = gl.getUniformLocation(this.program, "uSpriteRects")!;
    this.uSlotTypes = gl.getUniformLocation(this.program, "uSlotTypes")!;
    this.uFillSlot = gl.getUniformLocation(this.program, "uFillSlot")!;
    this.uGhostAlpha = gl.getUniformLocation(this.program, "uGhostAlpha")!;
    this.uOutlineColor = gl.getUniformLocation(this.program, "uOutlineColor")!;
    this.uAltView = gl.getUniformLocation(this.program, "uAltView")!;
    this.uHighlightMask = gl.getUniformLocation(
      this.program,
      "uHighlightMask",
    )!;
    this.uHighlightDimAlpha = gl.getUniformLocation(
      this.program,
      "uHighlightDimAlpha",
    )!;
    this.uIconAlpha = gl.getUniformLocation(this.program, "uIconAlpha")!;
    this.uFillDarken = gl.getUniformLocation(this.program, "uFillDarken")!;

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAtlas"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uSpritePalette"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAffiliation"), 2);
    gl.uniform1i(this.uFillSlot, this.palette.playerIndexes.fill);
    gl.uniform1f(this.uGhostAlpha, 1.0);
    gl.uniform3f(this.uOutlineColor, 0, 0, 0);
    gl.uniform1i(this.uHighlightMask, 0);

    // Static per-slot tables: atlas rect (in texels) and structure type index.
    const rects = new Float32Array(MAX_STRUCTURE_SPRITE_SLOTS * 4);
    for (let slot = 0; slot < this.table.slots.length; slot++) {
      const name = this.table.slots[slot];
      const rect = this.atlas.rects.get(name);
      if (rect === undefined) {
        throw new Error(
          `PixelStructurePass: atlas has no rect for sprite ${JSON.stringify(name)}`,
        );
      }
      rects[slot * 4 + 0] = rect.x;
      rects[slot * 4 + 1] = rect.y;
      rects[slot * 4 + 2] = rect.w;
      rects[slot * 4 + 3] = rect.h;
      this.slotTypes[slot] = this.table.slotTypes[slot];
    }
    gl.uniform4fv(this.uSpriteRects, rects);
    gl.uniform1fv(this.uSlotTypes, this.slotTypes);

    // --- Instance buffers (same layout as StructurePass) ---
    const instanceGlBuf = gl.createBuffer()!;
    this.instanceBuf = new DynamicInstanceBuffer(
      gl,
      instanceGlBuf,
      2048,
      FLOATS_PER_INSTANCE,
    );

    this.ghostInstanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ghostInstanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, BYTES_PER_INSTANCE, gl.DYNAMIC_DRAW);

    // --- VAO ---
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 16);
    gl.vertexAttribDivisor(2, 1);

    gl.bindVertexArray(null);
  }

  /**
   * Kept for API parity with StructurePass. The sprite palette already resolves
   * P/B/C per owner, so there is no local-player colour special case to cache.
   */
  setLocalPlayer(_smallID: number): void {}

  /**
   * Kept for API parity with StructurePass. The structures cosmetic recolours
   * the classic shape fill; porting it to sprites is F3e work.
   */
  setHighlightOwner(_ownerID: number): void {}

  updateStructures(units: Map<number, UnitState>): void {
    let count = 0;

    for (const unit of units.values()) {
      if (!unit.isActive) continue;
      const slot = structureSpriteSlot(this.table, unit.unitType, unit.level);
      if (slot === undefined) continue;

      this.instanceBuf.ensureCapacity(count + 1);

      const off = count * FLOATS_PER_INSTANCE;
      const x = unit.pos % this.mapW;
      const y = (unit.pos - x) / this.mapW;

      this.instanceBuf.float32[off + 0] = x;
      this.instanceBuf.float32[off + 1] = y;
      this.instanceBuf.float32[off + 2] = unit.ownerID;
      this.instanceBuf.float32[off + 3] = unit.underConstruction ? 1 : 0;
      this.instanceBuf.float32[off + 4] = slot;
      this.instanceBuf.float32[off + 5] =
        unit.markedForDeletion !== false ? 1 : 0;

      count++;
    }

    this.instanceCount = count;

    if (count > 0) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.instanceBuf.float32,
        0,
        count * FLOATS_PER_INSTANCE,
      );
    }
  }

  updateGhostPreview(data: GhostPreviewData | null): void {
    this.ghost = data;
  }

  setAltView(active: boolean): void {
    this.altView = active;
  }

  /** Highlight structures of the given types (null/empty = off). Dims all other types. */
  setHighlightTypes(unitTypes: string[] | null): void {
    let mask = 0;
    if (unitTypes) {
      for (const t of unitTypes) {
        const typeIndex = this.table.typeIndex.get(t);
        if (typeIndex !== undefined) mask |= 1 << typeIndex;
      }
    }
    this.highlightMask = mask;
  }

  setAffiliationTex(tex: WebGLTexture): void {
    this.affiliationTex = tex;
  }

  /** Re-resolve P/B/C after players join or change colour. */
  refreshPalette(paletteData: Float32Array): void {
    const rows = buildSpritePalette(
      paletteData,
      this.palette,
      getPaletteSize(),
    );
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.assets.paletteTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      rows.width,
      rows.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rows.data,
    );
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    const ghostSlot =
      this.ghost === null
        ? undefined
        : structureSpriteSlot(this.table, this.ghost.ghostType, 1);
    if (this.instanceCount === 0 && ghostSlot === undefined) return;

    const gl = this.gl;
    gl.useProgram(this.program);

    const ss = this.settings.structure;
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uZoom, zoom);
    gl.uniform1f(this.uIconSize, ss.iconSize);
    gl.uniform1f(this.uDotsThreshold, ss.dotsZoomThreshold);
    gl.uniform1f(this.uDotScale, ss.dotScale);
    gl.uniform1f(this.uScaleFactor, ss.iconScaleFactorZoomedOut);
    gl.uniform1f(this.uIconGrowZoom, ss.iconGrowZoom);

    for (let slot = 0; slot < this.table.slots.length; slot++) {
      const cfg =
        ss.shapes[STRUCTURE_TYPE_NAMES[this.table.slotTypes[slot]]];
      this.slotScales[slot] = cfg?.scale ?? 1.0;
    }
    gl.uniform1fv(this.uSlotScales, this.slotScales);

    gl.uniform1i(
      this.uAltView,
      this.altView &&
        this.settings.altView.recolorStructures &&
        this.affiliationTex !== null
        ? 1
        : 0,
    );
    gl.uniform1i(this.uHighlightMask, this.highlightMask);
    gl.uniform1f(this.uHighlightDimAlpha, ss.highlightDimAlpha);
    gl.uniform1f(this.uIconAlpha, ss.iconAlpha);
    gl.uniform1f(this.uFillDarken, ss.fillDarken);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.assets.atlasTexture);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.assets.paletteTexture);

    if (this.affiliationTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.affiliationTex);
    }

    gl.bindVertexArray(this.vao);

    // --- Real structures ---
    if (this.instanceCount > 0) {
      gl.uniform1f(this.uGhostAlpha, 1.0);
      gl.uniform3f(this.uOutlineColor, 0, 0, 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
    }

    // --- Ghost structure (1 translucent instance with outline) ---
    if (ghostSlot !== undefined) {
      const g = this.ghost!;

      // Temporarily rebind instance attrs to the ghost buffer.
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ghostInstanceBuf);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 16);

      // -- Green highlight on existing structure being upgraded --
      if (g.canUpgrade && g.upgradeTargetTile !== null) {
        const tx = g.upgradeTargetTile % this.mapW;
        const ty = (g.upgradeTargetTile - tx) / this.mapW;
        this.ghostBuf[0] = tx;
        this.ghostBuf[1] = ty;
        this.ghostBuf[2] = g.ownerID;
        this.ghostBuf[3] = 0;
        this.ghostBuf[4] = ghostSlot;
        this.ghostBuf[5] = 0;
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ghostBuf);

        gl.uniform1f(this.uGhostAlpha, 0.6);
        gl.uniform3f(this.uOutlineColor, 0.0, 0.8, 0.0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
      }

      // -- Ghost icon at cursor --
      this.ghostBuf[0] = g.tileX;
      this.ghostBuf[1] = g.tileY;
      this.ghostBuf[2] = g.ownerID;
      this.ghostBuf[3] = 0;
      this.ghostBuf[4] = ghostSlot;
      this.ghostBuf[5] = 0;
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.ghostBuf);

      gl.uniform1f(this.uGhostAlpha, 0.5);
      if (g.canUpgrade) {
        gl.uniform3f(this.uOutlineColor, 0.0, 0.8, 0.0);
      } else if (g.canBuild) {
        gl.uniform3f(this.uOutlineColor, 0, 0, 0);
      } else {
        gl.uniform3f(this.uOutlineColor, 0.8, 0.2, 0.2);
      }
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);

      // Restore instance attrs to the main buffer.
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf.buffer);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, BYTES_PER_INSTANCE, 16);
    }
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    this.instanceBuf.dispose();
    if (this.ghostInstanceBuf) gl.deleteBuffer(this.ghostInstanceBuf);
    gl.deleteVertexArray(this.vao);
    disposePixelAssets(gl, this.assets);
  }
}
