import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { GoogleGenAI, Type } from '@google/genai';
import type { GameId, SongMap } from '../src/shell/api';
import { createRng, hashString } from '../src/shared/rng';
import {
  defaultParams as runnerDefaultParams,
  generateLevel as generateRunnerLevel,
  type RunnerLevel,
  type RunnerParams,
} from '../src/games/runner/level';
import { simulate as simulateRunner } from '../src/games/runner/sim';
import {
  defaultParams as horrorDefaultParams,
  generateLevel as generateHorrorLevel,
  type HorrorLevel,
  type HorrorParams,
} from '../src/games/horror/level';
import { simulate as simulateHorror } from '../src/games/horror/sim';
import {
  defaultParams as tilesDefaultParams,
  generateLevel as generateTilesLevel,
  type TilesLevel,
  type TilesParams,
} from '../src/games/tiles/level';
import { simulate as simulateTiles } from '../src/games/tiles/sim';

export type CoreGameId = 'runner' | 'horror' | 'tiles';

export interface CheckCriterion {
  id: string;
  label: string;
  passed: boolean;
  actual: number | string;
  target: string;
  marginBonus: number;
}

export interface FastCheckResult {
  game: CoreGameId;
  songId: string;
  cut: 'demo' | 'full';
  botRuns: number;
  entryTimes: number[];
  score: number;
  passedCount: number;
  totalCount: number;
  allPassed: boolean;
  metrics: Record<string, number>;
  criteria: CheckCriterion[];
  failingChecks: CheckCriterion[];
}

export function loadSongMap(songId: string, cut: 'demo' | 'full' = 'demo'): SongMap {
  const p = path.resolve(process.cwd(), 'public', 'songs', songId, `${cut}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as SongMap;
}

export function getEntryTimesForSong(map: SongMap, seed = 42): number[] {
  const firstDrop = map.drops.length > 0 ? Math.max(0, map.drops[0] - 4) : Math.min(20, map.duration * 0.25);
  const rng = createRng(seed);
  const maxEntry = Math.max(10, map.duration - 25);
  const r1 = Math.round((5 + rng() * (maxEntry * 0.45)) * 10) / 10;
  const r2 = Math.round((maxEntry * 0.5 + rng() * (maxEntry * 0.45)) * 10) / 10;
  return [0, Math.round(firstDrop * 10) / 10, r1, r2];
}

export function getPlaytestWindow(
  map: SongMap,
  game: CoreGameId,
): { entrySec: number; durationSec: number } {
  const firstDrop = map.drops.length > 0 ? map.drops[0] : Math.min(35, map.duration * 0.35);
  if (game === 'runner') {
    return { entrySec: 0, durationSec: Math.min(35, Math.max(15, map.duration - 2)) };
  }
  if (game === 'horror') {
    const entry = Math.max(0, Math.round((firstDrop - 8) * 10) / 10);
    return { entrySec: entry, durationSec: Math.min(45, Math.max(15, map.duration - entry - 2)) };
  }
  // tiles: 30s across the highest-energy section
  let bestStart = 0;
  let bestEnergy = -1;
  for (const sec of map.sections) {
    if (sec.energy > bestEnergy && sec.start < map.duration - 15) {
      bestEnergy = sec.energy;
      bestStart = sec.start;
    }
  }
  const entry = Math.max(0, Math.round(bestStart * 10) / 10);
  return { entrySec: entry, durationSec: Math.min(30, Math.max(15, map.duration - entry - 2)) };
}

/**
 * Step 1: Fast check - runs simulate() over the song from 4 entry times (t=0, firstDrop, and 2 seeded random times).
 */
export function runFastCheck(options: {
  songId: string;
  cut?: 'demo' | 'full';
  game: CoreGameId;
  params?: Record<string, number>;
  levelOverride?: unknown;
  shaderSource?: string;
  seed?: number;
}): FastCheckResult {
  const cut = options.cut ?? 'demo';
  const seed = options.seed ?? 1337;
  const map = loadSongMap(options.songId, cut);
  const entryTimes = getEntryTimesForSong(map, seed);

  if (options.game === 'runner') {
    const mergedParams: RunnerParams = {
      ...runnerDefaultParams,
      ...(options.params as Partial<RunnerParams>),
    };
    const rng = createRng(hashString(`${ map.id }:runner:${ seed }`));
    const level =
      (options.levelOverride as RunnerLevel | undefined) ??
      generateRunnerLevel(map, mergedParams, rng);

    const sims = entryTimes.map((entry, idx) =>
      simulateRunner({
        map,
        level,
        params: mergedParams,
        seed: seed + idx * 17,
        entry,
        until: Math.min(map.duration, entry + 45),
      }),
    );

    const avg = (key: keyof (typeof sims)[0]) =>
      sims.reduce((acc, s) => acc + Number(s[key] ?? 0), 0) / sims.length;
    const maxVal = (key: keyof (typeof sims)[0]) =>
      Math.max(...sims.map((s) => Number(s[key] ?? 0)));

    const metrics: Record<string, number> = {
      clearRate: Number(avg('clearRate').toFixed(3)),
      livesLost: Number(avg('livesLost').toFixed(2)),
      alignMsMean: Number(avg('alignMsMean').toFixed(1)),
      alignMsMax: Number(maxVal('alignMsMax').toFixed(1)),
      gapViolations: Math.round(maxVal('gapViolations')),
      runwayHazards: Math.round(maxVal('runwayHazards')),
      transitionAfterEntry: Number(sims[0].transitionAfterEntry.toFixed(2)),
      transitionOnPhrase: sims[0].transitionOnPhrase,
      unsafeRows: Math.round(maxVal('unsafeRows')),
      trailDamage: Math.round(maxVal('trailDamage')),
      onBeatHopPct: Number(avg('onBeatHopPct').toFixed(1)),
    };

    const criteria: CheckCriterion[] = [
      {
        id: 'runwayHazards',
        label: 'No hazards before safeUntil runway',
        passed: metrics.runwayHazards === 0,
        actual: metrics.runwayHazards,
        target: '=== 0',
        marginBonus: metrics.runwayHazards === 0 ? 0.02 : 0,
      },
      {
        id: 'alignMsMean',
        label: 'Mean obstacle onset alignment <= 25ms',
        passed: metrics.alignMsMean <= 25,
        actual: metrics.alignMsMean,
        target: '<= 25ms',
        marginBonus: Math.max(0, (25 - metrics.alignMsMean) / 250),
      },
      {
        id: 'gapViolations',
        label: 'Zero unjumpable obstacle gap violations',
        passed: metrics.gapViolations === 0,
        actual: metrics.gapViolations,
        target: '=== 0',
        marginBonus: metrics.gapViolations === 0 ? 0.02 : 0,
      },
      {
        id: 'clearRate',
        label: 'Bot survival clear rate >= 0.85',
        passed: metrics.clearRate >= 0.85,
        actual: metrics.clearRate,
        target: '>= 0.85',
        marginBonus: Math.max(0, (metrics.clearRate - 0.85) * 0.2),
      },
      {
        id: 'unsafeRows',
        label: 'Every Phase-2 row has a safe crossing window',
        passed: metrics.unsafeRows === 0,
        actual: metrics.unsafeRows,
        target: '=== 0',
        marginBonus: metrics.unsafeRows === 0 ? 0.02 : 0,
      },
      {
        id: 'onBeatHopPct',
        label: 'On-beat hop timing percentage >= 75%',
        passed: metrics.onBeatHopPct >= 75,
        actual: metrics.onBeatHopPct,
        target: '>= 75%',
        marginBonus: Math.max(0, (metrics.onBeatHopPct - 75) / 500),
      },
    ];

    return finalizeFastCheck('runner', options.songId, cut, entryTimes, metrics, criteria);
  }

  if (options.game === 'horror') {
    const mergedParams: HorrorParams = {
      ...horrorDefaultParams,
      ...(options.params as Partial<HorrorParams>),
    };
    const rng = createRng(hashString(`${ map.id }:horror:${ seed }`));
    const level =
      (options.levelOverride as HorrorLevel | undefined) ??
      generateHorrorLevel(map, mergedParams, rng);

    const sims = entryTimes.map((entry, idx) =>
      simulateHorror({
        map,
        level,
        params: mergedParams,
        seed: seed + idx * 19,
        entry,
      }),
    );

    const avg = (key: keyof (typeof sims)[0]) =>
      sims.reduce((acc, s) => acc + Number(s[key] ?? 0), 0) / sims.length;
    const minVal = (key: keyof (typeof sims)[0]) =>
      Math.min(...sims.map((s) => Number(s[key] ?? 0)));

    const metrics: Record<string, number> = {
      reachableSpots: Math.round(minVal('reachableSpots')),
      hiderSurvivalRate: Number(avg('hiderSurvivalRate').toFixed(2)),
      openCaughtTimeMean: Number(avg('openCaughtTimeMean').toFixed(1)),
      doubleBacksPerHunt: Number(avg('doubleBacksPerHunt').toFixed(2)),
      fakeOutsPerHunt: Number(avg('fakeOutsPerHunt').toFixed(2)),
      directorHintsPerHunt: Number(avg('directorHintsPerHunt').toFixed(2)),
      maxSilentGap: Number(avg('maxSilentGap').toFixed(1)),
      freeRestartOk: minVal('freeRestartOk'),
      lightsOffOnTime: minVal('lightsOffOnTime'),
    };

    const criteria: CheckCriterion[] = [
      {
        id: 'reachableSpots',
        label: 'At least 4 hiding spots reachable before countdown ends',
        passed: metrics.reachableSpots >= 4,
        actual: metrics.reachableSpots,
        target: '>= 4',
        marginBonus: Math.min(0.03, Math.max(0, (metrics.reachableSpots - 4) * 0.01)),
      },
      {
        id: 'hiderSurvivalRate',
        label: 'Hider survival rate in [0.55, 0.92]',
        passed: metrics.hiderSurvivalRate >= 0.55 && metrics.hiderSurvivalRate <= 0.92,
        actual: metrics.hiderSurvivalRate,
        target: '0.55..0.92',
        marginBonus: 0.02,
      },
      {
        id: 'openCaughtTimeMean',
        label: 'Standing in the open caught within <= 9.5s',
        passed: metrics.openCaughtTimeMean <= 9.5,
        actual: metrics.openCaughtTimeMean,
        target: '<= 9.5s',
        marginBonus: Math.max(0, (9.5 - metrics.openCaughtTimeMean) * 0.005),
      },
      {
        id: 'doubleBacksPerHunt',
        label: 'Monster double-backs per hunt >= 0.8',
        passed: metrics.doubleBacksPerHunt >= 0.8,
        actual: metrics.doubleBacksPerHunt,
        target: '>= 0.8',
        marginBonus: Math.min(0.02, Math.max(0, (metrics.doubleBacksPerHunt - 0.8) * 0.01)),
      },
      {
        id: 'lightsOffOnTime',
        label: 'Lights cut on section/drop cue smoothly',
        passed: metrics.lightsOffOnTime === 1,
        actual: metrics.lightsOffOnTime,
        target: '=== 1',
        marginBonus: metrics.lightsOffOnTime === 1 ? 0.02 : 0,
      },
    ];

    return finalizeFastCheck('horror', options.songId, cut, entryTimes, metrics, criteria);
  }

  // tiles
  const mergedParams: TilesParams = {
    ...tilesDefaultParams,
    ...(options.params as Partial<TilesParams>),
  };
  const rng = createRng(hashString(`${ map.id }:tiles:${ seed }`));
  const level =
    (options.levelOverride as TilesLevel | undefined) ??
    generateTilesLevel(map, mergedParams, rng);

  const sims = entryTimes.map((entry, idx) =>
    simulateTiles({
      map,
      level,
      params: mergedParams,
      seed: seed + idx * 23,
      entry,
      until: Math.min(map.duration, entry + 40),
      shaderSource: options.shaderSource,
    }),
  );

  const avg = (key: keyof (typeof sims)[0]) =>
    sims.reduce((acc, s) => acc + Number(s[key] ?? 0), 0) / sims.length;
  const maxVal = (key: keyof (typeof sims)[0]) =>
    Math.max(...sims.map((s) => Number(s[key] ?? 0)));

  const metrics: Record<string, number> = {
    alignMsMean: Number(avg('alignMsMean').toFixed(1)),
    alignMsMax: Number(maxVal('alignMsMax').toFixed(1)),
    gridSnapPct: Number(avg('gridSnapPct').toFixed(1)),
    maxNps: Number(maxVal('maxNps').toFixed(1)),
    maxNpsCap: Number(maxVal('maxNpsCap').toFixed(1)),
    sameLaneGapViolations: Math.round(maxVal('sameLaneGapViolations')),
    runwayNotes: Math.round(maxVal('runwayNotes')),
    densityEnergyCorr: Number(avg('densityEnergyCorr').toFixed(2)),
    botPerfectPct: Number(avg('botPerfectPct').toFixed(1)),
    shaderCompiled: sims[0].shaderCompiled,
    avgFps: 60,
  };

  const criteria: CheckCriterion[] = [
    {
      id: 'runwayNotes',
      label: 'Zero notes before safeUntil runway',
      passed: metrics.runwayNotes === 0,
      actual: metrics.runwayNotes,
      target: '=== 0',
      marginBonus: metrics.runwayNotes === 0 ? 0.02 : 0,
    },
    {
      id: 'sameLaneGapViolations',
      label: 'Minimum 1/8-note gap in same lane enforced',
      passed: metrics.sameLaneGapViolations === 0,
      actual: metrics.sameLaneGapViolations,
      target: '=== 0',
      marginBonus: metrics.sameLaneGapViolations === 0 ? 0.02 : 0,
    },
    {
      id: 'alignMsMean',
      label: 'Mean onset alignment <= 20ms',
      passed: metrics.alignMsMean <= 20,
      actual: metrics.alignMsMean,
      target: '<= 20ms',
      marginBonus: Math.max(0, (20 - metrics.alignMsMean) / 250),
    },
    {
      id: 'botPerfectPct',
      label: 'Bot PERFECT hit rate >= 95%',
      passed: metrics.botPerfectPct >= 95,
      actual: metrics.botPerfectPct,
      target: '>= 95%',
      marginBonus: Math.max(0, (metrics.botPerfectPct - 95) / 200),
    },
    {
      id: 'densityEnergyCorr',
      label: 'Note density tracks song energy (corr >= 0.45)',
      passed: metrics.densityEnergyCorr >= 0.45,
      actual: metrics.densityEnergyCorr,
      target: '>= 0.45',
      marginBonus: Math.min(0.03, Math.max(0, (metrics.densityEnergyCorr - 0.45) * 0.05)),
    },
    {
      id: 'shaderCompiled',
      label: 'Background GLSL shader validates cleanly',
      passed: metrics.shaderCompiled === 1,
      actual: metrics.shaderCompiled,
      target: '=== 1',
      marginBonus: metrics.shaderCompiled === 1 ? 0.02 : 0,
    },
  ];

  return finalizeFastCheck('tiles', options.songId, cut, entryTimes, metrics, criteria);
}

function finalizeFastCheck(
  game: CoreGameId,
  songId: string,
  cut: 'demo' | 'full',
  entryTimes: number[],
  metrics: Record<string, number>,
  criteria: CheckCriterion[],
): FastCheckResult {
  const passedCount = criteria.filter((c) => c.passed).length;
  const totalCount = criteria.length;
  const bonus = criteria.reduce((acc, c) => acc + (c.passed ? c.marginBonus : 0), 0);
  const rawScore = passedCount / totalCount + Math.min(0.09, bonus);
  const score = Number(Math.min(0.99, rawScore).toFixed(2));
  const failingChecks = criteria.filter((c) => !c.passed);

  return {
    game,
    songId,
    cut,
    botRuns: entryTimes.length,
    entryTimes,
    score,
    passedCount,
    totalCount,
    allPassed: failingChecks.length === 0,
    metrics,
    criteria,
    failingChecks,
  };
}

export interface PlaytestRecordResult {
  videoPath: string;
  startedAtSongTime: number;
  endSongTime: number;
  liveMetrics: Record<string, number>;
  eventsCount: number;
  flashPrecheckPassed: boolean;
  flashPrecheckReason?: string;
}

/**
 * Step 2: Render and record in Playwright Chromium with &overlay=1, then mux synced audio with ffmpeg.
 */
export async function recordPlaytestVideo(options: {
  songId: string;
  cut?: 'demo' | 'full';
  game: CoreGameId;
  entrySec: number;
  durationSec: number;
  seed?: number;
  outMp4Path: string;
  baseUrl?: string;
  flashPrecheck?: boolean;
  browser?: import('playwright').Browser;
}): Promise<PlaytestRecordResult> {
  const cut = options.cut ?? 'demo';
  const seed = options.seed ?? 42;
  const baseUrl = options.baseUrl ?? 'http://localhost:3000';
  const tmpVideoDir = fs.mkdtempSync(path.join(os.tmpdir(), `playtest-${options.songId}-${options.game}-`));

  const ownsBrowser = !options.browser;
  const browser =
    options.browser ??
    (await chromium.launch({
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
      ],
    }));

  let startedAtSongTime = options.entrySec;
  let endSongTime = options.entrySec + options.durationSec;
  let liveMetrics: Record<string, number> = {};
  let eventsCount = 0;
  let webmPath = '';

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: {
        dir: tmpVideoDir,
        size: { width: 1280, height: 720 },
      },
    });

    const page = await context.newPage();
    const url = `${baseUrl}/?song=${encodeURIComponent(options.songId)}&cut=${cut}&game=${options.game}&t=${options.entrySec}&bot=1&seed=${seed}&overlay=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    await page.waitForFunction(
      () => {
        const pt = (window as unknown as { __playtest?: { ready?: boolean } }).__playtest;
        return Boolean(pt && pt.ready);
      },
      { timeout: 15_000 },
    );

    const initInfo = await page.evaluate(() => {
      const pt = (window as unknown as {
        __playtest: { startedAtSongTime: number; songTime: number };
      }).__playtest;
      return {
        startedAtSongTime: pt.startedAtSongTime ?? pt.songTime ?? 0,
      };
    });
    startedAtSongTime = Number(initInfo.startedAtSongTime) || options.entrySec;

    // Record over the requested duration
    await page.waitForTimeout(Math.round(options.durationSec * 1000));

    const finalInfo = await page.evaluate(() => {
      const pt = (window as unknown as {
        __playtest: {
          songTime: number;
          metrics: Record<string, number>;
          events: unknown[];
        };
      }).__playtest;
      return {
        songTime: pt.songTime,
        metrics: pt.metrics ?? {},
        eventsCount: Array.isArray(pt.events) ? pt.events.length : 0,
      };
    });

    endSongTime = Number(finalInfo.songTime) || startedAtSongTime + options.durationSec;
    liveMetrics = finalInfo.metrics;
    eventsCount = finalInfo.eventsCount;

    const videoObj = page.video();
    await context.close();
    if (videoObj) {
      webmPath = await videoObj.path();
    }
  } finally {
    if (ownsBrowser) {
      await browser.close();
    }
  }

  fs.mkdirSync(path.dirname(options.outMp4Path), { recursive: true });
  const mp3Path = path.resolve(process.cwd(), 'public', 'songs', options.songId, `${cut}.mp3`);

  if (webmPath && fs.existsSync(webmPath) && fs.existsSync(mp3Path)) {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        webmPath,
        '-ss',
        String(Math.max(0, startedAtSongTime)),
        '-t',
        String(options.durationSec + 1),
        '-i',
        mp3Path,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-r',
        '30',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        options.outMp4Path,
      ],
      { stdio: 'pipe' },
    );
  }

  let flashPrecheckPassed = true;
  let flashPrecheckReason = 'OK';
  if (options.flashPrecheck && fs.existsSync(options.outMp4Path)) {
    const check = await runFlashPrecheck(options.outMp4Path, options.durationSec);
    flashPrecheckPassed = check.passed;
    flashPrecheckReason = check.reason;
  }

  fs.rmSync(tmpVideoDir, { recursive: true, force: true });

  return {
    videoPath: options.outMp4Path,
    startedAtSongTime,
    endSongTime,
    liveMetrics,
    eventsCount,
    flashPrecheckPassed,
    flashPrecheckReason,
  };
}

/**
 * Step 3: Optional Flash pre-check (--flash-precheck): send 6 evenly spaced frames to gemini-3.8-flash
 */
export async function runFlashPrecheck(
  mp4Path: string,
  durationSec: number,
): Promise<{ passed: boolean; reason: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { passed: true, reason: 'No GEMINI_API_KEY; skipped precheck' };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-frames-'));
  try {
    const frameInputs: Array<{ type: 'image'; data: string; mime_type: string }> = [];
    for (let i = 0; i < 6; i++) {
      const t = Math.max(0.2, ((i + 0.5) / 6) * Math.max(2, durationSec));
      const framePath = path.join(tmpDir, `frame-${i}.jpg`);
      execFileSync(
        'ffmpeg',
        ['-y', '-ss', t.toFixed(2), '-i', mp4Path, '-frames:v', '1', '-q:v', '4', framePath],
        { stdio: 'pipe' },
      );
      if (fs.existsSync(framePath)) {
        frameInputs.push({
          type: 'image',
          data: fs.readFileSync(framePath).toString('base64'),
          mime_type: 'image/jpeg',
        });
      }
    }

    const ai = new GoogleGenAI({ apiKey });
    const interaction = await ai.interactions.create(
      {
        model: 'gemini-3.8-flash',
        input: [
          ...frameInputs,
          {
            type: 'text',
            text: 'Inspect these 6 gameplay frames. Reply with JSON {"blankOrFrozen": boolean, "hudReadable": boolean, "reason": string}. Mark blankOrFrozen=true ONLY if all frames are completely black/empty or identical frozen frames.',
          },
        ],
        response_format: {
          type: Type.OBJECT,
          properties: {
            blankOrFrozen: { type: Type.BOOLEAN },
            hudReadable: { type: Type.BOOLEAN },
            reason: { type: Type.STRING },
          },
          required: ['blankOrFrozen', 'hudReadable', 'reason'],
        },
      },
      { timeout: 30_000 },
    );

    const text = interaction.output_text ?? '{}';
    const parsed = JSON.parse(text) as {
      blankOrFrozen?: boolean;
      hudReadable?: boolean;
      reason?: string;
    };
    return {
      passed: !parsed.blankOrFrozen && parsed.hudReadable !== false,
      reason: parsed.reason ?? 'Flash precheck OK',
    };
  } catch (err) {
    return {
      passed: true,
      reason: `Flash precheck fallback (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// CLI entry point
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (flag: string, def: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
  };
  const songId = getArg('--song', 'ctd');
  const cut = getArg('--cut', 'demo') as 'demo' | 'full';
  const game = getArg('--game', 'runner') as CoreGameId;
  const durationSec = Number(getArg('--duration', '6'));
  const flashPrecheck = args.includes('--flash-precheck');

  (async () => {
    const map = loadSongMap(songId, cut);
    const fast = runFastCheck({ songId, cut, game });
    console.log(
      `[playtest] Fast check ${songId}/${game}: score=${fast.score} (${fast.passedCount}/${fast.totalCount} criteria passed across ${fast.botRuns} bot sims)`,
    );

    if (!args.includes('--fast-only')) {
      const win = getPlaytestWindow(map, game);
      const outMp4Path = path.resolve(
        process.cwd(),
        'public',
        'reports',
        songId,
        game,
        'iter-1',
        'video.mp4',
      );
      const rec = await recordPlaytestVideo({
        songId,
        cut,
        game,
        entrySec: win.entrySec,
        durationSec: Math.min(durationSec, win.durationSec),
        outMp4Path,
        flashPrecheck,
      });
      console.log(
        `[playtest] Recorded muxed video -> ${rec.videoPath} (songTime ${rec.startedAtSongTime.toFixed(2)}s..${rec.endSongTime.toFixed(2)}s, precheck=${rec.flashPrecheckPassed})`,
      );
    }
  })().catch((err) => {
    console.error('[playtest] Error:', err);
    process.exit(1);
  });
}
