import type {
  OnsetPoint,
  Palette,
  RailDistrictEntry,
  RailDistrictType,
  SectionLabel,
  SongMap,
  SongSection,
} from '../shell/api';
import { SCORING } from '../shell/config';

export const VALID_SECTION_LABELS: SectionLabel[] = [
  'intro',
  'verse',
  'build',
  'drop',
  'breakdown',
  'bridge',
  'outro',
];

export const VALID_RAIL_DISTRICTS: RailDistrictType[] = [
  'outskirts',
  'approach',
  'neon_core',
  'rain_rooftops',
  'sunrise',
];

export interface DspSegmentCandidate {
  start: number;
  end: number;
  energy: number;
  onsetDensity: number;
}

export interface DspDropCandidate {
  t: number;
  energyRise: number;
  preEnergy: number;
  postEnergy: number;
}

export interface DspOutput {
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
  phrases: number[];
  onsets: SongMap['onsets'];
  envelope: SongMap['envelope'];
  waveform: SongMap['waveform'];
  melody: SongMap['melody'];
  sectionCandidates: DspSegmentCandidate[];
  dropCandidates: DspDropCandidate[];
}

export function roundTime(t: number): number {
  return Math.round(t * 1000) / 1000;
}

export function findNearest(target: number, candidates: number[]): { value: number; dist: number; index: number } {
  if (candidates.length === 0) {
    return { value: roundTime(target), dist: 0, index: -1 };
  }
  let lo = 0;
  let hi = candidates.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (candidates[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const idxAfter = Math.min(candidates.length - 1, Math.max(0, lo));
  const idxBefore = Math.max(0, idxAfter - 1);
  const dBefore = Math.abs(target - candidates[idxBefore]);
  const dAfter = Math.abs(target - candidates[idxAfter]);
  if (dBefore <= dAfter) {
    return { value: roundTime(candidates[idxBefore]), dist: dBefore, index: idxBefore };
  }
  return { value: roundTime(candidates[idxAfter]), dist: dAfter, index: idxAfter };
}

/**
 * Returns the index of the beat at or immediately before `t` (0..beats.length-1).
 */
export function beatAt(map: SongMap, t: number): number {
  const beats = map.beats;
  if (!beats || beats.length === 0) return 0;
  if (t <= beats[0]) return 0;
  let lo = 0;
  let hi = beats.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (beats[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Returns the timestamp (in seconds) of the beat nearest to `t`.
 */
export function nearestBeat(map: SongMap, t: number): number {
  if (!map.beats || map.beats.length === 0) return roundTime(t);
  return findNearest(t, map.beats).value;
}

/**
 * Returns the fractional phase (0..1) between the current beat and the next beat at time `t`.
 */
export function beatPhase(map: SongMap, t: number): number {
  const beats = map.beats;
  if (!beats || beats.length === 0) {
    const period = 60 / Math.max(1, map.bpm || 120);
    return ((t % period) + period) % period / period;
  }
  if (t <= beats[0]) {
    const period = beats.length >= 2 ? beats[1] - beats[0] : 60 / Math.max(1, map.bpm || 120);
    if (period <= 1e-6) return 0;
    const ph = 1 - ((beats[0] - t) % period) / period;
    return Math.max(0, Math.min(1, ph));
  }
  const idx = beatAt(map, t);
  if (idx >= beats.length - 1) {
    const period = beats.length >= 2 ? beats[beats.length - 1] - beats[beats.length - 2] : 60 / Math.max(1, map.bpm || 120);
    if (period <= 1e-6) return 0;
    return Math.min(1, Math.max(0, ((t - beats[idx]) % period) / period));
  }
  const b0 = beats[idx];
  const b1 = beats[idx + 1];
  const span = Math.max(1e-6, b1 - b0);
  return Math.max(0, Math.min(1, (t - b0) / span));
}

/**
 * Returns the active SongSection at time `t`.
 */
export function sectionAt(map: SongMap, t: number): SongSection {
  const sections = map.sections;
  if (!sections || sections.length === 0) {
    return { start: 0, end: map.duration || 100, label: 'verse', energy: 0.5, mood: 'neutral' };
  }
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (t >= s.start && t < s.end) {
      return s;
    }
  }
  if (t < sections[0].start) return sections[0];
  return sections[sections.length - 1];
}

/**
 * Returns the 0-based section index at time `t`.
 */
export function sectionIndexAt(map: SongMap, t: number): number {
  const sections = map.sections;
  if (!sections || sections.length === 0) return 0;
  for (let i = 0; i < sections.length; i++) {
    if (t >= sections[i].start && t < sections[i].end) return i;
  }
  return t < sections[0].start ? 0 : sections.length - 1;
}

/**
 * Returns the first phrase start timestamp inside [a, b], else null.
 */
export function nextPhraseIn(map: SongMap, a: number, b: number): number | null {
  const phrases = map.phrases;
  if (!phrases || phrases.length === 0) return null;
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    if (p >= a && p <= b) {
      return p;
    }
  }
  return null;
}

/**
 * Returns the timestamp (in seconds) of the downbeat nearest to `t`.
 */
export function nearestDownbeat(map: SongMap, t: number): number {
  if (!map.downbeats || map.downbeats.length === 0) {
    return nearestBeat(map, t);
  }
  return findNearest(t, map.downbeats).value;
}

/**
 * Returns the interpolated envelope energy (0..1) at song time `t`.
 */
export function energyAt(map: SongMap, t: number): number {
  const env = map.envelope;
  if (!env || !env.energy || env.energy.length === 0) return 0.5;
  const hop = Math.max(0.001, env.hop || 0.05);
  const exactIdx = t / hop;
  if (exactIdx <= 0) return env.energy[0];
  if (exactIdx >= env.energy.length - 1) return env.energy[env.energy.length - 1];
  const i0 = Math.floor(exactIdx);
  const frac = exactIdx - i0;
  return env.energy[i0] * (1 - frac) + env.energy[i0 + 1] * frac;
}

/**
 * Returns all onset points in `band` ('low' | 'mid' | 'high') within [a, b].
 */
export function onsetsIn(
  map: SongMap,
  band: 'low' | 'mid' | 'high',
  a: number,
  b: number,
): OnsetPoint[] {
  const list = map.onsets?.[band];
  if (!list || list.length === 0) return [];
  // Binary search for start
  let lo = 0;
  let hi = list.length - 1;
  let startIdx = list.length;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].t >= a) {
      startIdx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const result: OnsetPoint[] = [];
  for (let i = startIdx; i < list.length; i++) {
    if (list[i].t > b) break;
    result.push(list[i]);
  }
  return result;
}

/**
 * Evaluates a timed player action at song time `t` against the beat grid.
 * Within 50 ms = 100 ("PERFECT"), within 100 ms = 50 ("GOOD"), else 0 ("MISS").
 */
export function scoreOnBeat(
  map: SongMap,
  t: number,
): { points: number; label: 'PERFECT' | 'GOOD' | 'MISS'; onBeat: boolean; deltaMs: number } {
  const nb = nearestBeat(map, t);
  const deltaMs = Math.abs(t - nb) * 1000;
  if (deltaMs <= SCORING.ON_BEAT_PERFECT_MS) {
    return {
      points: SCORING.ON_BEAT_PERFECT_PTS,
      label: 'PERFECT',
      onBeat: true,
      deltaMs,
    };
  }
  if (deltaMs <= SCORING.ON_BEAT_GOOD_MS) {
    return {
      points: SCORING.ON_BEAT_GOOD_PTS,
      label: 'GOOD',
      onBeat: true,
      deltaMs,
    };
  }
  return {
    points: 0,
    label: 'MISS',
    onBeat: false,
    deltaMs,
  };
}

/**
 * Snaps a timestamp to the nearest DSP candidate within toleranceSec (default 50ms),
 * else to the nearest downbeat (or beat if downbeats is empty).
 */
export function snapToCandidateOrDownbeat(
  t: number,
  candidates: number[],
  downbeats: number[],
  toleranceSec = 0.05,
): number {
  if (candidates.length > 0) {
    const nearestCand = findNearest(t, candidates);
    if (nearestCand.dist <= toleranceSec) {
      return nearestCand.value;
    }
  }
  if (downbeats.length > 0) {
    return findNearest(t, downbeats).value;
  }
  if (candidates.length > 0) {
    return findNearest(t, candidates).value;
  }
  return roundTime(t);
}

/**
 * Computes deduplicated phrase timestamps: every 4 bars from the first downbeat,
 * plus every section start, sorted and deduplicated within 50ms.
 */
export function buildPhrases(downbeats: number[], sectionStarts: number[]): number[] {
  const raw: number[] = [];
  for (let i = 0; i < downbeats.length; i += 4) {
    raw.push(roundTime(downbeats[i]));
  }
  for (const s of sectionStarts) {
    raw.push(roundTime(s));
  }
  raw.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const t of raw) {
    if (deduped.length === 0 || Math.abs(t - deduped[deduped.length - 1]) > 0.05) {
      deduped.push(t);
    }
  }
  return deduped;
}

/**
 * Computes mean envelope energy between [start, end].
 */
export function meanEnvelopeEnergy(
  envelope: SongMap['envelope'],
  start: number,
  end: number,
): number {
  if (!envelope.energy.length) return 0.5;
  const i0 = Math.max(0, Math.floor(start / envelope.hop));
  const i1 = Math.min(envelope.energy.length - 1, Math.ceil(end / envelope.hop));
  if (i1 < i0) return roundTime(envelope.energy[i0] ?? 0.5);
  let sum = 0;
  let count = 0;
  for (let i = i0; i <= i1; i++) {
    sum += envelope.energy[i];
    count++;
  }
  return count > 0 ? Math.round((sum / count) * 1000) / 1000 : 0.5;
}

/**
 * Downsamples a waveform peak array to `targetPoints` (e.g. 200) using max-pooling per bin.
 */
export function downsampleWaveform(peaks: number[], targetPoints = 200): number[] {
  if (peaks.length === 0) return new Array(targetPoints).fill(0);
  const out: number[] = [];
  for (let i = 0; i < targetPoints; i++) {
    const startIdx = Math.floor((i * peaks.length) / targetPoints);
    const endIdx = Math.max(startIdx + 1, Math.floor(((i + 1) * peaks.length) / targetPoints));
    let maxVal = 0;
    for (let j = startIdx; j < endIdx && j < peaks.length; j++) {
      if (peaks[j] > maxVal) maxVal = peaks[j];
    }
    out.push(Math.round(maxVal * 1000) / 1000);
  }
  return out;
}

/**
 * Maps full-song semantic sections, drops, palettes, and rail districts onto a cut demo DSP map.
 */
export function projectSemanticsToDemo(
  fullMap: SongMap,
  demoDsp: DspOutput,
  windowStart: number,
): {
  sections: SongSection[];
  drops: number[];
  perSectionPalette: Palette[];
  districts: RailDistrictEntry[];
  phrases: number[];
} {
  const demoDuration = demoDsp.duration;
  const windowEnd = windowStart + demoDuration;

  const overlapping: Array<{
    sec: SongSection;
    pal: Palette;
    district: RailDistrictType;
  }> = [];

  for (let i = 0; i < fullMap.sections.length; i++) {
    const sec = fullMap.sections[i];
    if (sec.end <= windowStart + 0.5 || sec.start >= windowEnd - 0.5) {
      continue;
    }
    const pal = fullMap.palette.perSection[i] ?? {
      bg: fullMap.palette.bg,
      primary: fullMap.palette.primary,
      secondary: fullMap.palette.secondary,
      accent: fullMap.palette.accent,
      highlight: fullMap.palette.highlight,
    };
    const districtEntry = fullMap.rail.districts.find((d) => d.section === i);
    const district: RailDistrictType = districtEntry?.district ?? 'neon_core';
    overlapping.push({ sec, pal, district });
  }

  if (overlapping.length === 0 && fullMap.sections.length > 0) {
    overlapping.push({
      sec: fullMap.sections[0],
      pal: fullMap.palette.perSection[0] ?? fullMap.palette,
      district: fullMap.rail.districts[0]?.district ?? 'outskirts',
    });
  }

  const demoCandBoundaries = demoDsp.sectionCandidates.map((c) => c.start);
  const sections: SongSection[] = [];
  const perSectionPalette: Palette[] = [];
  const districts: RailDistrictEntry[] = [];

  for (let i = 0; i < overlapping.length; i++) {
    const item = overlapping[i];
    const rawStart = Math.max(0, item.sec.start - windowStart);
    const rawEnd = Math.min(demoDuration, item.sec.end - windowStart);

    const snappedStart =
      i === 0
        ? 0
        : snapToCandidateOrDownbeat(rawStart, demoCandBoundaries, demoDsp.downbeats, 0.25);
    const snappedEnd =
      i === overlapping.length - 1
        ? roundTime(demoDuration)
        : snapToCandidateOrDownbeat(rawEnd, demoCandBoundaries, demoDsp.downbeats, 0.25);

    const start = i === 0 ? 0 : sections[sections.length - 1].end;
    const end = Math.max(start + 1.0, Math.min(roundTime(demoDuration), snappedEnd));

    sections.push({
      start: roundTime(start),
      end: i === overlapping.length - 1 ? roundTime(demoDuration) : roundTime(end),
      label: item.sec.label,
      energy: meanEnvelopeEnergy(demoDsp.envelope, start, end),
      mood: item.sec.mood,
    });
    perSectionPalette.push(item.pal);
    districts.push({
      section: sections.length - 1,
      district: item.district,
    });
  }

  const demoDropCands = demoDsp.dropCandidates.map((d) => d.t);
  const drops: number[] = [];
  for (const fullDrop of fullMap.drops) {
    const shifted = fullDrop - windowStart;
    if (shifted >= 2.0 && shifted <= demoDuration - 2.0) {
      const snapped = snapToCandidateOrDownbeat(
        shifted,
        [...demoDropCands, ...sections.map((s) => s.start)],
        demoDsp.downbeats,
        0.35,
      );
      if (!drops.some((d) => Math.abs(d - snapped) < 0.5)) {
        drops.push(snapped);
      }
    }
  }

  if (drops.length === 0 && demoDsp.dropCandidates.length > 0) {
    drops.push(roundTime(demoDsp.dropCandidates[0].t));
  }

  const phrases = buildPhrases(
    demoDsp.downbeats,
    sections.map((s) => s.start),
  );

  return {
    sections,
    drops,
    perSectionPalette,
    districts,
    phrases,
  };
}
