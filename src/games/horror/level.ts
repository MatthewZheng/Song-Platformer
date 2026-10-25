import type { SongMap } from '../../shell/api';
import { findNearest, roundTime, sectionAt } from '../../shared/songmap';
import { getOfficeMap } from './map';

export interface HorrorParams {
  directorIntervalBase: number;
  doubleBack: number;
  hintJitter: number;
  menaceMax: number;
  walkSpeedMin: number;
  walkSpeedMax: number;
  chaseSpeed: number;
  sprintSpeed: number;
}

export const defaultParams: HorrorParams = {
  directorIntervalBase: 10.0,
  doubleBack: 0.35,
  hintJitter: 3.8,
  menaceMax: 12.0,
  walkSpeedMin: 1.15,
  walkSpeedMax: 1.6,
  chaseSpeed: 2.6,
  sprintSpeed: 4.5,
};

export const paramRanges: Record<keyof HorrorParams, { min: number; max: number; step: number }> = {
  directorIntervalBase: { min: 8.0, max: 12.0, step: 0.5 },
  doubleBack: { min: 0.15, max: 0.6, step: 0.05 },
  hintJitter: { min: 2.0, max: 6.0, step: 0.2 },
  menaceMax: { min: 8.0, max: 16.0, step: 1.0 },
  walkSpeedMin: { min: 1.1, max: 1.35, step: 0.05 },
  walkSpeedMax: { min: 1.4, max: 1.6, step: 0.05 },
  chaseSpeed: { min: 2.2, max: 3.0, step: 0.1 },
  sprintSpeed: { min: 4.0, max: 5.0, step: 0.1 },
};

export interface SectionMonsterConfig {
  sectionIndex: number;
  directorInterval: number;
  walkSpeed: number;
}

export interface HorrorLevel {
  params: HorrorParams;
  countdownTargets: number[];
  sectionConfigs: SectionMonsterConfig[];
  enabledSpotIds: number[];
  doubleBack: number;
  hintJitter: number;
  menaceMax: number;
}

/**
 * Computes the end timestamp of a hide countdown starting at `hideStart`.
 * First round: first section start or drop in [hideStart + 10, hideStart + 20], else hideStart + 15.
 * Subsequent rounds ("HIDE AGAIN"): hideStart + 10.
 */
export function computeCountdownEnd(
  map: SongMap,
  hideStart: number,
  isFirstRound: boolean,
): number {
  if (!isFirstRound) {
    return roundTime(hideStart + 10.0);
  }
  const minT = hideStart + 10.0;
  const maxT = hideStart + 20.0;
  const candidates: number[] = [];

  for (const sec of map.sections) {
    if (sec.start >= minT && sec.start <= maxT) {
      candidates.push(sec.start);
    }
  }
  for (const dropT of map.drops) {
    if (dropT >= minT && dropT <= maxT) {
      candidates.push(dropT);
    }
  }
  candidates.sort((a, b) => a - b);
  if (candidates.length > 0) {
    return roundTime(candidates[0]);
  }
  return roundTime(hideStart + 15.0);
}

/**
 * Computes the 6 ceiling light bank switch-off timestamps during [hideStart, countdownEnd].
 * Banks 0..4 switch off on evenly spaced downbeats, and bank 5 (the 6th bank) switches off
 * exactly at countdownEnd.
 */
export function computeLightBankOffTimes(
  map: SongMap,
  hideStart: number,
  countdownEnd: number,
): number[] {
  const span = Math.max(3.0, countdownEnd - hideStart);
  const downbeatsInSpan = (map.downbeats ?? []).filter(
    (d) => d > hideStart + 0.4 && d < countdownEnd - 0.3,
  );
  const times: number[] = [];

  for (let i = 0; i < 5; i++) {
    const ideal = hideStart + ((i + 1) / 6) * span;
    if (downbeatsInSpan.length >= 5) {
      const nearest = findNearest(ideal, downbeatsInSpan).value;
      // Ensure strictly increasing order
      const prev = times.length > 0 ? times[times.length - 1] : hideStart + 0.3;
      times.push(roundTime(Math.max(prev + 0.25, Math.min(countdownEnd - 0.25 * (5 - i), nearest))));
    } else {
      times.push(roundTime(ideal));
    }
  }
  // 6th bank switches off right at countdownEnd
  times.push(roundTime(countdownEnd));
  return times;
}

/**
 * Computes when a hunt starting at `huntStart` ends:
 * lasts until the current section ends (clamped to minimum 15 s, maximum 35 s).
 */
export function computeHuntEnd(map: SongMap, huntStart: number): number {
  const sec = sectionAt(map, huntStart + 0.1);
  let targetEnd = sec.end;

  if (targetEnd - huntStart < 15.0) {
    // Look for subsequent section boundary within [huntStart + 15, huntStart + 35]
    for (const s of map.sections) {
      if (s.end >= huntStart + 15.0) {
        targetEnd = s.end;
        break;
      }
    }
  }

  const clamped = Math.max(huntStart + 15.0, Math.min(huntStart + 35.0, targetEnd));
  return roundTime(clamped);
}

export function generateLevel(
  map: SongMap,
  params: HorrorParams = defaultParams,
  rng: () => number = () => 0.5,
): HorrorLevel {
  const merged: HorrorParams = { ...defaultParams, ...params };
  const office = getOfficeMap();

  // Collect candidate countdown targets across the song
  const countdownTargets: number[] = [];
  for (const s of map.sections) {
    if (s.start >= 10) countdownTargets.push(roundTime(s.start));
  }
  for (const d of map.drops) {
    if (d >= 10 && !countdownTargets.includes(roundTime(d))) {
      countdownTargets.push(roundTime(d));
    }
  }
  countdownTargets.sort((a, b) => a - b);

  // Per-section directorInterval (8-12s, shorter in high-energy sections) and walkSpeed (1.1-1.6 m/s)
  const sectionConfigs: SectionMonsterConfig[] = map.sections.map((sec, idx) => {
    const e = Math.max(0, Math.min(1, sec.energy));
    const directorInterval = roundTime(
      Math.max(8.0, Math.min(12.0, merged.directorIntervalBase + (0.5 - e) * 4.0)),
    );
    const walkSpeed = roundTime(
      merged.walkSpeedMin + (merged.walkSpeedMax - merged.walkSpeedMin) * e,
    );
    return {
      sectionIndex: idx,
      directorInterval,
      walkSpeed,
    };
  });

  // Enable hiding spots (at least 12 out of total, always keeping booths, closets, and spawn-reachable desks)
  const totalSpots = office.hidingSpots;
  const enabledSpotIds: number[] = [];
  for (const spot of totalSpots) {
    if (spot.kind === 'booth' || spot.kind === 'closet') {
      enabledSpotIds.push(spot.id);
    } else {
      // Keep most desks enabled deterministically (at least 12 total spots)
      if (rng() < 0.85 || enabledSpotIds.length < 10) {
        enabledSpotIds.push(spot.id);
      }
    }
  }
  // Guarantee at least 10 enabled spots
  for (const spot of totalSpots) {
    if (enabledSpotIds.length >= 12) break;
    if (!enabledSpotIds.includes(spot.id)) {
      enabledSpotIds.push(spot.id);
    }
  }
  enabledSpotIds.sort((a, b) => a - b);

  return {
    params: merged,
    countdownTargets,
    sectionConfigs,
    enabledSpotIds,
    doubleBack: merged.doubleBack,
    hintJitter: merged.hintJitter,
    menaceMax: merged.menaceMax,
  };
}
