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
  p = fract(p * vec2(317.13, 189.47));
  p += dot(p, p + 29.53);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / max(1.0, uRes.y);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float distSq = dot(p, p);

  // Radioactive: High-voltage hexagonal reactor core + shockwave rings + ionized sparks
  vec3 bg = uPalette[0];
  vec3 radGreen = uPalette[1];
  vec3 crimson = uPalette[2];
  vec3 voltYellow = uPalette[3];
  vec3 whiteHi = uPalette[4];

  float bp = clamp(1.0 - uBeatPhase, 0.0, 1.0);
  float beatShock = bp * bp * bp;
  float radialFade = 1.0 / (1.0 + distSq * 2.1);

  float hexMetric = max(abs(p.x) * 0.866025 + abs(p.y) * 0.5, abs(p.y));
  float shockRing = smoothstep(0.68, 0.97, sin(hexMetric * 16.0 - uTime * 2.8 - beatShock * 1.4) * 0.5 + 0.5);
  float rayWave = abs(sin((p.x - p.y) * 4.5 + uTime * 0.4));
  float radialRays = (rayWave * rayWave * rayWave) * radialFade;

  // Ionized dust sparks on uHigh
  vec2 sparkCell = floor(p * 16.0 + vec2(cos(uTime * 0.4), sin(uTime * 0.4)) * 2.0);
  float sRnd = hash21(sparkCell + floor(uSection));
  float spark = step(0.82, sRnd) * (sin(uSongTime * 12.0 + sRnd * 6.28) * 0.5 + 0.5) * (0.25 + uHigh * 1.3);

  vec3 col = mix(bg, radGreen * 0.36, radialRays * (0.4 + uMid * 0.7));
  col += mix(radGreen, crimson, 0.4 + 0.4 * sin(uSectionProgress * 3.14159)) * shockRing * radialFade * (0.3 + uLow * 1.15 + beatShock * 0.45);
  col += mix(voltYellow, whiteHi, 0.45) * spark * 0.75;

  col *= (0.4 + 0.6 * clamp(uEnergy, 0.0, 1.0));
  col += voltYellow * (uBloom * 0.35 * radialFade);

  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma * 0.72), clamp(uDesat, 0.0, 1.0));
  col = mix(col, vec3(0.75, 0.08, 0.14), clamp(uMissFlash, 0.0, 1.0) * smoothstep(0.06, 0.8, distSq) * 0.55);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
