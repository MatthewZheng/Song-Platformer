import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SongMap } from '../../shell/api';
import { bpmToStartingHue, buildProgressedSwatchPalette } from '../../shared/palette';
import { defaultParams, generateLevel, simulate } from './index';
import {
  createRunnerSimState,
  setTrexSpeedDrop,
  startTrexJump,
  stepRunnerSim,
  TREX_JUMP_CONFIG,
  updateTrexJump,
} from './sim';
import { resolveRunnerSession } from './level';
import {
  buildSpriteTexture,
  CACTUS_SMALL,
  createSmoothRoundedBoxGeometry,
  HERO_RUN_A,
  HERO_RUN_B,
  HERO_RUN_MID,
} from './sprites';

const SONGS = ['ctd', 'fb', 'ra'];

test('BPM-driven Modern Warm / Synthwave palette maps slower BPM to blue and faster BPM to red with intermediate hues', () => {
  const slowHue = bpmToStartingHue(92); // ~232° (cool synthwave blue)
  const midHue = bpmToStartingHue(120); // ~300° (synthwave violet/magenta)
  const fastHue = bpmToStartingHue(145); // ~361° -> 1° (modern warm crimson red)

  assert.ok(slowHue >= 200 && slowHue <= 255, `Expected slow BPM hue in blue range, got ${slowHue}`);
  assert.ok(midHue >= 265 && midHue <= 335, `Expected mid BPM hue in violet/magenta range, got ${midHue}`);
  assert.ok(fastHue >= 345 || fastHue <= 25, `Expected fast BPM hue in warm red range, got ${fastHue}`);

  const pal0 = buildProgressedSwatchPalette(slowHue, 0, 0.4, 'intro');
  const pal2 = buildProgressedSwatchPalette(slowHue, 2, 0.85, 'drop');
  assert.notEqual(pal0.primary, pal2.primary, 'Palette must progress across sections and energy');
});

test('classic T-Rex sprite with pixel headphones, compact vegetation, and smooth 2D/3D edges', () => {
  assert.equal(HERO_RUN_A.width, 22);
  assert.equal(HERO_RUN_A.height, 24);
  assert.equal(HERO_RUN_MID.height, 24);
  assert.equal(HERO_RUN_B.height, 24);
  assert.ok(CACTUS_SMALL.height <= 14, 'Cactus height must be compact');

  const tex = buildSpriteTexture(HERO_RUN_A);
  // 6x supersampled anti-aliased texture
  assert.equal(tex.image.width, 22 * 6);
  assert.equal(tex.image.height, 24 * 6);

  const roundedGeo = createSmoothRoundedBoxGeometry(1, 1, 1, 0.22, 3);
  assert.ok(roundedGeo.attributes.position.count > 24);
  assert.ok(roundedGeo.attributes.normal.count > 24);
});

test('Chromium offline.js Trex jump physics achieves >3.8x cactus height clearance and gentle descent', () => {
  const demoPath = path.resolve(process.cwd(), 'public', 'songs', 'ctd', 'demo.json');
  const map = JSON.parse(fs.readFileSync(demoPath, 'utf-8')) as SongMap;
  const session = resolveRunnerSession(map, defaultParams, 42, 0, 5);
  const state = createRunnerSimState(map, defaultParams, session, 20);

  startTrexJump(state, TREX_JUMP_CONFIG.DEFAULT_SPEED);
  assert.equal(state.isJumping, true);
  assert.equal(
    state.jumpVelocity,
    TREX_JUMP_CONFIG.INITIAL_JUMP_VELOCITY - TREX_JUMP_CONFIG.DEFAULT_SPEED / 10,
  );

  const dt = 1 / 120;
  let maxHeroY = 0;
  let minTrexYPos: number = TREX_JUMP_CONFIG.GROUND_Y_POS;
  let clearanceSec = 0;
  let totalJumpSec = 0;

  while (state.isJumping && totalJumpSec < 2.0) {
    updateTrexJump(state, dt);
    totalJumpSec += dt;
    if (state.heroY > maxHeroY) maxHeroY = state.heroY;
    if (state.trexYPos < minTrexYPos) minTrexYPos = state.trexYPos;
    if (state.heroY >= 0.44) clearanceSec += dt;
  }

  // Apex reaches ~84px above ground in offline.js (>2.15 world units, ~3.9x the 0.56-unit cactus height)
  assert.ok(maxHeroY >= 2.12, `Expected maxHeroY >= 2.12 world units, got ${maxHeroY}`);
  assert.ok(minTrexYPos <= 10.5, `Expected offline.js apex yPos <= 10.5, got ${minTrexYPos}`);
  // Total jump time ~0.55s with >=0.47s spent clearing obstacles
  assert.ok(
    totalJumpSec >= 0.52 && totalJumpSec <= 0.59,
    `Expected Chrome T-Rex airtime ~0.55s, got ${totalJumpSec}`,
  );
  assert.ok(
    clearanceSec >= 0.46,
    `Expected obstacle clearance duration >= 0.46s, got ${clearanceSec}`,
  );

  // Verify mid-air speedDrop (Down/S key) accelerates fall with SPEED_DROP_COEFFICIENT = 3
  startTrexJump(state, TREX_JUMP_CONFIG.DEFAULT_SPEED);
  updateTrexJump(state, 0.15);
  setTrexSpeedDrop(state);
  let dropSec = 0;
  while (state.isJumping && dropSec < 1.0) {
    updateTrexJump(state, dt);
    dropSec += dt;
  }
  assert.ok(dropSec < 0.16, `Expected speedDrop to land quickly (<0.16s), got ${dropSec}`);
  assert.equal(state.isDucking, true, 'Landing from speedDrop should transition into ducking');
});

test('runner simulate passes all criteria on all 3 songs (demo cuts) at t=0 and first drop', () => {
  const rows: Array<Record<string, string | number>> = [];

  for (const songId of SONGS) {
    const demoPath = path.resolve(process.cwd(), 'public', 'songs', songId, 'demo.json');
    const map = JSON.parse(fs.readFileSync(demoPath, 'utf-8')) as SongMap;
    const level = generateLevel(map, defaultParams);
    const firstDrop = map.drops?.[0] ?? 30;

    for (const [label, entry] of [
      ['t=0', 0],
      [`drop (${firstDrop.toFixed(1)}s)`, firstDrop],
    ] as const) {
      const until = Math.min(map.duration, entry + 45);
      const metrics = simulate({
        map,
        level,
        params: defaultParams,
        seed: 42,
        entry,
        until,
      });

      rows.push({
        song: songId,
        entry: label,
        clearRate: metrics.clearRate,
        livesLost: metrics.livesLost,
        alignMean: metrics.alignMsMean,
        alignMax: metrics.alignMsMax,
        gapViol: metrics.gapViolations,
        runwayHaz: metrics.runwayHazards,
        transSec: metrics.transitionAfterEntry,
        onPhrase: metrics.transitionOnPhrase,
        unsafeRows: metrics.unsafeRows,
        trailDmg: metrics.trailDamage,
        onBeatHopPct: metrics.onBeatHopPct,
      });

      assert.equal(metrics.clearRate, 1, `${songId} @ ${label}: clearRate must be 1`);
      assert.equal(metrics.livesLost, 0, `${songId} @ ${label}: livesLost must be 0`);
      assert.ok(metrics.alignMsMean <= 30, `${songId} @ ${label}: alignMsMean <= 30`);
      assert.ok(metrics.alignMsMax <= 60, `${songId} @ ${label}: alignMsMax <= 60`);
      assert.equal(metrics.gapViolations, 0, `${songId} @ ${label}: gapViolations must be 0`);
      assert.equal(metrics.runwayHazards, 0, `${songId} @ ${label}: runwayHazards must be 0`);
      assert.ok(
        metrics.transitionAfterEntry >= 10 && metrics.transitionAfterEntry <= 15.5,
        `${songId} @ ${label}: transitionAfterEntry (${metrics.transitionAfterEntry}) must be in [10, 15.5]`,
      );
      assert.equal(metrics.unsafeRows, 0, `${songId} @ ${label}: unsafeRows must be 0`);
      assert.equal(metrics.trailDamage, 0, `${songId} @ ${label}: trailDamage must be 0`);
    }
  }

  console.table(rows);
});

test('Phase 2 comets generate non-sequentially ahead of the dinosaur with 1-2 simultaneous cap and fast deep_scorch bursts', () => {
  for (const songId of SONGS) {
    const demoPath = path.resolve(process.cwd(), 'public', 'songs', songId, 'demo.json');
    const map = JSON.parse(fs.readFileSync(demoPath, 'utf-8')) as SongMap;
    const session = resolveRunnerSession(map, defaultParams, 42, 0, 5);

    const allComets = session.rows
      .flatMap((r) => r.comets.map((c) => ({ ...c, rowType: r.type })))
      .sort((a, b) => a.onsetTime - b.onsetTime || a.row - b.row);

    assert.ok(allComets.length >= 80, `${songId}: expected abundant staggered comets across song`);

    // Group comets by beat onsetTime (within 10ms)
    const byOnset = new Map<number, typeof allComets>();
    for (const c of allComets) {
      const key = Math.round(c.onsetTime * 100);
      const list = byOnset.get(key) ?? [];
      list.push(c);
      byOnset.set(key, list);
    }

    const onsetTimes = Array.from(byOnset.keys())
      .map((k) => k / 100)
      .sort((a, b) => a - b);

    // 1. Verify no beat EVER spawns > 2 comets simultaneously (never 4-5 at once!)
    for (const list of byOnset.values()) {
      assert.ok(
        list.length <= 2,
        `${songId}: expected at most 2 simultaneous comets on any beat, got ${list.length}`,
      );
      if (list.length === 2) {
        assert.ok(
          Math.abs(list[0].row - list[1].row) >= 2,
          `${songId}: 2 simultaneous comets on a downbeat/drop must be at least 2 lanes apart`,
        );
      }
    }

    // 2. Verify no multi-second silent gaps and verify NON-SEQUENTIAL row selection
    const beatPeriod = 60 / (map.bpm || 120);
    let maxInterCometGap = 0;
    let consecutiveDistinctRows = 0;
    let nonSequentialSteps = 0;
    let prevPrimaryRow = -1;

    for (let i = 0; i < onsetTimes.length; i++) {
      const list = byOnset.get(Math.round(onsetTimes[i] * 100))!;
      const curRow = list[0].row;
      if (curRow !== prevPrimaryRow) {
        consecutiveDistinctRows++;
      }
      if (i > 0 && curRow !== prevPrimaryRow + 1) {
        nonSequentialSteps++;
      }
      prevPrimaryRow = curRow;

      if (i > 0 && onsetTimes[i] <= map.duration) {
        const gap = onsetTimes[i] - onsetTimes[i - 1];
        if (gap > maxInterCometGap) maxInterCometGap = gap;
      }
    }

    assert.ok(
      maxInterCometGap <= beatPeriod * 2.25,
      `${songId}: expected no multi-second comet dead zones (max gap ${maxInterCometGap.toFixed(2)}s > ${(beatPeriod * 2.25).toFixed(2)}s)`,
    );
    assert.ok(
      consecutiveDistinctRows / onsetTimes.length >= 0.92,
      `${songId}: expected consecutive beats to pick distinct rows`,
    );
    assert.ok(
      nonSequentialSteps / Math.max(1, onsetTimes.length - 1) >= 0.85,
      `${songId}: expected comet row selection to be non-sequential rather than row-by-row (r, r+1, r+2)`,
    );

    // 3. Verify deep_scorch comets travel faster than scorched_earth comets
    const deepComets = allComets.filter((c) => c.rowType === 'deep_scorch');
    const normalComets = allComets.filter((c) => c.rowType === 'scorched_earth');
    assert.ok(deepComets.length > 0, `${songId}: expected deep_scorch fast-burst comets`);
    const avgDeepSpeed = deepComets.reduce((s, c) => s + c.speed, 0) / deepComets.length;
    const avgNormalSpeed = normalComets.reduce((s, c) => s + c.speed, 0) / normalComets.length;
    assert.ok(
      avgDeepSpeed > avgNormalSpeed * 1.15,
      `${songId}: expected deep_scorch burst speed (${avgDeepSpeed.toFixed(2)}) > scorched_earth steady speed (${avgNormalSpeed.toFixed(2)})`,
    );
  }
});

test('fast-jumping dinosaur in Phase 2 never outruns comet generation and 3D camera scroll speed is significantly increased while 2D speed is unchanged', () => {
  assert.equal(defaultParams.scrollSpeed2D, 9.0, '2D runner scroll speed must remain untouched at 9.0');
  assert.ok(
    defaultParams.scrollRowsPerBeat >= 1.1,
    `3D crossing camera scroll speed (scrollRowsPerBeat) must be significantly increased (>= 1.1, got ${defaultParams.scrollRowsPerBeat})`,
  );

  const demoPath = path.resolve(process.cwd(), 'public', 'songs', 'ctd', 'demo.json');
  const map = JSON.parse(fs.readFileSync(demoPath, 'utf-8')) as SongMap;
  const session = resolveRunnerSession(map, defaultParams, 42, 0, 5);
  const state = createRunnerSimState(map, defaultParams, session, map.duration);

  const dt = 1 / 120;
  // Simulate rapid forward hopping in Phase 2 (faster than camera scroll) for 15 seconds
  const startT = session.transitionEndTime + 0.1;
  const endT = Math.min(map.duration - 2, startT + 15.0);

  for (let t = startT; t <= endT; t += dt) {
    // Keep dinosaur invincible so we purely test rapid forward sprinting (hopping every 0.14s)
    state.invulnUntil = t + 5.0;
    const nextRow = session.rows[state.gridRow + 1];
    let hopDir: 'forward' | 'left' | 'right' = 'forward';
    if (nextRow?.type === 'grass' && nextRow.blockers.some((b) => b.col === state.gridCol)) {
      hopDir = state.gridCol > 4 ? 'left' : 'right';
    }
    stepRunnerSim(state, dt, t, { hopDir });

    // Once past firstCometAllowedTime, verify there are ALWAYS upcoming comets scheduled ahead of state.gridRow
    const firstAllowed = session.firstCometAllowedTime ?? session.transitionEndTime + 3.0;
    if (t >= firstAllowed + 0.5) {
      let aheadCometCount = 0;
      for (let r = state.gridRow + 1; r <= state.gridRow + 14 && r < session.rows.length; r++) {
        const rowData = session.rows[r];
        if (!rowData) continue;
        for (const c of rowData.comets) {
          if (c.onsetTime >= t - 0.1 && c.onsetTime <= t + 3.8) {
            aheadCometCount++;
          }
        }
      }
      assert.ok(
        aheadCometCount >= 3,
        `At t=${t.toFixed(2)}s with fast-jumping dino at row ${state.gridRow}, expected comets ahead of dino, got ${aheadCometCount}`,
      );
    }
  }

  // Verify the fast-jumping dinosaur advanced many rows (> 70 rows in 15s) and camera kept scrolling
  assert.ok(
    state.gridRow >= 70,
    `Expected fast-jumping dino to reach row >= 70 in 15s, reached ${state.gridRow}`,
  );
  assert.ok(
    state.cameraRow >= state.gridRow - 3.0,
    `Expected 3D cameraRow (${state.cameraRow.toFixed(2)}) to keep up with fast-jumping dino (${state.gridRow})`,
  );
});

