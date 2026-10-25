export type GameId = 'runner' | 'horror' | 'tiles' | 'rail';

export interface ControlHint {
  keys: string[];
  label: string;
}

export interface OnsetPoint {
  t: number;
  s: number;
}

export interface MelodyPoint {
  t: number;
  dir: -1 | 0 | 1;
  pc: number;
}

export type SectionLabel =
  | 'intro'
  | 'verse'
  | 'build'
  | 'drop'
  | 'breakdown'
  | 'bridge'
  | 'outro';

export interface SongSection {
  start: number;
  end: number;
  label: SectionLabel;
  energy: number;
  mood: string;
}

export interface Palette {
  bg: string;
  primary: string;
  secondary: string;
  accent: string;
  highlight: string;
}

export type RailDistrictType =
  | 'outskirts'
  | 'approach'
  | 'neon_core'
  | 'rain_rooftops'
  | 'sunrise';

export interface RailDistrictEntry {
  section: number;
  district: RailDistrictType;
}

export interface SongMap {
  id: string;
  title: string;
  file: string;
  duration: number;
  bpm: number;
  beats: number[];
  downbeats: number[];
  phrases: number[];
  onsets: {
    low: OnsetPoint[];
    mid: OnsetPoint[];
    high: OnsetPoint[];
  };
  envelope: {
    hop: number;
    energy: number[];
    low: number[];
    mid: number[];
    high: number[];
  };
  waveform: {
    hop: number;
    peaks: number[];
  };
  melody: MelodyPoint[];
  sections: SongSection[];
  drops: number[];
  palette: Palette & {
    perSection: Palette[];
  };
  rail: {
    districts: RailDistrictEntry[];
  };
  demoWindow: {
    start: number;
    end: number;
  };
}

export interface SongClock {
  now(): number;
}

export interface AudioFx {
  lowpass(hz: number, rampSec: number): void;
  gain(g: number, rampSec: number): void;
  reset(): void;
}

export interface LiveBands {
  low: number;
  mid: number;
  high: number;
  energy: number;
}

export interface PaletteSource {
  at(songTime: number): Palette;
}

export interface SlotRegistry {
  tiles: {
    backgroundShader: string;
  };
  rail: {
    formation: (t: number, index: number, count: number) => { x: number; y: number; z: number };
  };
}

export interface GameContext {
  root: HTMLElement; // the game's own container; create your own canvas inside it
  map: SongMap; // parsed song map for the audio being played
  clock: SongClock; // clock.now() = song time in seconds, latency-compensated
  fx: AudioFx; // lowpass(hz, rampSec), gain(g, rampSec), reset()
  bands: LiveBands; // real-time { low, mid, high, energy } 0..1 from an AnalyserNode
  palette: PaletteSource; // palette.at(songTime) gives the current section palette
  level: unknown; // this song's generated level data for this game
  slots: SlotRegistry; // per-song code slots; every slot has a working default
  rng: () => number; // seeded; use for all randomness
  safeUntil: number; // song time before which no hazard may exist (entry + runway)
  bot: boolean; // true when the playtest harness drives the game
  emit(e: GameEvent): void;
}

export type GameEvent =
  | { type: 'score'; points: number; onBeat?: boolean; label?: string }
  | { type: 'lifeLost'; livesLeft: number }
  | { type: 'death' } // emitted after the game's own death animation (max 1.0 s)
  | { type: 'metric'; key: string; value: number };

export interface GameModule {
  id: GameId;
  title: string;
  listensTo: string;
  controls: ControlHint[];
  preload(ctx: GameContext): Promise<void>; // once per run, at song start
  enter(songTime: number): void; // becomes active; may be entered many times per run
  update(dt: number, songTime: number): void;
  render(): void;
  exit(): void; // stop sounds, release pointer lock and input
  getMetrics(): Record<string, number>;
}
