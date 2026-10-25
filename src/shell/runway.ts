import type { ControlHint, Palette } from './api';
import { RUNWAY, RUNWAY_MIN_EARLY } from './config';

export interface RunwayCard {
  element: HTMLElement;
  enter(gameTitle: string, listensTo: string, controls: ControlHint[], entrySongTime: number): void;
  recordKeyInput(code: string, key: string): void;
  recordPointerInput(): void;
  /**
   * Updates the runway card and returns the effective `safeUntil` song time.
   * Once all controls are tried (and >= 2.0s have elapsed), ends the runway early and fades out over 200ms.
   */
  update(songTime: number, palette: Palette): { active: boolean; safeUntil: number };
  hide(): void;
}

function formatKeyCap(rawKey: string): string {
  switch (rawKey) {
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'Space':
    case ' ':
      return 'SPACE';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'SHIFT';
    case 'MouseLeft':
    case 'Click':
      return 'CLICK';
    default:
      return rawKey.replace(/^Key/, '').toUpperCase();
  }
}

export function createRunwayCard(parent: HTMLElement): RunwayCard {
  const container = document.createElement('div');
  container.id = 'runway-card';
  container.dataset.testid = 'runway-card';
  container.className =
    'pointer-events-none absolute inset-x-0 top-28 flex justify-center z-20 hidden transition-opacity duration-200';
  parent.appendChild(container);

  let controlsList: ControlHint[] = [];
  let triedFlags: boolean[] = [];
  let entryTime = 0;
  let earlyFinishTriggerTime: number | null = null;
  let visible = false;

  let rowEls: HTMLElement[] = [];
  let checkEls: HTMLElement[] = [];
  let barFillEl: HTMLElement | null = null;

  function renderDOM(gameTitle: string, listensTo: string): void {
    container.innerHTML = '';
    const card = document.createElement('div');
    card.className =
      'w-full max-w-md rounded-lg border-2 bg-slate-950/90 px-5 py-4 font-mono text-slate-100 shadow-2xl';
    card.style.borderColor = '#38bdf8';

    const header = document.createElement('div');
    header.className = 'flex flex-col gap-0.5 border-b border-slate-800 pb-2.5 mb-3';
    header.innerHTML = `
      <span class="text-sm font-extrabold tracking-wider uppercase text-amber-400">${gameTitle} · SAFETY RUNWAY</span>
      <span class="text-[11px] text-slate-400">Listening to: ${listensTo}</span>
    `;
    card.appendChild(header);

    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'flex flex-col gap-2';
    rowEls = [];
    checkEls = [];

    controlsList.forEach((ctrl, idx) => {
      const row = document.createElement('div');
      row.dataset.testid = `runway-control-${idx}`;
      row.className =
        'flex items-center justify-between rounded border border-slate-800 bg-slate-900/90 px-3 py-2 text-xs transition-colors';

      const keysGroup = document.createElement('div');
      keysGroup.className = 'flex flex-wrap items-center gap-1.5';
      const displayKeys = ctrl.keys.slice(0, 4);
      displayKeys.forEach((k) => {
        const kbd = document.createElement('kbd');
        kbd.className =
          'rounded border border-slate-600 bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-slate-100 shadow-inner';
        kbd.textContent = formatKeyCap(k);
        keysGroup.appendChild(kbd);
      });

      const rightGroup = document.createElement('div');
      rightGroup.className = 'flex items-center gap-2';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'text-slate-200 font-semibold';
      labelSpan.textContent = ctrl.label;

      const checkSpan = document.createElement('span');
      checkSpan.className =
        'inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-700 text-[11px] font-bold text-slate-500';
      checkSpan.textContent = '·';

      rightGroup.appendChild(labelSpan);
      rightGroup.appendChild(checkSpan);

      row.appendChild(keysGroup);
      row.appendChild(rightGroup);
      rowsWrap.appendChild(row);

      rowEls.push(row);
      checkEls.push(checkSpan);
    });

    card.appendChild(rowsWrap);

    if (gameTitle === 'HIDE AND SEEK' || gameTitle === 'TILES') {
      const tipEl = document.createElement('div');
      tipEl.dataset.testid = 'runway-extra-line';
      tipEl.className =
        'mt-2.5 rounded border border-amber-400/30 bg-amber-950/35 px-3 py-1.5 text-center text-xs font-semibold text-amber-300';
      tipEl.textContent =
        gameTitle === 'TILES' ? '5 misses ends the game.' : 'Loud music covers your footsteps.';
      card.appendChild(tipEl);
    }

    const barTrack = document.createElement('div');
    barTrack.className = 'mt-3 h-1.5 w-full overflow-hidden rounded bg-slate-800';
    const barFill = document.createElement('div');
    barFill.className = 'h-full bg-amber-400 transition-none';
    barFill.style.width = '100%';
    barTrack.appendChild(barFill);
    card.appendChild(barTrack);
    barFillEl = barFill;

    container.appendChild(card);
  }

  function markControlTried(idx: number): void {
    if (triedFlags[idx]) return;
    triedFlags[idx] = true;
    const row = rowEls[idx];
    const check = checkEls[idx];
    if (row) {
      row.style.borderColor = '#10b981';
      row.style.backgroundColor = 'rgba(6, 78, 59, 0.45)';
    }
    if (check) {
      check.textContent = '✓';
      check.style.borderColor = '#10b981';
      check.style.backgroundColor = '#10b981';
      check.style.color = '#052e16';
    }
  }

  return {
    element: container,

    enter(gameTitle: string, listensTo: string, controls: ControlHint[], entrySongTime: number): void {
      controlsList = controls.length > 0 ? controls : [{ keys: ['Space'], label: 'Action' }];
      triedFlags = new Array(controlsList.length).fill(false);
      entryTime = entrySongTime;
      earlyFinishTriggerTime = null;
      visible = true;

      renderDOM(gameTitle, listensTo);
      container.style.opacity = '1';
      container.classList.remove('hidden');
    },

    recordKeyInput(code: string, key: string): void {
      if (!visible) return;
      const normKey = key === ' ' ? 'Space' : key;
      controlsList.forEach((ctrl, idx) => {
        if (
          ctrl.keys.some(
            (k) =>
              k.toLowerCase() === code.toLowerCase() ||
              k.toLowerCase() === normKey.toLowerCase() ||
              formatKeyCap(k).toLowerCase() === normKey.toLowerCase(),
          )
        ) {
          markControlTried(idx);
        }
      });
    },

    recordPointerInput(): void {
      if (!visible) return;
      controlsList.forEach((ctrl, idx) => {
        if (ctrl.keys.some((k) => /mouse|click|pointer/i.test(k))) {
          markControlTried(idx);
        }
      });
    },

    update(songTime: number, palette: Palette): { active: boolean; safeUntil: number } {
      const defaultSafeUntil = entryTime + RUNWAY;
      if (!visible) {
        return { active: false, safeUntil: earlyFinishTriggerTime ?? defaultSafeUntil };
      }

      const elapsed = Math.max(0, songTime - entryTime);
      const allTried = triedFlags.length > 0 && triedFlags.every(Boolean);

      if (allTried && earlyFinishTriggerTime === null && elapsed >= RUNWAY_MIN_EARLY) {
        earlyFinishTriggerTime = songTime;
      }

      const effectiveEnd = earlyFinishTriggerTime !== null ? earlyFinishTriggerTime : defaultSafeUntil;
      const totalSpan = Math.max(0.1, effectiveEnd - entryTime);
      const remaining = Math.max(0, effectiveEnd - songTime);

      if (barFillEl) {
        const pct = Math.max(0, Math.min(100, (remaining / RUNWAY) * 100));
        barFillEl.style.width = `${pct.toFixed(1)}%`;
        barFillEl.style.backgroundColor = palette.accent || '#f59e0b';
      }

      // Fade out over 200 ms once effectiveEnd is reached
      if (songTime >= effectiveEnd) {
        const fadeElapsed = songTime - effectiveEnd;
        const opacity = Math.max(0, 1 - fadeElapsed / 0.2);
        container.style.opacity = opacity.toFixed(2);
        if (fadeElapsed >= 0.2) {
          visible = false;
          container.classList.add('hidden');
        }
        return { active: false, safeUntil: effectiveEnd };
      }

      return { active: true, safeUntil: effectiveEnd };
    },

    hide(): void {
      visible = false;
      container.classList.add('hidden');
    },
  };
}
