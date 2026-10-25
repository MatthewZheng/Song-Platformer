import type { SongMap } from '../../shell/api';
import { nearestBeat } from '../../shared/songmap';

export function shouldBotPulseRail(map: SongMap, songTime: number, lastPulseBeatTime: number): {
  pulse: boolean;
  beatTime: number;
} {
  const nb = nearestBeat(map, songTime);
  if (Math.abs(songTime - nb) <= 0.035 && Math.abs(nb - lastPulseBeatTime) > 0.12) {
    return { pulse: true, beatTime: nb };
  }
  return { pulse: false, beatTime: lastPulseBeatTime };
}
