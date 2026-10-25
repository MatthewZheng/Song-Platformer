import type { SongMap } from '../../shell/api';
import { scoreOnBeat } from '../../shared/songmap';
import {
  cometHeadColAt,
  GRID_COLS,
  type RunnerParams,
  type RunnerSessionSchedule,
} from './level';

export const HOP_DURATION_SEC = 0.14;
export const BFS_STEP_SEC = 0.07;
export const BFS_LOOKAHEAD_SEC = 2.0;

export type Phase1BotAction = 'none' | 'jump' | 'duck';
export type Phase2HopDir = 'forward' | 'left' | 'right' | 'back' | 'wait';

/**
 * Phase 1 bot decision:
 * Jump when an upcoming cactus or low bird is at the lead distance implied by `airtime`.
 * Duck under high birds.
 */
export function decidePhase1BotAction(
  session: RunnerSessionSchedule,
  params: RunnerParams,
  songTime: number,
  isJumping: boolean,
): Phase1BotAction {
  if (songTime < session.safeUntil || songTime >= session.transitionTime) {
    return 'none';
  }

  for (const obs of session.phase1Obstacles) {
    if (obs.removed) continue;
    const dtToImpact = obs.t - songTime;
    // Skip obstacles whose collision window (|x| <= 0.42 -> ~0.04s) has already passed
    if (dtToImpact < -0.05) continue;

    if (obs.kind === 'bird_high') {
      if (dtToImpact <= 0.32 && dtToImpact >= -0.05) {
        return 'duck';
      }
      break;
    } else {
      // Jump lead time = ~0.48 of airtime (~0.264s) so Chrome T-Rex apex aligns with obs.t
      const leadTime = params.airtime * 0.48;
      const minLead = 0.04;
      if (!isJumping && dtToImpact <= leadTime && dtToImpact >= minLead) {
        return 'jump';
      }
      break;
    }
  }

  return 'none';
}

/**
 * Checks whether cell `(row, col)` is free of blockers, camera bottom edge, and comet heads at `t`.
 */
export function isCellSafeAt(
  session: RunnerSessionSchedule,
  row: number,
  col: number,
  t: number,
  safetyMarginTiles = 0.62,
  baseCameraRow?: number,
  baseTime?: number,
): boolean {
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= session.rows.length) {
    return false;
  }

  // Camera scroll bottom edge check (accounts for both auto-scroll and ratcheted cameraRow)
  const elapsedP2 = Math.max(0, t - session.transitionEndTime);
  const autoCamRow = elapsedP2 * session.rowsPerSec;
  const projectedCamRow =
    baseCameraRow !== undefined && baseTime !== undefined
      ? Math.max(autoCamRow, baseCameraRow + Math.max(0, t - baseTime) * session.rowsPerSec)
      : autoCamRow;
  const cameraBottomRow = projectedCamRow - 2.2;
  if (row < cameraBottomRow + 0.65) {
    return false;
  }

  const rowData = session.rows[row];
  if (!rowData) return false;

  if (rowData.type === 'grass') {
    for (let i = 0; i < rowData.blockers.length; i++) {
      if (rowData.blockers[i].col === col) return false;
    }
    return true;
  }

  // Hazard row: check comet heads only (trails are cosmetic and harmless)
  for (let i = 0; i < rowData.comets.length; i++) {
    const c = rowData.comets[i];
    const headCol = cometHeadColAt(c, t);
    if (Math.abs(headCol - col) <= c.headRadius + safetyMarginTiles) {
      return false;
    }
  }

  return true;
}

/**
 * Checks whether hopping from `(r0, c0)` to `(r1, c1)` over `[t0, t0 + HOP_DURATION_SEC]`
 * is safe at every 0.035s / 0.07s slice and for a settle window after landing.
 */
function isTransitionSafe(
  session: RunnerSessionSchedule,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  t0: number,
  baseCameraRow?: number,
  baseTime?: number,
): boolean {
  if (c1 < 0 || c1 >= GRID_COLS || r1 < 0 || r1 >= session.rows.length) {
    return false;
  }
  const rowDest = session.rows[r1];
  if (!rowDest) return false;
  if (rowDest.type === 'grass') {
    for (let i = 0; i < rowDest.blockers.length; i++) {
      if (rowDest.blockers[i].col === c1) return false;
    }
  }

  // First half of hop (0..0.07s) is on r0, second half (0.07..0.14s) + next hop takeoff (0.14..0.21s) is on r1
  if (!isCellSafeAt(session, r0, c0, t0, 0.7, baseCameraRow, baseTime)) return false;
  if (!isCellSafeAt(session, r0, c0, t0 + 0.035, 0.7, baseCameraRow, baseTime)) return false;
  if (!isCellSafeAt(session, r0, c0, t0 + BFS_STEP_SEC, 0.7, baseCameraRow, baseTime)) return false;
  if (!isCellSafeAt(session, r1, c1, t0 + BFS_STEP_SEC, 0.72, baseCameraRow, baseTime)) return false;
  if (!isCellSafeAt(session, r1, c1, t0 + 0.105, 0.72, baseCameraRow, baseTime)) return false;
  if (!isCellSafeAt(session, r1, c1, t0 + HOP_DURATION_SEC, 0.72, baseCameraRow, baseTime)) return false;
  if (!isCellSafeAt(session, r1, c1, t0 + HOP_DURATION_SEC + 0.035, 0.72, baseCameraRow, baseTime)) return false;
  if (!isCellSafeAt(session, r1, c1, t0 + HOP_DURATION_SEC + BFS_STEP_SEC, 0.7, baseCameraRow, baseTime)) return false;

  return true;
}

/**
 * Time-expanded BFS over `(row, col, t)` in 0.07s steps with a 2.0s lookahead.
 * Returns whether the state can survive the 2.0s horizon and the best reachable row.
 */
function evaluateLookaheadBFS(
  session: RunnerSessionSchedule,
  startRow: number,
  startCol: number,
  startTime: number,
  horizonTime: number,
  baseCameraRow?: number,
  baseTime?: number,
): { survives: boolean; maxRow: number } {
  let frontier = new Map<number, { row: number; col: number }>();
  frontier.set(startRow * GRID_COLS + startCol, { row: startRow, col: startCol });

  let bestRow = startRow;
  let curT = startTime;

  const deltas: Array<[number, number]> = [
    [1, 0], // forward
    [0, 0], // wait
    [0, -1], // left
    [0, 1], // right
    [-1, 0], // back
  ];

  // Bound lookahead steps to 8 hops (1.12s) for ultra-fast evaluation while checking full 0.07s slices
  const maxHorizon = Math.min(horizonTime, startTime + 1.12);

  while (curT < maxHorizon - 1e-4) {
    const nextFrontier = new Map<number, { row: number; col: number }>();
    for (const state of frontier.values()) {
      for (let d = 0; d < deltas.length; d++) {
        const nr = state.row + deltas[d][0];
        const nc = state.col + deltas[d][1];
        const key = nr * GRID_COLS + nc;
        if (nextFrontier.has(key)) continue;

        if (isTransitionSafe(session, state.row, state.col, nr, nc, curT, baseCameraRow, baseTime)) {
          nextFrontier.set(key, { row: nr, col: nc });
          if (nr > bestRow) bestRow = nr;
        }
      }
    }

    if (nextFrontier.size === 0) {
      return { survives: false, maxRow: bestRow };
    }

    if (nextFrontier.size > 14) {
      const sorted = Array.from(nextFrontier.values()).sort(
        (a, b) => b.row - a.row || Math.abs(a.col - 4) - Math.abs(b.col - 4),
      );
      frontier = new Map();
      for (let i = 0; i < 14; i++) {
        const st = sorted[i];
        frontier.set(st.row * GRID_COLS + st.col, st);
      }
    } else {
      frontier = nextFrontier;
    }

    curT += HOP_DURATION_SEC;
  }

  return { survives: true, maxRow: bestRow };
}

/**
 * Phase 2 bot decision using time-expanded BFS over `(row, col, t)` in 0.07s steps with 2.0s lookahead.
 * Prefers moving forward; when multiple moves (including waiting briefly) are safe, picks the one
 * that lands a hop on a beat.
 */
export function decidePhase2BotHop(
  map: SongMap,
  session: RunnerSessionSchedule,
  curRow: number,
  curCol: number,
  songTime: number,
  currentCameraRow?: number,
): Phase2HopDir {
  if (songTime < session.transitionEndTime) {
    return 'wait';
  }

  const horizonTime = Math.min(map.duration + 1.0, songTime + BFS_LOOKAHEAD_SEC);
  const elapsedP2 = Math.max(0, songTime - session.transitionEndTime);
  const estCamRow = Math.max(currentCameraRow ?? 0, elapsedP2 * session.rowsPerSec);
  const cameraBottomRow = estCamRow - 2.2;
  const cameraTargetRow = estCamRow + 3.2;

  const candidates: Array<{ dir: Phase2HopDir; dr: number; dc: number }> = [
    { dir: 'forward', dr: 1, dc: 0 },
    { dir: 'left', dr: 0, dc: -1 },
    { dir: 'right', dr: 0, dc: 1 },
    { dir: 'wait', dr: 0, dc: 0 },
    { dir: 'back', dr: -1, dc: 0 },
  ];

  const evaluated: Array<{
    dir: Phase2HopDir;
    survives: boolean;
    maxRow: number;
    destRow: number;
    destCol: number;
  }> = [];

  for (const cand of candidates) {
    const nr = curRow + cand.dr;
    const nc = curCol + cand.dc;
    if (!isTransitionSafe(session, curRow, curCol, nr, nc, songTime, estCamRow, songTime)) {
      continue;
    }
    const bfs = evaluateLookaheadBFS(
      session,
      nr,
      nc,
      songTime + HOP_DURATION_SEC,
      horizonTime,
      estCamRow,
      songTime,
    );
    evaluated.push({
      dir: cand.dir,
      survives: bfs.survives,
      maxRow: bfs.maxRow,
      destRow: nr,
      destCol: nc,
    });
  }

  const safeMoves = evaluated.filter((e) => e.survives);
  const pool = safeMoves.length > 0 ? safeMoves : evaluated;
  if (pool.length === 0) return 'forward';

  const beatRes = scoreOnBeat(map, songTime);
  const isOnBeatNow = beatRes.onBeat;
  const isPerfectNow = beatRes.deltaMs <= 45;

  const waitOption = pool.find((m) => m.dir === 'wait');
  const forwardOption = pool.find((m) => m.dir === 'forward');

  const tooFarAhead = curRow > cameraTargetRow + 2.5;
  const urgencyLowRow = curRow < cameraBottomRow + 3.6;

  if (forwardOption && !tooFarAhead) {
    if (
      isPerfectNow ||
      (isOnBeatNow && curRow <= cameraTargetRow + 1.8) ||
      !waitOption ||
      urgencyLowRow
    ) {
      return 'forward';
    }
    if (waitOption) {
      return 'wait';
    }
    return 'forward';
  }

  if (waitOption && !urgencyLowRow) {
    return 'wait';
  }

  pool.sort((a, b) => {
    if (b.maxRow !== a.maxRow) return b.maxRow - a.maxRow;
    if (b.destRow !== a.destRow) return b.destRow - a.destRow;
    return Math.abs(a.destCol - 4) - Math.abs(b.destCol - 4);
  });

  return pool[0].dir;
}
