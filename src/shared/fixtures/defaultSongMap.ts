import type { SongMap } from '../../shell/api';

export function createFixtureSongMap(id = 'fixture', duration = 100, bpm = 120): SongMap {
  const beatPeriod = 60 / bpm;
  const beats: number[] = [];
  for (let t = 0; t <= duration; t += beatPeriod) {
    beats.push(Math.round(t * 1000) / 1000);
  }
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const phrases = downbeats.filter((_, i) => i % 4 === 0);

  const onsetsLow = downbeats.map((t) => ({ t, s: 0.85 }));
  const onsetsMid = beats.filter((_, i) => i % 2 === 1).map((t) => ({ t, s: 0.7 }));
  const onsetsHigh = beats.map((t) => ({ t, s: 0.5 }));

  const nEnv = Math.ceil(duration / 0.05);
  const energy = Array.from({ length: nEnv }, (_, i) => {
    const t = i * 0.05;
    return t >= 40 && t < 75 ? 0.85 : 0.45;
  });

  const nWf = Math.ceil(duration / 0.01);
  const peaks = Array.from({ length: nWf }, (_, i) => {
    const t = i * 0.01;
    return Math.min(1, Math.max(0.1, 0.5 + 0.35 * Math.sin(t * 3.14)));
  });

  return {
    id,
    title: 'Synthetic Fixture Track',
    file: `/songs/${id}/demo.mp3`,
    duration,
    bpm,
    beats,
    downbeats,
    phrases,
    onsets: {
      low: onsetsLow,
      mid: onsetsMid,
      high: onsetsHigh,
    },
    envelope: {
      hop: 0.05,
      energy,
      low: energy,
      mid: energy,
      high: energy,
    },
    waveform: {
      hop: 0.01,
      peaks,
    },
    melody: onsetsMid.map((o, idx) => ({
      t: o.t,
      dir: ((idx % 3) - 1) as -1 | 0 | 1,
      pc: idx % 12,
    })),
    sections: [
      { start: 0, end: 20, label: 'intro', energy: 0.35, mood: 'calm' },
      { start: 20, end: 40, label: 'build', energy: 0.6, mood: 'rising' },
      { start: 40, end: 75, label: 'drop', energy: 0.9, mood: 'explosive' },
      { start: 75, end: duration, label: 'outro', energy: 0.4, mood: 'warm' },
    ],
    drops: [40],
    palette: {
      bg: '#090a10',
      primary: '#38bdf8',
      secondary: '#a855f7',
      accent: '#f59e0b',
      highlight: '#f8fafc',
      perSection: [
        { bg: '#080b14', primary: '#38bdf8', secondary: '#6366f1', accent: '#22d3ee', highlight: '#f0f9ff' },
        { bg: '#12091c', primary: '#c084fc', secondary: '#ec4899', accent: '#f97316', highlight: '#fdf4ff' },
        { bg: '#18070f', primary: '#f43f5e', secondary: '#f97316', accent: '#facc15', highlight: '#ffffff' },
        { bg: '#0b0f17', primary: '#fb923c', secondary: '#38bdf8', accent: '#fde047', highlight: '#fffbeb' },
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
    demoWindow: {
      start: 0,
      end: duration,
    },
  };
}

export const DEFAULT_FIXTURE_SONG_MAP: SongMap = createFixtureSongMap();

