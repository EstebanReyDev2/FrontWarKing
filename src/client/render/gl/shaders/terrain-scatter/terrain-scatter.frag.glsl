#version 300 es
precision highp float;
precision highp int;

// Sprite atlas: one palette index per texel, R8UI, NEAREST. 255 = transparent.
uniform highp usampler2D uAtlas;
// 16x1 RGBA8 palette row. Decor only uses fixed slots.
uniform sampler2D uPalette;
uniform vec4 uSpriteRects[MAX_SPRITE_SLOTS];

in vec2 vSpriteUV;
flat in float vSlot;
flat in float vVariant;

out vec4 fragColor;

void main() {
  int slot = int(vSlot + 0.5);
  vec4 rect = uSpriteRects[slot];

  vec2 uv = vSpriteUV;
  // Half the instances are mirrored; one drawing per prop is enough variety.
  if ((int(vVariant + 0.5) & 1) != 0) {
    uv.x = 1.0 - uv.x;
  }

  ivec2 origin = ivec2(rect.xy);
  ivec2 texel = origin + ivec2(floor(uv * rect.zw));
  texel = clamp(texel, origin, origin + ivec2(rect.zw - 1.0));

  uint index = texelFetch(uAtlas, texel, 0).r;
  if (index >= 15u) discard;

  fragColor = vec4(
    texelFetch(uPalette, ivec2(int(index), 0), 0).rgb,
    1.0
  );
}
