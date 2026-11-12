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
uniform vec4  uSpriteRects[MAX_SPRITE_SLOTS];
// Structure type index (0..5) per slot, for the build-button highlight mask.
uniform float uSlotTypes[MAX_SPRITE_SLOTS];

uniform float uZoom;
uniform float uDotsThreshold;
uniform int   uFillSlot;          // palette index of the player fill (P)
uniform float uGhostAlpha;        // 1.0 = normal, <1.0 = ghost transparency
uniform vec3  uOutlineColor;      // ghost tint (vec3(0) = none)
uniform int   uAltView;
uniform int   uHighlightMask;     // bitmask of structure type indexes
uniform float uHighlightDimAlpha;
uniform float uIconAlpha;
uniform float uFillDarken;        // alt-view darkening of the affiliation hue

in vec2  vSpriteUV;
in vec2  vLocalPos;
flat in float vSlot;
flat in float vOwnerID;
flat in float vUnderConstruction;
flat in float vMarkedForDeletion;

out vec4 fragColor;

// Palette indices 0..14 are colours; 15 is unused and 255 is transparent.
const uint FIRST_UNUSED_INDEX = 15u;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

vec3 darken(vec3 rgb, float vScale) {
  vec3 hsv = rgb2hsv(rgb);
  hsv.z *= vScale;
  return hsv2rgb(hsv);
}

bool insideRect(ivec2 p, ivec2 lo, ivec2 hi) {
  return p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y;
}

bool atlasOpaque(ivec2 p) {
  return texelFetch(uAtlas, p, 0).r < FIRST_UNUSED_INDEX;
}

void main() {
  int owner = int(vOwnerID + 0.5);
  int slot = int(vSlot + 0.5);
  vec4 rect = uSpriteRects[slot];
  ivec2 lo = ivec2(rect.xy);
  ivec2 hi = ivec2(rect.xy + rect.zw - 1.0);
  ivec2 texel = clamp(lo + ivec2(floor(vSpriteUV * rect.zw)), lo, hi);
  bool dots = uZoom <= uDotsThreshold;

  vec3 color = vec3(0.0);
  bool opaque = dots;
  if (dots) {
    // Zoomed out: the classic colour dot, one flat player-colour square.
    color = texelFetch(uSpritePalette, ivec2(uFillSlot, owner), 0).rgb;
  } else {
    uint index = texelFetch(uAtlas, texel, 0).r;
    opaque = index < FIRST_UNUSED_INDEX;
    if (opaque) {
      color = texelFetch(uSpritePalette, ivec2(int(index), owner), 0).rgb;
    }
  }

  float alpha = 1.0;

  // Build-button hover: outline the matching type, dim the rest.
  if (uHighlightMask != 0) {
    int bit = 1 << int(uSlotTypes[slot] + 0.5);
    bool lit = (uHighlightMask & bit) != 0;
    if (!lit) {
      if (!opaque) discard;
      alpha = uHighlightDimAlpha;
    } else if (dots) {
      color = mix(color, vec3(1.0), 0.35);
    } else if (!opaque) {
      // One-texel silhouette ring: a transparent texel touching an opaque
      // neighbour becomes white. The sprites keep a transparent margin, so the
      // ring stays inside the slot and never bleeds into the next sprite.
      bool near = false;
      if (insideRect(texel + ivec2(1, 0), lo, hi) &&
          atlasOpaque(texel + ivec2(1, 0))) near = true;
      if (insideRect(texel + ivec2(-1, 0), lo, hi) &&
          atlasOpaque(texel + ivec2(-1, 0))) near = true;
      if (insideRect(texel + ivec2(0, 1), lo, hi) &&
          atlasOpaque(texel + ivec2(0, 1))) near = true;
      if (insideRect(texel + ivec2(0, -1), lo, hi) &&
          atlasOpaque(texel + ivec2(0, -1))) near = true;
      if (!near) discard;
      fragColor = vec4(1.0);
      return;
    }
  }

  if (!opaque) discard;

  if (vUnderConstruction > 0.5) {
    // Scaffolding grey: keep the sprite's own shading, drop the hue.
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = vec3(luma * 0.85 + 0.1);
  } else if (uAltView != 0) {
    // Alt view paints the affiliation hue while keeping the sprite's
    // light/dark structure readable.
    vec3 affiliation = texelFetch(uAffiliation, ivec2(owner, 1), 0).rgb;
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    color = darken(affiliation, uFillDarken + (1.0 - uFillDarken) * luma);
  }

  // Red X for structures queued for deletion.
  if (vMarkedForDeletion > 0.5) {
    float dist = length(vLocalPos);
    float fw = fwidth(dist);
    float lineW = max(0.025, fw * 1.5);
    float d1 = abs(vLocalPos.x - vLocalPos.y) * 0.7071;
    float d2 = abs(vLocalPos.x + vLocalPos.y) * 0.7071;
    float dMin = min(d1, d2);
    float maskR = max(0.45 * 1.55, fw * 6.0);
    float mask = 1.0 - smoothstep(maskR - fw, maskR, dist);
    float xLine = (1.0 - smoothstep(lineW - fw, lineW + fw, dMin)) * mask;
    color = mix(color, vec3(1.0, 0.25, 0.25), xLine * 0.95);
  }

  // Ghost tint — same rule as the classic pass.
  float tint = step(0.01, dot(uOutlineColor, uOutlineColor));
  color = mix(color, uOutlineColor, tint * 0.5);

  fragColor = vec4(color, alpha * uGhostAlpha * uIconAlpha);
}
