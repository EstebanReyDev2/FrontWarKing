#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec2 aPos;

// Per-instance: world centre (x, y), decor kind slot, variant byte.
layout(location = 1) in vec4 aInst;

uniform mat3 uCamera;
// Same shared R8UI terrain bytes the pixel terrain pass reads. Re-checking the
// tile here makes a water nuke remove its trees without rebuilding instances.
uniform highp usampler2D uTerrainBytes;
uniform vec2 uWorldSize[MAX_SPRITE_SLOTS];
uniform int uMapW;
uniform int uMapH;

out vec2 vSpriteUV;
flat out float vSlot;
flat out float vVariant;

void main() {
  int slot = int(aInst.z + 0.5);
  ivec2 tile = ivec2(floor(aInst.xy));
  ivec2 clamped = clamp(tile, ivec2(0), ivec2(uMapW - 1, uMapH - 1));
  uint b = texelFetch(uTerrainBytes, clamped, 0).r;
  bool land = (b & 0x80u) != 0u && (b & 0x1fu) != 31u;
  if (!land) {
    // Degenerate vertex: the whole quad collapses outside the clip volume.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vSpriteUV = vec2(0.0);
    vSlot = 0.0;
    vVariant = 0.0;
    return;
  }

  vec2 size = uWorldSize[slot];
  vec2 worldPos = aInst.xy + (aPos - 0.5) * size;
  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vSpriteUV = aPos;
  vSlot = aInst.z;
  vVariant = aInst.w;
}
