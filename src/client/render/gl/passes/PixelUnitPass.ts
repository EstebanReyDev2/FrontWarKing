/**
 * PixelUnitPass — mobile units drawn from the runtime sprite atlas.
 *
 * Drop-in replacement for UnitPass, selected once in the Renderer constructor
 * from `?pixel=units` / `?pixel=all`. It keeps the classic pass's public API,
 * instance layout, layer split and missile smoothing:
 *
 *   float x, y, ownerID
 *   uint8 spriteSlot, flags, flickerHash, frame
 *
 * The only semantic change is byte 12: it used to be the PNG atlas column and
 * is now a sprite slot index (see pixel/unitSprites.ts). The sprite rect is
 * static per slot, so it goes up as a uniform once. Byte 15 stays reserved for
 * a frame index; every F3c sprite is single-frame, so it is written as 0.
 *
 * Colours come from the sprite palette texture (SpritePalette), not from the
 * legacy fill/border palette: the atlas stores palette indexes, and the palette
 * resolves P/B/C per owner. Combat states (angry/retreating/flicker), the
 * untargetable alpha and the hydrogen-bomb glow are preserved in the shader.
 * Warship/train cosmetics are deferred to F3e, like the structure pass.
 *
 * LOD: below 4 device pixels a 16x16 sprite is unreadable and shimmers while
 * panning, so the shader draws a snapped 2x2 or 4x4 solid player-colour block
 * instead. At zoom 1 and 4 the sprite maps to a whole number of device pixels
 * (16 and 64), which is what keeps it crisp.
 */

import type { Config } from "@openfront/engine-lib/configuration/Config";
import type { RendererConfig, UnitState } from "../../types";
import { buildAtlas, type SpriteAtlas } from "../../pixel/buildAtlas";
import { parsePalette, type Palette } from "../../pixel/parsePalette";
import { parseSprites } from "../../pixel/parseSprites";
import { buildSpritePalette } from "../../pixel/SpritePalette";
import {
  buildUnitSpriteTable,
  MAX_UNIT_SPRITE_SLOTS,
  UNIT_SPRITES,
  unitSpriteSlot,
  type UnitSpriteTable,
} from "../../pixel/unitSprites";
import {
  disposePixelAssets,
  uploadPixelAssets,
  type PixelGpuAssets,
} from "../../pixel/uploadPixelAssets";
import {
  SMOOTHED_NUKE_TYPES,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_TRADE_SHIP,
  UT_WARSHIP,
} from "../../types";
import { DynamicInstanceBuffer } from "../DynamicBuffer";
import type { RenderSettings } from "../RenderSettings";
import { getPaletteSize } from "../utils/ColorUtils";
import { createProgram, shaderSrc } from "../utils/GlUtils";

import naturalRaw from "../../pixel/palettes/natural.txt?raw";
import unitsRaw from "../../pixel/sprites/units.txt?raw";
import pixelUnitFragSrc from "../shaders/pixel-unit/pixel-unit.frag.glsl?raw";
import pixelUnitVertSrc from "../shaders/pixel-unit/pixel-unit.vert.glsl?raw";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** World units covered by one 16x16 sprite. At zoom 1 a texel is one device
 *  pixel; at zoom 4 it is four. Both are integer, so NEAREST stays crisp. */
const PIXEL_UNIT_WORLD_SIZE = 16;

/** Per-instance: 3 floats + 4 bytes, same 16-byte stride as UnitPass. */
const FLOATS_PER_INSTANCE = 4;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

const FLAG_NORMAL = 0;
const FLAG_FLICKER = 1;
const FLAG_ANGRY = 2;
const FLAG_TRADE_FRIENDLY = 3;
const FLAG_RETREATING = 4;
const FLAG_FLICKER_UNTARGETABLE = 5;
const FLAG_TRADE_SELF = 6;

/** Nuke + warhead types — rendered with flickering hot colours. */
const FLICKER_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_SAM_MISSILE,
  UT_SHELL,
]);

/** Missile/projectile types — rendered on top of structures. */
const MISSILE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_MIRV_WARHEAD,
]);

/** Values per smoothing segment: (instanceIdx, lastX, lastY, x, y). */
const SMOOTH_SEG_STRIDE = 5;

/** Per-instance flicker phase offset. Kept byte-identical to UnitPass so the
 *  pixel and classic renderers animate at the same phase. */
export function flickerHashByte(x: number, y: number): number {
  const f = x * 0.1731 + y * 0.3179;
  return ((f - Math.floor(f)) * 255) | 0;
}

function createUnitVao(
  gl: WebGL2RenderingContext,
  quadBuf: WebGLBuffer,
  instanceBuf: WebGLBuffer,
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
  gl.vertexAttribDivisor(1, 1);

  // spriteSlot, flags, flickerHash
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, false, BYTES_PER_INSTANCE, 12);
  gl.vertexAttribDivisor(2, 1);

  // frame (reserved byte, always 0 today)
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.UNSIGNED_BYTE, false, BYTES_PER_INSTANCE, 15);
  gl.vertexAttribDivisor(3, 1);

  gl.bindVertexArray(null);
  return vao;
}

// ---------------------------------------------------------------------------
// PixelUnitPass
// ---------------------------------------------------------------------------

export class PixelUnitPass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;
  private program: WebGLProgram;
  private mapW: number;

  private palette: Palette;
  private table: UnitSpriteTable;
  private atlas: SpriteAtlas;
  private assets: PixelGpuAssets;

  private uCamera: WebGLUniformLocation;
  private uZoom: WebGLUniformLocation;
  private uUnitSize: WebGLUniformLocation;
  private uHBombGlowScale: WebGLUniformLocation;
  private uHBombGlowColor: WebGLUniformLocation;
  private uHBombGlowStrength: WebGLUniformLocation;
  private uHBombGlowInner: WebGLUniformLocation;
  private uSpriteRects: WebGLUniformLocation;
  private uFillSlot: WebGLUniformLocation;
  private uBorderSlot: WebGLUniformLocation;
  private uAccentSlot: WebGLUniformLocation;
  private uAltView: WebGLUniformLocation;
  private uSelfColor: WebGLUniformLocation;
  private uAllyColor: WebGLUniformLocation;
  private uAngryColor: WebGLUniformLocation;
  private uTick: WebGLUniformLocation;
  private uFlickerSpeed: WebGLUniformLocation;
  private uUntargetableAlpha: WebGLUniformLocation;

  private affiliationTex: WebGLTexture | null = null;
  private altView = false;

  // Ground/sea units (boats, trains) — render below structures.
  private groundVao: WebGLVertexArrayObject;
  private groundBuf: DynamicInstanceBuffer;
  private groundCount = 0;

  // Missiles/projectiles (nukes, shells, SAM) — render above structures.
  private missileVao: WebGLVertexArrayObject;
  private missileBuf: DynamicInstanceBuffer;
  private missileCount = 0;

  // Per-frame nuke smoothing: flat SMOOTH_SEG_STRIDE-wide tuples
  // (instanceIdx, lastX, lastY, x, y), identical to UnitPass.
  private smoothSegs: number[] = [];
  private lastUnitsUpdateMs = 0;
  private tickIntervalMs: number;

  private quadBuf: WebGLBuffer;

  private frameTick = 0;
  private lastGameTick = -1;
  private startTime = performance.now();

  private localPlayerID = 0;
  private friendlyOwners = new Set<number>();
  private structures: Map<number, UnitState> = new Map();

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    paletteData: Float32Array,
    settings: RenderSettings,
    config: Config,
  ) {
    this.gl = gl;
    this.settings = settings;
    this.mapW = header.mapWidth;
    this.tickIntervalMs = config.msPerTick();

    // --- Sprite assets (parsed once, from the files bundled at build time) ---
    this.palette = parsePalette(naturalRaw, "natural");
    const sprites = parseSprites(
      [{ name: "units.txt", text: unitsRaw }],
      new Map([[this.palette.name, this.palette]]),
    );
    this.table = buildUnitSpriteTable(sprites);
    for (const name of UNIT_SPRITES.values()) {
      if (!sprites.has(name)) {
        throw new Error(
          `PixelUnitPass: units.txt has no sprite for ${JSON.stringify(name)}`,
        );
      }
    }
    const hydrogenBombSlot = this.table.lookup.get(UT_HYDROGEN_BOMB);
    if (hydrogenBombSlot === undefined) {
      throw new Error("PixelUnitPass: units.txt has no hydrogen bomb sprite");
    }
    this.atlas = buildAtlas(sprites, this.palette);

    gl.activeTexture(gl.TEXTURE0);
    this.assets = uploadPixelAssets(
      gl,
      this.atlas,
      buildSpritePalette(paletteData, this.palette, getPaletteSize()),
    );
    if (typeof gl.pixelStorei === "function") {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }

    // --- Program ---
    this.program = createProgram(
      gl,
      shaderSrc(pixelUnitVertSrc, {
        MAX_SPRITE_SLOTS: MAX_UNIT_SPRITE_SLOTS,
        HYDROGEN_BOMB_SLOT: hydrogenBombSlot,
      }),
      shaderSrc(pixelUnitFragSrc, {
        MAX_SPRITE_SLOTS: MAX_UNIT_SPRITE_SLOTS,
      }),
      "PixelUnitPass",
    );

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uZoom = gl.getUniformLocation(this.program, "uZoom")!;
    this.uUnitSize = gl.getUniformLocation(this.program, "uUnitSize")!;
    this.uHBombGlowScale = gl.getUniformLocation(
      this.program,
      "uHBombGlowScale",
    )!;
    this.uHBombGlowColor = gl.getUniformLocation(
      this.program,
      "uHBombGlowColor",
    )!;
    this.uHBombGlowStrength = gl.getUniformLocation(
      this.program,
      "uHBombGlowStrength",
    )!;
    this.uHBombGlowInner = gl.getUniformLocation(
      this.program,
      "uHBombGlowInner",
    )!;
    this.uSpriteRects = gl.getUniformLocation(this.program, "uSpriteRects")!;
    this.uFillSlot = gl.getUniformLocation(this.program, "uFillSlot")!;
    this.uBorderSlot = gl.getUniformLocation(this.program, "uBorderSlot")!;
    this.uAccentSlot = gl.getUniformLocation(this.program, "uAccentSlot")!;
    this.uAltView = gl.getUniformLocation(this.program, "uAltView")!;
    this.uSelfColor = gl.getUniformLocation(this.program, "uSelfColor")!;
    this.uAllyColor = gl.getUniformLocation(this.program, "uAllyColor")!;
    this.uAngryColor = gl.getUniformLocation(this.program, "uAngryColor")!;
    this.uTick = gl.getUniformLocation(this.program, "uTick")!;
    this.uFlickerSpeed = gl.getUniformLocation(this.program, "uFlickerSpeed")!;
    this.uUntargetableAlpha = gl.getUniformLocation(
      this.program,
      "uUntargetableAlpha",
    )!;

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAtlas"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uSpritePalette"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAffiliation"), 2);
    gl.uniform1i(this.uFillSlot, this.palette.playerIndexes.fill);
    gl.uniform1i(this.uBorderSlot, this.palette.playerIndexes.border);
    gl.uniform1i(this.uAccentSlot, this.palette.playerIndexes.accent);

    // Static per-slot atlas rects (x, y, w, h) in texels.
    const rects = new Float32Array(MAX_UNIT_SPRITE_SLOTS * 4);
    for (let slot = 0; slot < this.table.slots.length; slot++) {
      const name = this.table.slots[slot];
      const rect = this.atlas.rects.get(name);
      if (rect === undefined) {
        throw new Error(
          `PixelUnitPass: atlas has no rect for sprite ${JSON.stringify(name)}`,
        );
      }
      rects[slot * 4 + 0] = rect.x;
      rects[slot * 4 + 1] = rect.y;
      rects[slot * 4 + 2] = rect.w;
      rects[slot * 4 + 3] = rect.h;
    }
    gl.uniform4fv(this.uSpriteRects, rects);

    // --- Shared quad + instance buffers ---
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );

    const groundGlBuf = gl.createBuffer()!;
    this.groundBuf = new DynamicInstanceBuffer(
      gl,
      groundGlBuf,
      1024,
      FLOATS_PER_INSTANCE,
    );
    this.groundVao = createUnitVao(gl, this.quadBuf, groundGlBuf);

    const missileGlBuf = gl.createBuffer()!;
    this.missileBuf = new DynamicInstanceBuffer(
      gl,
      missileGlBuf,
      512,
      FLOATS_PER_INSTANCE,
    );
    this.missileVao = createUnitVao(gl, this.quadBuf, missileGlBuf);
  }

  private emitGround(
    x: number,
    y: number,
    ownerID: number,
    slot: number,
    flags: number,
  ): void {
    this.groundBuf.ensureCapacity(this.groundCount + 1);
    const off = this.groundCount * FLOATS_PER_INSTANCE;
    this.groundBuf.float32[off + 0] = x;
    this.groundBuf.float32[off + 1] = y;
    this.groundBuf.float32[off + 2] = ownerID;
    const byteOff = this.groundCount * BYTES_PER_INSTANCE;
    this.groundBuf.uint8[byteOff + 12] = slot;
    this.groundBuf.uint8[byteOff + 13] = flags;
    this.groundBuf.uint8[byteOff + 14] = flickerHashByte(x, y);
    this.groundBuf.uint8[byteOff + 15] = 0; // frame
    this.groundCount++;
  }

  private emitMissile(
    x: number,
    y: number,
    ownerID: number,
    slot: number,
    flags: number,
  ): void {
    this.missileBuf.ensureCapacity(this.missileCount + 1);
    const off = this.missileCount * FLOATS_PER_INSTANCE;
    this.missileBuf.float32[off + 0] = x;
    this.missileBuf.float32[off + 1] = y;
    this.missileBuf.float32[off + 2] = ownerID;
    const byteOff = this.missileCount * BYTES_PER_INSTANCE;
    this.missileBuf.uint8[byteOff + 12] = slot;
    this.missileBuf.uint8[byteOff + 13] = flags;
    this.missileBuf.uint8[byteOff + 14] = flickerHashByte(x, y);
    this.missileBuf.uint8[byteOff + 15] = 0; // frame
    this.missileCount++;
  }

  setFrameTick(frameTick: number): void {
    this.frameTick = frameTick;
  }

  updateUnits(units: Map<number, UnitState>, gameTick: number): void {
    if (gameTick !== this.lastGameTick) {
      this.lastGameTick = gameTick;
      this.lastUnitsUpdateMs = performance.now();
    }
    this.groundCount = 0;
    this.missileCount = 0;
    this.smoothSegs.length = 0;

    for (const unit of units.values()) {
      if (!unit.isActive || unit.waitTicks > 0) continue;

      const slot = unitSpriteSlot(
        this.table,
        unit.unitType,
        unit.trainType,
        unit.loaded,
      );
      if (slot === undefined) continue;

      const isRetreatingWarship =
        unit.unitType === UT_WARSHIP && unit.retreating;
      const isAngryWarship =
        unit.unitType === UT_WARSHIP && unit.targetUnitId !== null;
      const isFlicker = FLICKER_TYPES.has(unit.unitType);

      // Alt-view trade ship colour from owner + destination port owner:
      //   self involved on either end        -> green  (FLAG_TRADE_SELF)
      //   ally/teammate involved on either end -> yellow (FLAG_TRADE_FRIENDLY)
      //   otherwise                          -> red    (owner affiliation)
      let tradeFlag = FLAG_NORMAL;
      if (
        unit.unitType === UT_TRADE_SHIP &&
        unit.targetUnitId !== null &&
        this.localPlayerID > 0
      ) {
        const targetPort = this.structures.get(unit.targetUnitId);
        if (targetPort) {
          const portOwner = targetPort.ownerID;
          if (
            unit.ownerID === this.localPlayerID ||
            portOwner === this.localPlayerID
          ) {
            tradeFlag = FLAG_TRADE_SELF;
          } else if (
            this.friendlyOwners.has(unit.ownerID) ||
            this.friendlyOwners.has(portOwner)
          ) {
            tradeFlag = FLAG_TRADE_FRIENDLY;
          }
        }
      }

      let flags = FLAG_NORMAL;
      if (tradeFlag !== FLAG_NORMAL) {
        flags = tradeFlag;
      } else if (isRetreatingWarship) {
        flags = FLAG_RETREATING;
      } else if (isAngryWarship) {
        flags = FLAG_ANGRY;
      } else if (isFlicker) {
        flags = unit.targetable
          ? FLAG_FLICKER
          : FLAG_FLICKER_UNTARGETABLE;
      }
      const isMissile = MISSILE_TYPES.has(unit.unitType);

      const x = unit.pos % this.mapW;
      const y = (unit.pos - x) / this.mapW;

      if (isMissile) {
        if (
          SMOOTHED_NUKE_TYPES.has(unit.unitType) &&
          unit.lastPos !== unit.pos
        ) {
          const lx = unit.lastPos % this.mapW;
          const ly = (unit.lastPos - lx) / this.mapW;
          this.smoothSegs.push(this.missileCount, lx, ly, x, y);
        }
        this.emitMissile(x, y, unit.ownerID, slot, flags);

        // Shells emit a second instance at lastPos (2-pixel trail effect).
        if (unit.unitType === UT_SHELL && unit.lastPos !== unit.pos) {
          const lx = unit.lastPos % this.mapW;
          const ly = (unit.lastPos - lx) / this.mapW;
          this.emitMissile(lx, ly, unit.ownerID, slot, flags);
        }
      } else {
        this.emitGround(x, y, unit.ownerID, slot, flags);
      }
    }

    const gl = this.gl;
    if (this.groundCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf.buffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.groundBuf.float32,
        0,
        this.groundCount * FLOATS_PER_INSTANCE,
      );
    }
    if (this.missileCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.missileBuf.buffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        this.missileBuf.float32,
        0,
        this.missileCount * FLOATS_PER_INSTANCE,
      );
    }
  }

  setAltView(active: boolean): void {
    this.altView = active;
  }

  setAffiliationTex(tex: WebGLTexture): void {
    this.affiliationTex = tex;
  }

  setLocalPlayer(id: number): void {
    this.localPlayerID = id;
  }

  setAllies(allies: Set<number>): void {
    this.friendlyOwners = allies;
  }

  setStructures(structs: Map<number, UnitState>): void {
    this.structures = structs;
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

  private bindProgram(cameraMatrix: Float32Array, zoom: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);

    const us = this.settings.unit;
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uZoom, zoom);
    gl.uniform1f(this.uUnitSize, PIXEL_UNIT_WORLD_SIZE);
    gl.uniform1f(this.uTick, this.frameTick);
    gl.uniform1f(this.uFlickerSpeed, us.flickerSpeed);
    gl.uniform3f(this.uAngryColor, us.angryR, us.angryG, us.angryB);
    gl.uniform1f(this.uHBombGlowScale, us.hBombGlowScale);
    gl.uniform3f(
      this.uHBombGlowColor,
      us.hBombGlowR,
      us.hBombGlowG,
      us.hBombGlowB,
    );
    gl.uniform1f(this.uHBombGlowStrength, us.hBombGlowStrength);
    gl.uniform1f(this.uHBombGlowInner, us.hBombGlowInner);
    gl.uniform1f(this.uUntargetableAlpha, us.untargetableAlpha);
    gl.uniform1i(this.uAltView, this.altView ? 1 : 0);
    const af = this.settings.affiliation;
    gl.uniform3f(this.uSelfColor, af.selfR, af.selfG, af.selfB);
    gl.uniform3f(this.uAllyColor, af.allyR, af.allyG, af.allyB);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.assets.atlasTexture);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.assets.paletteTexture);

    if (this.affiliationTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.affiliationTex);
    }
  }

  /** Draw ground/sea units (boats, trains). Render below structures. */
  drawGround(cameraMatrix: Float32Array, zoom: number): void {
    if (this.groundCount === 0) return;
    this.bindProgram(cameraMatrix, zoom);
    const gl = this.gl;
    gl.bindVertexArray(this.groundVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.groundCount);
  }

  /** Draw missiles/projectiles. Render above structures. */
  drawMissiles(cameraMatrix: Float32Array, zoom: number): void {
    if (this.missileCount === 0) return;
    this.applyMissileSmoothing();
    this.bindProgram(cameraMatrix, zoom);
    const gl = this.gl;
    gl.bindVertexArray(this.missileVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.missileCount);
  }

  /** Lerp smoothed nukes lastPos→pos by wall-clock progress through the
   *  current tick and re-upload the (small) missile instance buffer. */
  private applyMissileSmoothing(): void {
    const segs = this.smoothSegs;
    if (segs.length === 0) return;
    const alpha = Math.min(
      1,
      (performance.now() - this.lastUnitsUpdateMs) / this.tickIntervalMs,
    );
    const f32 = this.missileBuf.float32;
    for (let i = 0; i < segs.length; i += SMOOTH_SEG_STRIDE) {
      const off = segs[i] * FLOATS_PER_INSTANCE;
      f32[off + 0] = segs[i + 1] + (segs[i + 3] - segs[i + 1]) * alpha;
      f32[off + 1] = segs[i + 2] + (segs[i + 4] - segs[i + 2]) * alpha;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.missileBuf.buffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      f32,
      0,
      this.missileCount * FLOATS_PER_INSTANCE,
    );
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    this.groundBuf.dispose();
    this.missileBuf.dispose();
    gl.deleteBuffer(this.quadBuf);
    gl.deleteVertexArray(this.groundVao);
    gl.deleteVertexArray(this.missileVao);
    disposePixelAssets(gl, this.assets);
  }
}
