#version 300 es
precision highp float;
precision highp int;

// Raw terrain byte per tile, shared with the map-layer passes:
//   bit 7 land, bit 6 shoreline, bits 0-4 magnitude (31 = impassable).
uniform highp usampler2D uTerrainBytes;
// 16x1 RGBA8 palette row. Terrain colours are fixed slots from natural.txt;
// the player slots are never used here.
uniform sampler2D uPalette;

uniform int uSlotDeep;      // d - deep water
uniform int uSlotShallow;   // w - shallow water
uniform int uSlotSand;      // s - sand
uniform int uSlotGrass;     // g - grass
uniform int uSlotForest;    // f - forest
uniform int uSlotHighland;  // h - highland
uniform int uSlotMountain;  // m - mountain / foam
uniform vec3 uBackground;   // matches the renderer clear colour

// Device pixels per world tile. The camera already includes DPR, so 4 means
// one device pixel per 4x4 sub-tile cell.
uniform float uZoom;

in vec2 vWorld;
out vec4 fragColor;

const uint SEED = 0x46574b53u;

int bayer4(ivec2 p) {
  const int m[16] = int[16](
    0,  8,  2, 10,
   12,  4, 14,  6,
    3, 11,  1,  9,
   15,  7, 13,  5
  );
  return m[(p.y & 3) * 4 + (p.x & 3)];
}

// Exact 32-bit integer hash (same constants as pixel/terrainScatter.ts).
uint hashU(ivec2 p) {
  uint h = SEED;
  h ^= uint(p.x) * 0x9e3779b1u;
  h = (h ^ (h >> 16u)) * 0x85ebca6bu;
  h ^= uint(p.y) * 0xc2b2ae35u;
  h = (h ^ (h >> 13u)) * 0x27d4eb2fu;
  return h ^ (h >> 16u);
}

bool isLandAt(ivec2 p) {
  ivec2 q = clamp(p, ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  uint v = texelFetch(uTerrainBytes, q, 0).r;
  return (v & 0x80u) != 0u && (v & 0x1fu) != 31u;
}

// Ordered dither between two adjacent palette slots. `threshold` is 0..16.
int pick(int base, int target, uint d, uint threshold) {
  return d < threshold ? target : base;
}

void main() {
  ivec2 tile = clamp(
    ivec2(floor(vWorld)),
    ivec2(0),
    ivec2(MAP_W - 1, MAP_H - 1)
  );
  uint b = texelFetch(uTerrainBytes, tile, 0).r;

  bool isLand = (b & 0x80u) != 0u;
  bool isShore = (b & 0x40u) != 0u;
  uint mag = b & 0x1fu;

  // Impassable terrain blends into the area outside the map quad, exactly like
  // the classic baked texture did.
  if (isLand && mag == 31u) {
    fragColor = vec4(uBackground, 1.0);
    return;
  }

  bool detail = uZoom >= 4.0;
  ivec2 sub = ivec2(0);
  uint d;
  if (detail) {
    sub = clamp(
      ivec2(floor(fract(vWorld) * 4.0)),
      ivec2(0),
      ivec2(3)
    );
    d = (uint(bayer4(sub)) + (hashU(tile) & 15u)) & 15u;
  } else {
    // One colour per tile: the macro dither avoids a flat checkerboard and
    // keeps tiles stable while panning zoomed out.
    d = (uint(bayer4(tile)) + (hashU(tile) & 15u)) & 15u;
  }

  int slot;
  if (isLand) {
    if (isShore) {
      slot = uSlotSand;
    } else if (mag < 5u) {
      slot = pick(uSlotSand, uSlotGrass, d, mag * 16u / 5u);
    } else if (mag < 10u) {
      slot = pick(uSlotGrass, uSlotForest, d, (mag - 5u) * 16u / 5u);
    } else if (mag < 15u) {
      slot = pick(uSlotGrass, uSlotHighland, d, (mag - 10u) * 16u / 5u);
    } else if (mag < 20u) {
      slot = pick(uSlotHighland, uSlotMountain, d, (mag - 15u) * 16u / 5u);
    } else {
      slot = pick(uSlotHighland, uSlotMountain, d, (mag - 20u) * 16u / 10u);
    }
  } else if (isShore) {
    slot = uSlotShallow;
    // Foam: one sub-pixel on the water side of every edge that faces land.
    // Only meaningful when sub-tiles exist; at macro LOD the tile is 1 px.
    if (detail) {
      bool foam = false;
      if (sub.x == 0) {
        foam = isLandAt(tile + ivec2(-1, 0));
      } else if (sub.x == 3) {
        foam = isLandAt(tile + ivec2(1, 0));
      }
      if (!foam) {
        if (sub.y == 0) {
          foam = isLandAt(tile + ivec2(0, -1));
        } else if (sub.y == 3) {
          foam = isLandAt(tile + ivec2(0, 1));
        }
      }
      if (foam) slot = uSlotMountain;
    }
  } else {
    slot = pick(uSlotShallow, uSlotDeep, d, min(mag, 10u) * 16u / 10u);
  }

  fragColor = vec4(texelFetch(uPalette, ivec2(slot, 0), 0).rgb, 1.0);
}
