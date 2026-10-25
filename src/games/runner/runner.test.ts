import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SongMap } from '../../shell/api';
import { bpmToStartingHue, buildProgressedSwatchPalette } from '../../shared/palette';
import { defaultParams, generateLevel, simulate } from './index';
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
