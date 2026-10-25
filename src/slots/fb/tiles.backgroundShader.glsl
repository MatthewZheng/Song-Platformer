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
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / max(1.0, uRes.y);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float distSq = dot(p, p);
  float dist = sqrt(distSq);

  // Fire Burning: Solar dancefloor plasma ribbons + pulsing club equalizer rings
  vec3 bg = uPalette[0];
  vec3 flameRed = uPalette[1];
  vec3 solarOrange = uPalette[2];
  vec3 neonMagenta = uPalette[3];
  vec3 warmGold = uPalette[4];

  float bp = clamp(1.0 - uBeatPhase, 0.0, 1.0);
  float beatPulse = bp * bp * bp;
  float radialFade = 1.0 / (1.0 + distSq * 2.1);

  float swirl = sin((p.x * p.y) * 9.0 + dist * 8.0 - uTime * 2.2) * 0.5 + 0.5;
  float waveRibbon = sin(p.y * 7.0 + sin(p.x * 4.5 + uTime * 1.6) * 1.4) * 0.5 + 0.5;

  // Club bass rings driven by uLow
  float ring = smoothstep(0.65, 0.96, sin(dist * 14.0 - uTime * 3.0 - beatPulse * 1.1) * 0.5 + 0.5);
  float ringFade = radialFade * (0.3 + uLow * 1.05 + beatPulse * 0.4);

  // Rising ember sparkles driven by uHigh
  vec2 emberUv = p * 14.0 - vec2(sin(uTime * 0.7) * 0.5, uTime * 1.2);
  vec2 eId = floor(emberUv);
  vec2 eSt = fract(emberUv) - 0.5;
  float eRnd = hash21(eId + floor(uSection));
  float ember = smoothstep(0.03, 0.001, dot(eSt, eSt)) * step(0.68, eRnd) * (0.3 + uHigh * 1.25);

  vec3 col = mix(bg, flameRed * 0.42, waveRibbon * 0.55);
  col = mix(col, solarOrange * 0.62, swirl * radialFade * (0.35 + uMid * 0.65));
  col += mix(solarOrange, neonMagenta, 0.45) * ring * ringFade * 0.85;
  col += warmGold * ember * 0.8;

  col *= (0.4 + 0.6 * clamp(uEnergy, 0.0, 1.0));
  col += mix(neonMagenta, warmGold, 0.5) * (uBloom * 0.36 * radialFade);

  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma * 0.72), clamp(uDesat, 0.0, 1.0));
  col = mix(col, vec3(0.75, 0.08, 0.14), clamp(uMissFlash, 0.0, 1.0) * smoothstep(0.06, 0.8, distSq) * 0.55);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
