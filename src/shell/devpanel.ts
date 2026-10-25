import type { GameId, SongMap } from './api';
import { ORDER } from './config';
import { sectionAt } from '../shared/songmap';

export interface DevPanelCallbacks {
  getSongMap(): SongMap | null;
  getSongTime(): number;
  getActiveGameId(): GameId;
  getFps(): number;
  getSwitchCount(): number;
  getCalibrationOffsetMs(): number;
  setCalibrationOffsetMs(ms: number): void;
  jumpToGame(gameId: GameId): void;
  skipToNextGame(): void;
  seekToTime(sec: number): void;
  killCurrentGame(): void;
  runSwitchStressTest(times: number): void;
}

export interface DevPanel {
  element: HTMLElement;
  toggle(): void;
  isOpen(): boolean;
  update(): void;
}

export function createDevPanel(parent: HTMLElement, cb: DevPanelCallbacks): DevPanel {
  const panel = document.createElement('aside');
  panel.id = 'dev-panel';
  panel.dataset.testid = 'dev-panel';
  panel.className =
    'pointer-events-auto absolute left-6 bottom-6 z-40 hidden w-80 rounded-lg border border-slate-700 bg-slate-950/95 p-4 font-mono text-xs text-slate-200 shadow-2xl';

  panel.innerHTML = `
    <div class="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
      <span class="font-extrabold uppercase tracking-wider text-amber-400">DEV PANEL [\`]</span>
      <span id="dev-fps" class="font-bold text-emerald-400">60 FPS</span>
    </div>

    <div class="space-y-1 text-[11px]" style="font-variant-numeric: tabular-nums;">
      <div class="flex justify-between"><span class="text-slate-400">Song Time:</span><span id="dev-time">0.00s</span></div>
      <div class="flex justify-between"><span class="text-slate-400">BPM:</span><span id="dev-bpm">120</span></div>
      <div class="flex justify-between"><span class="text-slate-400">Section:</span><span id="dev-section">intro</span></div>
      <div class="flex justify-between"><span class="text-slate-400">Active Game:</span><span id="dev-game" class="font-bold text-sky-400">runner</span></div>
      <div class="flex justify-between"><span class="text-slate-400">Heap / Switches:</span><span id="dev-heap">— MB · 0x</span></div>
    </div>

    <div class="mt-3 border-t border-slate-800 pt-2.5">
      <div class="text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Jump to Game</div>
      <div class="grid grid-cols-4 gap-1.5" id="dev-game-btns"></div>
    </div>

    <div class="mt-3 border-t border-slate-800 pt-2.5">
      <div class="text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Jump to Time</div>
      <div class="grid grid-cols-4 gap-1.5" id="dev-time-btns"></div>
    </div>

    <div class="mt-3 border-t border-slate-800 pt-2.5 flex flex-col gap-2">
      <button
        id="dev-next-game-btn"
        type="button"
        data-testid="dev-next-game-btn"
        class="w-full cursor-pointer rounded border border-emerald-500/60 bg-emerald-950/75 px-2.5 py-1.5 text-[11px] font-bold uppercase text-emerald-200 hover:bg-emerald-900"
      >
        Skip to Next Game → [N]
      </button>
      <div class="flex gap-2">
        <button
          id="dev-kill-btn"
          type="button"
          data-testid="dev-kill-btn"
          class="flex-1 cursor-pointer rounded border border-rose-500/60 bg-rose-950/70 px-2.5 py-1.5 text-[11px] font-bold uppercase text-rose-200 hover:bg-rose-900"
        >
          Kill Current Game
        </button>
        <button
          id="dev-stress-btn"
          type="button"
          data-testid="dev-stress-btn"
          class="cursor-pointer rounded border border-sky-500/60 bg-sky-950/70 px-2.5 py-1.5 text-[11px] font-bold uppercase text-sky-200 hover:bg-sky-900"
        >
          20x Switch
        </button>
      </div>
    </div>

    <div class="mt-3 border-t border-slate-800 pt-2.5">
      <label for="dev-latency-slider" class="flex items-center justify-between text-[11px] text-slate-400 mb-1">
        <span>Audio Latency Offset</span>
        <span id="dev-latency-val" class="font-bold text-slate-100">0 ms</span>
      </label>
      <input
        id="dev-latency-slider"
        type="range"
        min="-150"
        max="150"
        step="5"
        value="0"
        class="w-full accent-amber-400 cursor-pointer"
      />
    </div>
  `;
  parent.appendChild(panel);

  const fpsEl = panel.querySelector<HTMLElement>('#dev-fps')!;
  const timeEl = panel.querySelector<HTMLElement>('#dev-time')!;
  const bpmEl = panel.querySelector<HTMLElement>('#dev-bpm')!;
  const secEl = panel.querySelector<HTMLElement>('#dev-section')!;
  const gameEl = panel.querySelector<HTMLElement>('#dev-game')!;
  const heapEl = panel.querySelector<HTMLElement>('#dev-heap')!;
  const gameBtnsWrap = panel.querySelector<HTMLElement>('#dev-game-btns')!;
  const timeBtnsWrap = panel.querySelector<HTMLElement>('#dev-time-btns')!;
  const nextGameBtn = panel.querySelector<HTMLButtonElement>('#dev-next-game-btn')!;
  const killBtn = panel.querySelector<HTMLButtonElement>('#dev-kill-btn')!;
  const stressBtn = panel.querySelector<HTMLButtonElement>('#dev-stress-btn')!;
  const latencySlider = panel.querySelector<HTMLInputElement>('#dev-latency-slider')!;
  const latencyVal = panel.querySelector<HTMLElement>('#dev-latency-val')!;

  ORDER.forEach((gid) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.testid = `dev-jump-${gid}`;
    btn.className =
      'cursor-pointer rounded border border-slate-700 bg-slate-900 py-1 text-[10px] font-bold uppercase text-slate-200 hover:border-amber-400';
    btn.textContent = gid;
    btn.addEventListener('click', () => cb.jumpToGame(gid));
    gameBtnsWrap.appendChild(btn);
  });

  [0, 30, 60, 90].forEach((sec) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'cursor-pointer rounded border border-slate-700 bg-slate-900 py-1 text-[10px] font-bold text-slate-200 hover:border-sky-400';
    btn.textContent = `${sec}s`;
    btn.addEventListener('click', () => cb.seekToTime(sec));
    timeBtnsWrap.appendChild(btn);
  });

  nextGameBtn.addEventListener('click', () => cb.skipToNextGame());
  killBtn.addEventListener('click', () => cb.killCurrentGame());
  stressBtn.addEventListener('click', () => cb.runSwitchStressTest(20));

  const initMs = cb.getCalibrationOffsetMs();
  latencySlider.value = String(initMs);
  latencyVal.textContent = `${initMs > 0 ? '+' : ''}${initMs} ms`;

  latencySlider.addEventListener('input', () => {
    const ms = Number(latencySlider.value) || 0;
    latencyVal.textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
    cb.setCalibrationOffsetMs(ms);
  });

  let open = false;

  return {
    element: panel,

    toggle(): void {
      open = !open;
      panel.classList.toggle('hidden', !open);
    },

    isOpen(): boolean {
      return open;
    },

    update(): void {
      if (!open) return;
      const map = cb.getSongMap();
      const t = cb.getSongTime();
      const fps = cb.getFps();

      fpsEl.textContent = `${Math.round(fps)} FPS`;
      timeEl.textContent = map ? `${t.toFixed(2)}s / ${map.duration.toFixed(1)}s` : `${t.toFixed(2)}s`;
      bpmEl.textContent = map ? String(map.bpm) : '—';
      if (map) {
        const sec = sectionAt(map, t);
        secEl.textContent = `${sec.label} (${sec.mood})`;
      } else {
        secEl.textContent = '—';
      }
      gameEl.textContent = cb.getActiveGameId().toUpperCase();

      const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const heapStr = perfMem ? `${(perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(1)} MB` : 'N/A';
      heapEl.textContent = `${heapStr} · ${cb.getSwitchCount()}x`;
    },
  };
}
