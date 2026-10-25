precision mediump float;

uniform float uTime;
uniform float uSongTime;
uniform vec2 uRes;
uniform float uLow;
uniform float uMid;
uniform float uHigh;
uniform float uEnergy;
uniform float uBeatPhase;
uniform float uSection;
uniform float uSectionProgress;
uniform vec3 uPalette[5];
uniform float uMissFlash;
uniform float uBloom;
uniform float uDesat;

varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / max(1.0, uRes.y);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float distSq = dot(p, p);
  float dist = sqrt(distSq);

  // Slow flowing gradients in the section palette (0: bg, 1: primary, 2: secondary, 3: accent, 4: highlight)
  float flowA = sin(p.x * 2.4 + uTime * 0.55 + uSection * 0.7) * 0.5 + 0.5;
  float flowB = cos(p.y * 2.8 - uTime * 0.42 + uSectionProgress * 3.14159) * 0.5 + 0.5;
  vec3 gradCol = mix(uPalette[0], uPalette[1] * 0.48, flowA * 0.65);
  gradCol = mix(gradCol, uPalette[2] * 0.55, flowB * 0.52);

  // Fast polynomial beat wave & radial falloff (replaces multiple exp/atan calls)
  float bp = clamp(1.0 - uBeatPhase, 0.0, 1.0);
  float beatWave = bp * bp * bp;
  float radialFade = 1.0 / (1.0 + distSq * 2.4);

  // Layered concentric rings pulsing with uLow and uBeatPhase
  float ringFreq = 11.0 + mod(uSection, 3.0) * 2.0;
  float ringPhase = dist * ringFreq - uTime * (1.8 + uLow * 2.2) - beatWave * 0.9;
  float rings1 = smoothstep(0.68, 0.96, sin(ringPhase) * 0.5 + 0.5);
  float crossRipple = (p.x * p.x - p.y * p.y) * 1.4;
  float rings2 = smoothstep(0.72, 0.98, cos(dist * 18.0 - uTime * 1.2 + crossRipple) * 0.5 + 0.5);
  float ringMask = (rings1 * 0.75 + rings2 * 0.45) * radialFade * (0.28 + uLow * 0.95 + beatWave * 0.35);

  vec3 col = gradCol;
  col += uPalette[1] * ringMask * 0.65;
  col += uPalette[3] * rings2 * radialFade * (0.2 + uMid * 0.65);

  // Sparkles on uHigh across a drifting star grid
  vec2 gridUv = p * 14.0 + vec2(0.0, uTime * 0.35);
  vec2 cellId = floor(gridUv);
  vec2 cellSt = fract(gridUv) - 0.5;
  float rnd = hash21(cellId + floor(uSection));
  float sparkDistSq = dot(cellSt, cellSt);
  float twinkle = sin(uSongTime * 8.0 + rnd * 6.2831) * 0.5 + 0.5;
  float sparkle = smoothstep(0.035 * (0.4 + uHigh * 0.9), 0.001, sparkDistSq) * twinkle * step(0.66, rnd);
  col += mix(uPalette[3], uPalette[4], 0.6) * sparkle * (0.25 + uHigh * 1.35);

  // Valley & peak brightness envelope: in valleys brightness = 0.4 + 0.6 * uEnergy
  float valleyBrightness = 0.4 + 0.6 * clamp(uEnergy, 0.0, 1.0);
  col *= valleyBrightness;

  // Streak bloom boost
  col += (uPalette[3] + uPalette[4]) * (0.16 * uBloom * radialFade);

  // Miss desaturation: drain color toward luminance
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma * 0.75), clamp(uDesat, 0.0, 1.0));

  // Brief crimson edge pulse on miss
  float vig = smoothstep(0.08, 0.85, distSq);
  col = mix(col, vec3(0.75, 0.08, 0.14), clamp(uMissFlash, 0.0, 1.0) * vig * 0.55);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
