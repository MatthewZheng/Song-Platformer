import type {
  GameContext,
  GameEvent,
  GameId,
  GameModule,
  Palette,
  SongMap,
} from './api';
import {
  ORDER,
  READJUST,
  RUNWAY,
  SCORING,
  SONG_END_FADE_SEC,
} from './config';
import { createAudioEngine } from './clock';
import { createDevPanel } from './devpanel';
import { createPlayHud } from './hud';
import { createHyperspaceOverlay } from './hyperspace';
import {
  createResultsScreen,
  type DeathMarker,
  type PerGameRunStats,
  type RunSummary,
} from './results';
import { createRunwayCard } from './runway';
import { validateSlotRegistry } from './slots';
import { DEFAULT_FIXTURE_SONG_MAP } from '../shared/fixtures/defaultSongMap';
import { createPaletteSource } from '../shared/palette';
import { drawPixelText } from '../shared/pixel';
import { createRng, hashString } from '../shared/rng';
import { createRunnerGame } from '../games/runner';
import { createHorrorGame } from '../games/horror';
import { createTilesGame } from '../games/tiles';
import { createRailGame } from '../games/rail';

export interface SongIndexEntry {
  id: string;
  title: string;
  bpm: number;
  duration: number;
  demoDuration: number;
  demoWindow: { start: number; end: number };
  palette: Palette;
  waveform: number[];
}

export interface PlaytestState {
  ready: boolean;
  startedAtSongTime: number;
  songTime: number;
  metrics: Record<string, number>;
  events: Array<GameEvent & { t: number; game: GameId }>;
}

declare global {
  interface Window {
    __playtest?: PlaytestState;
  }
}

type ScreenState = 'title' | 'select' | 'loading' | 'play' | 'results';

type PlayPhase =
  | { kind: 'active' }
  | { kind: 'hyperspace'; elapsed: number; nextGameId: GameId }
  | { kind: 'fadingOut'; elapsed: number };

const isSoftwareGl = (() => {
  if (typeof document === 'undefined') return true;
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
})();

const afterDraw = (): Promise<void> =>
  isSoftwareGl
    ? new Promise((r) => setTimeout(r, 16))
    : new Promise((r) => requestAnimationFrame(() => r()));

export function createShellApp(root: HTMLElement): void {
  root.innerHTML = '';
  root.className = 'relative h-screen w-screen overflow-hidden bg-[#090a10] text-slate-100 select-none font-mono';

  const urlParams = new URLSearchParams(window.location.search);
  const paramSong = urlParams.get('song');
  const paramCut = urlParams.get('cut') === 'full' ? 'full' : urlParams.get('cut') === 'demo' ? 'demo' : null;
  const paramGame = urlParams.get('game') as GameId | null;
  const paramEntrySec = Number(urlParams.get('t') ?? '0') || 0;
  const paramBot = urlParams.get('bot') === '1' || urlParams.get('bot') === 'true';
  const paramSeed = urlParams.get('seed') ? Number(urlParams.get('seed')) : null;
  const hasAutoStartParams = Boolean(paramGame || paramBot || urlParams.get('autostart') === '1');

  // Initialize global playtest hook
  const playtest: PlaytestState = {
    ready: false,
    startedAtSongTime: paramEntrySec,
    songTime: paramEntrySec,
    metrics: {},
    events: [],
  };
  window.__playtest = playtest;

  const audio = createAudioEngine();

  // Instantiate the 4 game modules once and keep their DOM containers mounted
  const gameModules: Record<GameId, GameModule> = {
    runner: createRunnerGame(),
    horror: createHorrorGame(),
    tiles: createTilesGame(),
    rail: createRailGame(),
  };

  const gameStageWrap = document.createElement('div');
  gameStageWrap.id = 'game-stage-wrap';
  gameStageWrap.className = 'absolute inset-0 h-full w-full hidden';
  root.appendChild(gameStageWrap);

  const gameContainers: Record<GameId, HTMLElement> = {} as Record<GameId, HTMLElement>;
  const gameContexts: Record<GameId, GameContext> = {} as Record<GameId, GameContext>;

  ORDER.forEach((gid) => {
    const el = document.createElement('div');
    el.id = `game-root-${gid}`;
    el.dataset.testid = `game-root-${gid}`;
    el.className = 'absolute inset-0 h-full w-full hidden';
    gameStageWrap.appendChild(el);
    gameContainers[gid] = el;
  });

  // Title Screen
  const titleScreen = document.createElement('div');
  titleScreen.id = 'title-screen';
  titleScreen.dataset.testid = 'title-screen';
  titleScreen.className = 'absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#090a10]';
  titleScreen.innerHTML = `
    <canvas id="title-canvas" class="absolute inset-0 h-full w-full"></canvas>
    <div class="relative z-10 mt-52 flex flex-col items-center gap-4 text-center">
      <p class="max-w-md text-xs uppercase tracking-widest text-slate-400">
        One Song · Three Games · Continuous Audio
      </p>
      <button
        id="title-enter-btn"
        type="button"
        data-start="true"
        data-testid="title-enter-btn"
        class="cursor-pointer rounded border-2 border-amber-400 bg-amber-400/15 px-8 py-3 text-sm font-extrabold uppercase tracking-widest text-amber-300 shadow-lg transition hover:bg-amber-400 hover:text-slate-950"
      >
        Press Enter
      </button>
    </div>
  `;
  root.appendChild(titleScreen);
  const titleCanvas = titleScreen.querySelector<HTMLCanvasElement>('#title-canvas')!;
  const titleEnterBtn = titleScreen.querySelector<HTMLButtonElement>('#title-enter-btn')!;

  // Song Select Screen
  const selectScreen = document.createElement('div');
  selectScreen.id = 'song-select-screen';
  selectScreen.dataset.testid = 'song-select-screen';
  selectScreen.className =
    'absolute inset-0 z-20 hidden overflow-y-auto bg-[#090a10] p-6 md:p-10';
  root.appendChild(selectScreen);

  // Loading Overlay
  const loadingScreen = document.createElement('div');
  loadingScreen.id = 'loading-screen';
  loadingScreen.dataset.testid = 'loading-screen';
  loadingScreen.className =
    'absolute inset-0 z-30 hidden flex-col items-center justify-center bg-[#090a10]/95';
  loadingScreen.innerHTML = `
    <div class="rounded-lg border border-slate-800 bg-slate-900/90 px-8 py-6 text-center shadow-2xl">
      <div class="text-xs uppercase tracking-widest text-amber-400">Initializing Run</div>
      <div id="loading-title" class="mt-2 text-lg font-extrabold text-slate-100">Loading Song & Games...</div>
      <div class="mt-3 text-[11px] text-slate-400">Decoding continuous Web Audio buffer & preloading 3 stages</div>
    </div>
  `;
  root.appendChild(loadingScreen);
  const loadingTitleEl = loadingScreen.querySelector<HTMLElement>('#loading-title')!;

  // Overlays for Play and Results
  const hud = createPlayHud(root);
  const runway = createRunwayCard(root);
  const hyperspace = createHyperspaceOverlay(root);
  const results = createResultsScreen(root);

  // Persistent top control bar: Exit Game + Dev Skip to Next Game
  const topBarWrap = document.createElement('div');
  topBarWrap.className =
    'pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2.5';
  root.appendChild(topBarWrap);

  const exitGameBtn = document.createElement('button');
  exitGameBtn.id = 'exit-game-btn';
  exitGameBtn.dataset.testid = 'exit-game-btn';
  exitGameBtn.type = 'button';
  exitGameBtn.tabIndex = -1;
  exitGameBtn.setAttribute('aria-label', 'Exit Game');
  exitGameBtn.className =
    'pointer-events-auto flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700/90 bg-slate-950/90 px-3.5 py-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-200 shadow-lg transition hover:border-rose-400 hover:bg-rose-950/80 hover:text-rose-200';
  exitGameBtn.innerHTML = `
    <svg viewBox="0 0 24 24" class="h-3.5 w-3.5 fill-none stroke-current" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
    <span>Exit Game</span>
  `;
  topBarWrap.appendChild(exitGameBtn);

  const skipGameBtn = document.createElement('button');
  skipGameBtn.id = 'skip-game-btn';
  skipGameBtn.dataset.testid = 'skip-game-btn';
  skipGameBtn.type = 'button';
  skipGameBtn.tabIndex = -1;
  skipGameBtn.setAttribute('aria-label', 'Skip to Next Game');
  skipGameBtn.title = 'Dev: Skip to Next Game (Shortcut: N)';
  skipGameBtn.className =
    'pointer-events-auto flex cursor-pointer items-center gap-1.5 rounded-lg border border-amber-500/70 bg-slate-950/90 px-3.5 py-1.5 text-xs font-extrabold uppercase tracking-wider text-amber-300 shadow-lg transition hover:border-amber-300 hover:bg-amber-950/80 hover:text-amber-200';
  skipGameBtn.innerHTML = `
    <span class="rounded bg-amber-400/20 px-1 py-0.5 text-[10px] text-amber-300">DEV</span>
    <span>Next Game →</span>
  `;
  topBarWrap.appendChild(skipGameBtn);

  // State variables
  let screen: ScreenState = 'title';
  let songsList: SongIndexEntry[] = [];
  let selectedSongId = 'ctd';
  let useDemoCut = paramCut ? paramCut === 'demo' : true;
  let uploadEndpointAvailable = false;
  let uploadingSong = false;

  let currentMap: SongMap | null = null;
  let currentPaletteSource: ReturnType<typeof createPaletteSource> | null = null;
  let activeGameId: GameId = 'runner';
  let playPhase: PlayPhase = { kind: 'active' };
  let totalScore = 0;
  let totalDeaths = 0;
  let switchCount = 0;
  let deathMarkers: DeathMarker[] = [];
  let perGameStats: Record<GameId, PerGameRunStats> = createInitialPerGameStats();

  // Title starfield state
  const titleStars = Array.from({ length: 95 }, (_, i) => ({
    x: ((i * 73) % 1000) / 1000,
    y: ((i * 137) % 1000) / 1000,
    z: 0.2 + ((i * 29) % 80) / 100,
    size: 1 + (i % 3),
  }));

  // FPS tracking
  let fps = 60;
  let lastFrameWallMs = performance.now();

  function createInitialPerGameStats(): Record<GameId, PerGameRunStats> {
    return {
      runner: {
        id: 'runner',
        title: gameModules.runner.title,
        score: 0,
        timeSpent: 0,
        deaths: 0,
        onBeatActions: 0,
        totalTimedActions: 0,
        enteredCount: 0,
      },
      horror: {
        id: 'horror',
        title: gameModules.horror.title,
        score: 0,
        timeSpent: 0,
        deaths: 0,
        onBeatActions: 0,
        totalTimedActions: 0,
        enteredCount: 0,
      },
      tiles: {
        id: 'tiles',
        title: gameModules.tiles.title,
        score: 0,
        timeSpent: 0,
        deaths: 0,
        onBeatActions: 0,
        totalTimedActions: 0,
        enteredCount: 0,
      },
      rail: {
        id: 'rail',
        title: gameModules.rail.title,
        score: 0,
        timeSpent: 0,
        deaths: 0,
        onBeatActions: 0,
        totalTimedActions: 0,
        enteredCount: 0,
      },
    };
  }

  function exitToSplashScreen(): void {
    try {
      gameModules[activeGameId]?.exit();
    } catch {
      // ignore
    }
    ORDER.forEach((gid) => {
      gameContainers[gid]?.classList.add('hidden');
    });
    audio.stop();
    audio.fx.reset();
    document.exitPointerLock?.();
    playPhase = { kind: 'active' };
    exitGameBtn.blur();
    setScreen('title');
  }

  exitGameBtn.addEventListener('click', () => {
    exitToSplashScreen();
  });

  function skipToNextGame(): void {
    skipGameBtn.blur();
    document.exitPointerLock?.();
    if (screen === 'play' && currentMap) {
      const nextIdx = (ORDER.indexOf(activeGameId) + 1) % ORDER.length;
      const nextGameId = ORDER[nextIdx];
      hyperspace.hide();
      playPhase = { kind: 'active' };
      enterGame(nextGameId, audio.clock.now());
    } else if (screen === 'title' || screen === 'select' || screen === 'results') {
      const nextIdx = (ORDER.indexOf(activeGameId) + 1) % ORDER.length;
      const nextGameId = ORDER[nextIdx];
      void startSongRun(selectedSongId, useDemoCut ? 'demo' : 'full', nextGameId, 0);
    }
  }

  skipGameBtn.addEventListener('click', () => {
    skipToNextGame();
  });

  function setScreen(next: ScreenState): void {
    screen = next;
    document.body.dataset.state = next === 'play' ? 'playing' : next;
    titleScreen.classList.toggle('hidden', next !== 'title');
    selectScreen.classList.toggle('hidden', next !== 'select');
    loadingScreen.classList.toggle('hidden', next !== 'loading');
    loadingScreen.classList.toggle('flex', next === 'loading');
    gameStageWrap.classList.toggle('hidden', next !== 'play');
    if (next !== 'play') {
      hud.hide();
      runway.hide();
      hyperspace.hide();
    }
    if (next !== 'results') {
      results.hide();
    }
  }

  async function loadSongsIndex(): Promise<void> {
    try {
      const res = await fetch('/songs/index.json');
      if (res.ok) {
        const list = (await res.json()) as SongIndexEntry[];
        if (Array.isArray(list) && list.length > 0) {
          songsList = list;
        }
      }
    } catch {
      // Fallback to fixture
    }

    if (songsList.length === 0) {
      songsList = [
        {
          id: DEFAULT_FIXTURE_SONG_MAP.id,
          title: DEFAULT_FIXTURE_SONG_MAP.title,
          bpm: DEFAULT_FIXTURE_SONG_MAP.bpm,
          duration: DEFAULT_FIXTURE_SONG_MAP.duration,
          demoDuration: DEFAULT_FIXTURE_SONG_MAP.duration,
          demoWindow: DEFAULT_FIXTURE_SONG_MAP.demoWindow,
          palette: DEFAULT_FIXTURE_SONG_MAP.palette,
          waveform: DEFAULT_FIXTURE_SONG_MAP.waveform.peaks,
        },
      ];
    }

    if (!songsList.some((s) => s.id === selectedSongId)) {
      selectedSongId = songsList[0].id;
    }

    // Check if optional upload dev-server endpoint is available
    try {
      const statusRes = await fetch('/api/songs/status');
      const ct = statusRes.headers.get('content-type') || '';
      uploadEndpointAvailable = statusRes.ok && ct.includes('application/json');
    } catch {
      uploadEndpointAvailable = false;
    }
  }

  function drawCardWaveform(canvas: HTMLCanvasElement, peaks: number[], pal: Palette): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = 320 * dpr;
    const H = 68 * dpr;
    canvas.width = W;
    canvas.height = H;

    ctx.fillStyle = pal.bg || '#090a10';
    ctx.fillRect(0, 0, W, H);

    const n = peaks.length || 1;
    const midY = H * 0.5;
    const barW = Math.max(1, W / n);

    for (let i = 0; i < n; i++) {
      const val = Math.max(0.04, peaks[i] ?? 0);
      const amp = val * (H * 0.42);
      ctx.fillStyle = val > 0.65 ? pal.accent || '#f59e0b' : pal.primary || '#38bdf8';
      ctx.fillRect(i * barW, midY - amp, Math.max(1, barW - 0.5 * dpr), amp * 2);
    }
  }

  function renderSongSelect(): void {
    const cardsHtml = songsList
      .map((song) => {
        const durSec = useDemoCut ? song.demoDuration : song.duration;
        const mins = Math.floor(durSec / 60);
        const secs = Math.round(durSec % 60)
          .toString()
          .padStart(2, '0');
        return `
          <div
            data-song-card="${song.id}"
            data-testid="song-card-${song.id}"
            class="group relative flex flex-col justify-between rounded-lg border-2 bg-slate-900/85 p-5 shadow-xl transition hover:-translate-y-0.5 cursor-pointer"
            style="border-color: ${song.palette.primary || '#38bdf8'}66;"
          >
            <div>
              <div class="flex items-start justify-between gap-3">
                <h2 class="text-base font-extrabold text-slate-100 group-hover:text-amber-300 leading-snug">
                  ${song.title}
                </h2>
                <span
                  class="shrink-0 rounded px-2 py-0.5 text-xs font-extrabold text-slate-950"
                  style="background-color: ${song.palette.accent || '#f59e0b'};"
                >
                  ${Math.round(song.bpm)} BPM
                </span>
              </div>
              <div class="mt-1 text-[11px] text-slate-400">
                ID: <span class="text-slate-200 font-semibold">${song.id}</span> · Duration: ${mins}:${secs} (${useDemoCut ? 'Demo Cut' : 'Full Track'})
              </div>
              <canvas
                id="wf-card-${song.id}"
                class="mt-4 h-16 w-full rounded border border-slate-800"
              ></canvas>
            </div>

            <div class="mt-4 flex items-center justify-between pt-2 border-t border-slate-800/80">
              <div class="flex items-center gap-1.5">
                <span class="inline-block h-3 w-3 rounded-full" style="background:${song.palette.primary}"></span>
                <span class="inline-block h-3 w-3 rounded-full" style="background:${song.palette.secondary}"></span>
                <span class="inline-block h-3 w-3 rounded-full" style="background:${song.palette.accent}"></span>
              </div>
              <button
                type="button"
                data-play-song="${song.id}"
                data-testid="play-song-${song.id}"
                class="cursor-pointer rounded px-4 py-1.5 text-xs font-extrabold uppercase tracking-wider text-slate-950 transition"
                style="background-color: ${song.palette.primary || '#38bdf8'};"
              >
                Play Track →
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    const uploadDisabledAttr = uploadEndpointAvailable && !uploadingSong ? '' : 'disabled';
    const uploadTooltip = uploadEndpointAvailable
      ? 'Upload an MP3 to run offline DSP + Argon semantic analysis'
      : 'Dev-server upload endpoint (/api/songs/upload) is unavailable in static preview';

    selectScreen.innerHTML = `
      <div class="mx-auto max-w-6xl flex flex-col gap-6">
        <div class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
          <div>
            <div class="text-xs uppercase tracking-widest text-amber-400">SELECT A TRACK</div>
            <h1 class="mt-1 text-3xl font-black tracking-tight text-slate-100">SONG ARCADE</h1>
          </div>

          <div class="flex flex-wrap items-center gap-4">
            <label
              class="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-bold text-slate-200 hover:border-amber-400"
            >
              <input
                id="demo-cut-toggle"
                data-testid="demo-cut-toggle"
                type="checkbox"
                ${useDemoCut ? 'checked' : ''}
                class="h-4 w-4 accent-amber-400 cursor-pointer"
              />
              <span>Demo cut (about 100 s)</span>
            </label>

            <button
              id="fullscreen-btn"
              data-testid="fullscreen-btn"
              type="button"
              class="cursor-pointer rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-200 hover:border-sky-400"
            >
              Fullscreen
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          ${cardsHtml}

          <div
            id="add-song-card"
            data-testid="add-song-card"
            title="${uploadTooltip}"
            class="flex flex-col justify-between rounded-lg border-2 border-dashed border-slate-700 bg-slate-900/40 p-5 ${
              uploadEndpointAvailable ? 'hover:border-amber-400' : 'opacity-60 cursor-not-allowed'
            }"
          >
            <div>
              <div class="flex items-center justify-between">
                <h2 class="text-base font-extrabold text-slate-200">+ Add a Song (.mp3)</h2>
                <span class="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-400">
                  ${uploadEndpointAvailable ? 'DEV PIPELINE' : 'OFFLINE'}
                </span>
              </div>
              <p class="mt-2 text-xs text-slate-400 leading-relaxed">
                ${
                  uploadingSong
                    ? 'Running Python DSP + Gemini 4 Argon semantic analysis...'
                    : uploadTooltip
                }
              </p>
            </div>

            <div class="mt-4 pt-3 border-t border-slate-800/80">
              <input
                id="add-song-input"
                type="file"
                accept=".mp3,audio/mpeg"
                class="hidden"
                ${uploadDisabledAttr}
              />
              <button
                id="add-song-btn"
                data-testid="add-song-btn"
                type="button"
                ${uploadDisabledAttr}
                title="${uploadTooltip}"
                class="w-full rounded border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-200 ${
                  uploadEndpointAvailable && !uploadingSong
                    ? 'cursor-pointer hover:border-amber-400 hover:text-amber-300'
                    : 'cursor-not-allowed opacity-60'
                }"
              >
                ${uploadingSong ? 'Analyzing Track...' : 'Upload MP3 & Analyze'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    songsList.forEach((song) => {
      const c = selectScreen.querySelector<HTMLCanvasElement>(`#wf-card-${song.id}`);
      if (c) {
        drawCardWaveform(c, song.waveform, song.palette);
      }
      const cardEl = selectScreen.querySelector<HTMLElement>(`[data-song-card="${song.id}"]`);
      cardEl?.addEventListener('click', () => {
        selectedSongId = song.id;
        void startSongRun(song.id, useDemoCut ? 'demo' : 'full', 'runner', 0);
      });
    });

    const demoToggle = selectScreen.querySelector<HTMLInputElement>('#demo-cut-toggle');
    demoToggle?.addEventListener('change', () => {
      useDemoCut = demoToggle.checked;
      renderSongSelect();
    });

    const fsBtn = selectScreen.querySelector<HTMLButtonElement>('#fullscreen-btn');
    fsBtn?.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    });

    const addBtn = selectScreen.querySelector<HTMLButtonElement>('#add-song-btn');
    const fileInput = selectScreen.querySelector<HTMLInputElement>('#add-song-input');
    if (addBtn && fileInput && uploadEndpointAvailable && !uploadingSong) {
      addBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        uploadingSong = true;
        renderSongSelect();
        try {
          const buf = await file.arrayBuffer();
          const res = await fetch(`/api/songs/upload?filename=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf,
          });
          if (res.ok) {
            await loadSongsIndex();
          }
        } catch (err) {
          console.warn('Song upload failed:', err);
        } finally {
          uploadingSong = false;
          renderSongSelect();
        }
      });
    }
  }

  async function fetchSongMap(songId: string, cut: 'demo' | 'full'): Promise<SongMap> {
    try {
      const res = await fetch(`/songs/${songId}/${cut}.json`);
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        return (await res.json()) as SongMap;
      }
    } catch {
      // fall through
    }
    return DEFAULT_FIXTURE_SONG_MAP;
  }

  function handleGameEvent(gameId: GameId, e: GameEvent): void {
    const now = audio.clock.now();
    playtest.events.push({ ...e, t: now, game: gameId });

    if (e.type === 'score') {
      totalScore += e.points;
      perGameStats[gameId].score += e.points;
      if (e.onBeat !== undefined) {
        perGameStats[gameId].totalTimedActions += 1;
        if (e.onBeat) {
          perGameStats[gameId].onBeatActions += 1;
        }
      }
      if (currentMap) {
        const pal = (currentPaletteSource ?? createPaletteSource(currentMap)).at(now);
        hud.spawnScorePopup(e.points, e.label, pal);
      }
    } else if (e.type === 'lifeLost') {
      const maxLives = gameId === 'runner' ? 2 : gameId === 'tiles' ? 5 : 3;
      hud.setLives(e.livesLeft, maxLives);
    } else if (e.type === 'metric') {
      playtest.metrics[`${gameId}.${e.key}`] = e.value;
    } else if (e.type === 'death') {
      if (playPhase.kind !== 'active') return;
      triggerDeathAndJump(gameId, now);
    }
  }

  function triggerDeathAndJump(fromGameId: GameId, songTime: number): void {
    totalDeaths += 1;
    perGameStats[fromGameId].deaths += 1;
    deathMarkers.push({ songTime, gameId: fromGameId });

    // Exit current game cleanly
    gameModules[fromGameId].exit();
    gameContainers[fromGameId].classList.add('hidden');
    runway.hide();

    // Pick next game in ORDER
    const curIdx = ORDER.indexOf(fromGameId);
    const nextIdx = (curIdx + 1) % ORDER.length;
    const nextGameId = ORDER[nextIdx];
    const nextMod = gameModules[nextGameId];

    playPhase = {
      kind: 'hyperspace',
      elapsed: 0,
      nextGameId,
    };

    hyperspace.start(nextMod.title, nextMod.listensTo);
  }

  function enterGame(gameId: GameId, songTime: number): void {
    if (activeGameId && activeGameId !== gameId) {
      try {
        gameModules[activeGameId].exit();
      } catch {
        // ignore
      }
    }

    ORDER.forEach((gid) => {
      gameContainers[gid].classList.toggle('hidden', gid !== gameId);
    });

    activeGameId = gameId;
    switchCount += 1;
    perGameStats[gameId].enteredCount += 1;

    const mod = gameModules[gameId];
    const ctx = gameContexts[gameId];
    ctx.safeUntil = songTime + RUNWAY;

    const maxLives = gameId === 'runner' ? 2 : gameId === 'tiles' ? 5 : 3;
    hud.show();
    hud.setGameInfo(mod.title, mod.listensTo, maxLives, maxLives);
    runway.enter(mod.title, mod.listensTo, mod.controls, songTime);
    mod.enter(songTime);
  }

  async function startSongRun(
    songId: string,
    cut: 'demo' | 'full',
    initialGame: GameId = 'runner',
    entrySec = 0,
  ): Promise<void> {
    setScreen('loading');
    loadingTitleEl.textContent = `Loading ${songId.toUpperCase()} (${cut.toUpperCase()})...`;

    const map = await fetchSongMap(songId, cut);
    currentMap = map;
    selectedSongId = map.id;

    totalScore = 0;
    totalDeaths = 0;
    switchCount = 0;
    deathMarkers = [];
    perGameStats = createInitialPerGameStats();

    const paletteSource = createPaletteSource(map);
    currentPaletteSource = paletteSource;
    const slots = validateSlotRegistry();
    const baseSeed = paramSeed !== null && Number.isFinite(paramSeed) ? paramSeed : hashString(map.id);

    // Try loading pre-generated per-song levels if present
    const loadedLevels: Partial<Record<GameId, unknown>> = {};
    await Promise.all(
      ORDER.map(async (gid) => {
        try {
          const res = await fetch(`/songs/${map.id}/levels/${gid}.json`);
          const ct = res.headers.get('content-type') || '';
          if (res.ok && ct.includes('application/json')) {
            loadedLevels[gid] = await res.json();
          }
        } catch {
          // use default generated level
        }
      }),
    );

    ORDER.forEach((gid, idx) => {
      gameContexts[gid] = {
        root: gameContainers[gid],
        map,
        clock: audio.clock,
        fx: audio.fx,
        bands: audio.bands,
        palette: paletteSource,
        level: loadedLevels[gid] ?? null,
        slots,
        rng: createRng(baseSeed + idx * 101),
        safeUntil: entrySec + RUNWAY,
        bot: paramBot,
        emit: (ev: GameEvent) => handleGameEvent(gid, ev),
      };
    });

    // Preload all 4 games once at song start before starting the clock
    await Promise.all(ORDER.map((gid) => gameModules[gid].preload(gameContexts[gid])));

    // Start continuous audio source
    await audio.loadAndStart(map, entrySec);
    const startSongTime = audio.clock.now();

    playtest.ready = true;
    playtest.startedAtSongTime = startSongTime;
    playtest.songTime = startSongTime;
    playtest.metrics = {};
    playtest.events = [];

    playPhase = { kind: 'active' };
    setScreen('play');
    const validGame: GameId = ORDER.includes(initialGame) ? initialGame : 'runner';
    enterGame(validGame, startSongTime);
  }

  function finishRunAndShowResults(): void {
    if (!currentMap) return;
    try {
      gameModules[activeGameId].exit();
    } catch {
      // ignore
    }
    audio.stop();
    hyperspace.hide();
    runway.hide();
    hud.hide();

    const gamesReached = ORDER.filter((gid) => perGameStats[gid].enteredCount > 0).length;
    const summary: RunSummary = {
      map: currentMap,
      totalScore,
      totalDeaths,
      gamesReached: Math.max(1, gamesReached),
      perGame: perGameStats,
      deathMarkers,
    };

    setScreen('results');
    void results.show(
      summary,
      () => {
        void startSongRun(selectedSongId, useDemoCut ? 'demo' : 'full', 'runner', 0);
      },
      () => {
        setScreen('select');
        renderSongSelect();
      },
    );
  }

  // Dev Panel
  const devPanel = createDevPanel(root, {
    getSongMap: () => currentMap,
    getSongTime: () => audio.clock.now(),
    getActiveGameId: () => activeGameId,
    getFps: () => fps,
    getSwitchCount: () => switchCount,
    getCalibrationOffsetMs: () => Math.round(audio.getCalibrationOffsetSec() * 1000),
    setCalibrationOffsetMs: (ms: number) => audio.setCalibrationOffsetSec(ms / 1000),
    jumpToGame: (gid: GameId) => {
      if (screen !== 'play' || !currentMap) return;
      document.exitPointerLock?.();
      hyperspace.hide();
      playPhase = { kind: 'active' };
      enterGame(gid, audio.clock.now());
    },
    skipToNextGame: () => {
      skipToNextGame();
    },
    seekToTime: (sec: number) => {
      if (screen !== 'play' || !currentMap) return;
      audio.seekTo(sec);
      gameContexts[activeGameId].safeUntil = sec + RUNWAY;
      runway.enter(
        gameModules[activeGameId].title,
        gameModules[activeGameId].listensTo,
        gameModules[activeGameId].controls,
        sec,
      );
    },
    killCurrentGame: () => {
      if (screen !== 'play' || !currentMap) return;
      if (playPhase.kind === 'active') {
        triggerDeathAndJump(activeGameId, audio.clock.now());
      }
    },
    runSwitchStressTest: (times: number) => {
      if (screen !== 'play' || !currentMap) return;
      hyperspace.hide();
      playPhase = { kind: 'active' };
      const now = audio.clock.now();
      for (let i = 0; i < times; i++) {
        const nextGid = ORDER[(ORDER.indexOf(activeGameId) + 1) % ORDER.length];
        enterGame(nextGid, now);
        gameModules[nextGid].update(1 / 60, now);
        gameModules[nextGid].render();
      }
    },
  });

  // Global keyboard & pointer listeners
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Backquote' || e.key === '`') {
      e.preventDefault();
      devPanel.toggle();
      return;
    }

    if (e.code === 'KeyN' && screen === 'play') {
      e.preventDefault();
      skipToNextGame();
      return;
    }

    if (screen === 'title' && (e.code === 'Enter' || e.code === 'Space')) {
      e.preventDefault();
      setScreen('select');
      renderSongSelect();
      return;
    }

    if (screen === 'play' && playPhase.kind === 'active') {
      runway.recordKeyInput(e.code, e.key);
    }
  });

  window.addEventListener('pointerdown', () => {
    if (screen === 'play' && playPhase.kind === 'active') {
      runway.recordPointerInput();
    }
  });

  titleEnterBtn.addEventListener('click', () => {
    setScreen('select');
    renderSongSelect();
  });

  function renderTitleCanvas(dt: number): void {
    const ctx = titleCanvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(320, Math.floor(window.innerWidth * dpr));
    const H = Math.max(240, Math.floor(window.innerHeight * dpr));
    if (titleCanvas.width !== W || titleCanvas.height !== H) {
      titleCanvas.width = W;
      titleCanvas.height = H;
    }

    ctx.fillStyle = '#090a10';
    ctx.fillRect(0, 0, W, H);

    // Slow audio-free starfield in neutral colors
    for (let i = 0; i < titleStars.length; i++) {
      const s = titleStars[i];
      s.y += dt * 0.025 * s.z;
      if (s.y > 1) s.y -= 1;
      const sx = s.x * W;
      const sy = s.y * H;
      const alpha = (0.25 + s.z * 0.65).toFixed(2);
      ctx.fillStyle = `rgba(203, 213, 225, ${alpha})`;
      ctx.fillRect(sx, sy, s.size * dpr, s.size * dpr);
    }

    const pixelSize = Math.max(4, Math.min(12, Math.floor(W / 95)));
    drawPixelText(
      ctx,
      'SONG ARCADE',
      W * 0.5,
      H * 0.34,
      pixelSize,
      '#f8fafc',
      '#f59e0b',
    );
  }

  // Main frame loop
  let running = true;
  async function frameLoop(): Promise<void> {
    while (running) {
      try {
        const nowWall = performance.now();
        const rawDt = Math.max(0.001, (nowWall - lastFrameWallMs) / 1000);
        lastFrameWallMs = nowWall;
        const dt = Math.min(0.1, rawDt);
        fps = fps * 0.9 + (1 / rawDt) * 0.1;

        if (screen === 'title') {
          renderTitleCanvas(dt);
        } else if (screen === 'play' && currentMap) {
          const songTime = audio.clock.now();
          audio.updateBands(songTime);
          const pal = (currentPaletteSource ?? createPaletteSource(currentMap)).at(songTime);

          // Update playtest state every frame
          playtest.songTime = songTime;
          const activeMetrics = gameModules[activeGameId].getMetrics();
          Object.entries(activeMetrics).forEach(([k, v]) => {
            playtest.metrics[k] = v;
            playtest.metrics[`${activeGameId}.${k}`] = v;
          });
          playtest.metrics.totalScore = Math.round(totalScore);
          playtest.metrics.deaths = totalDeaths;

          if (playPhase.kind === 'active') {
            // Survival points: 10 points per second
            const survPts = SCORING.SURVIVAL_PTS_PER_SEC * dt;
            totalScore += survPts;
            perGameStats[activeGameId].score += survPts;
            perGameStats[activeGameId].timeSpent += dt;

            const rwState = runway.update(songTime, pal);
            gameContexts[activeGameId].safeUntil = rwState.safeUntil;

            gameModules[activeGameId].update(dt, songTime);
            gameModules[activeGameId].render();

            hud.update(
              songTime,
              currentMap.duration,
              totalScore,
              perGameStats[activeGameId].score,
              pal,
            );

            // Check if song reached the end
            if (audio.isEnded(songTime)) {
              audio.fx.gain(0, SONG_END_FADE_SEC);
              playPhase = { kind: 'fadingOut', elapsed: 0 };
            }
          } else if (playPhase.kind === 'hyperspace') {
            playPhase.elapsed += dt;
            hyperspace.updateAndRender(dt, playPhase.elapsed, pal, audio.bands);
            hud.update(
              songTime,
              currentMap.duration,
              totalScore,
              perGameStats[activeGameId].score,
              pal,
            );

            if (playPhase.elapsed >= READJUST) {
              const targetGame = playPhase.nextGameId;
              hyperspace.hide();
              if (audio.isEnded(songTime)) {
                audio.fx.gain(0, SONG_END_FADE_SEC);
                playPhase = { kind: 'fadingOut', elapsed: 0 };
              } else {
                playPhase = { kind: 'active' };
                enterGame(targetGame, songTime);
              }
            }
          } else if (playPhase.kind === 'fadingOut') {
            playPhase.elapsed += dt;
            gameModules[activeGameId].render();
            if (playPhase.elapsed >= SONG_END_FADE_SEC) {
              finishRunAndShowResults();
            }
          }
        }

        devPanel.update();
      } catch (err) {
        console.error('[frameLoop] Unhandled frame error:', err);
      }
      await afterDraw();
    }
  }

  // Kick off initialization
  void (async () => {
    await loadSongsIndex();
    if (paramSong && songsList.some((s) => s.id === paramSong)) {
      selectedSongId = paramSong;
    } else if (songsList.length > 0) {
      selectedSongId = songsList[0].id;
    }

    if (hasAutoStartParams) {
      const cutToUse: 'demo' | 'full' = paramCut ?? (useDemoCut ? 'demo' : 'full');
      const targetGame: GameId =
        paramGame && ORDER.includes(paramGame) ? paramGame : 'runner';
      await startSongRun(selectedSongId, cutToUse, targetGame, paramEntrySec);
    } else {
      setScreen('title');
    }
  })();

  void frameLoop();
}
