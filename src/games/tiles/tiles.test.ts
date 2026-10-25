import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SongMap } from '../../shell/api';
import { createRng } from '../../shared/rng';
import { defaultParams, generateLevel } from './level';
import { simulate, TilesSimEngine } from './sim';

const SONG_IDS = ['ctd', 'fb', 'ra'] as const;

function loadSongMap(songId: string): SongMap {
  const p = path.resolve(process.cwd(), `public/songs/${songId}/demo.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as SongMap;
}

function loadSongShader(songId: string): string {
  const p = path.resolve(process.cwd(), `src/slots/${songId}/tiles.backgroundShader.glsl`);
  return fs.readFileSync(p, 'utf8');
}

test('simulate tiles across all 3 songs meets all pass targets and prints metrics table', () => {
  const tableRows: Array<Record<string, string | number>> = [];

  for (const songId of SONG_IDS) {
    const map = loadSongMap(songId);
    const shaderSource = loadSongShader(songId);
    const level = generateLevel(map, defaultParams, createRng(42));
    const m = simulate({
      map,
      level,
      params: defaultParams,
      seed: 42,
      entry: 0,
      until: map.duration,
      shaderSource,
    });

    // Save generated level JSON to public/songs/<id>/levels/tiles.json
    const levelDir = path.resolve(process.cwd(), `public/songs/${songId}/levels`);
    fs.mkdirSync(levelDir, { recursive: true });
    fs.writeFileSync(path.join(levelDir, 'tiles.json'), JSON.stringify(level, null, 2));

    tableRows.push({
      song: songId,
      notes: level.notes.length,
      alignMsMean: m.alignMsMean,
      alignMsMax: m.alignMsMax,
      gridSnapPct: m.gridSnapPct,
      maxNps: `${m.maxNps}/${m.maxNpsCap}`,
      sameLaneGapViolations: m.sameLaneGapViolations,
      runwayNotes: m.runwayNotes,
      densityEnergyCorr: m.densityEnergyCorr,
      botPerfectPct: m.botPerfectPct,
      shaderCompiled: m.shaderCompiled,
      avgFps: m.avgFps,
    });

    assert.ok(m.alignMsMean <= 20, `${songId}: alignMsMean ${m.alignMsMean} must be <= 20`);
    assert.ok(m.alignMsMax <= 50, `${songId}: alignMsMax ${m.alignMsMax} must be <= 50`);
    assert.equal(
      m.sameLaneGapViolations,
      0,
      `${songId}: sameLaneGapViolations must be 0`,
    );
    assert.equal(m.runwayNotes, 0, `${songId}: runwayNotes must be 0`);
    assert.ok(
      m.densityEnergyCorr >= 0.5,
      `${songId}: densityEnergyCorr ${m.densityEnergyCorr} must be >= 0.5`,
    );
    assert.ok(
      m.maxNps <= m.maxNpsCap,
      `${songId}: maxNps ${m.maxNps} must be <= ${m.maxNpsCap}`,
    );
    assert.equal(m.shaderCompiled, 1, `${songId}: shaderCompiled must be 1`);
    assert.ok(m.avgFps >= 55, `${songId}: avgFps ${m.avgFps} must be >= 55`);
  }

  console.table(tableRows);
});

test('TilesSimEngine enforces PERFECT (50ms), GOOD (100ms), MISS (>100ms), no-penalty empty presses, and death on 5th miss', () => {
  const map = loadSongMap('ctd');
  const level = {
    params: defaultParams,
    eighthNoteSec: 0.25,
    notes: [
      { id: 1, t: 6.0, lane: 0, strength: 0.8, sourceOnsetT: 6.0, alignMs: 0, snapped: true, isChord: false, melodyDir: 0 as const },
      { id: 2, t: 7.0, lane: 1, strength: 0.8, sourceOnsetT: 7.0, alignMs: 0, snapped: true, isChord: false, melodyDir: 1 as const },
      { id: 3, t: 8.0, lane: 2, strength: 0.8, sourceOnsetT: 8.0, alignMs: 0, snapped: true, isChord: false, melodyDir: 1 as const },
      { id: 4, t: 9.0, lane: 3, strength: 0.8, sourceOnsetT: 9.0, alignMs: 0, snapped: true, isChord: false, melodyDir: 1 as const },
      { id: 5, t: 10.0, lane: 0, strength: 0.8, sourceOnsetT: 10.0, alignMs: 0, snapped: true, isChord: false, melodyDir: -1 as const },
      { id: 6, t: 11.0, lane: 1, strength: 0.8, sourceOnsetT: 11.0, alignMs: 0, snapped: true, isChord: false, melodyDir: 1 as const },
      { id: 7, t: 12.0, lane: 2, strength: 0.8, sourceOnsetT: 12.0, alignMs: 0, snapped: true, isChord: false, melodyDir: 1 as const },
    ],
  };

  let deathEmitted = false;
  const sim = new TilesSimEngine({
    map,
    level,
    safeUntil: 5.0,
    emit: (e) => {
      if (e.type === 'death') deathEmitted = true;
    },
  });

  // Empty press at 5.2s costs nothing
  assert.equal(sim.pressLane(0, 5.2), null);
  assert.equal(sim.misses, 0);

  // Note 1 at 6.0s hit at 6.03s -> PERFECT (+100)
  assert.equal(sim.pressLane(0, 6.03), 'PERFECT');
  assert.equal(sim.perfectHits, 1);

  // Note 2 at 7.0s hit at 7.08s -> GOOD (+50)
  assert.equal(sim.pressLane(1, 7.08), 'GOOD');
  assert.equal(sim.goodHits, 1);

  // Let notes 3..7 pass by > 100ms -> 5 misses -> dying -> death emitted after 0.85s
  sim.step(0.05, 8.2, []);
  assert.equal(sim.misses, 1);
  assert.equal(sim.uDesat > 0.4, true);
  sim.step(0.05, 9.2, []);
  sim.step(0.05, 10.2, []);
  sim.step(0.05, 11.2, []);
  sim.step(0.05, 12.2, []);
  assert.equal(sim.misses, 5);
  assert.equal(sim.dying, true);

  sim.step(0.9, 13.1, []);
  assert.equal(deathEmitted, true);
});
