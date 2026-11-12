/**
 * TerrainScatterPass — trees, rocks and huts on top of the pixel terrain.
 *
 * The instance list is built once per map by pixel/terrainScatter.ts, from the
 * same deterministic hash the terrain shader uses. One instanced draw call
 * covers every prop, so the cost is one buffer upload at load and one draw
 * while the camera is close enough for the art to read.
 *
 * The vertex shader re-reads the shared R8UI terrain texture for each instance
 * and collapses the quad when the tile is no longer land (a water nuke). That
 * keeps the static buffer valid for the whole match without a map-sized
 * rebuild per explosion.
 *
 * Visibility gate: zoom is device pixels per world tile (the camera already
 * includes DPR). Below 6 device pixels per tile a 16x16 prop is unreadable and
 * shimmers, so the pass is skipped entirely.
 */

import type { RendererConfig } from "../../types";
import { buildAtlas, type SpriteAtlas } from "../../pixel/buildAtlas";
import { parsePalette, type Palette } from "../../pixel/parsePalette";
import { parseSprites } from "../../pixel/parseSprites";
import { buildSpritePalette } from "../../pixel/SpritePalette";
import {
  buildScatterInstances,
  DECOR_SPRITE_NAMES,
} from "../../pixel/terrainScatter";
import {
  disposePixelAssets,
  uploadPixelAssets,
  type PixelGpuAssets,
} from "../../pixel/uploadPixelAssets";
import { createProgram, shaderSrc } from "../utils/GlUtils";

import naturalRaw from "../../pixel/palettes/natural.txt?raw";
import worldRaw from "../../pixel/sprites/world.txt?raw";
import terrainScatterFragSrc from "../shaders/terrain-scatter/terrain-scatter.frag.glsl?raw";
import terrainScatterVertSrc from "../shaders/terrain-scatter/terrain-scatter.vert.glsl?raw";

/** Minimum device pixels per tile before decor is drawn. */
export const DECOR_MIN_ZOOM = 6;

/** x, y, kind slot, variant. */
const FLOATS_PER_INSTANCE = 4;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

export class TerrainScatterPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer;
  private instanceBuf: WebGLBuffer;
  private assets: PixelGpuAssets;

  private uCamera: WebGLUniformLocation;
  private readonly spriteRects: Float32Array;
  private readonly worldSizes: Float32Array;
  private instanceCount = 0;

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    terrainBytes: Uint8Array,
    private terrainBytesTex: WebGLTexture,
  ) {
    this.gl = gl;

    const palette: Palette = parsePalette(naturalRaw, "natural");
    const sprites = parseSprites(
      [{ name: "world.txt", text: worldRaw }],
      new Map([[palette.name, palette]]),
    );
    const atlas: SpriteAtlas = buildAtlas(sprites, palette);

    // Texture units: 0 = terrain bytes, 1 = atlas, 2 = palette.
    gl.activeTexture(gl.TEXTURE1);
    this.assets = uploadPixelAssets(
      gl,
      atlas,
      buildSpritePalette(new Float32Array(0), palette, 1),
    );
    if (typeof gl.pixelStorei === "function") {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }

    const slotCount = DECOR_SPRITE_NAMES.length;
    this.spriteRects = new Float32Array(slotCount * 4);
    this.worldSizes = new Float32Array(slotCount * 2);
    for (let kind = 0; kind < slotCount; kind++) {
      const name = DECOR_SPRITE_NAMES[kind];
      const sprite = sprites.get(name);
      const rect = atlas.rects.get(name);
      if (sprite === undefined || rect === undefined) {
        throw new Error(
          `TerrainScatterPass: world.txt has no sprite ${JSON.stringify(name)}`,
        );
      }
      this.spriteRects[kind * 4 + 0] = rect.x;
      this.spriteRects[kind * 4 + 1] = rect.y;
      this.spriteRects[kind * 4 + 2] = rect.w;
      this.spriteRects[kind * 4 + 3] = rect.h;
      this.worldSizes[kind * 2 + 0] = sprite.world[0];
      this.worldSizes[kind * 2 + 1] = sprite.world[1];
    }

    const instances = buildScatterInstances(
      terrainBytes,
      header.mapWidth,
      header.mapHeight,
    );
    this.instanceCount = instances.length;
    const instanceData = new Float32Array(instances.length * FLOATS_PER_INSTANCE);
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const off = i * FLOATS_PER_INSTANCE;
      instanceData[off + 0] = inst.x;
      instanceData[off + 1] = inst.y;
      instanceData[off + 2] = inst.kind;
      instanceData[off + 3] = inst.variant;
    }

    this.program = createProgram(
      gl,
      shaderSrc(terrainScatterVertSrc, { MAX_SPRITE_SLOTS: slotCount }),
      shaderSrc(terrainScatterFragSrc, { MAX_SPRITE_SLOTS: slotCount }),
      "TerrainScatterPass",
    );

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTerrainBytes"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAtlas"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPalette"), 2);
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uMapW"),
      header.mapWidth,
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uMapH"),
      header.mapHeight,
    );
    gl.uniform4fv(
      gl.getUniformLocation(this.program, "uSpriteRects"),
      this.spriteRects,
    );
    gl.uniform2fv(
      gl.getUniformLocation(this.program, "uWorldSize"),
      this.worldSizes,
    );

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );

    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.STATIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(
      1,
      4,
      gl.FLOAT,
      false,
      BYTES_PER_INSTANCE,
      0,
    );
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    if (this.instanceCount === 0 || zoom < DECOR_MIN_ZOOM) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainBytesTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.assets.atlasTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.assets.paletteTexture);

    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteBuffer(this.instanceBuf);
    gl.deleteVertexArray(this.vao);
    disposePixelAssets(gl, this.assets);
  }
}
