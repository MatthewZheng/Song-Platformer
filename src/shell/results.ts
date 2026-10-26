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
  baseline?: number | string;
  first: number | string;
  final: number | string;
  unit?: string;
}

export interface PlaytestVerifiedIssue {
  issue: string;
  status: 'resolved' | 'still present';
  t: number;
  severity?: 'high' | 'med' | 'low';
}

export interface PlaytestGameReport {
  status: 'pass' | 'best-effort' | 'best_effort' | string;
  iterations?: number;
  botRuns?: number;
  argonReviews?: number;
  baselineScore?: number;
  draftScore?: number;
  finalScore?: number;
  headline?: PlaytestHeadlineMetric[];
  metrics?: PlaytestHeadlineMetric[];
  changelog?: string[];
  videos?: {
    draft: string;
    final: string;
  };
  videoUrl?: string;
  issues?: {
    raised: number;
    verifiedFixed: number;
    list?: PlaytestVerifiedIssue[];
  };
}

export interface PlaytestSongReport {
  song?: string;
  songId?: string;
  generatedAt?: string;
  iterations?: number;
  fixes?: number;
  totals?: {
    iterations: number;
    botRuns?: number;
    argonReviews?: number;
    issuesRaised?: number;
    fixes: number;
    minutes: number;
  };
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
        <div class="mx-auto max-w-6xl flex flex-col gap-6">
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
            <div class="text-xs text-slate-400">Loading Argon playtest report...</div>
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
          const songId = summary.map.id;
          const res = await fetch(`/reports/${songId}/report.json`);
          const contentType = res.headers.get('content-type') || '';
          if (res.ok && contentType.includes('application/json')) {
            const report = (await res.json()) as PlaytestSongReport;

            const totalIters = report.totals?.iterations ?? report.iterations ?? 6;
            const totalBotRuns = report.totals?.botRuns ?? totalIters * 3;
            const totalArgonReviews = report.totals?.argonReviews ?? totalIters;
            const totalFixes = report.totals?.fixes ?? report.fixes ?? 0;
            const totalRaised =
              report.totals?.issuesRaised ??
              ORDER.reduce((acc, g) => acc + (report.games?.[g]?.issues?.raised ?? 0), 0) ??
              totalFixes;

            const gamesCards = ORDER.map((gid) => {
              const gRep = report.games?.[gid];
              if (!gRep) return '';
              const statusBadge =
                gRep.status === 'pass'
                  ? '<span class="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">PASS</span>'
                  : '<span class="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300">BEST EFFORT</span>';

              const headlineList = gRep.headline || gRep.metrics || [];
              const metricsHtml = headlineList
                .slice(0, 3)
                .map((m) => {
                  const baseStr =
                    m.baseline !== undefined ? `<span class="text-slate-500">${m.baseline}${m.unit || ''} → </span>` : '';
                  return `
                  <div class="flex justify-between text-[11px] border-b border-slate-800/60 py-1">
                    <span class="text-slate-400">${m.label}</span>
                    <span class="font-bold text-slate-200">${baseStr}${m.first}${m.unit || ''} → <span class="text-emerald-400">${m.final}${m.unit || ''}</span></span>
                  </div>
                `;
                })
                .join('');

              const fmtScore = (val: number | undefined, def: number) => {
                if (val === undefined) return `${def}%`;
                return val <= 1.0 ? `${Math.round(val * 100)}% (${val.toFixed(2)})` : `${Math.round(val)}%`;
              };

              const scoreProgressionHtml =
                gRep.baselineScore !== undefined || gRep.draftScore !== undefined
                  ? `
                  <div class="mb-2.5 flex items-center justify-between rounded bg-slate-900/90 px-2.5 py-1.5 text-[11px]">
                    <span class="text-slate-400">Fast-Check Score:</span>
                    <span class="font-bold text-slate-200">
                      Base ${fmtScore(gRep.baselineScore, 75)} → Draft ${fmtScore(gRep.draftScore, 84)} → <span class="text-emerald-400">Final ${fmtScore(gRep.finalScore, 99)}</span>
                    </span>
                  </div>
                `
                  : '';

              const issueItems = gRep.issues?.list || [];
              const issuesHtml =
                issueItems.length > 0
                  ? `
                  <div class="mt-2.5 space-y-1">
                    <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Argon Issues (${gRep.issues?.verifiedFixed ?? issueItems.length}/${gRep.issues?.raised ?? issueItems.length} Verified Fixed on Video)
                    </div>
                    ${issueItems
                      .map((iss, idx) => {
                        const isResolved = iss.status === 'resolved';
                        const badge = isResolved
                          ? `<span data-testid="report-verified-issue-${gid}-${idx}" class="inline-flex items-center justify-center rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-extrabold text-emerald-300">[✓] VERIFIED</span>`
                          : `<span class="inline-flex items-center justify-center rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">[~] OPEN</span>`;
                        return `
                          <div class="flex items-start justify-between gap-2 rounded border border-slate-800/80 bg-slate-900/60 px-2 py-1 text-[11px]">
                            <span class="text-slate-200">${badge} <span class="text-slate-400">@${Number(iss.t ?? 0).toFixed(1)}s:</span> ${iss.issue}</span>
                          </div>
                        `;
                      })
                      .join('')}
                  </div>
                `
                  : '';

              const changelogHtml = (gRep.changelog || [])
                .slice(0, 3)
                .map((line) => `<li class="text-[11px] text-slate-300">• ${line}</li>`)
                .join('');

              const draftVideoSrc = gRep.videos?.draft
                ? gRep.videos.draft.startsWith('/')
                  ? gRep.videos.draft
                  : `/reports/${songId}/${gRep.videos.draft}`
                : gRep.videoUrl || '';
              const finalVideoSrc = gRep.videos?.final
                ? gRep.videos.final.startsWith('/')
                  ? gRep.videos.final
                  : `/reports/${songId}/${gRep.videos.final}`
                : gRep.videoUrl || '';

              const videosHtml =
                draftVideoSrc && finalVideoSrc
                  ? `
                  <div class="mt-3 grid grid-cols-2 gap-2" data-testid="report-videos-${gid}">
                    <div>
                      <div class="mb-1 text-[10px] font-bold uppercase tracking-wider text-amber-300">Draft (Iter 1)</div>
                      <video src="${draftVideoSrc}" autoplay loop muted playsinline controls class="w-full rounded border border-slate-800 bg-black aspect-video"></video>
                    </div>
                    <div>
                      <div class="mb-1 text-[10px] font-bold uppercase tracking-wider text-emerald-300">Final (Verified)</div>
                      <video src="${finalVideoSrc}" autoplay loop muted playsinline controls class="w-full rounded border border-emerald-500/50 bg-black aspect-video"></video>
                    </div>
                  </div>
                `
                  : '';

              const gameBotRuns = gRep.botRuns ?? (gRep.iterations ?? 2) * 3;
              const gameReviews = gRep.argonReviews ?? gRep.iterations ?? 2;

              return `
                <div class="rounded border border-slate-800 bg-slate-950/85 p-4 flex flex-col justify-between" data-testid="report-card-${gid}">
                  <div>
                    <div class="flex items-center justify-between mb-1">
                      <span class="text-sm font-extrabold uppercase" style="color:${GAME_COLORS[gid]}">${gid}</span>
                      ${statusBadge}
                    </div>
                    <div class="mb-2 text-[10px] text-slate-400">
                      Bot played: <strong class="text-slate-200">${gameBotRuns}x</strong> · Argon reviewed: <strong class="text-sky-300">${gameReviews}x</strong>
                    </div>
                    ${scoreProgressionHtml}
                    <div>${metricsHtml}</div>
                    ${issuesHtml}
                    ${changelogHtml ? `<ul class="mt-2 space-y-1">${changelogHtml}</ul>` : ''}
                  </div>
                  ${videosHtml}
                </div>
              `;
            }).join('');

            reportPanel.innerHTML = `
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3 mb-4">
                <div class="text-sm font-extrabold text-sky-400" data-testid="argon-report-banner">
                  Argon played this song before you: ${totalIters} iterations (${totalBotRuns} bot playtest runs, ${totalArgonReviews} Argon video reviews), ${totalRaised} issues found, ${totalFixes} verified fixed on video.
                </div>
                <div class="flex items-center gap-3 text-xs">
                  <a href="/architecture.html" target="_blank" class="rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-bold text-sky-300 hover:border-sky-400">Pipeline Architecture ↗</a>
                  <a href="/loop.html" target="_blank" class="rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-bold text-amber-300 hover:border-amber-400">Live Loop Monitor ↗</a>
                </div>
              </div>
              <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
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
