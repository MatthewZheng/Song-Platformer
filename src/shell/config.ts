import type { GameId } from './api';

export const ORDER: GameId[] = ['runner', 'horror', 'tiles'];

export const DEATH_MAX_SEC = 1.0;
export const READJUST = 1.0;
export const RUNWAY = 5.0;
export const RUNWAY_MIN_EARLY = 2.0;
export const SONG_END_FADE_SEC = 0.5;

export const SCORING = {
  ON_BEAT_PERFECT_MS: 50,
  ON_BEAT_PERFECT_PTS: 100,
  ON_BEAT_GOOD_MS: 100,
  ON_BEAT_GOOD_PTS: 50,
  SURVIVAL_PTS_PER_SEC: 10,
} as const;
