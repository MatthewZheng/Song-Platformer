import type { GameId, SongMap } from './api';
import { ORDER } from './config';

export interface PerGameRunStats {
  id: GameId;
  title: string;
  score: number;
  timeSpent: number;
  deaths: number;
  onBeatActions: number;
  totalTimedActions: number;
  enteredCount: number;
}

export interface DeathMarker {
  songTime: number;
  gameId: GameId;
}

export interface RunSummary {
  map: SongMap;
  totalScore: number;
  totalDeaths: number;
  gamesReached: number;
  perGame: Record<GameId, PerGameRunStats>;
  deathMarkers: DeathMarker[];
}

export interface PlaytestHeadlineMetric {
  label: string;
  first: number | string;
  final: number | string;
  unit?: string;
}

export interface PlaytestGameReport {
  status: 'pass' | 'best_effort' | string;
  metrics?: PlaytestHeadlineMetric[];
  changelog?: string[];
  videoUrl?: string;
}

export interface PlaytestSongReport {
  songId: string;
  iterations: number;
  fixes: number;
  games?: Partial<Record<GameId, PlaytestGameReport>>;
}

const GAME_COLORS: Record<GameId, string> = {
  runner: '#f59e0b',
  horror: '#ef4444',
  tiles: '#38bdf8',
  rail: '#a855f7',
};

export interface ResultsScreen {
  element: HTMLElement;
  show(
    summary: RunSummary,
    onPlayAgain: () => void,
    onPickSong: () => void,
  ): Promise<void>;
  hide(): void;
}

export function createResultsScreen(parent: HTMLElement): ResultsScreen {
  const container = document.createElement('div');
  container.id = 'results-screen';
  container.dataset.testid = 'results-screen';
  container.className =
    'pointer-events-auto absolute inset-0 z-30 hidden overflow-y-auto bg-slate-950/95 p-6 md:p-10 font-mono text-slate-100';
  parent.appendChild(container);

  function drawRunWaveform(canvas: HTMLCanvasElement, summary: RunSummary): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = 900 * dpr;
    const H = 130 * dpr;
    canvas.width = W;
    canvas.height = H;

    const map = summary.map;
    const dur = Math.max(0.01, map.duration);
    const xOf = (t: number) => Math.max(0, Math.min(W, (t / dur) * W));

    ctx.fillStyle = '#090b12';
    ctx.fillRect(0, 0, W, H);

    // Section background tints
    (map.sections || []).forEach((sec, idx) => {
      const pal = map.palette?.perSection?.[idx] || map.palette;
      const x0 = xOf(sec.start);
      const x1 = xOf(sec.end);
      ctx.fillStyle = (pal?.primary || '#38bdf8') + '18';
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
    });

    // Waveform peaks
    const peaks = map.waveform?.peaks || [];
    const midY = H * 0.55;
    if (peaks.length > 0) {
      ctx.fillStyle = (map.palette?.primary || '#38bdf8') + 'aa';
      const step = Math.max(1, Math.floor(peaks.length / W));
      for (let px = 0; px < W; px++) {
        const idx0 = Math.floor((px / W) * peaks.length);
        const idx1 = Math.min(peaks.length, idx0 + step);
        let maxP = 0;
        for (let j = idx0; j < idx1; j++) {
          if (peaks[j] > maxP) maxP = peaks[j];
        }
        const amp = maxP * (H * 0.36);
        ctx.fillRect(px, midY - amp, 1, Math.max(1, amp * 2));
      }
    }

    // Death markers colored by game
    summary.deathMarkers.forEach((dm) => {
      const dx = xOf(dm.songTime);
      const col = GAME_COLORS[dm.gameId] || '#f43f5e';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(dx, 10 * dpr);
      ctx.lineTo(dx, H - 6 * dpr);
      ctx.stroke();

      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(dx, 14 * dpr, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  return {
    element: container,

    async show(
      summary: RunSummary,
      onPlayAgain: () => void,
      onPickSong: () => void,
    ): Promise<void> {
      container.classList.remove('hidden');

      let totalOnBeat = 0;
      let totalTimed = 0;
      ORDER.forEach((gid) => {
        totalOnBeat += summary.perGame[gid].onBeatActions;
        totalTimed += summary.perGame[gid].totalTimedActions;
      });
      const overallOnBeatPct = totalTimed > 0 ? Math.round((totalOnBeat / totalTimed) * 100) : 100;

      const rowsHtml = ORDER.map((gid) => {
        const st = summary.perGame[gid];
        const pct =
          st.totalTimedActions > 0
            ? `${Math.round((st.onBeatActions / st.totalTimedActions) * 100)}%`
            : '—';
        const col = GAME_COLORS[gid];
        return `
          <tr class="border-b border-slate-800/80 text-xs">
            <td class="py-2.5 pr-4 font-bold uppercase" style="color: ${col}">
              <span class="inline-block w-2.5 h-2.5 rounded-full mr-2" style="background:${col}"></span>${st.title}
            </td>
            <td class="py-2.5 px-3 text-right font-bold text-slate-100">${Math.round(st.score)}</td>
            <td class="py-2.5 px-3 text-right text-slate-300">${st.timeSpent.toFixed(1)}s</td>
            <td class="py-2.5 px-3 text-right text-amber-300">${pct}</td>
            <td class="py-2.5 pl-3 text-right text-rose-400">${st.deaths}</td>
          </tr>
        `;
      }).join('');

      container.innerHTML = `
        <div class="mx-auto max-w-5xl flex flex-col gap-6">
          <div class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
            <div>
              <div class="text-xs uppercase tracking-widest text-slate-400">RUN COMPLETE · ${summary.map.title}</div>
              <h1 class="mt-1 text-4xl font-black tracking-tight text-amber-400" style="font-variant-numeric: tabular-nums;" data-testid="results-total-score">
                ${Math.round(summary.totalScore)} <span class="text-lg font-normal text-slate-400">PTS</span>
              </h1>
            </div>

            <div class="flex flex-wrap items-center gap-6 text-right" style="font-variant-numeric: tabular-nums;">
              <div>
                <div class="text-[10px] uppercase tracking-wider text-slate-400">ON-BEAT %</div>
                <div class="text-xl font-bold text-sky-400">${overallOnBeatPct}%</div>
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-wider text-slate-400">DEATHS</div>
                <div class="text-xl font-bold text-rose-400" data-testid="results-deaths">${summary.totalDeaths}</div>
              </div>
              <div>
                <div class="text-[10px] uppercase tracking-wider text-slate-400">GAMES REACHED</div>
                <div class="text-xl font-bold text-emerald-400" data-testid="results-games-reached">${summary.gamesReached} / ${ORDER.length}</div>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div class="rounded-lg border border-slate-800 bg-slate-900/75 p-5">
              <div class="text-xs font-bold uppercase tracking-wider text-slate-300 mb-3">Per-Game Breakdown</div>
              <table class="w-full border-collapse" style="font-variant-numeric: tabular-nums;">
                <thead>
                  <tr class="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-400">
                    <th class="pb-2 text-left">Game</th>
                    <th class="pb-2 px-3 text-right">Score</th>
                    <th class="pb-2 px-3 text-right">Time</th>
                    <th class="pb-2 px-3 text-right">On-Beat</th>
                    <th class="pb-2 pl-3 text-right">Deaths</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml}
                </tbody>
              </table>
            </div>

            <div class="rounded-lg border border-slate-800 bg-slate-900/75 p-5 flex flex-col justify-between">
              <div>
                <div class="flex items-center justify-between mb-2">
                  <span class="text-xs font-bold uppercase tracking-wider text-slate-300">Your Run on the Waveform</span>
                  <span class="text-[11px] text-slate-400">Dots mark deaths colored by game</span>
                </div>
                <canvas id="results-waveform" class="w-full h-32 rounded border border-slate-800 bg-slate-950"></canvas>
              </div>
              <div class="mt-3 flex flex-wrap gap-4 text-[11px] text-slate-400">
                <span><i class="inline-block w-2 h-2 rounded-full mr-1" style="background:#f59e0b"></i>Runner</span>
                <span><i class="inline-block w-2 h-2 rounded-full mr-1" style="background:#ef4444"></i>Horror</span>
                <span><i class="inline-block w-2 h-2 rounded-full mr-1" style="background:#38bdf8"></i>Tiles</span>
              </div>
            </div>
          </div>

          <div id="results-report-panel" data-testid="results-report-panel" class="rounded-lg border border-slate-800 bg-slate-900/75 p-5">
            <div class="text-xs text-slate-400">Checking playtest report...</div>
          </div>

          <div class="flex flex-wrap items-center gap-4 pt-2">
            <button
              id="results-play-again"
              type="button"
              data-start="true"
              class="cursor-pointer rounded bg-amber-400 px-6 py-3 text-xs font-extrabold uppercase tracking-wider text-slate-950 transition hover:bg-amber-300"
            >
              Play Again (Same Song)
            </button>
            <button
              id="results-pick-song"
              type="button"
              class="cursor-pointer rounded border border-slate-700 bg-slate-800 px-6 py-3 text-xs font-bold uppercase tracking-wider text-slate-100 transition hover:border-sky-400"
            >
              Pick Another Song
            </button>
          </div>
        </div>
      `;

      const wfCanvas = container.querySelector<HTMLCanvasElement>('#results-waveform');
      if (wfCanvas) {
        drawRunWaveform(wfCanvas, summary);
      }

      container.querySelector<HTMLButtonElement>('#results-play-again')?.addEventListener('click', onPlayAgain);
      container.querySelector<HTMLButtonElement>('#results-pick-song')?.addEventListener('click', onPickSong);

      // Load Playtest Report if it exists
      const reportPanel = container.querySelector<HTMLElement>('#results-report-panel');
      if (reportPanel) {
        try {
          const res = await fetch(`/reports/${summary.map.id}/report.json`);
          const contentType = res.headers.get('content-type') || '';
          if (res.ok && contentType.includes('application/json')) {
            const report = (await res.json()) as PlaytestSongReport;
            const gamesCards = ORDER.map((gid) => {
              const gRep = report.games?.[gid];
              if (!gRep) return '';
              const statusBadge =
                gRep.status === 'pass'
                  ? '<span class="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">PASS</span>'
                  : '<span class="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300">BEST EFFORT</span>';
              const metricsHtml = (gRep.metrics || [])
                .slice(0, 3)
                .map(
                  (m) => `
                  <div class="flex justify-between text-[11px] border-b border-slate-800/60 py-1">
                    <span class="text-slate-400">${m.label}</span>
                    <span class="font-bold text-slate-200">${m.first}${m.unit || ''} → <span class="text-emerald-400">${m.final}${m.unit || ''}</span></span>
                  </div>
                `,
                )
                .join('');
              const changelogHtml = (gRep.changelog || [])
                .slice(0, 4)
                .map((line) => `<li class="text-[11px] text-slate-300">• ${line}</li>`)
                .join('');
              const videoHtml = gRep.videoUrl
                ? `<video src="${gRep.videoUrl}" autoplay loop muted playsinline class="mt-2 w-full rounded border border-slate-800 bg-black"></video>`
                : '';
              return `
                <div class="rounded border border-slate-800 bg-slate-950/80 p-3.5">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-xs font-extrabold uppercase" style="color:${GAME_COLORS[gid]}">${gid}</span>
                    ${statusBadge}
                  </div>
                  <div>${metricsHtml}</div>
                  ${changelogHtml ? `<ul class="mt-2 space-y-1">${changelogHtml}</ul>` : ''}
                  ${videoHtml}
                </div>
              `;
            }).join('');

            reportPanel.innerHTML = `
              <div class="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                <div class="text-sm font-extrabold text-sky-400">
                  Argon played this song before you did: ${report.iterations ?? 0} iterations, ${report.fixes ?? 0} fixes.
                </div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                ${gamesCards}
              </div>
            `;
          } else {
            reportPanel.innerHTML = `
              <div class="text-xs text-slate-400">No playtest report yet</div>
            `;
          }
        } catch {
          reportPanel.innerHTML = `
            <div class="text-xs text-slate-400">No playtest report yet</div>
          `;
        }
      }
    },

    hide(): void {
      container.classList.add('hidden');
    },
  };
}
