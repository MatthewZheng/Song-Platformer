import type { Palette } from './api';

interface ScorePopup {
  el: HTMLElement;
  bornAt: number;
}

export interface PlayHud {
  element: HTMLElement;
  show(): void;
  hide(): void;
  setGameInfo(title: string, listensTo: string, livesLeft: number, maxLives?: number): void;
  setLives(livesLeft: number, maxLives?: number): void;
  spawnScorePopup(points: number, label: string | undefined, palette: Palette): void;
  update(songTime: number, duration: number, totalScore: number, gameScore: number, palette: Palette): void;
}

export function createPlayHud(parent: HTMLElement): PlayHud {
  const hud = document.createElement('div');
  hud.id = 'play-hud';
  hud.dataset.testid = 'play-hud';
  hud.className = 'pointer-events-none absolute inset-0 z-20 hidden select-none font-mono';
  hud.innerHTML = `
    <div class="flex items-start justify-between p-6">
      <div class="max-w-xs rounded-lg border border-slate-800/90 bg-slate-950/85 px-4 py-3 shadow-lg">
        <div class="text-[10px] uppercase tracking-widest text-slate-400">ACTIVE GAME</div>
        <div id="hud-game-title" class="text-xl font-extrabold tracking-wider text-slate-100">RUNNER</div>
        <div id="hud-listens-to" class="text-[11px] text-slate-400 mt-0.5 leading-snug">Listening to: the beat</div>
        <div class="mt-2 flex items-center gap-1.5" id="hud-lives-row" aria-label="Lives Remaining"></div>
      </div>

      <div class="relative text-right">
        <div class="rounded-lg border border-slate-800/90 bg-slate-950/85 px-4 py-3 shadow-lg" style="font-variant-numeric: tabular-nums;">
          <div class="text-[10px] uppercase tracking-widest text-slate-400">TOTAL SCORE</div>
          <div id="hud-total-score" data-testid="hud-total-score" class="text-2xl font-black text-amber-400">0</div>
          <div id="hud-game-score" class="text-xs text-slate-400 mt-0.5">STAGE: 0</div>
        </div>
        <div id="hud-popups" class="pointer-events-none absolute right-2 top-20 flex flex-col items-end gap-1"></div>
      </div>
    </div>

    <div class="absolute inset-x-0 bottom-0 h-1.5 bg-slate-900/90">
      <div id="hud-progress-bar" class="h-full w-0 transition-none" style="background-color: #f59e0b;"></div>
    </div>
  `;
  parent.appendChild(hud);

  const titleEl = hud.querySelector<HTMLElement>('#hud-game-title')!;
  const listensEl = hud.querySelector<HTMLElement>('#hud-listens-to')!;
  const livesRowEl = hud.querySelector<HTMLElement>('#hud-lives-row')!;
  const totalScoreEl = hud.querySelector<HTMLElement>('#hud-total-score')!;
  const gameScoreEl = hud.querySelector<HTMLElement>('#hud-game-score')!;
  const popupsWrap = hud.querySelector<HTMLElement>('#hud-popups')!;
  const progressBarEl = hud.querySelector<HTMLElement>('#hud-progress-bar')!;

  const popups: ScorePopup[] = [];
  let currentMaxLives = 3;
  let lastTotalInt = -1;
  let lastGameInt = -1;
  let lastAccentCol = '';
  let lastPrimaryCol = '';
  let lastPctStr = '';

  function renderLives(livesLeft: number, maxLives = currentMaxLives): void {
    currentMaxLives = maxLives;
    livesRowEl.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'text-[10px] uppercase tracking-wider text-slate-400 mr-1';
    label.textContent = 'LIVES';
    livesRowEl.appendChild(label);

    for (let i = 0; i < maxLives; i++) {
      const pip = document.createElement('span');
      const full = i < livesLeft;
      pip.className = 'inline-block h-3 w-3 rounded-sm border';
      if (full) {
        pip.style.backgroundColor = '#ef4444';
        pip.style.borderColor = '#fca5a5';
      } else {
        pip.style.backgroundColor = 'transparent';
        pip.style.borderColor = '#475569';
      }
      livesRowEl.appendChild(pip);
    }
  }

  return {
    element: hud,

    show(): void {
      hud.classList.remove('hidden');
    },

    hide(): void {
      hud.classList.add('hidden');
    },

    setGameInfo(title: string, listensTo: string, livesLeft: number, maxLives = 3): void {
      titleEl.textContent = title.toUpperCase();
      listensEl.textContent = `Listening to: ${listensTo}`;
      lastTotalInt = -1;
      lastGameInt = -1;
      renderLives(livesLeft, maxLives);
    },

    setLives(livesLeft: number, maxLives = currentMaxLives): void {
      renderLives(livesLeft, maxLives);
    },

    spawnScorePopup(points: number, label: string | undefined, palette: Palette): void {
      if (points <= 0 && !label) return;
      const el = document.createElement('div');
      el.className = 'text-xs font-extrabold tracking-wider uppercase drop-shadow';
      el.style.color = palette.highlight || '#f8fafc';
      const prefix = points > 0 ? `+${Math.round(points)}` : '';
      el.textContent = `${prefix}${label ? ' ' + label : ''}`.trim();
      popupsWrap.appendChild(el);
      popups.push({ el, bornAt: performance.now() });

      while (popups.length > 5) {
        const oldest = popups.shift();
        oldest?.el.remove();
      }
    },

    update(songTime: number, duration: number, totalScore: number, gameScore: number, palette: Palette): void {
      const totInt = Math.round(totalScore);
      if (totInt !== lastTotalInt) {
        lastTotalInt = totInt;
        totalScoreEl.textContent = String(totInt);
      }

      const gInt = Math.round(gameScore);
      if (gInt !== lastGameInt) {
        lastGameInt = gInt;
        gameScoreEl.textContent = `GAME: ${gInt}`;
      }

      const accent = palette.accent || '#f59e0b';
      if (accent !== lastAccentCol) {
        lastAccentCol = accent;
        totalScoreEl.style.color = accent;
        progressBarEl.style.backgroundColor = accent;
      }

      const primary = palette.primary || '#38bdf8';
      if (primary !== lastPrimaryCol) {
        lastPrimaryCol = primary;
        titleEl.style.color = primary;
      }

      const pct = duration > 0 ? Math.max(0, Math.min(100, (songTime / duration) * 100)) : 0;
      const pctStr = `${pct.toFixed(1)}%`;
      if (pctStr !== lastPctStr) {
        lastPctStr = pctStr;
        progressBarEl.style.width = pctStr;
      }

      if (popups.length > 0) {
        const now = performance.now();
        for (let i = popups.length - 1; i >= 0; i--) {
          const age = (now - popups[i].bornAt) / 650;
          if (age >= 1) {
            popups[i].el.remove();
            popups.splice(i, 1);
          } else {
            popups[i].el.style.opacity = (1 - age).toFixed(2);
            popups[i].el.style.transform = `translateY(${(-age * 18).toFixed(1)}px)`;
          }
        }
      }
    },
  };
}
