import type { SlotRegistry } from './api';

export const DEFAULT_TILES_FRAGMENT_SHADER = /* glsl */ `precision mediump float;

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

  float flowA = sin(p.x * 2.4 + uTime * 0.55 + uSection * 0.7) * 0.5 + 0.5;
  float flowB = cos(p.y * 2.8 - uTime * 0.42 + uSectionProgress * 3.14159) * 0.5 + 0.5;
  vec3 gradCol = mix(uPalette[0], uPalette[1] * 0.48, flowA * 0.65);
  gradCol = mix(gradCol, uPalette[2] * 0.55, flowB * 0.52);

  float bp = clamp(1.0 - uBeatPhase, 0.0, 1.0);
  float beatWave = bp * bp * bp;
  float radialFade = 1.0 / (1.0 + distSq * 2.4);

  float ringFreq = 11.0 + mod(uSection, 3.0) * 2.0;
  float ringPhase = dist * ringFreq - uTime * (1.8 + uLow * 2.2) - beatWave * 0.9;
  float rings1 = smoothstep(0.68, 0.96, sin(ringPhase) * 0.5 + 0.5);
  float crossRipple = (p.x * p.x - p.y * p.y) * 1.4;
  float rings2 = smoothstep(0.72, 0.98, cos(dist * 18.0 - uTime * 1.2 + crossRipple) * 0.5 + 0.5);
  float ringMask = (rings1 * 0.75 + rings2 * 0.45) * radialFade * (0.28 + uLow * 0.95 + beatWave * 0.35);

  vec3 col = gradCol;
  col += uPalette[1] * ringMask * 0.65;
  col += uPalette[3] * rings2 * radialFade * (0.2 + uMid * 0.65);

  vec2 gridUv = p * 14.0 + vec2(0.0, uTime * 0.35);
  vec2 cellId = floor(gridUv);
  vec2 cellSt = fract(gridUv) - 0.5;
  float rnd = hash21(cellId + floor(uSection));
  float sparkDistSq = dot(cellSt, cellSt);
  float twinkle = sin(uSongTime * 8.0 + rnd * 6.2831) * 0.5 + 0.5;
  float sparkle = smoothstep(0.035 * (0.4 + uHigh * 0.9), 0.001, sparkDistSq) * twinkle * step(0.66, rnd);
  col += mix(uPalette[3], uPalette[4], 0.6) * sparkle * (0.25 + uHigh * 1.35);

  float valleyBrightness = 0.4 + 0.6 * clamp(uEnergy, 0.0, 1.0);
  col *= valleyBrightness;
  col += (uPalette[3] + uPalette[4]) * (0.16 * uBloom * radialFade);

  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(luma * 0.75), clamp(uDesat, 0.0, 1.0));

  float vig = smoothstep(0.08, 0.85, distSq);
  col = mix(col, vec3(0.75, 0.08, 0.14), clamp(uMissFlash, 0.0, 1.0) * vig * 0.55);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const REQUIRED_TILES_UNIFORMS = [
  'uTime',
  'uSongTime',
  'uRes',
  'uLow',
  'uMid',
  'uHigh',
  'uEnergy',
  'uBeatPhase',
  'uSection',
  'uSectionProgress',
  'uPalette',
  'uMissFlash',
  'uBloom',
  'uDesat',
] as const;

export function isValidTilesShaderSource(src: string): boolean {
  if (typeof src !== 'string' || !src.includes('void main') || !src.includes('gl_FragColor')) {
    return false;
  }
  return REQUIRED_TILES_UNIFORMS.every((u) => src.includes(u));
}

export function defaultRailFormation(
  t: number,
  index: number,
  count: number,
): { x: number; y: number; z: number } {
  const safeCount = Math.max(1, count);
  const norm = index / safeCount;
  const angle = norm * Math.PI * 2 + t * 1.4;
  const radius = 2.2 + 0.6 * Math.sin(t * 2.0 + index);
  return {
    x: Math.cos(angle) * radius,
    y: 1.2 + Math.sin(angle * 2.0) * 0.8,
    z: -12 - (index % 4) * 2.5,
  };
}

export function createDefaultSlots(): SlotRegistry {
  return {
    tiles: {
      backgroundShader: DEFAULT_TILES_FRAGMENT_SHADER,
    },
    rail: {
      formation: defaultRailFormation,
    },
  };
}

/**
 * Validates candidate per-song slots within a strict 2 ms wall-clock budget.
 * On any error or timeout, falls back to the working default slot and logs a warning.
 */
export function validateSlotRegistry(partial?: Partial<SlotRegistry>): SlotRegistry {
  const defaults = createDefaultSlots();
  if (!partial) return defaults;

  let tilesShader = defaults.tiles.backgroundShader;
  if (
    typeof partial.tiles?.backgroundShader === 'string' &&
    isValidTilesShaderSource(partial.tiles.backgroundShader)
  ) {
    tilesShader = partial.tiles.backgroundShader;
  }

  let railFn = defaults.rail.formation;
  if (typeof partial.rail?.formation === 'function') {
    const candidate = partial.rail.formation;
    try {
      const t0 = performance.now();
      const pos = candidate(1.0, 0, 5);
      const elapsedMs = performance.now() - t0;
      if (
        elapsedMs <= 2.0 &&
        pos &&
        Number.isFinite(pos.x) &&
        Number.isFinite(pos.y) &&
        Number.isFinite(pos.z)
      ) {
        railFn = (t: number, index: number, count: number) => {
          try {
            const p = candidate(t, index, count);
            if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
              return p;
            }
          } catch {
            // fallback on runtime exception
          }
          return defaultRailFormation(t, index, count);
        };
      } else {
        console.warn(`[slots] rail.formation failed validation or exceeded 2ms (${elapsedMs.toFixed(2)}ms); using default.`);
      }
    } catch (err) {
      console.warn('[slots] rail.formation threw during validation; using default:', err);
    }
  }

  return {
    tiles: { backgroundShader: tilesShader },
    rail: { formation: railFn },
  };
}
