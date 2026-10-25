import type { SongMap } from '../../shell/api';

export interface RunnerParams {
  obstacleDensity: number;
  speedMultiplier: number;
  missLimit: number;
}

export const defaultParams: RunnerParams = {
  obstacleDensity: 0.65,
  speedMultiplier: 1.0,
  missLimit: 3,
};

export const paramRanges: Record<keyof RunnerParams, { min: number; max: number; step: number }> = {
  obstacleDensity: { min: 0.2, max: 1.0, step: 0.05 },
  speedMultiplier: { min: 0.6, max: 1.8, step: 0.1 },
  missLimit: { min: 2, max: 5, step: 1 },
};

export interface RunnerLevel {
  beatTargets: number[];
  params: RunnerParams;
}

export function generateLevel(
  map: SongMap,
  params: RunnerParams = defaultParams,
  rng: () => number = () => 0.5,
): RunnerLevel {
  const beatTargets = map.beats.filter((_, i) => i === 0 || rng() <= params.obstacleDensity + 0.35);
  return {
    beatTargets: beatTargets.length > 0 ? beatTargets : map.beats.slice(),
    params: { ...defaultParams, ...params },
  };
}
