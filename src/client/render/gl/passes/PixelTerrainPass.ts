/**
 * PixelTerrainPass — procedural pixel-art terrain.
 *
 * Drop-in replacement for TerrainPass, selected once in the Renderer
 * constructor from `?pixel=terrain` / `?pixel=all`. It reads the raw R8UI
 * terrain bytes that the map-layer passes already share and derives every
 * colour in the fragment shader, so the map-sized RGBA8 bake disappears.
 *
 * The byte contract is unchanged (bit 7 land, bit 6 shoreline, bit 5 ocean,
 * bits 0-4 magnitude, impassable = land + magnitude 31). Presentation is
 * derived with a Bayer 4x4 matrix plus a 32-bit integer hash seeded with
 * 0x46574b53 ("FWKS"); no `fract(sin())`, so every GPU produces the same tile.
 *
 * LOD: at zoom >= 4 (device pixels per tile) the tile is a 4x4 sub-pixel
 * pattern. Below that it collapses to one dithered colour per tile, which is
 * what avoids high-frequency shimmer while panning zoomed out. The camera's
 * zoom already includes DPR, so no extra DPR factor belongs here.
 *
 * Colours come from the fixed slots of natural.txt, not from
 * `settings.terrain.*`; only `backgroundColor` is honoured because it must
 * match the renderer clear colour for the impassable silhouette.
 */

import { parsePalette, type Palette } from "../../pixel/parsePalette";
import { buildSpritePalette } from "../../pixel/SpritePalette";
import type { RenderSettings } from "../RenderSettings";
import type { TerrainRect } from "../../types";
import {
  hexToRgb,
  type TerrainColorOverrides,
} from "../utils/ColorUtils";
import {
  createMapQuad,
  createProgram,
  createTexture2D,
  shaderSrc,
} from "../utils/GlUtils";

import naturalRaw from "../../pixel/palettes/natural.txt?raw";
import pixelTerrainFragSrc from "../shaders/pixel-terrain/pixel-terrain.frag.glsl?raw";
import pixelTerrainVertSrc from "../shaders/pixel-terrain/pixel-terrain.vert.glsl?raw";

function slotOf(palette: Palette, symbol: string): number {
  const index = palette.symbolToIndex.get(symbol);
  if (index === undefined || index >= 15) {
    throw new Error(
      `PixelTerrainPass: palette ${JSON.stringify(palette.name)} has no slot ${JSON.stringify(symbol)}`,
    );
  }
  return index;
}

export class PixelTerrainPass {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private paletteTex: WebGLTexture;
  private uCamera: WebGLUniformLocation;
  private uZoom: WebGLUniformLocation;
  private uBackground: WebGLUniformLocation;
  private readonly background = new Float32Array(3);

  constructor(
    private gl: WebGL2RenderingContext,
    // Owned by the Renderer; shared with the map-layer passes and updated by
    // applyTerrainRects(), so this pass must never delete it.
    private terrainBytesTex: WebGLTexture,
    mapW: number,
    mapH: number,
    settings: RenderSettings,
  ) {
    const palette = parsePalette(naturalRaw, "natural");
    const rows = buildSpritePalette(new Float32Array(0), palette, 1);
    this.paletteTex = createTexture2D(gl, {
      width: rows.width,
      height: rows.height,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      data: rows.data,
      filter: gl.NEAREST,
    });

    const defines = { MAP_W: mapW, MAP_H: mapH };
    this.program = createProgram(
      gl,
      shaderSrc(pixelTerrainVertSrc, defines),
      shaderSrc(pixelTerrainFragSrc, defines),
      "PixelTerrainPass",
    );

    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uZoom = gl.getUniformLocation(this.program, "uZoom")!;
    this.uBackground = gl.getUniformLocation(this.program, "uBackground")!;

    gl.useProgram(this.program);
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uTerrainBytes"),
      0,
    );
    gl.uniform1i(gl.getUniformLocation(this.program, "uPalette"), 1);
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uSlotDeep"),
      slotOf(palette, "d"),
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uSlotShallow"),
      slotOf(palette, "w"),
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uSlotSand"),
      slotOf(palette, "s"),
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uSlotGrass"),
      slotOf(palette, "g"),
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uSlotForest"),
      slotOf(palette, "f"),
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uSlotHighland"),
      slotOf(palette, "h"),
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uSlotMountain"),
      slotOf(palette, "m"),
    );

    this.setTerrainColors({
      backgroundColor:
        hexToRgb(settings.terrain.backgroundColor) ?? undefined,
    });

    this.vao = createMapQuad(gl, mapW, mapH);
  }

  /**
   * Only the background is configurable in pixel mode: the twelve terrain
   * colours are the fixed palette. Called by Renderer.rebuildTerrain().
   */
  setTerrainColors(colors?: TerrainColorOverrides): void {
    const bg = colors?.backgroundColor ?? [60, 60, 60];
    this.background[0] = bg[0] / 255;
    this.background[1] = bg[1] / 255;
    this.background[2] = bg[2] / 255;
  }

  /**
   * No-op: the shared R8UI texture is updated by Renderer.applyTerrainRects()
   * after this method returns. Keeping the method makes the pixel and classic
   * passes interchangeable in the Renderer.
   */
  applyTerrainRects(_rects: readonly TerrainRect[], _bytes: Uint8Array): void {
    // Shared texture is updated by the Renderer.
  }

  draw(cameraMatrix: Float32Array, zoom: number): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uZoom, zoom);
    gl.uniform3fv(this.uBackground, this.background);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.terrainBytesTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteTexture(this.paletteTex);
    // VAO + buffer leak is acceptable on dispose (context is being destroyed),
    // matching TerrainPass.
  }
}
