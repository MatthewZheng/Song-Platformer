import type { SlotRegistry } from './api';

export const DEFAULT_TILES_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;
uniform float uTime;
uniform float uEnergy;
uniform float uLow;
uniform float uMid;
uniform float uHigh;
uniform vec3 uBg;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
uniform vec3 uAccent;
varying vec2 vUv;

void main() {
  vec2 uv = vUv - 0.5;
  float dist = length(uv);
  float wave = sin(uv.y * 18.0 - uTime * 3.5) * 0.5 + 0.5;
  float pulse = smoothstep(0.55, 0.05, dist) * (0.3 + uLow * 0.7);
  vec3 col = mix(uBg, uPrimary, wave * 0.22 * (0.4 + uMid));
  col = mix(col, uSecondary, pulse * 0.38);
  col += uAccent * (0.08 * uHigh * smoothstep(0.4, 0.0, abs(uv.x)));
  gl_FragColor = vec4(col, 1.0);
}
`;

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
    partial.tiles.backgroundShader.includes('gl_FragColor')
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
