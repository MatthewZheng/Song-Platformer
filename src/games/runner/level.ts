import type { SongMap } from '../../shell/api';
import { RUNWAY } from '../../shell/config';
import { createRng, hashString } from '../../shared/rng';
import {
  beatAt,
  nearestBeat,
  nearestDownbeat,
  nextPhraseIn,
  onsetsIn,
  sectionAt,
} from '../../shared/songmap';

export interface RunnerParams {
  airtime: number;
  scrollSpeed2D: number;
  scrollRowsPerBeat: number;
  cometSpeedMin: number;
  cometSpeedMax: number;
  minObstacleGapBuffer: number;
  lavaStreamEnabled: number;
}

export const defaultParams: RunnerParams = {
  airtime: 0.42,
  scrollSpeed2D: 11.5,
  scrollRowsPerBeat: 0.5,
  cometSpeedMin: 2.5,
  cometSpeedMax: 6.0,
  minObstacleGapBuffer: 0.18,
  lavaStreamEnabled: 0,
};

export const paramRanges: Record<
  keyof RunnerParams,
  { min: number; max: number; step: number }
> = {
  airtime: { min: 0.32, max: 0.56, step: 0.02 },
  scrollSpeed2D: { min: 8.0, max: 16.0, step: 0.5 },
  scrollRowsPerBeat: { min: 0.3, max: 0.9, step: 0.05 },
  cometSpeedMin: { min: 1.5, max: 4.5, step: 0.25 },
  cometSpeedMax: { min: 4.0, max: 9.0, step: 0.5 },
  minObstacleGapBuffer: { min: 0.14, max: 0.35, step: 0.02 },
  lavaStreamEnabled: { min: 0, max: 1, step: 1 },
};

export const TRANSITION_DURATION_SEC = 1.6;
export const PHASE2_SAFE_BUFFER_SEC = 3.0;
export const GRID_COLS = 9;
export const CENTER_COL = 4;

export type Phase1ObstacleKind =
  | 'cactus_small'
  | 'cactus_medium'
  | 'cactus_large'
  | 'cactus_group'
  | 'bird_low'
  | 'bird_high';

export interface Phase1Obstacle {
  id: number;
  t: number; // exact impact time at heroX
  onsetTime: number; // source onset timestamp
  kind: Phase1ObstacleKind;
  strength: number;
  passed?: boolean;
  removed?: boolean;
}

export type LaneRowType = 'grass' | 'scorched_earth' | 'deep_scorch' | 'lava_stream';

export interface GrassBlocker {
  col: number;
  kind: 'fern' | 'boulder';
}

export interface CometEvent {
  id: number;
  row: number;
  onsetTime: number; // exact time when comet head passes CENTER_COL (col 4)
  dir: 1 | -1; // +1 = left-to-right, -1 = right-to-left
  speed: number; // tiles per second
  headRadius: number; // collision radius in tiles (~0.4 for standard, ~0.48 for deep_scorch)
  trailLength: number; // cosmetic ember trail length in tiles (1.5)
  isBig: boolean;
  preFlareBeats: [number, number]; // 2 beat timestamps prior to onsetTime for deep_scorch crack flares
}

export interface LaneRowData {
  index: number;
  type: LaneRowType;
  band: 'low' | 'mid';
  dir: 1 | -1;
  blockers: GrassBlocker[]; // for grass rows
  comets: CometEvent[]; // for scorched_earth / deep_scorch rows
}

export interface RunnerSessionSchedule {
  entry: number;
  safeUntil: number;
  transitionTime: number; // T
  transitionEndTime: number; // T + 1.6s
  transitionAfterEntry: number; // T - entry
  transitionOnPhrase: 0 | 1;
  phase1Obstacles: Phase1Obstacle[];
  rows: LaneRowData[];
  rowsPerSec: number;
}

export interface RunnerLevel {
  songId: string;
  seed: number;
  params: RunnerParams;
  p95LowStrength: number;
  defaultSession: RunnerSessionSchedule;
}

/**
 * Computes the exact column position of a comet's head at `songTime`.
 * At `songTime === comet.onsetTime`, returns `CENTER_COL` (4.0).
 */
export function cometHeadColAt(comet: CometEvent, songTime: number): number {
  return CENTER_COL + comet.dir * comet.speed * (songTime - comet.onsetTime);
}

/**
 * Checks if `(col)` at `songTime` is hit by the comet's solid head (`true`) or harmless ember trail.
 */
export function evaluateCometAtColumn(
  comet: CometEvent,
  col: number,
  songTime: number,
): { headHit: boolean; trailHit: boolean } {
  const headCol = cometHeadColAt(comet, songTime);
  const delta = headCol - col;
  const absDelta = Math.abs(delta);
  const collisionHalfSpan = comet.headRadius + 0.24; // ~0.64 tiles

  if (absDelta <= collisionHalfSpan) {
    return { headHit: true, trailHit: false };
  }

  // Trail stretches behind the head in the opposite direction of `comet.dir` for `comet.trailLength` (1.5 tiles)
  const behindDist = delta * comet.dir;
  if (behindDist > collisionHalfSpan && behindDist <= collisionHalfSpan + comet.trailLength) {
    return { headHit: false, trailHit: true };
  }

  return { headHit: false, trailHit: false };
}

/**
 * Computes the transition timestamp `T` for a given `entry` song time:
 * `T = map.nextPhraseIn(entry + 10, entry + 15), else nearestDownbeat(entry + 12.5)`
 */
export function computeTransitionTiming(
  map: SongMap,
  entry: number,
): { transitionTime: number; transitionAfterEntry: number; transitionOnPhrase: 0 | 1 } {
  const phraseCandidate = nextPhraseIn(map, entry + 10.0, entry + 15.0);
  if (phraseCandidate !== null) {
    return {
      transitionTime: phraseCandidate,
      transitionAfterEntry: Math.round((phraseCandidate - entry) * 1000) / 1000,
      transitionOnPhrase: 1,
    };
  }

  // Also check up to 15.5s if a phrase boundary lands just past 15.0s
  const phraseExtended = nextPhraseIn(map, entry + 10.0, entry + 15.5);
  if (phraseExtended !== null) {
    return {
      transitionTime: phraseExtended,
      transitionAfterEntry: Math.round((phraseExtended - entry) * 1000) / 1000,
      transitionOnPhrase: 1,
    };
  }

  let db = nearestDownbeat(map, entry + 12.5);
  if (db < entry + 10.0 || db > entry + 15.5) {
    db = Math.round((entry + 12.5) * 1000) / 1000;
  }
  const onPhrase = (map.phrases || []).some((p) => Math.abs(p - db) <= 0.05) ? 1 : 0;
  return {
    transitionTime: db,
    transitionAfterEntry: Math.round((db - entry) * 1000) / 1000,
    transitionOnPhrase: onPhrase,
  };
}

/**
 * Generates a deterministic RunnerSessionSchedule for any `entry` and `safeUntil` timestamp.
 */
export function resolveRunnerSession(
  map: SongMap,
  params: RunnerParams,
  seed: number,
  entry = 0,
  safeUntil = entry + RUNWAY,
  p95LowStrength = 0.78,
): RunnerSessionSchedule {
  const rng = createRng(seed ^ Math.round(entry * 100));
  const effectiveSafeUntil = Math.max(safeUntil, entry + RUNWAY);
  const { transitionTime, transitionAfterEntry, transitionOnPhrase } = computeTransitionTiming(
    map,
    entry,
  );
  const transitionEndTime = Math.round((transitionTime + TRANSITION_DURATION_SEC) * 1000) / 1000;

  const beatPeriod = 60 / Math.max(60, map.bpm || 120);
  const minGapSec = Math.max(
    params.airtime + params.minObstacleGapBuffer,
    beatPeriod * 2 - 0.03,
    0.75,
  );

  // Phase 1 obstacles: between [effectiveSafeUntil + 0.45, transitionTime - 1.0]
  // Easy phase: single small cacti on strong low-band onsets that fall on beats, at least 2 beats apart.
  // Birds come from strong mid onsets at two heights when section energy > 0.5.
  const phase1Start = effectiveSafeUntil + 0.45;
  const phase1End = transitionTime - 1.0;
  const phase1Obstacles: Phase1Obstacle[] = [];

  if (phase1End > phase1Start) {
    const lowCandidates = onsetsIn(map, 'low', phase1Start, phase1End).filter((o) => {
      const nb = nearestBeat(map, o.t);
      return o.s >= 0.3 && Math.abs(o.t - nb) <= 0.045;
    });

    const midCandidates = onsetsIn(map, 'mid', phase1Start, phase1End).filter((o) => {
      const nb = nearestBeat(map, o.t);
      const sec = sectionAt(map, o.t);
      return sec.energy > 0.5 && o.s >= 0.68 && Math.abs(o.t - nb) <= 0.045;
    });

    // Merge and sort candidate onsets by timestamp
    const merged: Array<{ t: number; s: number; band: 'low' | 'mid' }> = [
      ...lowCandidates.map((o) => ({ t: o.t, s: o.s, band: 'low' as const })),
      ...midCandidates.map((o) => ({ t: o.t, s: o.s, band: 'mid' as const })),
    ].sort((a, b) => a.t - b.t);

    let lastObsTime = -999;
    let obsId = 1;
    for (const cand of merged) {
      if (cand.t - lastObsTime < minGapSec) continue;
      if (cand.t < effectiveSafeUntil || cand.t > transitionTime - 1.0) continue;

      let kind: Phase1ObstacleKind = 'cactus_small';
      if (cand.band === 'mid' && phase1Obstacles.length >= 2 && rng() < 0.28) {
        kind = rng() < 0.5 ? 'bird_low' : 'bird_high';
      } else {
        // Easy phase before transition uses single small cacti
        kind = 'cactus_small';
      }

      phase1Obstacles.push({
        id: obsId++,
        t: cand.t,
        onsetTime: cand.t,
        kind,
        strength: cand.s,
      });
      lastObsTime = cand.t;
    }

    // Fallback if no low-band onset happened to land on a beat in a quiet intro
    if (phase1Obstacles.length === 0) {
      const allLow = onsetsIn(map, 'low', phase1Start, phase1End);
      for (const cand of allLow) {
        if (cand.t - lastObsTime >= minGapSec && cand.t <= transitionTime - 1.0) {
          phase1Obstacles.push({
            id: obsId++,
            t: cand.t,
            onsetTime: cand.t,
            kind: 'cactus_small',
            strength: cand.s,
          });
          lastObsTime = cand.t;
        }
      }
    }
  }

  // Phase 2: Voxel Lane-Crossing Grid (9 columns wide)
  const beatsPerSec = Math.max(1, (map.bpm || 120) / 60);
  const rowsPerSec = Math.max(0.4, params.scrollRowsPerBeat * beatsPerSec);
  const remainingDuration = Math.max(30, map.duration - transitionEndTime + 25);
  const totalRows = Math.max(80, Math.ceil(remainingDuration * rowsPerSec * 1.6) + 24);

  const rows: LaneRowData[] = [];
  let consecutiveHazards = 0;
  let cometId = 1;

  const firstCometAllowedTime = Math.max(
    effectiveSafeUntil + 0.5,
    transitionEndTime + PHASE2_SAFE_BUFFER_SEC,
  );

  for (let r = 0; r < totalRows; r++) {
    const estRowTime = transitionEndTime + r / rowsPerSec;
    const sec = sectionAt(map, estRowTime);

    // First 3 rows after the transition (plus row 0 spawn) are guaranteed safe grass
    let rowType: LaneRowType = 'grass';
    if (r >= 4) {
      if (consecutiveHazards >= 2) {
        rowType = 'grass';
      } else {
        const nearDrop = (map.drops || []).some((d) => Math.abs(d - estRowTime) <= 4.0);
        const roll = rng();
        if (sec.label === 'drop' || nearDrop || sec.energy >= 0.72) {
          if (roll < 0.32) rowType = 'deep_scorch';
          else if (roll < 0.72) rowType = 'scorched_earth';
          else rowType = 'grass';
        } else if (sec.label === 'build' || sec.label === 'bridge' || sec.energy >= 0.48) {
          if (roll < 0.58) rowType = 'scorched_earth';
          else rowType = 'grass';
        } else {
          // Calm section: mostly grass
          if (roll < 0.36) rowType = 'scorched_earth';
          else rowType = 'grass';
        }
      }
    }

    if (rowType === 'grass') {
      consecutiveHazards = 0;
    } else {
      consecutiveHazards++;
    }

    const band: 'low' | 'mid' = rowType === 'deep_scorch' ? 'low' : r % 2 === 0 ? 'low' : 'mid';
    const dir: 1 | -1 = r % 2 === 0 ? 1 : -1;
    const blockers: GrassBlocker[] = [];
    const comets: CometEvent[] = [];

    if (rowType === 'grass') {
      // Place decorative voxel ferns & boulders while always leaving the central path (cols 3,4,5) open
      const candidateCols = r <= 3 ? [0, 1, 7, 8] : [0, 1, 2, 6, 7, 8];
      for (const col of candidateCols) {
        if (rng() < (r <= 3 ? 0.35 : 0.42)) {
          blockers.push({
            col,
            kind: rng() < 0.65 ? 'fern' : 'boulder',
          });
        }
      }
    } else {
      // Scorched earth or Deep scorch row: schedule beat-aligned comets
      const windowStart = Math.max(firstCometAllowedTime, estRowTime - 18);
      const windowEnd = Math.min(map.duration + 10, estRowTime + 22);

      if (windowEnd > windowStart) {
        const rawOnsets = onsetsIn(map, band, windowStart, windowEnd);
        const speedBase =
          params.cometSpeedMin +
          (params.cometSpeedMax - params.cometSpeedMin) * Math.max(0.15, Math.min(1, sec.energy));
        const cometSpeed =
          rowType === 'deep_scorch'
            ? Math.round(Math.max(params.cometSpeedMax, speedBase * 1.15) * 100) / 100
            : Math.round(speedBase * 100) / 100;

        const headRadius = rowType === 'deep_scorch' ? 0.46 : 0.38;
        // Minimum time gap between comets on the same row so every column always has >= 1.1s (> 0.6s) free gap
        const minRowCometGap = rowType === 'deep_scorch' ? 2.1 : 1.75;

        let filtered = rawOnsets.filter((o) => {
          if (rowType === 'deep_scorch') {
            const nearDrop = (map.drops || []).some((d) => Math.abs(d - o.t) <= 4.5);
            return o.s >= p95LowStrength || nearDrop || sec.label === 'drop';
          }
          return o.s >= 0.35;
        });

        if (filtered.length === 0) {
          filtered = rawOnsets;
        }

        let lastCometOnset = -999;
        for (let idx = 0; idx < filtered.length; idx++) {
          const onset = filtered[idx];
          if (onset.t < firstCometAllowedTime) continue;
          if (onset.t - lastCometOnset < minRowCometGap) continue;
          // Stagger across adjacent rows so comets form diagonal weave patterns
          if (filtered.length > 4 && (idx + r) % 2 !== 0 && onset.s < 0.75) continue;

          const bIdx = beatAt(map, onset.t);
          const preBeat1 = map.beats[Math.max(0, bIdx - 2)] ?? Math.max(0, onset.t - 2 * beatPeriod);
          const preBeat2 = map.beats[Math.max(0, bIdx - 1)] ?? Math.max(0, onset.t - beatPeriod);

          comets.push({
            id: cometId++,
            row: r,
            onsetTime: onset.t,
            dir,
            speed: cometSpeed,
            headRadius,
            trailLength: 1.5,
            isBig: rowType === 'deep_scorch',
            preFlareBeats: [preBeat1, preBeat2],
          });
          lastCometOnset = onset.t;
        }
      }
    }

    rows.push({
      index: r,
      type: rowType,
      band,
      dir,
      blockers,
      comets,
    });
  }

  return {
    entry,
    safeUntil: effectiveSafeUntil,
    transitionTime,
    transitionEndTime,
    transitionAfterEntry,
    transitionOnPhrase,
    phase1Obstacles,
    rows,
    rowsPerSec,
  };
}

/**
 * Generates the pure level data for a song.
 */
export function generateLevel(
  map: SongMap,
  params: RunnerParams = defaultParams,
  rng?: () => number,
): RunnerLevel {
  const seed = rng ? Math.floor(rng() * 0x7fffffff) : hashString(map.id || 'runner');
  const lowStrengths = (map.onsets?.low || []).map((o) => o.s).sort((a, b) => a - b);
  const p95Idx = Math.min(
    lowStrengths.length - 1,
    Math.max(0, Math.floor(lowStrengths.length * 0.95)),
  );
  const p95LowStrength = lowStrengths[p95Idx] ?? 0.78;

  const defaultSession = resolveRunnerSession(
    map,
    params,
    seed,
    0,
    RUNWAY,
    p95LowStrength,
  );

  return {
    songId: map.id,
    seed,
    params: { ...params },
    p95LowStrength,
    defaultSession,
  };
}
