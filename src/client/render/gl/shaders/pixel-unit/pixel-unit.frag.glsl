#version 300 es
precision highp float;
precision highp int;

// Sprite atlas: one palette index per texel, R8UI, NEAREST. 255 = transparent.
uniform highp usampler2D uAtlas;
// 16-wide RGBA8 palette: row = owner smallID, column = palette index. Built by
// SpritePalette from the renderer's paletteData, so P/B/C are the live player
// colours and never reach PlayerPalette itself.
uniform sampler2D uSpritePalette;
// 256x2 RGBA8 — row 1 = unit affiliation (alt view).
uniform sampler2D uAffiliation;

// Pixel rect of each slot inside the atlas: x, y, w, h.
uniform vec4 uSpriteRects[MAX_SPRITE_SLOTS];

uniform int   uFillSlot;    // palette index of the player fill (P)
uniform int   uBorderSlot;  // palette index of the player border (B)
uniform int   uAccentSlot;  // palette index of the player accent (C)
uniform int   uAltView;
uniform vec3  uAngryColor;
uniform vec3  uSelfColor;   // alt-view trade ship colours
uniform vec3  uAllyColor;
uniform float uTick;
uniform float uFlickerSpeed;
uniform vec3  uHBombGlowColor;
uniform float uHBombGlowStrength;
uniform float uHBombGlowInner;
uniform float uUntargetableAlpha;

in vec2  vSpriteUV;
in vec2  vQuadPos;
flat in float vSlot;
flat in float vOwnerID;
flat in float vFlags;
flat in float vHash;
flat in float vGlow;
flat in float vLod;
flat in float vFrame;

out vec4 fragColor;

// Palette indices 0..14 are colours; 15 is unused and 255 is transparent.
const uint FIRST_UNUSED_INDEX = 15u;
const uint TRANSPARENT_INDEX = 255u;

// Flag constants — must match CPU-side FLAG_* values.
const float FLAG_FLICKER = 1.0;
const float FLAG_ANGRY = 2.0;
const float FLAG_TRADE_FRIENDLY = 3.0;
const float FLAG_RETREATING = 4.0;
const float FLAG_FLICKER_UNTARGETABLE = 5.0;
const float FLAG_TRADE_SELF = 6.0;

const vec3 FLICKER_COLORS[4] = vec3[4](
  vec3(1.0, 0.0, 0.0),
  vec3(1.0, 0.5, 0.0),
  vec3(1.0, 1.0, 0.0),
  vec3(1.0, 1.0, 1.0)
);

void main() {
  int owner = int(vOwnerID + 0.5);
  // Untargetable nukes render translucent so players know SAMs can't hit them.
  float alphaMul = abs(vFlags - FLAG_FLICKER_UNTARGETABLE) < 0.1
    ? uUntargetableAlpha
    : 1.0;

  // Zoomed-out LOD: one flat player-colour block, no atlas lookup. Combat and
  // affiliation states still apply so a red angry warship stays red.
  if (vLod > 0.5) {
    vec3 block = texelFetch(uSpritePalette, ivec2(uFillSlot, owner), 0).rgb;
    if (uAltView != 0) {
      block = abs(vFlags - FLAG_TRADE_SELF) < 0.1
        ? uSelfColor
        : abs(vFlags - FLAG_TRADE_FRIENDLY) < 0.1
          ? uAllyColor
          : texelFetch(uAffiliation, ivec2(owner, 1), 0).rgb;
    } else if (abs(vFlags - FLAG_ANGRY) < 0.1) {
      block = uAngryColor;
    } else if (abs(vFlags - FLAG_FLICKER) < 0.1 ||
               abs(vFlags - FLAG_FLICKER_UNTARGETABLE) < 0.1) {
      float phase = fract(uTick * uFlickerSpeed + vHash);
      block = FLICKER_COLORS[int(phase * 4.0) % 4];
    }
    fragColor = vec4(block, alphaMul);
    return;
  }

  int slot = int(vSlot + 0.5);
  vec4 rect = uSpriteRects[slot];
  // The reserved instance byte selects a frame inside an animation strip. All
  // F3c sprites are single-frame, so this is the frame-0 path today.
  ivec2 origin = ivec2(rect.xy) + ivec2(int(vFrame + 0.5) * int(rect.z), 0);
  ivec2 lo = origin;
  ivec2 hi = origin + ivec2(rect.zw - 1.0);

  bool inSprite = vSpriteUV.x >= 0.0 && vSpriteUV.x <= 1.0 &&
                  vSpriteUV.y >= 0.0 && vSpriteUV.y <= 1.0;
  uint index = TRANSPARENT_INDEX;
  if (inSprite) {
    ivec2 texel = clamp(
      lo + ivec2(floor(vSpriteUV * rect.zw)),
      lo,
      hi
    );
    index = texelFetch(uAtlas, texel, 0).r;
  }

  // Outside the sprite: render the steady soft glow under the hydrogen bomb,
  // otherwise discard. Glow is suppressed in alt (affiliation) view.
  if (index >= FIRST_UNUSED_INDEX) {
    if (vGlow > 0.5 && uAltView == 0) {
      float d = length(vQuadPos - 0.5) * 2.0;
      float g = (1.0 - smoothstep(uHBombGlowInner, 1.0, d)) *
                uHBombGlowStrength;
      if (g > 0.001) {
        fragColor = vec4(uHBombGlowColor, g * alphaMul);
        return;
      }
    }
    discard;
  }

  // Alt view paints the affiliation hue and keeps the sprite alpha.
  if (uAltView != 0) {
    vec3 ac = abs(vFlags - FLAG_TRADE_SELF) < 0.1
      ? uSelfColor
      : abs(vFlags - FLAG_TRADE_FRIENDLY) < 0.1
        ? uAllyColor
        : texelFetch(uAffiliation, ivec2(owner, 1), 0).rgb;
    fragColor = vec4(ac, alphaMul);
    return;
  }

  vec3 fill = texelFetch(uSpritePalette, ivec2(uFillSlot, owner), 0).rgb;
  vec3 border = texelFetch(uSpritePalette, ivec2(uBorderSlot, owner), 0).rgb;
  vec3 accent = texelFetch(uSpritePalette, ivec2(uAccentSlot, owner), 0).rgb;

  if (abs(vFlags - FLAG_ANGRY) < 0.1) {
    // Attacking warship: the player fill and accent go red, border stays.
    fill = uAngryColor;
    accent = uAngryColor;
  } else if (abs(vFlags - FLAG_RETREATING) < 0.1) {
    // Retreating: slowly blink the player fill to black.
    float blink = step(0.5, fract(uTick * 0.07));
    fill = mix(fill, vec3(0.0), blink);
    accent = mix(accent, vec3(0.0), blink);
  } else if (abs(vFlags - FLAG_FLICKER) < 0.1 ||
             abs(vFlags - FLAG_FLICKER_UNTARGETABLE) < 0.1) {
    // Nukes and warheads cycle through hot colours, offset by position hash.
    float phase = fract(uTick * uFlickerSpeed + vHash);
    int idx = int(phase * 4.0) % 4;
    fill = FLICKER_COLORS[idx];
    border = FLICKER_COLORS[(idx + 2) % 4];
    accent = fill;
  }

  int i = int(index);
  vec3 color;
  if (i == uFillSlot) {
    color = fill;
  } else if (i == uBorderSlot) {
    color = border;
  } else if (i == uAccentSlot) {
    color = accent;
  } else {
    color = texelFetch(uSpritePalette, ivec2(i, owner), 0).rgb;
  }

  fragColor = vec4(color, alphaMul);
}
