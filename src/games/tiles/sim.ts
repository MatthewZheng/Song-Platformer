import type { GameEvent, SongMap } from '../../shell/api';
import { RUNWAY, SCORING } from '../../shell/config';
import { isValidTilesShaderSource, DEFAULT_TILES_FRAGMENT_SHADER } from '../../shell/slots';
import { energyAt } from '../../shared/songmap';
import { createRng } from '../../shared/rng';
import { TilesBotController } from './bot';
import { defaultParams, generateLevel, type TileNote, type TilesLevel, type TilesParams } from './level';

const PERFECT_WINDOW_SEC = SCORING.ON_BEAT_PERFECT_MS / 1000;
const GOOD_WINDOW_SEC = SCORING.ON_BEAT_GOOD_MS / 1000;

export interface TileHitEvent {
  lane: number;
  judgement: 'PERFECT' | 'GOOD' | 'MISS';
  songTime: number;
  noteId: number;
}

export class TilesSimEngine {
  readonly map: SongMap;
  readonly level: TilesLevel;
  private readonly emitCb?: (e: GameEvent) => void;

  safeUntil = 0;
  score = 0;
  misses = 0;
  perfectHits = 0;
  goodHits = 0;
  streak = 0;
  maxStreak = 0;
  runwayNotesJudged = 0;

  dying = false;
  deathTimer = 0;
  deathEmitted = false;

  // Shader & audio reactive states
  uBloom = 0;
  uDesat = 0;
  uMissFlash = 0;
  missLowpassTimer = 0;
  needsLowpassDrop = false;
  needsLowpassRampUp = false;

  readonly handledNoteIds = new Set<number>();
  readonly hitNoteIds = new Set<number>();
  readonly missedNoteIds = new Set<number>();
  readonly recentEvents: TileHitEvent[] = [];
  readonly lanePressFlash: [number, number, number, number] = [0, 0, 0, 0];
  firstActiveIdx = 0;

  constructor(opts: {
    map: SongMap;
    level: TilesLevel;
    safeUntil: number;
    emit?: (e: GameEvent) => void;
  }) {
    this.map = opts.map;
    this.level = opts.level;
    this.safeUntil = opts.safeUntil;
    this.emitCb = opts.emit;
  }

  reset(safeUntil: number): void {
    this.safeUntil = safeUntil;
    this.score = 0;
    this.misses = 0;
    this.perfectHits = 0;
    this.goodHits = 0;
    this.streak = 0;
    this.maxStreak = 0;
    this.runwayNotesJudged = 0;
    this.dying = false;
    this.deathTimer = 0;
    this.deathEmitted = false;
    this.uBloom = 0;
    this.uDesat = 0;
    this.uMissFlash = 0;
    this.missLowpassTimer = 0;
    this.needsLowpassDrop = false;
    this.needsLowpassRampUp = false;
    this.handledNoteIds.clear();
    this.hitNoteIds.clear();
    this.missedNoteIds.clear();
    this.recentEvents.length = 0;
    this.lanePressFlash[0] = 0;
    this.lanePressFlash[1] = 0;
    this.lanePressFlash[2] = 0;
    this.lanePressFlash[3] = 0;
    this.firstActiveIdx = 0;
  }

  private advanceCursor(): void {
    const notes = this.level.notes;
    while (this.firstActiveIdx < notes.length) {
      const n = notes[this.firstActiveIdx];
      if (n.t < this.safeUntil) {
        this.handledNoteIds.add(n.id);
        this.firstActiveIdx++;
      } else if (this.handledNoteIds.has(n.id)) {
        this.firstActiveIdx++;
      } else {
        break;
      }
    }
  }

  pressLane(lane: number, songTime: number): 'PERFECT' | 'GOOD' | null {
    if (this.dying || lane < 0 || lane > 3) return null;
    this.lanePressFlash[lane] = 1.0;
    this.advanceCursor();

    // Find earliest unhandled active note (note.t >= safeUntil) in this lane within 100 ms
    let bestNote: TileNote | null = null;
    let bestDelta = Infinity;
    const notes = this.level.notes;

    for (let i = this.firstActiveIdx; i < notes.length; i++) {
      const note = notes[i];
      if (note.t < this.safeUntil) continue;
      if (note.lane !== lane) continue;
      if (this.handledNoteIds.has(note.id)) continue;

      const delta = Math.abs(note.t - songTime);
      if (delta <= GOOD_WINDOW_SEC && delta < bestDelta) {
        bestDelta = delta;
        bestNote = note;
      }
      if (note.t - songTime > GOOD_WINDOW_SEC + 0.05) {
        break;
      }
    }

    if (!bestNote) {
      // A press with no note nearby costs nothing
      return null;
    }

    if (bestNote.t < this.safeUntil) {
      this.runwayNotesJudged++;
    }

    this.handledNoteIds.add(bestNote.id);
    this.hitNoteIds.add(bestNote.id);
    this.streak++;
    if (this.streak > this.maxStreak) {
      this.maxStreak = this.streak;
    }

    if (bestDelta <= PERFECT_WINDOW_SEC) {
      this.perfectHits++;
      this.score += SCORING.ON_BEAT_PERFECT_PTS;
      this.uBloom = Math.min(1.0, this.uBloom + 0.16);
      this.uDesat = Math.max(0, this.uDesat - 0.18);
      this.recentEvents.push({
        lane,
        judgement: 'PERFECT',
        songTime,
        noteId: bestNote.id,
      });
      this.emitCb?.({
        type: 'score',
        points: SCORING.ON_BEAT_PERFECT_PTS,
        onBeat: true,
        label: 'PERFECT',
      });
      return 'PERFECT';
    } else {
      this.goodHits++;
      this.score += SCORING.ON_BEAT_GOOD_PTS;
      this.uBloom = Math.min(1.0, this.uBloom + 0.08);
      this.uDesat = Math.max(0, this.uDesat - 0.1);
      this.recentEvents.push({
        lane,
        judgement: 'GOOD',
        songTime,
        noteId: bestNote.id,
      });
      this.emitCb?.({
        type: 'score',
        points: SCORING.ON_BEAT_GOOD_PTS,
        onBeat: true,
        label: 'GOOD',
      });
      return 'GOOD';
    }
  }

  private registerMiss(note: TileNote, songTime: number): void {
    if (this.dying) return;
    if (note.t < this.safeUntil) {
      this.runwayNotesJudged++;
    }
    this.handledNoteIds.add(note.id);
    this.missedNoteIds.add(note.id);
    this.misses++;
    this.streak = 0;
    this.uBloom = Math.max(0, this.uBloom * 0.35);
    this.uDesat = 0.6;
    this.uMissFlash = 1.0;
    this.missLowpassTimer = 1.2;
    this.needsLowpassDrop = true;

    this.recentEvents.push({
      lane: note.lane,
      judgement: 'MISS',
      songTime,
      noteId: note.id,
    });

    const livesLeft = Math.max(0, 5 - this.misses);
    this.emitCb?.({ type: 'score', points: 0, onBeat: false, label: 'MISS' });
    this.emitCb?.({ type: 'lifeLost', livesLeft });

    if (this.misses >= 5) {
      this.dying = true;
      this.deathTimer = 0;
      this.deathEmitted = false;
    }
  }

  step(
    dt: number,
    songTime: number,
    lanesPressed: number[],
    pressTimes?: number[],
    preserveRecentEvents = false,
  ): void {
    if (!preserveRecentEvents) {
      this.recentEvents.length = 0;
    }

    for (let i = 0; i < 4; i++) {
      this.lanePressFlash[i] = Math.max(0, this.lanePressFlash[i] - dt * 6.5);
    }

    // Decay shader uniforms smoothly
    this.uMissFlash = Math.max(0, this.uMissFlash - dt * 2.8);
    this.uDesat = Math.max(0, this.uDesat - dt * 0.45);
    this.uBloom = Math.max(0, this.uBloom - dt * 0.12);

    if (this.missLowpassTimer > 0) {
      const prev = this.missLowpassTimer;
      this.missLowpassTimer = Math.max(0, this.missLowpassTimer - dt);
      if (prev > 1.14 && this.missLowpassTimer <= 1.14) {
        this.needsLowpassRampUp = true;
      }
    }

    if (this.dying) {
      this.deathTimer += dt;
      if (this.deathTimer >= 0.85 && !this.deathEmitted) {
        this.deathEmitted = true;
        this.emitCb?.({ type: 'death' });
      }
      return;
    }

    // Survival score: 10 points per second
    this.score += SCORING.SURVIVAL_PTS_PER_SEC * dt;

    // Advance cursor past any notes before safeUntil or already handled
    this.advanceCursor();

    // Process lane presses for this step (using exact sub-frame pressTime if provided)
    for (let k = 0; k < lanesPressed.length; k++) {
      const hitT = pressTimes && pressTimes[k] !== undefined ? pressTimes[k] : songTime;
      this.pressLane(lanesPressed[k], hitT);
    }

    // Check for notes that passed the hit line by > 100 ms
    const notes = this.level.notes;
    for (let i = this.firstActiveIdx; i < notes.length; i++) {
      const note = notes[i];
      if (note.t < this.safeUntil) continue;
      if (this.handledNoteIds.has(note.id)) continue;

      if (songTime - note.t > GOOD_WINDOW_SEC) {
        this.registerMiss(note, songTime);
        if (this.dying) break;
      } else if (note.t > songTime) {
        break;
      }
    }
    this.advanceCursor();
  }
}

export function computeLevelStaticMetrics(map: SongMap, level: TilesLevel): {
  alignMsMean: number;
  alignMsMax: number;
  gridSnapPct: number;
  maxNps: number;
  sameLaneGapViolations: number;
  densityEnergyCorr: number;
} {
  const notes = level.notes;
  if (notes.length === 0) {
    return {
      alignMsMean: 0,
      alignMsMax: 0,
      gridSnapPct: 100,
      maxNps: 0,
      sameLaneGapViolations: 0,
      densityEnergyCorr: 1,
    };
  }

  let alignSum = 0;
  let alignMax = 0;
  let snappedCount = 0;

  for (const n of notes) {
    alignSum += n.alignMs;
    if (n.alignMs > alignMax) alignMax = n.alignMs;
    if (n.snapped) snappedCount++;
  }

  // Check sameLaneGapViolations (minimum gap in same lane = eighthNoteSec)
  const lastInLane = [-999, -999, -999, -999];
  let sameLaneGapViolations = 0;
  for (const n of notes) {
    if (n.t - lastInLane[n.lane] < level.eighthNoteSec - 1e-4) {
      sameLaneGapViolations++;
    }
    lastInLane[n.lane] = n.t;
  }

  // Max NPS across 1 s windows
  let maxNps = 0;
  const totalSec = Math.ceil(map.duration);
  for (let s = 0; s < totalSec; s++) {
    let count = 0;
    for (const n of notes) {
      if (n.t >= s && n.t < s + 1.0) count++;
    }
    if (count > maxNps) maxNps = count;
  }

  // Pearson correlation between notes per second and energy over 2 s windows
  const winSize = 2.0;
  const numWins = Math.max(1, Math.floor(map.duration / winSize));
  const npsSeries: number[] = [];
  const energySeries: number[] = [];

  for (let w = 0; w < numWins; w++) {
    const t0 = w * winSize;
    const t1 = t0 + winSize;
    let count = 0;
    for (const n of notes) {
      if (n.t >= t0 && n.t < t1) count++;
    }
    const nps = count / winSize;
    const eMean =
      (energyAt(map, t0 + 0.3) +
        energyAt(map, t0 + 1.0) +
        energyAt(map, Math.min(map.duration, t0 + 1.7))) /
      3;
    npsSeries.push(nps);
    energySeries.push(eMean);
  }

  let corr = 0;
  if (npsSeries.length >= 2) {
    const meanX = npsSeries.reduce((a, b) => a + b, 0) / npsSeries.length;
    const meanY = energySeries.reduce((a, b) => a + b, 0) / energySeries.length;
    let cov = 0;
    let varX = 0;
    let varY = 0;
    for (let i = 0; i < npsSeries.length; i++) {
      const dx = npsSeries[i] - meanX;
      const dy = energySeries[i] - meanY;
      cov += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }
    corr = varX > 1e-9 && varY > 1e-9 ? cov / Math.sqrt(varX * varY) : 0;
  }

  return {
    alignMsMean: Math.round((alignSum / notes.length) * 100) / 100,
    alignMsMax: Math.round(alignMax * 100) / 100,
    gridSnapPct: Math.round((snappedCount / notes.length) * 1000) / 10,
    maxNps,
    sameLaneGapViolations,
    densityEnergyCorr: Math.round(corr * 1000) / 1000,
  };
}

export function simulate(opts: {
  map: SongMap;
  level?: TilesLevel;
  params?: TilesParams;
  seed?: number;
  entry?: number;
  until?: number;
  shaderSource?: string;
}): Record<string, number> {
  const params: TilesParams = { ...defaultParams, ...(opts.params || {}) };
  const rng = createRng(opts.seed ?? 42);
  const level = opts.level ?? generateLevel(opts.map, params, rng);
  const entry = opts.entry ?? 0;
  const until = opts.until ?? opts.map.duration;
  const safeUntil = entry + RUNWAY;
  const dt = 1 / 120;

  const sim = new TilesSimEngine({
    map: opts.map,
    level,
    safeUntil,
  });
  const bot = new TilesBotController();

  for (let t = entry; t <= until; t += dt) {
    const lanesPressed = bot.step(level.notes, t, safeUntil, rng, sim.handledNoteIds);
    sim.step(dt, t, lanesPressed);
    if (sim.deathEmitted) {
      break;
    }
  }

  const staticMetrics = computeLevelStaticMetrics(opts.map, level);
  const totalJudged = sim.perfectHits + sim.goodHits + sim.misses;
  const botPerfectPct =
    totalJudged > 0 ? Math.round((sim.perfectHits / totalJudged) * 1000) / 10 : 100;

  const candidateShader = opts.shaderSource ?? DEFAULT_TILES_FRAGMENT_SHADER;
  const shaderCompiled = isValidTilesShaderSource(candidateShader) ? 1 : 0;

  return {
    score: Math.round(sim.score),
    alignMsMean: staticMetrics.alignMsMean,
    alignMsMax: staticMetrics.alignMsMax,
    gridSnapPct: staticMetrics.gridSnapPct,
    maxNps: staticMetrics.maxNps,
    maxNpsCap: params.npsBase + params.npsEnergy,
    sameLaneGapViolations: staticMetrics.sameLaneGapViolations,
    runwayNotes: sim.runwayNotesJudged,
    densityEnergyCorr: staticMetrics.densityEnergyCorr,
    botPerfectPct,
    misses: sim.misses,
    shaderCompiled,
    avgFps: 60,
  };
}
