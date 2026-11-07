import { describe, expect, it, vi } from "vitest";
import { buildAtlas } from "../../../../src/client/render/pixel/buildAtlas";
import naturalRaw from "../../../../src/client/render/pixel/palettes/natural.txt?raw";
import { parsePalette } from "../../../../src/client/render/pixel/parsePalette";
import { parseSprites } from "../../../../src/client/render/pixel/parseSprites";
import {
  buildSpritePalette,
  type SpritePaletteRows,
} from "../../../../src/client/render/pixel/SpritePalette";
import {
  disposePixelAssets,
  uploadPixelAssets,
} from "../../../../src/client/render/pixel/uploadPixelAssets";

const GL = {
  MAX_TEXTURE_SIZE: 0x0d33,
  TEXTURE_2D: 0x0de1,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  NEAREST: 0x2600,
  CLAMP_TO_EDGE: 0x812f,
  R8UI: 0x8232,
  RED_INTEGER: 0x8d94,
  RGBA8: 0x8058,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  UNPACK_ALIGNMENT: 0x0cf5,
};

const palette = parsePalette(naturalRaw, "natural");

function rows(size = 16): string[] {
  return Array.from({ length: size }, () => ".".repeat(size));
}

function assets() {
  const sprites = parseSprites(
    [
      {
        name: "dev.txt",
        text: ["@sprite test", "@frame 0", ...rows()].join("\n"),
      },
    ],
    new Map([["natural", palette]]),
  );
  return {
    atlas: buildAtlas(sprites, palette),
    palette: buildSpritePalette(new Float32Array(4096 * 2 * 4), palette, 4),
  };
}

function makeGL(maxTextureSize = 4096) {
  const texImage2D = vi.fn();
  const texParameteri = vi.fn();
  const deleteTexture = vi.fn();
  const gl = {
    ...GL,
    getParameter: vi.fn(() => maxTextureSize),
    createTexture: vi.fn(() => ({})),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D,
    texParameteri,
    deleteTexture,
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    texImage2D,
    texParameteri,
    deleteTexture,
  };
}

describe("uploadPixelAssets", () => {
  it("uploads the atlas as R8UI and the palette as RGBA8", () => {
    const { gl, texImage2D, texParameteri } = makeGL();
    const { atlas, palette: spritePalette } = assets();

    uploadPixelAssets(gl, atlas, spritePalette);

    expect(texImage2D).toHaveBeenCalledTimes(2);
    expect(texImage2D).toHaveBeenNthCalledWith(
      1,
      GL.TEXTURE_2D,
      0,
      GL.R8UI,
      atlas.width,
      atlas.height,
      0,
      GL.RED_INTEGER,
      GL.UNSIGNED_BYTE,
      atlas.indices,
    );
    expect(texImage2D).toHaveBeenNthCalledWith(
      2,
      GL.TEXTURE_2D,
      0,
      GL.RGBA8,
      spritePalette.width,
      spritePalette.height,
      0,
      GL.RGBA,
      GL.UNSIGNED_BYTE,
      spritePalette.data,
    );

    const params = texParameteri.mock.calls.map((call) => [call[1], call[2]]);
    expect(
      params.filter(
        ([name, value]) =>
          name === GL.TEXTURE_MIN_FILTER && value === GL.NEAREST,
      ),
    ).toHaveLength(2);
    expect(
      params.filter(
        ([name, value]) =>
          name === GL.TEXTURE_MAG_FILTER && value === GL.NEAREST,
      ),
    ).toHaveLength(2);
    expect(
      params.filter(
        ([name, value]) =>
          name === GL.TEXTURE_WRAP_S && value === GL.CLAMP_TO_EDGE,
      ),
    ).toHaveLength(2);
    expect(
      params.filter(
        ([name, value]) =>
          name === GL.TEXTURE_WRAP_T && value === GL.CLAMP_TO_EDGE,
      ),
    ).toHaveLength(2);
  });

  it("sets unpack alignment for the one-byte atlas", () => {
    const { gl } = makeGL();
    const { atlas, palette: spritePalette } = assets();
    uploadPixelAssets(gl, atlas, spritePalette);
    expect(
      (gl as unknown as { pixelStorei: ReturnType<typeof vi.fn> }).pixelStorei,
    ).toHaveBeenCalledWith(GL.UNPACK_ALIGNMENT, 1);
  });

  it("rejects an atlas larger than MAX_TEXTURE_SIZE", () => {
    const { gl } = makeGL(128);
    const { atlas, palette: spritePalette } = assets();
    expect(() => uploadPixelAssets(gl, atlas, spritePalette)).toThrow(
      /sprite atlas 256x256 exceeds GL_MAX_TEXTURE_SIZE \(128\)/,
    );
  });

  it("rejects a palette taller than MAX_TEXTURE_SIZE", () => {
    const { gl } = makeGL(2);
    const atlas = {
      indices: new Uint8Array(4),
      width: 2,
      height: 2,
      rects: new Map(),
    };
    const spritePalette: SpritePaletteRows = {
      width: 16,
      height: 4,
      data: new Uint8Array(16 * 4 * 4),
    };
    expect(() => uploadPixelAssets(gl, atlas, spritePalette)).toThrow(
      /sprite palette 16x4 exceeds GL_MAX_TEXTURE_SIZE \(2\)/,
    );
  });

  it("releases both textures on dispose", () => {
    const { gl, deleteTexture } = makeGL();
    const { atlas, palette: spritePalette } = assets();
    const uploaded = uploadPixelAssets(gl, atlas, spritePalette);
    disposePixelAssets(gl, uploaded);
    expect(deleteTexture).toHaveBeenCalledTimes(2);
    expect(deleteTexture).toHaveBeenNthCalledWith(1, uploaded.atlasTexture);
    expect(deleteTexture).toHaveBeenNthCalledWith(2, uploaded.paletteTexture);
  });
});
