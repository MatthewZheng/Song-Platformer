AGENTS.md: Song Arcade (working title)
What we're building
Song Arcade turns any song into four games that were designed and playtested for that song.
The song plays once, start to end, and never pauses. The player starts in Runner. Each death plays
a short death animation, a hyperspace jump, and drops the player into the next game while the music
keeps going. Order: runner -> horror -> tiles -> rail -> runner ... When the song ends, a results
screen shows the score and Argon's playtest report for that song.

Each game reads a different layer of the song:

runner: the beat (obstacles and traffic land on onsets)
horror: the structure (hunts start on section changes; the music IS the monster)
tiles: the melody (lanes follow melody direction; peaks and valleys drive the background)
rail: the energy (enemy density, bullet patterns and city districts follow intensity and sections)
Who it's for
Primary: a player whose favorite song isn't in any rhythm game. Pick a song, play it.
Growth: indie artists shipping a playable single; rhythm-game mappers getting a playtested first draft.

How this is judged (optimize for it)
Gemini 4 Argon SF Hackathon, Problem Statement Two: build a system that renders what it made,
watches the result, critiques it against the goal, and fixes it in a loop.

Working live demo (50%): runs live with real inputs; uses gemini-4-argon and companion models
effectively; has a real verification loop.

Problem and usefulness (25%).
Originality (15%): only possible because of Argon's 1M context, long decode, reasoning, multimodal.
Pitch clarity (10%): 3-minute live demo, no slides.
Implications: never crash on stage; every game must visibly react to the song within seconds;
the loop must leave evidence in the app (before/after metrics, changelog, playtest video).

Hard constraints
Deadline: [DEADLINE, e.g. 4:58 PM PT today]. Solo developer. A working first draft of every
part beats a polished version of one part.

Desktop web app in Chrome, keyboard and mouse, 1920x1080 and 1280x720. No mobile.
Play must work offline once songs are analyzed. Only analysis and the playtest loop call the API.
Original art only. No copied or traced sprites, characters, logos or real brand names.
The runner hero is an original pixel dinosaur wearing headphones. The horror monster is original.

60 fps target on a laptop GPU. Never block the main thread for more than 4 ms.
Stack
Vite + TypeScript. Three.js for all four games. Plain DOM overlays, no React.
Web Audio API, one AudioContext, one continuous song source.
Python 3.10+ (librosa, numpy, soundfile) for offline song analysis in analysis/.
Node 20+ scripts in scripts/: @google/genai >= 2.3.0 on the Interactions API, Playwright for
the playtest harness, ffmpeg for cutting audio and muxing audio onto playtest video, sharp for images.

Use the gemini-api-dev skill for all Gemini API code. Use thinking_level. Never use temperature,
top_p, top_k, thinking_budget or explicit cached_content with gemini-4-argon.

Models
gemini-4-argon: song semantics, level critique and patches, per-song code slots.
gemini-3.8-flash: optional cheap pre-checks on playtest frames (blank screen, unreadable HUD).
gemini-nano-banana-2.1: monster sprites and jumpscare art.
Repo layout
songs/ raw mp3s (input, any names)
analysis/ analyze.py (DSP), requirements.txt
scripts/ analyze.ts, semantic.ts, gen-monster.ts, playtest.ts, critique.ts
public/songs/<id>/ full.mp3, demo.mp3, full.json, demo.json, levels/<game>.json
public/assets/monster/ processed monster PNGs
public/reports/<id>/ report.json, <game>/iter-N/{metrics.json, critique.json, video.mp4}
src/shell/ api.ts, config.ts, clock, audio fx, switcher, hyperspace, runway, hud, results, devpanel
src/shared/ songmap helpers, seeded rng, pixel and voxel utils, palette utils
src/games/<game>/ index.ts (module), level.ts (generateLevel, defaultParams), sim.ts, bot.ts
src/slots/<song>/ per-song generated code slots

Song map (public/songs/<id>/demo.json and full.json)
Times are seconds from the start of the matching audio file.

id, title, file, duration, bpm
beats[]; downbeats[] (bar starts); phrases[] (every 4 bars from the first downbeat, plus
section starts, deduplicated)

onsets: { low[], mid[], high[] } of { t, s } with s = strength 0..1
envelope: { hop: 0.05, energy[], low[], mid[], high[] }, values 0..1
waveform: { hop: 0.01, peaks[] }, values 0..1, for drawing
melody[]: { t, dir: -1 | 0 | 1, pc: 0..11 } at mid and high onsets
sections[]: { start, end, label: intro|verse|build|drop|breakdown|bridge|outro, energy, mood }
drops[]
palette: { bg, primary, secondary, accent, highlight } as hex, plus perSection[] of the same shape
rail: { districts[]: { section, district: outskirts|approach|neon_core|rain_rooftops|sunrise } }
demoWindow: { start, end } in full-file seconds
Rule: Argon never invents timestamps. Semantic labels pick from DSP candidates, and every time is
snapped to the beat grid.

Runtime contract (src/shell/api.ts)
BEGIN api.ts
export type GameId = 'runner' | 'horror' | 'tiles' | 'rail';
export interface ControlHint { keys: string[]; label: string }
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
id: GameId; title: string; listensTo: string; controls: ControlHint[];
preload(ctx: GameContext): Promise<void>; // once per run, at song start
enter(songTime: number): void; // becomes active; may be entered many times per run
update(dt: number, songTime: number): void;
render(): void;
exit(): void; // stop sounds, release pointer lock and input
getMetrics(): Record<string, number>;
}
Each game folder also exports:
generateLevel(map, params, rng) -> level (pure data for the whole song)
defaultParams and paramRanges (numbers the loop may tune)
simulate({ map, level, params, seed, entry, until }) -> metrics (rules + bot, no rendering,
fixed 1/120 s step)
END api.ts

Flow and timing (src/shell/config.ts)
ORDER = ['runner', 'horror', 'tiles', 'rail'], looping. Rail is removed if it gets cut.
Death: the game plays its own death animation (max 1.0 s), then emits death.
READJUST = 1.0 s: the hyperspace jump plays, with 'Next: <TITLE> / Listening to: <listensTo>'.
RUNWAY = 5.0 s from enter: no hazards, control card on screen, each control ticks off when used,
runway ends early once every control has been tried (minimum 2.0 s).

The song never pauses or restarts during a run. Song end: fade 0.5 s, then results.
Scoring
One currency. On-beat actions: within 50 ms of a beat = 100, within 100 ms = 50. Survival = 10 points
per second. Each game spec lists its own bonuses. Results show total, per-game score, on-beat %,
deaths and games reached.

What Argon generates per song
Data: params and level edits per game, saved to public/songs/<id>/levels/<game>.json.
Code slots, each with a fixed signature and a working default:
tiles.backgroundShader (GLSL fragment, fixed uniforms) and rail.formation (function).

Load order for slots: generated -> validate (compiles, typechecks, runs in try/catch within 2 ms)
-> on any failure use the default and log it. A broken slot must never break a run.

Playtest hooks
URL params: ?song=<id>&cut=demo|full&game=<id>&t=<entry seconds>&bot=1&seed=<n>
window.__playtest = { ready, startedAtSongTime, songTime, metrics, events } for Playwright.
Headless Chrome needs --autoplay-policy=no-user-gesture-required. Playwright video has no audio,
so the harness muxes the song onto the video with ffmpeg using startedAtSongTime.

Conventions
Everything time-based reads clock.now(). Never Date.now() or frame counts.
A game imports only from src/shell/api.ts and src/shared/. No game imports another game.
Every level and sim is deterministic for a given seed.
Dev panel on the backtick key (hidden in the demo build): song time, BPM, section, game, FPS,
buttons to jump to any game or time, audio latency offset slider.

Commit after each working step.
Lessons
When you hit a non-obvious setup or build quirk, add one line here: the quirk and the fix.
- `python3 -m venv .venv` fails without `python3-venv` (`ensurepip`), and symlinking `/usr/local/bin/python` to `.venv/bin/python` breaks `pyvenv.cfg` lookup: create the venv with `python3 -m venv --without-pip .venv`, bootstrap pip via `get-pip.py`, and use a shell wrapper (`exec /app/applet/.venv/bin/python "$@"`) at `/usr/local/bin/python`.
- Container `/ms-playwright` ships `chromium_headless_shell-1247` while `playwright@1.64.1` expects `v1248`: run `npx playwright install chromium --only-shell` so Playwright scripts resolve the matching headless shell and ffmpeg binaries.
- Environment variables are injected into the shell process rather than a pre-existing `.env` file, and `.git` is not pre-initialized: write `GEMINI_API_KEY` from env to `.env` for `dotenv`-based scripts and initialize git (`git init` + local user config) before committing.