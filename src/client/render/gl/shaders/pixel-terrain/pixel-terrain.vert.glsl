#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;

uniform mat3 uCamera;

out vec2 vWorld;

void main() {
  // aPos is already in world tiles; the fragment shader needs the exact
  // position to derive the tile and the 4x4 sub-tile pattern.
  vWorld = aPos;

  vec3 clip = uCamera * vec3(aPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
