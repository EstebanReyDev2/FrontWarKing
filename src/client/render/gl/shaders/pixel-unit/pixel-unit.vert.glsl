#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;

// Per-instance, identical layout to the classic UnitPass:
//   x, y, ownerID (3 floats) + spriteSlot, flags, flickerHash, frame (4 bytes)
layout(location = 1) in vec3 aInstPos;   // x, y, ownerID
layout(location = 2) in vec3 aInstFlags; // spriteSlot, flags, flickerHash
layout(location = 3) in float aInstFrame; // reserved frame byte (0 = static)

uniform mat3  uCamera;
uniform float uZoom;
// World units covered by one 16x16 sprite. At zoom 1 a texel maps to one device
// pixel, so the art stays crisp at the integer zooms the game uses.
uniform float uUnitSize;
uniform float uHBombGlowScale; // quad enlargement for the hydrogen bomb halo

out vec2  vSpriteUV; // cell coords; the central 1/scale region is the sprite
out vec2  vQuadPos;  // quad coords [0,1] — drives the glow falloff
flat out float vSlot;
flat out float vOwnerID;
flat out float vFlags;
flat out float vHash;
flat out float vGlow;
flat out float vLod;   // 1.0 = solid colour block instead of the sprite
flat out float vFrame;

void main() {
  float slot = aInstFlags.x;
  vSlot = slot;
  vOwnerID = aInstPos.z;
  vFlags = aInstFlags.y;
  // CPU-side hash so per-frame smoothing never re-rolls the flicker phase.
  vHash = aInstFlags.z * (1.0 / 255.0);
  vFrame = aInstFrame;

  float isHBomb = step(abs(slot - float(HYDROGEN_BOMB_SLOT)), 0.5);
  vGlow = isHBomb;

  // LOD: a 16x16 sprite squeezed under 4 device pixels is unreadable and
  // shimmers while panning. Draw a snapped 2x2 or 4x4 solid player block
  // instead. The threshold is in device pixels because uZoom is device
  // pixels per world unit.
  float spritePx = uUnitSize * uZoom;
  float lod = step(spritePx, 3.999);
  vLod = lod;
  float blockPx = spritePx < 2.0 ? 2.0 : 4.0;

  // Glow enlarges the quad only when the sprite is actually drawn.
  float scale = mix(mix(1.0, uHBombGlowScale, isHBomb), 1.0, lod);
  float worldSize = mix(uUnitSize * scale, blockPx / max(uZoom, 0.0001), lod);
  float halfSize = worldSize * 0.5;

  vec2 center = vec2(aInstPos.x + 0.5, aInstPos.y + 0.5);
  vec2 worldPos = center + (aPos - 0.5) * halfSize * 2.0;

  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vQuadPos = aPos;
  // Map the enlarged glow quad back to sprite-cell space.
  vSpriteUV = (aPos - 0.5) * scale + 0.5;
}
