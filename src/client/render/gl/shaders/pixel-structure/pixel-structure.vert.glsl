#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;

// Per-instance, identical to StructurePass:
//   x, y, ownerID, underConstruction, spriteSlot, markedForDeletion
layout(location = 1) in vec4 aInst0; // x, y, ownerID, underConstruction
layout(location = 2) in vec2 aInst1; // spriteSlot, markedForDeletion

uniform mat3  uCamera;
uniform float uZoom;

uniform float uIconSize;
uniform float uDotsThreshold;
uniform float uDotScale;
uniform float uScaleFactor;
uniform float uIconGrowZoom;
// Per-slot shape scale, so a sprite keeps the footprint its type had in the
// classic renderer (silo/SAM are deliberately bigger than a city).
uniform float uSlotScales[MAX_SPRITE_SLOTS];

out vec2  vSpriteUV;
out vec2  vLocalPos;
flat out float vSlot;
flat out float vOwnerID;
flat out float vUnderConstruction;
flat out float vMarkedForDeletion;

void main() {
  int slot = int(aInst1.x + 0.5);
  vSlot = aInst1.x;
  vOwnerID = aInst0.z;
  vUnderConstruction = aInst0.w;
  vMarkedForDeletion = aInst1.y;

  // Same LOD as the classic pass: dots when zoomed out, fixed screen size in
  // the middle band, world-anchored past uIconGrowZoom.
  float iconScale;
  if (uZoom <= uDotsThreshold) {
    iconScale = uDotScale;
  } else if (uZoom >= uIconGrowZoom) {
    iconScale = uZoom / uIconGrowZoom;
  } else {
    iconScale = min(1.0, uZoom / uScaleFactor);
  }

  float halfSize = uIconSize * iconScale * 0.5 / uZoom * uSlotScales[slot];

  vec2 center = vec2(aInst0.x + 0.5, aInst0.y + 0.5);
  vec2 worldPos = center + (aPos - 0.5) * halfSize * 2.0;

  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);

  vLocalPos = aPos - 0.5;
  vSpriteUV = aPos;
}
