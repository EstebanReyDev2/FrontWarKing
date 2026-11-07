/**
 * Uploads the runtime sprite atlas (R8UI) and the sprite palette (RGBA8).
 *
 * Both textures are integer-indexed, so there is no filtering to configure
 * beyond NEAREST/CLAMP_TO_EDGE and no mipmap chain. The atlas size is checked
 * against `MAX_TEXTURE_SIZE` before `texImage2D`, so a driver too small for the
 * atlas fails with a readable error instead of a silent incomplete texture.
 */

import type { SpriteAtlas } from "./buildAtlas";
import type { SpritePaletteRows } from "./SpritePalette";

export interface PixelGpuAssets {
  atlasTexture: WebGLTexture;
  paletteTexture: WebGLTexture;
}

function requireMaxTextureSize(gl: WebGL2RenderingContext): number {
  const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) {
    throw new Error("GL_MAX_TEXTURE_SIZE is unavailable");
  }
  return max;
}

function configureNearest(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

export function uploadPixelAssets(
  gl: WebGL2RenderingContext,
  atlas: SpriteAtlas,
  palette: SpritePaletteRows,
): PixelGpuAssets {
  const max = requireMaxTextureSize(gl);
  if (atlas.width > max || atlas.height > max) {
    throw new Error(
      `sprite atlas ${atlas.width}x${atlas.height} exceeds GL_MAX_TEXTURE_SIZE (${max})`,
    );
  }
  if (palette.width > max || palette.height > max) {
    throw new Error(
      `sprite palette ${palette.width}x${palette.height} exceeds GL_MAX_TEXTURE_SIZE (${max})`,
    );
  }

  const atlasTexture = gl.createTexture();
  if (atlasTexture === null) {
    throw new Error("could not create the sprite atlas texture");
  }

  let paletteTexture: WebGLTexture | null = null;
  try {
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    if (typeof gl.pixelStorei === "function") {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    }
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8UI,
      atlas.width,
      atlas.height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      atlas.indices,
    );
    configureNearest(gl);

    paletteTexture = gl.createTexture();
    if (paletteTexture === null) {
      throw new Error("could not create the sprite palette texture");
    }
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      palette.width,
      palette.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      palette.data,
    );
    configureNearest(gl);
  } catch (error) {
    gl.deleteTexture(atlasTexture);
    if (paletteTexture !== null) gl.deleteTexture(paletteTexture);
    throw error;
  }

  return { atlasTexture, paletteTexture };
}

/** Release both textures; safe to call on a context about to be lost. */
export function disposePixelAssets(
  gl: WebGL2RenderingContext,
  assets: PixelGpuAssets,
): void {
  gl.deleteTexture(assets.atlasTexture);
  gl.deleteTexture(assets.paletteTexture);
}
