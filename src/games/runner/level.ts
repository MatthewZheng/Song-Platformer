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
  airtime: 0.55,
  scrollSpeed2D: 9.0,
  scrollRowsPerBeat: 1.15,
  cometSpeedMin: 2.5,
  cometSpeedMax: 6.0,
  minObstacleGapBuffer: 0.18,
  lavaStreamEnabled: 0,
};

export const paramRanges: Record<
  keyof RunnerParams,
  { min: number; max: number; step: number }
> = {
  airtime: { min: 0.42, max: 0.68, step: 0.02 },
  scrollSpeed2D: { min: 7.5, max: 14.0, step: 0.5 },
  scrollRowsPerBeat: { min: 0.8, max: 1.8, step: 0.05 },
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
  headRadius: number; // collision radius in tiles (~0.38 for standard, ~0.46 for deep_scorch)
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
  seed?: number;
  p95LowStrength?: number;
  firstCometAllowedTime?: number;
  nextCometId?: number;
  lastScheduledRow?: number;
  beatTimeline?: number[];
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
 * Checks if `row` can safely accept a comet at `onsetTime` with `speed` while preserving >= 0.6s
 * column passage gaps across all columns 0..8 against all existing comets on `row`.
 */
export function canScheduleOnRow(
  row: LaneRowData,
  onsetTime: number,
  speed: number,
  beatPeriod: number,
): boolean {
  const minBaseGap = Math.max(
    beatPeriod * 2.85,
    row.type === 'deep_scorch' ? 1.62 : 1.42,
  );
  for (let i = 0; i < row.comets.length; i++) {
    const existing = row.comets[i];
    const catchupSec = 4 * Math.abs(1 / existing.speed - 1 / speed);
    const requiredGap = minBaseGap + catchupSec;
    if (Math.abs(onsetTime - existing.onsetTime) < requiredGap) {
      return false;
    }
  }
  return true;
}

/**
 * Deterministically appends lane rows up to `targetRowCount` so fast-jumping players never outrun the grid.
 */
export function appendRunnerRows(
  map: SongMap,
  session: RunnerSessionSchedule,
  targetRowCount: number,
): void {
  const baseSeed = session.seed ?? hashString(map.id || 'runner');
  const rows = session.rows;

  let consecutiveHazards = 0;
  let consecutiveGrass = 0;
  for (let i = Math.max(0, rows.length - 4); i < rows.length; i++) {
    if (rows[i].type === 'grass') {
      consecutiveHazards = 0;
      consecutiveGrass++;
    } else {
      consecutiveHazards++;
      consecutiveGrass = 0;
    }
  }

  for (let r = rows.length; r < targetRowCount; r++) {
    const rowRng = createRng((baseSeed ^ Math.imul(r + 1, 0x9e3779b1)) >>> 0);
    const estRowTime = Math.min(
      map.duration,
      session.transitionEndTime + r / Math.max(0.4, session.rowsPerSec),
    );
    const sec = sectionAt(map, estRowTime);

    // First 4 rows (0..3) after the transition are guaranteed safe grass
    let rowType: LaneRowType = 'grass';
    if (r >= 4) {
      if (consecutiveHazards >= 2) {
        rowType = 'grass';
      } else {
        const nearDrop = (map.drops || []).some((d) => Math.abs(d - estRowTime) <= 4.0);
        const roll = rowRng();
        if (sec.label === 'drop' || nearDrop || sec.energy >= 0.72) {
          if (roll < 0.35) rowType = 'deep_scorch';
          else if (roll < 0.82 || consecutiveGrass >= 1) rowType = 'scorched_earth';
          else rowType = 'grass';
        } else if (sec.label === 'build' || sec.label === 'bridge' || sec.energy >= 0.48) {
          if (roll < 0.22) rowType = 'deep_scorch';
          else if (roll < 0.74 || consecutiveGrass >= 1) rowType = 'scorched_earth';
          else rowType = 'grass';
        } else {
          if (roll < 0.14) rowType = 'deep_scorch';
          else if (roll < 0.62 || consecutiveGrass >= 2) rowType = 'scorched_earth';
          else rowType = 'grass';
        }
      }
    }

    if (rowType === 'grass') {
      consecutiveHazards = 0;
      consecutiveGrass++;
    } else {
      consecutiveHazards++;
      consecutiveGrass = 0;
    }

    const band: 'low' | 'mid' = rowType === 'deep_scorch' ? 'low' : r % 2 === 0 ? 'low' : 'mid';
    const dir: 1 | -1 = r % 2 === 0 ? 1 : -1;
    const blockers: GrassBlocker[] = [];

    if (rowType === 'grass') {
      const candidateCols = r <= 3 ? [0, 1, 7, 8] : [0, 1, 2, 6, 7, 8];
      for (const col of candidateCols) {
        if (rowRng() < (r <= 3 ? 0.35 : 0.42)) {
          blockers.push({
            col,
            kind: rowRng() < 0.65 ? 'fern' : 'boulder',
          });
        }
      }
    }

    rows.push({
      index: r,
      type: rowType,
      band,
      dir,
      blockers,
      comets: [],
    });
  }
}

/**
 * Identifies where the dinosaur currently is (`dinoRow`) and ensures comets are generated
 * NON-SEQUENTIALLY across hazard rows ahead of the dinosaur (`[dinoRow + 1, dinoRow + 14]`).
 */
export function ensureCometsAheadOfDino(
  map: SongMap,
  session: RunnerSessionSchedule,
  params: RunnerParams,
  dinoRow: number,
  songTime: number,
  lookaheadSec = 4.0,
  isInitialBuild = false,
): void {
  const cleanDinoRow = Math.max(0, Math.floor(dinoRow));
  const minRowsNeeded = cleanDinoRow + 36;
  if (session.rows.length < minRowsNeeded) {
    appendRunnerRows(map, session, minRowsNeeded);
  }

  const beatPeriod = 60 / Math.max(60, map.bpm || 120);
  const firstCometAllowedTime =
    session.firstCometAllowedTime ??
    Math.max(session.safeUntil + 0.5, session.transitionEndTime + PHASE2_SAFE_BUFFER_SEC);
  const baseSeed = session.seed ?? hashString(map.id || 'runner');
  const p95LowStrength = session.p95LowStrength ?? 0.78;

  if (!session.beatTimeline || session.beatTimeline.length === 0) {
    const bt: number[] = [];
    for (const b of map.beats || []) {
      if (b >= firstCometAllowedTime && b <= map.duration + 12) {
        bt.push(b);
      }
    }
    let tailBeat = bt.length > 0 ? bt[bt.length - 1] + beatPeriod : firstCometAllowedTime;
    while (tailBeat <= map.duration + 12) {
      bt.push(Math.round(tailBeat * 1000) / 1000);
      tailBeat += beatPeriod;
    }
    session.beatTimeline = bt;
  }

  const beatTimeline = session.beatTimeline;
  const windowStart = Math.max(firstCometAllowedTime, songTime - 0.04);
  const windowEnd = Math.max(windowStart, songTime + lookaheadSec);

  const aheadStartRow = Math.max(4, cleanDinoRow + 1);
  const aheadEndRow = Math.min(session.rows.length - 1, Math.max(aheadStartRow + 10, cleanDinoRow + 14));

  const aheadHazardRows: LaneRowData[] = [];
  for (let r = aheadStartRow; r <= aheadEndRow; r++) {
    const row = session.rows[r];
    if (row && row.type !== 'grass') {
      aheadHazardRows.push(row);
    }
  }
  if (aheadHazardRows.length === 0) return;

  const allLowOnsets = onsetsIn(map, 'low', windowStart - 0.1, windowEnd + 0.1);
  const allMidOnsets = onsetsIn(map, 'mid', windowStart - 0.1, windowEnd + 0.1);

  let lastScheduledRow = session.lastScheduledRow ?? -99;
  let nextCometId = session.nextCometId ?? 1;

  for (let bIdx = 0; bIdx < beatTimeline.length; bIdx++) {
    const rawBeatTime = beatTimeline[bIdx];
    if (rawBeatTime < windowStart) continue;
    if (rawBeatTime > windowEnd) break;

    const sec = sectionAt(map, rawBeatTime);
    const isDownbeat = (map.downbeats || []).some((db) => Math.abs(db - rawBeatTime) <= 0.065);
    const nearDrop = (map.drops || []).some((d) => Math.abs(d - rawBeatTime) <= 4.5);

    let matchedLowStrength = 0;
    let matchedMidStrength = 0;
    let snappedOnsetTime = rawBeatTime;
    let bestSnapDelta = 0.036;

    for (let i = 0; i < allLowOnsets.length; i++) {
      const dt = Math.abs(allLowOnsets[i].t - rawBeatTime);
      if (dt <= 0.045) {
        if (allLowOnsets[i].s > matchedLowStrength) matchedLowStrength = allLowOnsets[i].s;
        if (dt < bestSnapDelta) {
          bestSnapDelta = dt;
          snappedOnsetTime = allLowOnsets[i].t;
        }
      }
    }
    for (let i = 0; i < allMidOnsets.length; i++) {
      const dt = Math.abs(allMidOnsets[i].t - rawBeatTime);
      if (dt <= 0.045) {
        if (allMidOnsets[i].s > matchedMidStrength) matchedMidStrength = allMidOnsets[i].s;
        if (dt < bestSnapDelta) {
          bestSnapDelta = dt;
          snappedOnsetTime = allMidOnsets[i].t;
        }
      }
    }

    const bestOnsetStrength = Math.max(matchedLowStrength, matchedMidStrength);

    const shouldFireThisBeat =
      sec.energy >= 0.42 ||
      sec.label === 'drop' ||
      sec.label === 'build' ||
      isDownbeat ||
      nearDrop ||
      bestOnsetStrength >= 0.25 ||
      bIdx % 2 === 0;

    if (!shouldFireThisBeat) {
      continue;
    }

    const isDropBeat =
      sec.label === 'drop' || (nearDrop && (sec.energy >= 0.68 || bestOnsetStrength >= 0.65));
    const targetSimultaneous =
      isDownbeat || (isDropBeat && (bIdx % 2 === 0 || bestOnsetStrength >= p95LowStrength))
        ? 2
        : 1;

    // Skip beats that have already occurred during live dynamic updates
    if (!isInitialBuild && snappedOnsetTime <= songTime + 0.08) {
      continue;
    }

    // If the dinosaur has jumped past rows that had future unreached comets scheduled for this beat,
    // prune those stale behind-dino comets so they are generated ahead of the dinosaur instead.
    if (!isInitialBuild) {
      for (let r = 4; r < aheadStartRow; r++) {
        const oldRow = session.rows[r];
        if (!oldRow || oldRow.comets.length === 0) continue;
        for (let ci = oldRow.comets.length - 1; ci >= 0; ci--) {
          const c = oldRow.comets[ci];
          if (Math.abs(c.onsetTime - snappedOnsetTime) <= 0.025) {
            oldRow.comets.splice(ci, 1);
          }
        }
      }
    }

    // Check how many comets for this beat already exist (across all rows on initial build, or ahead rows after pruning)
    const searchStartRow = isInitialBuild ? 4 : aheadStartRow;
    const existingAheadRows: number[] = [];
    for (let r = searchStartRow; r < session.rows.length; r++) {
      const row = session.rows[r];
      if (!row || row.type === 'grass') continue;
      for (let ci = 0; ci < row.comets.length; ci++) {
        if (Math.abs(row.comets[ci].onsetTime - snappedOnsetTime) <= 0.025) {
          existingAheadRows.push(r);
        }
      }
    }

    if (existingAheadRows.length >= targetSimultaneous) {
      lastScheduledRow = existingAheadRows[0];
      continue;
    }

    const energyNorm = Math.max(0.15, Math.min(1.0, sec.energy));
    const steadySpeed =
      Math.round(
        (params.cometSpeedMin +
          (params.cometSpeedMax - params.cometSpeedMin) * (0.2 + 0.68 * energyNorm)) *
          100,
      ) / 100;
    const deepScorchBurstSpeed =
      Math.round(
        Math.min(
          params.cometSpeedMax * 1.25,
          Math.max(params.cometSpeedMax, steadySpeed * 1.32),
        ) * 100,
      ) / 100;

    // Identify where `lastScheduledRow` sits in `aheadHazardRows` so we can explicitly avoid
    // sequential row-by-row stepping (prevHIdx + 1 or lastScheduledRow + 1)
    const prevHIdx = aheadHazardRows.findIndex((hr) => hr.index === lastScheduledRow);

    // Filter candidate rows ahead of the dinosaur; if scheduling dynamically for a very near beat,
    // place at least 2 rows ahead of dinoRow so it never spawns on the immediate hop target
    const minSafeAheadRow =
      !isInitialBuild && snappedOnsetTime - songTime < 0.55
        ? Math.max(aheadStartRow, cleanDinoRow + 2)
        : aheadStartRow;

    const scoredCandidates = aheadHazardRows
      .filter((cand) => cand.index >= minSafeAheadRow)
      .map((cand, hIdx) => {
        const distAhead = cand.index - cleanDinoRow;
        // Deterministic pseudo-random hash per (bIdx, row.index, seed) for non-sequential ordering
        const hash =
          ((Math.imul(bIdx + 17, 2246822519) ^
            Math.imul(cand.index + 31, 3266489917) ^
            baseSeed) >>>
            0) %
          1000;

        // Prime visual band ahead of the dinosaur (2..10 rows ahead)
        const visualBandScore = distAhead >= 2 && distAhead <= 10 ? 1500 : 500;

        // Strictly penalize same row AND penalize sequential neighbor rows (hIdx === prevHIdx + 1 or index === last + 1)
        let nonSeqScore = 2000;
        if (cand.index === lastScheduledRow) {
          nonSeqScore = -8000;
        } else if (
          (prevHIdx >= 0 && (hIdx === prevHIdx + 1 || hIdx === (prevHIdx + 1) % aheadHazardRows.length)) ||
          Math.abs(cand.index - lastScheduledRow) === 1
        ) {
          nonSeqScore = -2500;
        }

        return {
          row: cand,
          score: nonSeqScore + visualBandScore + hash,
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.row);

    const mapBeatIdx = beatAt(map, snappedOnsetTime);
    const preBeat1 =
      map.beats[Math.max(0, mapBeatIdx - 2)] ?? Math.max(0, snappedOnsetTime - 2 * beatPeriod);
    const preBeat2 =
      map.beats[Math.max(0, mapBeatIdx - 1)] ?? Math.max(0, snappedOnsetTime - beatPeriod);

    const chosenRows: LaneRowData[] = [];
    const preferDeepScorch =
      isDownbeat || isDropBeat || matchedLowStrength >= p95LowStrength;

    const neededCount = targetSimultaneous - existingAheadRows.length;

    if (preferDeepScorch && neededCount > 0) {
      for (const cand of scoredCandidates) {
        if (existingAheadRows.includes(cand.index)) continue;
        if (
          cand.type === 'deep_scorch' &&
          cand.index !== lastScheduledRow &&
          canScheduleOnRow(cand, snappedOnsetTime, deepScorchBurstSpeed, beatPeriod)
        ) {
          chosenRows.push(cand);
          break;
        }
      }
    }

    for (const cand of scoredCandidates) {
      if (chosenRows.length >= neededCount) break;
      if (existingAheadRows.includes(cand.index)) continue;
      if (chosenRows.some((c) => c.index === cand.index)) continue;
      if (
        (chosenRows.length > 0 || existingAheadRows.length > 0) &&
        (chosenRows.some((c) => Math.abs(c.index - cand.index) < 2) ||
          existingAheadRows.some((rIdx) => Math.abs(rIdx - cand.index) < 2))
      ) {
        continue;
      }
      const candSpeed = cand.type === 'deep_scorch' ? deepScorchBurstSpeed : steadySpeed;
      if (canScheduleOnRow(cand, snappedOnsetTime, candSpeed, beatPeriod)) {
        chosenRows.push(cand);
      }
    }

    for (let cIdx = 0; cIdx < chosenRows.length; cIdx++) {
      const targetRow = chosenRows[cIdx];
      const isDeep = targetRow.type === 'deep_scorch';
      const speed = isDeep ? deepScorchBurstSpeed : steadySpeed;
      const headRadius = isDeep ? 0.46 : 0.38;

      targetRow.comets.push({
        id: nextCometId++,
        row: targetRow.index,
        onsetTime: snappedOnsetTime,
        dir: targetRow.dir,
        speed,
        headRadius,
        trailLength: 1.5,
        isBig: isDeep,
        preFlareBeats: [preBeat1, preBeat2],
      });
      targetRow.comets.sort((a, b) => a.onsetTime - b.onsetTime);

      if (cIdx === 0 && existingAheadRows.length === 0) {
        lastScheduledRow = targetRow.index;
      }
    }
  }

  session.lastScheduledRow = lastScheduledRow;
  session.nextCometId = nextCometId;
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
  const sessionSeed = (seed ^ Math.round(entry * 100)) >>> 0;
  const rng = createRng(sessionSeed);
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
  const rowsPerSec = Math.max(0.8, params.scrollRowsPerBeat * beatsPerSec);
  const remainingDuration = Math.max(30, map.duration - transitionEndTime + 25);
  const totalRows = Math.max(100, Math.ceil(remainingDuration * rowsPerSec * 1.45) + 32);

  const firstCometAllowedTime = Math.max(
    effectiveSafeUntil + 0.5,
    transitionEndTime + PHASE2_SAFE_BUFFER_SEC,
  );

  const session: RunnerSessionSchedule = {
    entry,
    safeUntil: effectiveSafeUntil,
    transitionTime,
    transitionEndTime,
    transitionAfterEntry,
    transitionOnPhrase,
    phase1Obstacles,
    rows: [],
    rowsPerSec,
    seed: sessionSeed,
    p95LowStrength,
    firstCometAllowedTime,
    nextCometId: 1,
    lastScheduledRow: -99,
  };

  appendRunnerRows(map, session, totalRows);

  // Pre-populate baseline non-sequential comets ahead of expected dinosaur position across the song
  const stepSec = Math.max(0.25, beatPeriod * 0.9);
  for (let t = firstCometAllowedTime; t <= map.duration + 10; t += stepSec) {
    const estDinoRow = Math.floor(Math.max(0, t - transitionEndTime) * rowsPerSec);
    ensureCometsAheadOfDino(
      map,
      session,
      params,
      estDinoRow,
      t,
      stepSec + 0.15,
      true,
    );
  }

  return session;
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
