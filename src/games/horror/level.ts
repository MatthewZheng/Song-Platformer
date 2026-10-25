import type { SongMap } from '../../shell/api';

export interface HorrorParams {
  huntSensitivity: number;
  monsterSpeed: number;
  missLimit: number;
}

export const defaultParams: HorrorParams = {
  huntSensitivity: 0.7,
  monsterSpeed: 1.0,
  missLimit: 3,
};

export const paramRanges: Record<keyof HorrorParams, { min: number; max: number; step: number }> = {
  huntSensitivity: { min: 0.3, max: 1.0, step: 0.05 },
  monsterSpeed: { min: 0.5, max: 2.0, step: 0.1 },
  missLimit: { min: 2, max: 5, step: 1 },
};

export interface HorrorLevel {
  huntSections: number[];
  params: HorrorParams;
}

export function generateLevel(
  map: SongMap,
  params: HorrorParams = defaultParams,
  _rng: () => number = () => 0.5,
): HorrorLevel {
  const huntSections = map.sections
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => s.label === 'drop' || s.label === 'build' || s.energy >= 0.55)
    .map(({ idx }) => idx);
  return {
    huntSections,
    params: { ...defaultParams, ...params },
  };
}
