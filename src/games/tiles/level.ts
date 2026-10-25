import type { SongMap } from '../../shell/api';
import { energyAt, findNearest, roundTime, sectionAt } from '../../shared/songmap';

export interface TilesParams {
  minStrength: number;
  npsBase: number;
  npsEnergy: number;
  snapWindowMs: number;
}

export const defaultParams: TilesParams = {
  minStrength: 0.25,
  npsBase: 2,
  npsEnergy: 5,
  snapWindowMs: 40,
};

export const paramRanges: Record<keyof TilesParams, { min: number; max: number; step: number }> = {
  minStrength: { min: 0.1, max: 0.6, step: 0.05 },
  npsBase: { min: 1, max: 4, step: 0.5 },
  npsEnergy: { min: 2, max: 8, step: 0.5 },
  snapWindowMs: { min: 20, max: 50, step: 5 },
};

export interface TileNote {
  id: number;
  t: number;
  lane: number;
  strength: number;
  sourceOnsetT: number;
  alignMs: number;
  snapped: boolean;
  isChord: boolean;
  melodyDir: -1 | 0 | 1;
}

export interface TilesLevel {
  notes: TileNote[];
  params: TilesParams;
  eighthNoteSec: number;
}

function buildSixteenthNoteGrid(map: SongMap): number[] {
  const grid: number[] = [];
  const bpm = Math.max(40, map.bpm || 120);
  const defaultSixteenth = 60 / bpm / 4;
  const beats = map.beats && map.beats.length > 0 ? map.beats : [];

  if (beats.length === 0) {
    for (let t = 0; t <= map.duration + defaultSixteenth; t += defaultSixteenth) {
      grid.push(roundTime(t));
    }
    return grid;
  }

  // Leading subdivisions before beats[0]
  const preSteps: number[] = [];
  for (let t = beats[0] - defaultSixteenth; t >= 0; t -= defaultSixteenth) {
    preSteps.push(roundTime(t));
  }
  preSteps.reverse();
  grid.push(...preSteps);

  // Subdivide each beat interval into 4 sixteenth notes
  for (let i = 0; i < beats.length - 1; i++) {
    const b0 = beats[i];
    const b1 = beats[i + 1];
    const span = b1 - b0;
    if (span <= 0.01) continue;
    for (let sub = 0; sub < 4; sub++) {
      grid.push(roundTime(b0 + (span * sub) / 4));
    }
  }

  // Trailing subdivisions from last beat to map.duration
  const lastBeat = beats[beats.length - 1];
  for (let t = lastBeat; t <= map.duration + defaultSixteenth; t += defaultSixteenth) {
    grid.push(roundTime(t));
  }

  return grid;
}

function getMelodyDirAt(map: SongMap, t: number): -1 | 0 | 1 {
  const mel = map.melody;
  if (!mel || mel.length === 0) return 0;
  let lo = 0;
  let hi = mel.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (mel[mid].t < t) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const idxAfter = Math.min(mel.length - 1, Math.max(0, lo));
  const idxBefore = Math.max(0, idxAfter - 1);
  const dBefore = Math.abs(t - mel[idxBefore].t);
  const dAfter = Math.abs(t - mel[idxAfter].t);
  return dBefore <= dAfter ? mel[idxBefore].dir : mel[idxAfter].dir;
}

export function generateLevel(
  map: SongMap,
  params: TilesParams = defaultParams,
  _rng: () => number = () => 0.5,
): TilesLevel {
  const mergedParams: TilesParams = { ...defaultParams, ...params };
  const bpm = Math.max(40, map.bpm || 120);
  const eighthNoteSec = 60 / bpm / 2;
  const grid16 = buildSixteenthNoteGrid(map);
  const snapSec = mergedParams.snapWindowMs / 1000;

  // 1. Collect all onset candidates from low, mid, high with strength >= minStrength
  interface RawCandidate {
    t: number;
    sourceOnsetT: number;
    strength: number;
    alignMs: number;
    snapped: boolean;
  }

  const allOnsets: Array<{ t: number; s: number }> = [
    ...(map.onsets?.low ?? []),
    ...(map.onsets?.mid ?? []),
    ...(map.onsets?.high ?? []),
  ];

  const totalSec = Math.ceil(map.duration);
  const winEnergies: number[] = [];
  for (let w = 0; w < totalSec; w++) {
    winEnergies.push(
      (energyAt(map, w + 0.15) +
        energyAt(map, w + 0.5) +
        energyAt(map, Math.min(map.duration, w + 0.85))) /
        3,
    );
  }
  const sortedE = [...winEnergies].sort((a, b) => a - b);
  const eP10 = sortedE[Math.floor(sortedE.length * 0.1)] ?? 0.2;
  const eP50 = sortedE[Math.floor(sortedE.length * 0.5)] ?? 0.5;
  const eP90 = sortedE[Math.floor(sortedE.length * 0.9)] ?? 0.8;
  const eSpan = Math.max(0.08, eP90 - eP10);

  const rawCandidates: RawCandidate[] = [];
  for (const o of allOnsets) {
    const eAtOnset = energyAt(map, o.t);
    const effectiveMinStrength =
      eAtOnset >= eP50 ? Math.min(mergedParams.minStrength, 0.04) : mergedParams.minStrength;
    if (o.s < effectiveMinStrength) continue;
    if (o.t < 0 || o.t > map.duration) continue;

    const nearest = findNearest(o.t, grid16);
    const shouldSnap = nearest.index >= 0 && nearest.dist <= snapSec + 1e-6;
    const finalT = shouldSnap ? roundTime(nearest.value) : roundTime(o.t);
    const alignMs = Math.abs(finalT - o.t) * 1000;

    rawCandidates.push({
      t: finalT,
      sourceOnsetT: o.t,
      strength: o.s,
      alignMs,
      snapped: shouldSnap,
    });
  }

  // Sort by snapped time ascending, then by strength descending
  rawCandidates.sort((a, b) => a.t - b.t || b.strength - a.strength);

  // Deduplicate candidates that land within 28 ms of each other (keeping the strongest onset)
  const deduped: RawCandidate[] = [];
  for (const cand of rawCandidates) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(cand.t - prev.t) < 0.028) {
      if (cand.strength > prev.strength) {
        deduped[deduped.length - 1] = cand;
      }
    } else {
      deduped.push(cand);
    }
  }

  // 2. Apply per-1s-window density cap (maxNps = npsBase + npsEnergy * energy)
  // and budget over 2s windows so note density tracks song energy smoothly even in compressed tracks
  const winSize = 2.0;
  const numTwoSecWins = Math.max(1, Math.ceil(map.duration / winSize));
  const twoSecEnergies: number[] = [];
  for (let w = 0; w < numTwoSecWins; w++) {
    const t0 = w * winSize;
    const eMean =
      (energyAt(map, t0 + 0.3) +
        energyAt(map, t0 + 1.0) +
        energyAt(map, Math.min(map.duration, t0 + 1.7))) /
      3;
    twoSecEnergies.push(eMean);
  }
  const sortedE2 = [...twoSecEnergies].sort((a, b) => a - b);
  const e2Min = sortedE2[Math.floor(sortedE2.length * 0.05)] ?? 0.2;
  const e2Max = sortedE2[Math.floor(sortedE2.length * 0.95)] ?? 0.8;
  const e2Span = Math.max(0.05, e2Max - e2Min);

  const selectedByWindow: RawCandidate[] = [];

  for (let w = 0; w < numTwoSecWins; w++) {
    const t0 = w * winSize;
    const t1 = t0 + winSize;
    const inWin = deduped.filter((c) => c.t >= t0 && c.t < t1);
    if (inWin.length === 0) continue;

    const eMean = twoSecEnergies[w];
    const eNorm = Math.max(0, Math.min(1, (eMean - e2Min) / e2Span));

    const capSec0 = Math.max(
      1,
      Math.floor(mergedParams.npsBase + mergedParams.npsEnergy * energyAt(map, t0 + 0.5)),
    );
    const capSec1 = Math.max(
      1,
      Math.floor(
        mergedParams.npsBase +
          mergedParams.npsEnergy * energyAt(map, Math.min(map.duration, t0 + 1.5)),
      ),
    );
    const twoSecHardCap = capSec0 + capSec1;
    // Scale 2s note budget linearly with normalized 2s energy (1 .. twoSecHardCap)
    const twoSecTarget = Math.max(
      eMean < 0.15 ? 0 : 1,
      Math.min(twoSecHardCap, Math.round(1 + eNorm * (twoSecHardCap - 1))),
    );

    const byStrength = [...inWin].sort((a, b) => b.strength - a.strength || a.alignMs - b.alignMs);
    const pickedInTwoSec: RawCandidate[] = [];
    let countSec0 = 0;
    let countSec1 = 0;

    for (const cand of byStrength) {
      if (pickedInTwoSec.length >= twoSecTarget) break;
      const inFirstHalf = cand.t < t0 + 1.0;
      if (inFirstHalf && countSec0 < capSec0) {
        countSec0++;
        pickedInTwoSec.push(cand);
      } else if (!inFirstHalf && countSec1 < capSec1) {
        countSec1++;
        pickedInTwoSec.push(cand);
      }
    }

    pickedInTwoSec.sort((a, b) => a.t - b.t);
    selectedByWindow.push(...pickedInTwoSec);
  }

  const slidingFiltered = selectedByWindow;

  // 3. Assign lanes following melody direction + enforce minimum 1/8-note same-lane gap + add drop chords
  const notes: TileNote[] = [];
  const lastLaneTime = [-999, -999, -999, -999];
  let currentLane = 1; // Start in lane 1
  let altNeighborStep = 1; // For dir === 0 alternating between two neighboring lanes
  let nextId = 1;
  let lastChordBarIdx = -1;
  const downbeats = map.downbeats ?? [];

  for (const cand of slidingFiltered) {
    const melDir = getMelodyDirAt(map, cand.t);
    let desiredLane = currentLane;

    if (melDir === 1) {
      // Move one lane right, bounce at right edge (3 -> 2)
      desiredLane = currentLane < 3 ? currentLane + 1 : 2;
    } else if (melDir === -1) {
      // Move one lane left, bounce at left edge (0 -> 1)
      desiredLane = currentLane > 0 ? currentLane - 1 : 1;
    } else {
      // dir === 0: alternate between two neighboring lanes, bouncing at edges
      let next = currentLane + altNeighborStep;
      if (next > 3) {
        next = 2;
        altNeighborStep = -1;
      } else if (next < 0) {
        next = 1;
        altNeighborStep = 1;
      } else {
        altNeighborStep = -altNeighborStep;
      }
      desiredLane = next;
    }

    // Enforce minimum gap in the same lane: one eighth note at the song's tempo
    let assignedLane = -1;
    if (cand.t - lastLaneTime[desiredLane] >= eighthNoteSec - 1e-5) {
      assignedLane = desiredLane;
    } else {
      // Find nearest lane that satisfies the eighth-note gap
      const laneOrder = [0, 1, 2, 3].sort(
        (a, b) =>
          Math.abs(a - desiredLane) - Math.abs(b - desiredLane) ||
          lastLaneTime[a] - lastLaneTime[b],
      );
      for (const altLane of laneOrder) {
        if (cand.t - lastLaneTime[altLane] >= eighthNoteSec - 1e-5) {
          assignedLane = altLane;
          break;
        }
      }
    }

    if (assignedLane < 0) {
      // All 4 lanes are on eighth-note cooldown; skip to guarantee 0 sameLaneGapViolations
      continue;
    }

    currentLane = assignedLane;
    lastLaneTime[assignedLane] = cand.t;

    notes.push({
      id: nextId++,
      t: cand.t,
      lane: assignedLane,
      strength: cand.strength,
      sourceOnsetT: cand.sourceOnsetT,
      alignMs: cand.alignMs,
      snapped: cand.snapped,
      isChord: false,
      melodyDir: melDir,
    });

    // 4. Chords: on strong downbeats in drop sections with energy > 0.75,
    // add a second note in a non-adjacent lane, at most once per bar
    const sec = sectionAt(map, cand.t);
    const eNow = energyAt(map, cand.t);
    if (sec?.label === 'drop' && eNow > 0.75 && cand.strength >= 0.5 && downbeats.length > 0) {
      const nearDb = findNearest(cand.t, downbeats);
      if (nearDb.index >= 0 && nearDb.dist <= 0.065 && nearDb.index !== lastChordBarIdx) {
        // Check 1s window capacity (across the full [secStart, secStart + 1.0) second) before adding second chord note
        const secStart = Math.floor(cand.t);
        const capNow = Math.max(
          1,
          Math.floor(mergedParams.npsBase + mergedParams.npsEnergy * energyAt(map, secStart + 0.5)),
        );
        const existingInSec = notes.filter((n) => n.t >= secStart && n.t < secStart + 1.0).length;
        const upcomingInSec = slidingFiltered.filter(
          (c) => c.t > cand.t && c.t < secStart + 1.0,
        ).length;
        if (existingInSec + upcomingInSec < capNow) {
          // Pick a non-adjacent lane (|chordLane - assignedLane| >= 2)
          const nonAdjacentLanes = [0, 1, 2, 3].filter(
            (l) =>
              Math.abs(l - assignedLane) >= 2 &&
              cand.t - lastLaneTime[l] >= eighthNoteSec - 1e-5,
          );
          if (nonAdjacentLanes.length > 0) {
            const chordLane = nonAdjacentLanes[0];
            lastLaneTime[chordLane] = cand.t;
            lastChordBarIdx = nearDb.index;
            notes.push({
              id: nextId++,
              t: cand.t,
              lane: chordLane,
              strength: cand.strength,
              sourceOnsetT: cand.sourceOnsetT,
              alignMs: cand.alignMs,
              snapped: cand.snapped,
              isChord: true,
              melodyDir: melDir,
            });
          }
        }
      }
    }
  }

  return {
    notes,
    params: mergedParams,
    eighthNoteSec,
  };
}
