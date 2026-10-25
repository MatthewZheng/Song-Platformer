import type { GameEvent, SongMap } from '../../shell/api';
import { RUNWAY } from '../../shell/config';
import { scoreOnBeat } from '../../shared/songmap';
import { hashString } from '../../shared/rng';
import {
  decidePhase1BotAction,
  decidePhase2BotHop,
  HOP_DURATION_SEC,
  type Phase2HopDir,
} from './bot';
import {
  CENTER_COL,
  cometHeadColAt,
  defaultParams,
  evaluateCometAtColumn,
  generateLevel,
  GRID_COLS,
  resolveRunnerSession,
  type RunnerLevel,
  type RunnerParams,
  type RunnerSessionSchedule,
} from './level';

export interface RunnerMetrics {
  clearRate: number;
  livesLost: number;
  alignMsMean: number;
  alignMsMax: number;
  gapViolations: number;
  runwayHazards: number;
  transitionAfterEntry: number;
  transitionOnPhrase: number;
  unsafeRows: number;
  trailDamage: number;
  onBeatHopPct: number;
  avgFps?: number;
}

export interface RunnerSimInput {
  jump?: boolean;
  duck?: boolean;
  hopDir?: Exclude<Phase2HopDir, 'wait'> | null;
}

export interface RunnerSimState {
  map: SongMap;
  params: RunnerParams;
  session: RunnerSessionSchedule;
  phase: 'phase1' | 'transition' | 'phase2';
  livesLeft: number;
  livesLost: number;
  trailDamage: number;
  invulnUntil: number;
  hitFlashTimer: number;
  emberFlickerTimer: number;
  dying: boolean;
  deathTimer: number;
  deathEmitted: boolean;
  score: number;

  // Phase 1 state
  isJumping: boolean;
  jumpElapsed: number;
  jumpBufferTimer: number;
  isDucking: boolean;
  heroY: number;

  // Phase 2 state
  gridRow: number;
  gridCol: number;
  hopFromRow: number;
  hopFromCol: number;
  hopping: boolean;
  hopElapsed: number;
  visualRow: number;
  visualCol: number;
  hopArcY: number;
  queuedHopDir: Exclude<Phase2HopDir, 'wait'> | null;
  cameraRow: number;

  // Metrics tracking
  totalForwardHops: number;
  onBeatForwardHops: number;
  alignmentErrorsMs: number[];
  checkedCometIds: Set<number>;
  gapViolations: number;
  runwayHazards: number;
  unsafeRows: number;
}

/**
 * Computes static schedule verification metrics (`gapViolations`, `runwayHazards`, `unsafeRows`,
 * and baseline alignment deltas) for a session schedule over `[entry, until]`.
 */
export function computeStaticScheduleMetrics(
  session: RunnerSessionSchedule,
  params: RunnerParams,
  until: number,
): {
  gapViolations: number;
  runwayHazards: number;
  unsafeRows: number;
  alignmentErrorsMs: number[];
} {
  let gapViolations = 0;
  let runwayHazards = 0;
  const alignmentErrorsMs: number[] = [];

  const minAllowedGap = params.airtime + 0.18 - 1e-4;
  const obsList = session.phase1Obstacles.filter((o) => o.t <= until);

  for (let i = 0; i < obsList.length; i++) {
    const o = obsList[i];
    if (o.t < session.safeUntil) {
      runwayHazards++;
    }
    alignmentErrorsMs.push(Math.abs(o.t - o.onsetTime) * 1000);
    if (i > 0 && o.t - obsList[i - 1].t < minAllowedGap) {
      gapViolations++;
    }
  }

  let unsafeRows = 0;
  const maxActiveRow = Math.min(
    session.rows.length - 1,
    Math.ceil(Math.max(0, until - session.transitionEndTime) * session.rowsPerSec) + 8,
  );

  for (let r = 0; r <= maxActiveRow; r++) {
    const row = session.rows[r];
    if (!row || row.type === 'grass') continue;

    const rowComets = row.comets.filter((c) => c.onsetTime <= until + 2.0);
    for (const c of rowComets) {
      if (c.onsetTime < session.safeUntil) {
        runwayHazards++;
      }
      // At t = c.onsetTime, headCol is exactly CENTER_COL (4)
      const headAtOnset = cometHeadColAt(c, c.onsetTime);
      const timeErrSec = Math.abs(headAtOnset - CENTER_COL) / Math.max(0.1, c.speed);
      alignmentErrorsMs.push(timeErrSec * 1000);
    }

    if (rowComets.length <= 1) continue;

    // Check every column 0..8 on this hazard row to verify there is at least one >= 0.6s gap
    // between consecutive comet head passages
    let rowHasUnsafeCol = false;
    for (let col = 0; col < GRID_COLS; col++) {
      const passages: Array<{ enter: number; exit: number }> = [];
      for (const c of rowComets) {
        const tCross = c.onsetTime + ((col - CENTER_COL) * c.dir) / c.speed;
        const halfDur = (c.headRadius + 0.25) / c.speed;
        passages.push({ enter: tCross - halfDur, exit: tCross + halfDur });
      }
      passages.sort((a, b) => a.enter - b.enter);

      let maxGapOnCol = 999;
      if (passages.length >= 2) {
        maxGapOnCol = 0;
        for (let k = 1; k < passages.length; k++) {
          const gap = passages[k].enter - passages[k - 1].exit;
          if (gap > maxGapOnCol) maxGapOnCol = gap;
        }
      }
      if (maxGapOnCol < 0.6) {
        rowHasUnsafeCol = true;
        break;
      }
    }

    if (rowHasUnsafeCol) {
      unsafeRows++;
    }
  }

  return {
    gapViolations,
    runwayHazards,
    unsafeRows,
    alignmentErrorsMs,
  };
}

export function createRunnerSimState(
  map: SongMap,
  params: RunnerParams,
  session: RunnerSessionSchedule,
  until = map.duration,
): RunnerSimState {
  const staticStats = computeStaticScheduleMetrics(session, params, until);
  return {
    map,
    params,
    session,
    phase: 'phase1',
    livesLeft: 2,
    livesLost: 0,
    trailDamage: 0,
    invulnUntil: session.safeUntil,
    hitFlashTimer: 0,
    emberFlickerTimer: 0,
    dying: false,
    deathTimer: 0,
    deathEmitted: false,
    score: 0,

    isJumping: false,
    jumpElapsed: 0,
    jumpBufferTimer: 0,
    isDucking: false,
    heroY: 0,

    gridRow: 0,
    gridCol: CENTER_COL,
    hopFromRow: 0,
    hopFromCol: CENTER_COL,
    hopping: false,
    hopElapsed: 0,
    visualRow: 0,
    visualCol: CENTER_COL,
    hopArcY: 0,
    queuedHopDir: null,
    cameraRow: 0,

    totalForwardHops: 0,
    onBeatForwardHops: 0,
    alignmentErrorsMs: [...staticStats.alignmentErrorsMs],
    checkedCometIds: new Set<number>(),
    gapViolations: staticStats.gapViolations,
    runwayHazards: staticStats.runwayHazards,
    unsafeRows: staticStats.unsafeRows,
  };
}

function tryStartHop(
  state: RunnerSimState,
  dir: Exclude<Phase2HopDir, 'wait'>,
  songTime: number,
  emit?: (e: GameEvent) => void,
): boolean {
  const dr = dir === 'forward' ? 1 : dir === 'back' ? -1 : 0;
  const dc = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
  const targetRow = state.gridRow + dr;
  const targetCol = state.gridCol + dc;

  if (targetCol < 0 || targetCol >= GRID_COLS) return false;
  if (targetRow < 0 || targetRow >= state.session.rows.length) return false;

  const destRowData = state.session.rows[targetRow];
  if (destRowData?.type === 'grass') {
    if (destRowData.blockers.some((b) => b.col === targetCol)) {
      return false;
    }
  }

  state.hopping = true;
  state.hopElapsed = 0;
  state.hopFromRow = state.gridRow;
  state.hopFromCol = state.gridCol;
  state.gridRow = targetRow;
  state.gridCol = targetCol;

  if (dir === 'forward') {
    state.totalForwardHops += 1;
    const beatRes = scoreOnBeat(state.map, songTime);
    if (beatRes.onBeat) {
      state.onBeatForwardHops += 1;
      state.score += beatRes.points;
      emit?.({ type: 'score', points: beatRes.points, onBeat: true, label: beatRes.label });
    } else {
      state.score += 10;
      emit?.({ type: 'score', points: 10, onBeat: false, label: 'HOP +10' });
    }
  }

  return true;
}

function loseLife(
  state: RunnerSimState,
  songTime: number,
  emit?: (e: GameEvent) => void,
): void {
  if (state.dying) return;
  state.livesLeft = Math.max(0, state.livesLeft - 1);
  state.livesLost += 1;
  state.invulnUntil = songTime + 1.5;
  state.hitFlashTimer = 0.4;
  emit?.({ type: 'lifeLost', livesLeft: state.livesLeft });

  if (state.livesLeft <= 0) {
    state.dying = true;
    state.deathTimer = 0;
    state.deathEmitted = false;
  }
}

export function stepRunnerSim(
  state: RunnerSimState,
  dt: number,
  songTime: number,
  input: RunnerSimInput,
  emit?: (e: GameEvent) => void,
): void {
  if (state.hitFlashTimer > 0) {
    state.hitFlashTimer = Math.max(0, state.hitFlashTimer - dt);
  }
  if (state.emberFlickerTimer > 0) {
    state.emberFlickerTimer = Math.max(0, state.emberFlickerTimer - dt);
  }

  if (state.dying) {
    state.deathTimer += dt;
    if (state.deathTimer >= 0.85 && !state.deathEmitted) {
      state.deathEmitted = true;
      emit?.({ type: 'death' });
    }
    return;
  }

  const { session, params } = state;

  // Phase 1: 2D Runner
  if (songTime < session.transitionTime) {
    state.phase = 'phase1';

    if (input.jump) {
      state.jumpBufferTimer = 0.14;
    } else if (state.jumpBufferTimer > 0) {
      state.jumpBufferTimer = Math.max(0, state.jumpBufferTimer - dt);
    }

    if (state.jumpBufferTimer > 0 && !state.isJumping) {
      state.isJumping = true;
      state.jumpElapsed = 0;
      state.jumpBufferTimer = 0;
      state.isDucking = false;
    }

    if (state.isJumping) {
      // Pressing duck while airborne triggers a snappy fast-drop
      const dropMult = input.duck ? 2.35 : 1.0;
      state.jumpElapsed += dt * dropMult;
      const u = state.jumpElapsed / Math.max(0.1, params.airtime);
      if (u >= 1.0) {
        state.isJumping = false;
        state.jumpElapsed = 0;
        state.heroY = 0;
        state.isDucking = Boolean(input.duck);
      } else {
        // Smooth, responsive gravity curve with quick takeoff and floaty apex
        const sineArc = Math.sin(u * Math.PI);
        const paraArc = 4 * u * (1 - u);
        state.heroY = (0.62 * sineArc + 0.38 * paraArc) * 1.48;
      }
    } else {
      state.heroY = 0;
      state.isDucking = Boolean(input.duck);
    }

    // Check Phase 1 obstacles (compact vegetation & bird heights)
    for (let i = 0; i < session.phase1Obstacles.length; i++) {
      const obs = session.phase1Obstacles[i];
      if (obs.removed) continue;

      const x = (obs.t - songTime) * params.scrollSpeed2D;
      if (!obs.passed && x <= 0) {
        obs.passed = true;
      }

      // Collision window around heroX = 0
      if (Math.abs(x) <= 0.34 && songTime >= session.safeUntil && songTime > state.invulnUntil) {
        let hit = false;
        if (obs.kind === 'bird_high') {
          hit = !state.isDucking && state.heroY < 0.88;
        } else {
          hit = state.heroY < 0.48;
        }

        if (hit) {
          obs.removed = true;
          loseLife(state, songTime, emit);
          break;
        }
      }
    }
    return;
  }

  // Transition Phase (1.6 s)
  if (songTime < session.transitionEndTime) {
    state.phase = 'transition';
    state.isJumping = false;
    state.jumpBufferTimer = 0;
    state.isDucking = false;
    state.heroY = 0;
    state.gridRow = 0;
    state.gridCol = CENTER_COL;
    state.visualRow = 0;
    state.visualCol = CENTER_COL;
    state.hopArcY = 0;
    state.cameraRow = 0;
    return;
  }

  // Phase 2: 3D Voxel Lane Crossing
  state.phase = 'phase2';

  if (input.hopDir) {
    if (!state.hopping) {
      tryStartHop(state, input.hopDir, songTime, emit);
    } else if (!state.queuedHopDir) {
      state.queuedHopDir = input.hopDir;
    }
  }

  if (state.hopping) {
    state.hopElapsed += dt;
    const u = Math.min(1, state.hopElapsed / HOP_DURATION_SEC);
    // Smooth cosine ease-in-out for horizontal glide + smooth sine arc on Y
    const smoothU = 0.5 - 0.5 * Math.cos(u * Math.PI);
    state.visualRow = state.hopFromRow + (state.gridRow - state.hopFromRow) * smoothU;
    state.visualCol = state.hopFromCol + (state.gridCol - state.hopFromCol) * smoothU;
    state.hopArcY = Math.sin(u * Math.PI) * 0.62;

    if (state.hopElapsed >= HOP_DURATION_SEC) {
      state.hopping = false;
      state.hopElapsed = 0;
      state.visualRow = state.gridRow;
      state.visualCol = state.gridCol;
      state.hopArcY = 0;

      if (state.queuedHopDir) {
        const queued = state.queuedHopDir;
        state.queuedHopDir = null;
        tryStartHop(state, queued, songTime, emit);
      }
    }
  } else {
    state.visualRow = state.gridRow;
    state.visualCol = state.gridCol;
    state.hopArcY = 0;
  }

  // Camera auto-scrolls forward at scrollRowsPerBeat, and catches up if hero gets far ahead
  const elapsedP2 = Math.max(0, songTime - session.transitionEndTime);
  const autoScrollRow = elapsedP2 * session.rowsPerSec;
  const targetCamRow = Math.max(autoScrollRow, state.visualRow - 3.2);
  state.cameraRow = Math.max(state.cameraRow, targetCamRow);

  const bottomEdgeRow = state.cameraRow - 2.3;
  if (state.visualRow < bottomEdgeRow && songTime >= session.safeUntil) {
    if (songTime > state.invulnUntil) {
      loseLife(state, songTime, emit);
    }
    if (!state.dying) {
      // Respawn on the nearest safe grass row in view with 1.5 s of invulnerability
      let respawnRow = Math.max(0, Math.ceil(state.cameraRow + 1));
      while (
        respawnRow < session.rows.length - 1 &&
        session.rows[respawnRow].type !== 'grass'
      ) {
        respawnRow++;
      }
      let respawnCol = CENTER_COL;
      const blockers = session.rows[respawnRow]?.blockers || [];
      if (blockers.some((b) => b.col === respawnCol)) {
        for (const c of [3, 5, 2, 6, 1, 7]) {
          if (!blockers.some((b) => b.col === c)) {
            respawnCol = c;
            break;
          }
        }
      }
      state.gridRow = respawnRow;
      state.gridCol = respawnCol;
      state.hopFromRow = respawnRow;
      state.hopFromCol = respawnCol;
      state.visualRow = respawnRow;
      state.visualCol = respawnCol;
      state.hopping = false;
      state.queuedHopDir = null;
      state.invulnUntil = songTime + 1.5;
    }
    return;
  }

  // Check comets on the hero's currently occupied row (hopFromRow during first half of hop, gridRow during second half)
  const activeRow =
    state.hopping && state.hopElapsed < HOP_DURATION_SEC * 0.5
      ? state.hopFromRow
      : state.gridRow;
  const curRowData = session.rows[activeRow];
  if (curRowData && curRowData.type !== 'grass') {
    for (let i = 0; i < curRowData.comets.length; i++) {
      const comet = curRowData.comets[i];
      const hitRes = evaluateCometAtColumn(comet, state.visualCol, songTime);
      if (hitRes.trailHit) {
        // Trail is strictly cosmetic: never costs a life, only makes hero flicker with embers
        state.emberFlickerTimer = 0.4;
      } else if (
        hitRes.headHit &&
        songTime >= session.safeUntil &&
        songTime > state.invulnUntil
      ) {
        loseLife(state, songTime, emit);
        break;
      }
    }
  }
}

export function buildRunnerMetrics(state: RunnerSimState, avgFps?: number): RunnerMetrics {
  const errs = state.alignmentErrorsMs;
  let alignMsMean = 0;
  let alignMsMax = 0;
  if (errs.length > 0) {
    let sum = 0;
    for (let i = 0; i < errs.length; i++) {
      sum += errs[i];
      if (errs[i] > alignMsMax) alignMsMax = errs[i];
    }
    alignMsMean = Math.round((sum / errs.length) * 100) / 100;
    alignMsMax = Math.round(alignMsMax * 100) / 100;
  }

  const onBeatHopPct =
    state.totalForwardHops > 0
      ? Math.round((state.onBeatForwardHops / state.totalForwardHops) * 1000) / 10
      : 100;

  const out: RunnerMetrics = {
    clearRate: state.livesLost === 0 ? 1 : 0,
    livesLost: state.livesLost,
    alignMsMean,
    alignMsMax,
    gapViolations: state.gapViolations,
    runwayHazards: state.runwayHazards,
    transitionAfterEntry: state.session.transitionAfterEntry,
    transitionOnPhrase: state.session.transitionOnPhrase,
    unsafeRows: state.unsafeRows,
    trailDamage: state.trailDamage,
    onBeatHopPct,
  };

  if (avgFps !== undefined) {
    out.avgFps = Math.round(avgFps * 10) / 10;
  }
  return out;
}

export interface SimulateArgs {
  map: SongMap;
  level?: unknown;
  params?: Partial<RunnerParams>;
  seed?: number;
  entry?: number;
  until?: number;
}

/**
 * Deterministic headless simulation at fixed 1/120 s step using rules + bot.
 */
export function simulate({
  map,
  level,
  params,
  seed,
  entry = 0,
  until,
}: SimulateArgs): RunnerMetrics {
  const mergedParams: RunnerParams = {
    ...defaultParams,
    ...(params || {}),
  };

  const baseLevel =
    (level as RunnerLevel | undefined) || generateLevel(map, mergedParams);
  const simSeed = seed ?? baseLevel.seed ?? hashString(map.id || 'runner');
  const endSec = until ?? Math.min(map.duration, entry + 60);
  const safeUntil = entry + RUNWAY;

  const session = resolveRunnerSession(
    map,
    mergedParams,
    simSeed,
    entry,
    safeUntil,
    baseLevel.p95LowStrength ?? 0.78,
  );

  const state = createRunnerSimState(map, mergedParams, session, endSec);
  const stepDt = 1 / 120;
  let stepIdx = 0;

  for (let t = entry; t <= endSec; t += stepDt) {
    stepIdx++;
    const input: RunnerSimInput = {};
    if (t < session.transitionTime) {
      const act = decidePhase1BotAction(session, mergedParams, t, state.isJumping);
      if (act === 'jump') input.jump = true;
      else if (act === 'duck') input.duck = true;
    } else if (t >= session.transitionEndTime && !state.hopping && stepIdx % 3 === 0) {
      const hopDir = decidePhase2BotHop(
        map,
        session,
        state.gridRow,
        state.gridCol,
        t,
      );
      if (hopDir !== 'wait') {
        input.hopDir = hopDir;
      }
    }

    stepRunnerSim(state, stepDt, t, input);
    if (state.deathEmitted) {
      break;
    }
  }

  return buildRunnerMetrics(state);
}
