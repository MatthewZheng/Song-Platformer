import type { SongMap } from '../../shell/api';

export interface RailParams {
  enemyDensity: number;
  bulletSpeed: number;
  missLimit: number;
}

export const defaultParams: RailParams = {
  enemyDensity: 0.7,
  bulletSpeed: 1.0,
  missLimit: 3,
};

export const paramRanges: Record<keyof RailParams, { min: number; max: number; step: number }> = {
  enemyDensity: { min: 0.3, max: 1.0, step: 0.05 },
  bulletSpeed: { min: 0.6, max: 1.8, step: 0.1 },
  missLimit: { min: 2, max: 5, step: 1 },
};

export interface RailLevel {
  waveTimes: number[];
  params: RailParams;
}

export function generateLevel(
  map: SongMap,
  params: RailParams = defaultParams,
  _rng: () => number = () => 0.5,
): RailLevel {
  return {
    waveTimes: map.downbeats.slice(),
    params: { ...defaultParams, ...params },
  };
}
