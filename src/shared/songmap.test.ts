import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beatAt,
  beatPhase,
  buildPhrases,
  downsampleWaveform,
  energyAt,
  nearestBeat,
  nearestDownbeat,
  nextPhraseIn,
  onsetsIn,
  projectSemanticsToDemo,
  scoreOnBeat,
  sectionAt,
  snapToCandidateOrDownbeat,
  type DspOutput,
} from './songmap';
import { DEFAULT_FIXTURE_SONG_MAP } from './fixtures/defaultSongMap';
import type { SongMap } from '../shell/api';

test('snapToCandidateOrDownbeat snaps within 50ms to candidate, else to nearest downbeat', () => {
  const candidates = [0, 16.0, 32.0, 64.0];
  const downbeats = [0, 2.0, 4.0, 6.0, 8.0, 16.0, 24.0, 32.0];

  assert.equal(snapToCandidateOrDownbeat(16.03, candidates, downbeats, 0.05), 16.0);
  assert.equal(snapToCandidateOrDownbeat(23.7, candidates, downbeats, 0.05), 24.0);
});

test('buildPhrases combines every 4th downbeat and section starts without duplicates', () => {
  const downbeats = [0.5, 2.5, 4.5, 6.5, 8.5, 10.5, 12.5, 14.5, 16.5];
  const sectionStarts = [0.0, 8.52, 12.5];
  const phrases = buildPhrases(downbeats, sectionStarts);
  assert.deepEqual(phrases, [0, 0.5, 8.5, 12.5, 16.5]);
});

test('downsampleWaveform produces exact target length with max pooling', () => {
  const peaks = [0.1, 0.9, 0.2, 0.4, 0.8, 0.3, 0.5, 0.7];
  const down = downsampleWaveform(peaks, 4);
  assert.equal(down.length, 4);
  assert.deepEqual(down, [0.9, 0.4, 0.8, 0.7]);
});

test('songmap runtime helpers: beatAt, nearestBeat, beatPhase, sectionAt, nextPhraseIn, nearestDownbeat, energyAt, onsetsIn, scoreOnBeat', () => {
  const map = DEFAULT_FIXTURE_SONG_MAP;
  // Beats are every 0.5s: 0, 0.5, 1.0, 1.5, 2.0 ...
  assert.equal(beatAt(map, 0), 0);
  assert.equal(beatAt(map, 1.24), 2);
  assert.equal(nearestBeat(map, 1.22), 1.0);
  assert.equal(nearestBeat(map, 1.26), 1.5);

  const ph = beatPhase(map, 1.25);
  assert.ok(Math.abs(ph - 0.5) < 1e-6);

  const sec0 = sectionAt(map, 5.0);
  assert.equal(sec0.label, 'intro');
  const sec2 = sectionAt(map, 50.0);
  assert.equal(sec2.label, 'drop');

  assert.equal(nextPhraseIn(map, 7.0, 9.0), 8.0);
  assert.equal(nextPhraseIn(map, 8.1, 10.0), null);

  assert.equal(nearestDownbeat(map, 3.8), 4.0);

  const e = energyAt(map, 10.0);
  assert.ok(e >= 0 && e <= 1);

  const lowOnsets = onsetsIn(map, 'low', 1.0, 5.0);
  assert.equal(lowOnsets.length, 2);
  assert.ok(lowOnsets.every((o) => o.t >= 1.0 && o.t <= 5.0));

  const perf = scoreOnBeat(map, 2.03); // 30ms off beat 2.0
  assert.equal(perf.points, 100);
  assert.equal(perf.label, 'PERFECT');
  assert.equal(perf.onBeat, true);

  const good = scoreOnBeat(map, 2.08); // 80ms off beat 2.0
  assert.equal(good.points, 50);
  assert.equal(good.label, 'GOOD');
  assert.equal(good.onBeat, true);

  const miss = scoreOnBeat(map, 2.25); // 250ms off beat
  assert.equal(miss.points, 0);
  assert.equal(miss.label, 'MISS');
  assert.equal(miss.onBeat, false);
});

test('projectSemanticsToDemo shifts times by -windowStart and snaps to demo grid', () => {
  const fullMap: SongMap = {
    id: 'test',
    title: 'Test Track',
    file: '/songs/test/full.mp3',
    duration: 200,
    bpm: 120,
    beats: [0, 0.5, 1.0],
    downbeats: [0, 2, 4, 6, 8],
    phrases: [0, 8],
    onsets: { low: [], mid: [], high: [] },
    envelope: { hop: 0.05, energy: [0.3, 0.6, 0.9], low: [0.3], mid: [0.5], high: [0.4] },
    waveform: { hop: 0.01, peaks: [0.5, 0.8] },
    melody: [],
    sections: [
      { start: 0, end: 30, label: 'intro', energy: 0.2, mood: 'hazy' },
      { start: 30, end: 70, label: 'build', energy: 0.6, mood: 'tense' },
      { start: 70, end: 130, label: 'drop', energy: 0.95, mood: 'explosive' },
      { start: 130, end: 200, label: 'outro', energy: 0.3, mood: 'calm' },
    ],
    drops: [70],
    palette: {
      bg: '#090a0f',
      primary: '#38bdf8',
      secondary: '#a855f7',
      accent: '#f59e0b',
      highlight: '#f8fafc',
      perSection: [
        { bg: '#090a0f', primary: '#38bdf8', secondary: '#a855f7', accent: '#f59e0b', highlight: '#f8fafc' },
        { bg: '#100a1f', primary: '#ec4899', secondary: '#a855f7', accent: '#f59e0b', highlight: '#f8fafc' },
        { bg: '#1a0910', primary: '#ef4444', secondary: '#f97316', accent: '#facc15', highlight: '#ffffff' },
        { bg: '#09141a', primary: '#14b8a6', secondary: '#38bdf8', accent: '#a855f7', highlight: '#f8fafc' },
      ],
    },
    rail: {
      districts: [
        { section: 0, district: 'outskirts' },
        { section: 1, district: 'approach' },
        { section: 2, district: 'neon_core' },
        { section: 3, district: 'sunrise' },
      ],
    },
    demoWindow: { start: 20, end: 120 },
  };

  const demoDsp: DspOutput = {
    duration: 100,
    bpm: 120,
    beats: [0, 0.5, 1.0],
    downbeats: [0, 10, 20, 50, 80, 100],
    phrases: [0, 20, 80],
    onsets: { low: [], mid: [], high: [] },
    envelope: { hop: 0.05, energy: new Array(2000).fill(0.75), low: [], mid: [], high: [] },
    waveform: { hop: 0.01, peaks: [0.5] },
    melody: [],
    sectionCandidates: [
      { start: 0, end: 10, energy: 0.3, onsetDensity: 1.2 },
      { start: 10, end: 50, energy: 0.6, onsetDensity: 2.5 },
      { start: 50, end: 100, energy: 0.9, onsetDensity: 4.1 },
    ],
    dropCandidates: [{ t: 50, energyRise: 0.3, preEnergy: 0.6, postEnergy: 0.9 }],
  };

  const projected = projectSemanticsToDemo(fullMap, demoDsp, 20);
  assert.equal(projected.sections.length, 3);
  assert.equal(projected.sections[0].start, 0);
  assert.equal(projected.sections[1].start, 10);
  assert.equal(projected.sections[1].label, 'build');
  assert.equal(projected.sections[2].start, 50);
  assert.equal(projected.sections[2].label, 'drop');
  assert.equal(projected.sections[2].end, 100);
  assert.deepEqual(projected.drops, [50]);
});
