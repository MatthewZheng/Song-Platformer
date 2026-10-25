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
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / max(1.0, uRes.y);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float distSq = dot(p, p);
  float dist = sqrt(distSq);

  // Clubbed to Death: Neo-noir emerald digital rain + dramatic orchestral string ripples
  vec3 bg = uPalette[0];
  vec3 emerald = uPalette[1];
  vec3 teal = uPalette[2];
  vec3 gold = uPalette[3];
  vec3 hi = uPalette[4];

  // Vertical rain columns streaming down
  float colX = floor((p.x + 2.0) * 24.0);
  float colRnd = hash21(vec2(colX, 1.0));
  float colSpeed = 0.8 + colRnd * 1.3;
  float rainY = fract(uv.y * 2.4 + uTime * colSpeed * 0.45 + colRnd);
  float rainTrail = smoothstep(0.0, 0.85, rainY) * step(rainY, 0.92);
  float rainHead = smoothstep(0.86, 0.94, rainY) * step(rainY, 0.96);
  float colActive = step(0.42, hash21(vec2(colX, floor(uSongTime * 0.5))));
  vec3 rainCol = (emerald * rainTrail * 0.32 + hi * rainHead * 0.55) * colActive * (0.35 + uMid * 0.75);

  // Concentric orchestral bass rings on uLow & beat phase (fast polynomial power & radial falloff)
  float bp = clamp(1.0 - uBeatPhase, 0.0, 1.0);
  float beatKick = bp * bp * bp;
  float radialFade = 1.0 / (1.0 + distSq * 2.2);
  float ripple = sin(dist * 15.0 - uTime * 2.4 - beatKick * 1.2) * 0.5 + 0.5;
  float rippleSq = ripple * ripple;
  float ringGlow = (rippleSq * rippleSq) * radialFade * (0.25 + uLow * 1.1 + beatKick * 0.4);

  // High-frequency piano/cymbal glints on uHigh
  vec2 spGrid = floor(p * 18.0 + vec2(0.0, uTime * 0.5));
  float spRnd = hash21(spGrid + floor(uSection));
  float spMask = step(0.84, spRnd) * (sin(uSongTime * 10.0 + spRnd * 6.28) * 0.5 + 0.5);

  vec3 col = mix(bg, teal * 0.35, clamp(1.0 - dist * 0.65, 0.0, 1.0) * (0.4 + 0.6 * uSectionProgress));
  col += rainCol;
  col += mix(emerald, gold, 0.35) * ringGlow * 0.75;
  col += mix(gold, hi, 0.5) * spMask * uHigh * 0.65;

  // Valley & peak envelope
  col *= (0.4 + 0.6 * clamp(uEnergy, 0.0, 1.0));
  col += gold * (uBloom * 0.35 * radialFade);

  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma * 0.72), clamp(uDesat, 0.0, 1.0));
  col = mix(col, vec3(0.75, 0.08, 0.14), clamp(uMissFlash, 0.0, 1.0) * smoothstep(0.06, 0.8, distSq) * 0.55);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
