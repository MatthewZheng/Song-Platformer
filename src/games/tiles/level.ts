import type { SongMap } from '../../shell/api';

export interface TilesParams {
  laneSpeed: number;
  noteDensity: number;
  missLimit: number;
}

export const defaultParams: TilesParams = {
  laneSpeed: 1.0,
  noteDensity: 0.75,
  missLimit: 3,
};

export const paramRanges: Record<keyof TilesParams, { min: number; max: number; step: number }> = {
  laneSpeed: { min: 0.6, max: 1.8, step: 0.1 },
  noteDensity: { min: 0.3, max: 1.0, step: 0.05 },
  missLimit: { min: 2, max: 5, step: 1 },
};

export interface TilesLevel {
  notes: Array<{ t: number; lane: number }>;
  params: TilesParams;
}

export function generateLevel(
  map: SongMap,
  params: TilesParams = defaultParams,
  _rng: () => number = () => 0.5,
): TilesLevel {
  let lane = 1;
  const notes = map.melody.map((m) => {
    lane = Math.max(0, Math.min(3, lane + m.dir));
    return { t: m.t, lane };
  });
  return {
    notes,
    params: { ...defaultParams, ...params },
  };
}
