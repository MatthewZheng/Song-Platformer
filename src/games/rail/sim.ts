import type { SongMap } from '../../shell/api';
import { scoreOnBeat } from '../../shared/songmap';
import { createRng } from '../../shared/rng';
import { defaultParams, generateLevel, type RailLevel, type RailParams } from './level';
import { shouldBotPulseRail } from './bot';

export function simulate(opts: {
  map: SongMap;
  level?: RailLevel;
  params?: RailParams;
  seed?: number;
  entry?: number;
  until?: number;
}): Record<string, number> {
  const params = { ...defaultParams, ...(opts.params || {}) };
  const rng = createRng(opts.seed ?? 42);
  const level = opts.level ?? generateLevel(opts.map, params, rng);
  const entry = opts.entry ?? 0;
  const until = opts.until ?? Math.min(opts.map.duration, entry + 30);
  const dt = 1 / 120;

  let score = 0;
  let onBeatActions = 0;
  let totalActions = 0;
  let lastPulseBeat = -999;

  for (let t = entry; t <= until; t += dt) {
    const decision = shouldBotPulseRail(opts.map, t, lastPulseBeat);
    if (decision.pulse) {
      lastPulseBeat = decision.beatTime;
      totalActions++;
      const res = scoreOnBeat(opts.map, t);
      if (res.onBeat) {
        onBeatActions++;
        score += res.points;
      }
    }
    score += 10 * dt;
  }

  return {
    score: Math.round(score),
    onBeatPct: totalActions > 0 ? Math.round((onBeatActions / totalActions) * 100) : 100,
    wavesCount: level.waveTimes.length,
  };
}
