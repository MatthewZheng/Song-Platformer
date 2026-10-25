import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER,
  DEATH_MAX_SEC,
  READJUST,
  RUNWAY,
  RUNWAY_MIN_EARLY,
  SONG_END_FADE_SEC,
  SCORING,
} from './config';

test('game rotation order matches AGENTS.md contract (3 core games)', () => {
  assert.deepEqual(ORDER, ['runner', 'horror', 'tiles']);
});

test('flow and timing constants match AGENTS.md specification', () => {
  assert.equal(DEATH_MAX_SEC, 1.0);
  assert.equal(READJUST, 1.0);
  assert.equal(RUNWAY, 5.0);
  assert.equal(RUNWAY_MIN_EARLY, 2.0);
  assert.equal(SONG_END_FADE_SEC, 0.5);
});

test('scoring currency rules match AGENTS.md specification', () => {
  assert.equal(SCORING.ON_BEAT_PERFECT_MS, 50);
  assert.equal(SCORING.ON_BEAT_PERFECT_PTS, 100);
  assert.equal(SCORING.ON_BEAT_GOOD_MS, 100);
  assert.equal(SCORING.ON_BEAT_GOOD_PTS, 50);
  assert.equal(SCORING.SURVIVAL_PTS_PER_SEC, 10);
});
