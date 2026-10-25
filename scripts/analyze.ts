import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Palette, SongMap } from '../src/shell/api';
import {
  buildPhrases,
  downsampleWaveform,
  projectSemanticsToDemo,
  roundTime,
  type DspOutput,
} from '../src/shared/songmap';
import { runSemanticAnalysis } from './semantic';

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

export function slugifyFilename(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'song'
  );
}

function runDspAnalyze(mp3Path: string, outJsonPath: string): DspOutput {
  const out = execFileSync('python', ['analysis/analyze.py', mp3Path, outJsonPath], {
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(out);
  return JSON.parse(fs.readFileSync(outJsonPath, 'utf-8')) as DspOutput;
}

function cutDemoMp3(
  fullMp3Path: string,
  demoMp3Path: string,
  startSec: number,
  endSec: number,
): void {
  const winDur = Math.max(5.0, roundTime(endSec - startSec));
  const fadeOutStart = Math.max(1.0, roundTime(winDur - 2.0));

  // Cut demoWindow with 1s fade in, 2s fade out, and EBU R128 loudness normalization
  const afFilter = `loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=2`;
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-ss',
      String(startSec),
      '-t',
      String(winDur),
      '-i',
      fullMp3Path,
      '-af',
      afFilter,
      '-acodec',
      'libmp3lame',
      '-b:a',
      '192k',
      demoMp3Path,
    ],
    { stdio: 'inherit' },
  );
}

export async function analyzeSingleSong(mp3InputPath: string): Promise<{
  fullMap: SongMap;
  demoMap: SongMap;
}> {
  const absInput = path.resolve(mp3InputPath);
  if (!fs.existsSync(absInput)) {
    throw new Error(`Input MP3 not found: ${absInput}`);
  }

  const id = slugifyFilename(absInput);
  const outDir = path.resolve('public/songs', id);
  fs.mkdirSync(path.join(outDir, 'levels'), { recursive: true });

  const fullMp3Path = path.join(outDir, 'full.mp3');
  fs.copyFileSync(absInput, fullMp3Path);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `song-arcade-${id}-`));
  const fullDspPath = path.join(tmpDir, 'full.dsp.json');
  const demoDspPath = path.join(tmpDir, 'demo.dsp.json');

  console.log(`\n========================================`);
  console.log(`[analyze] Processing song "${id}" from ${path.basename(absInput)}`);
  console.log(`========================================`);

  const fullDsp = runDspAnalyze(fullMp3Path, fullDspPath);
  const semantic = await runSemanticAnalysis(fullDsp, fullMp3Path, id.toUpperCase());

  const fullPhrases = buildPhrases(
    fullDsp.downbeats,
    semantic.sections.map((s) => s.start),
  );

  const fullMap: SongMap = {
    id,
    title: semantic.title,
    file: `/songs/${id}/full.mp3`,
    duration: fullDsp.duration,
    bpm: fullDsp.bpm,
    beats: fullDsp.beats,
    downbeats: fullDsp.downbeats,
    phrases: fullPhrases,
    onsets: fullDsp.onsets,
    envelope: fullDsp.envelope,
    waveform: fullDsp.waveform,
    melody: fullDsp.melody,
    sections: semantic.sections,
    drops: semantic.drops,
    palette: semantic.palette,
    rail: semantic.rail,
    demoWindow: semantic.demoWindow,
  };

  const fullJsonPath = path.join(outDir, 'full.json');
  fs.writeFileSync(fullJsonPath, JSON.stringify(fullMap, null, 2), 'utf-8');
  console.log(`[analyze] Wrote ${path.relative(process.cwd(), fullJsonPath)}`);

  // Cut demo.mp3 and run DSP on demo.mp3
  const demoMp3Path = path.join(outDir, 'demo.mp3');
  console.log(
    `[analyze] Cutting demo.mp3 (${semantic.demoWindow.start.toFixed(2)}s .. ${semantic.demoWindow.end.toFixed(2)}s, dur ${(semantic.demoWindow.end - semantic.demoWindow.start).toFixed(2)}s)...`,
  );
  cutDemoMp3(fullMp3Path, demoMp3Path, semantic.demoWindow.start, semantic.demoWindow.end);

  const demoDsp = runDspAnalyze(demoMp3Path, demoDspPath);
  const projected = projectSemanticsToDemo(fullMap, demoDsp, semantic.demoWindow.start);

  const demoMap: SongMap = {
    id,
    title: semantic.title,
    file: `/songs/${id}/demo.mp3`,
    duration: demoDsp.duration,
    bpm: fullDsp.bpm,
    beats: demoDsp.beats,
    downbeats: demoDsp.downbeats,
    phrases: projected.phrases,
    onsets: demoDsp.onsets,
    envelope: demoDsp.envelope,
    waveform: demoDsp.waveform,
    melody: demoDsp.melody,
    sections: projected.sections,
    drops: projected.drops,
    palette: {
      bg: semantic.palette.bg,
      primary: semantic.palette.primary,
      secondary: semantic.palette.secondary,
      accent: semantic.palette.accent,
      highlight: semantic.palette.highlight,
      perSection: projected.perSectionPalette,
    },
    rail: {
      districts: projected.districts,
    },
    demoWindow: {
      start: 0,
      end: demoDsp.duration,
    },
  };

  const demoJsonPath = path.join(outDir, 'demo.json');
  fs.writeFileSync(demoJsonPath, JSON.stringify(demoMap, null, 2), 'utf-8');
  console.log(`[analyze] Wrote ${path.relative(process.cwd(), demoJsonPath)}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  updateSongsIndex();

  return { fullMap, demoMap };
}

export function updateSongsIndex(): SongIndexEntry[] {
  const songsRoot = path.resolve('public/songs');
  if (!fs.existsSync(songsRoot)) return [];

  const entries: SongIndexEntry[] = [];
  const dirs = fs
    .readdirSync(songsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dirName of dirs) {
    const fullJsonPath = path.join(songsRoot, dirName, 'full.json');
    const demoJsonPath = path.join(songsRoot, dirName, 'demo.json');
    if (!fs.existsSync(fullJsonPath)) continue;

    const fullMap = JSON.parse(fs.readFileSync(fullJsonPath, 'utf-8')) as SongMap;
    const demoMap = fs.existsSync(demoJsonPath)
      ? (JSON.parse(fs.readFileSync(demoJsonPath, 'utf-8')) as SongMap)
      : null;

    entries.push({
      id: fullMap.id,
      title: fullMap.title,
      bpm: fullMap.bpm,
      duration: fullMap.duration,
      demoDuration: demoMap?.duration ?? roundTime(fullMap.demoWindow.end - fullMap.demoWindow.start),
      demoWindow: fullMap.demoWindow,
      palette: {
        bg: fullMap.palette.bg,
        primary: fullMap.palette.primary,
        secondary: fullMap.palette.secondary,
        accent: fullMap.palette.accent,
        highlight: fullMap.palette.highlight,
      },
      waveform: downsampleWaveform(fullMap.waveform.peaks, 200),
    });
  }

  const indexPath = path.join(songsRoot, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2), 'utf-8');
  console.log(`[analyze] Updated public/songs/index.json (${entries.length} song(s))`);
  return entries;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/analyze.ts <mp3> | --all');
    process.exit(1);
  }

  let mp3Files: string[] = [];
  if (args.includes('--all')) {
    const songsDir = path.resolve('songs');
    mp3Files = fs
      .readdirSync(songsDir)
      .filter((f) => f.toLowerCase().endsWith('.mp3'))
      .sort()
      .map((f) => path.join(songsDir, f));
  } else {
    mp3Files = args.map((a) => path.resolve(a));
  }

  if (mp3Files.length === 0) {
    console.error('No .mp3 files found to analyze.');
    process.exit(1);
  }

  const results: Array<{ fullMap: SongMap; demoMap: SongMap }> = [];
  for (const mp3 of mp3Files) {
    const res = await analyzeSingleSong(mp3);
    results.push(res);
  }

  console.log('\n=== SONG ANALYSIS COMPLETE ===');
  for (const { fullMap } of results) {
    const winDur = roundTime(fullMap.demoWindow.end - fullMap.demoWindow.start);
    const secSummary = fullMap.sections
      .map((s) => `${s.label}(${s.mood}@${s.start.toFixed(1)}s)`)
      .join(' -> ');
    const flags: string[] = [];
    if (fullMap.bpm < 70 || fullMap.bpm > 180) flags.push(`BPM_OUT_OF_RANGE(${fullMap.bpm})`);
    if (fullMap.sections.length < 4) flags.push(`FEW_SECTIONS(${fullMap.sections.length})`);
    if (fullMap.drops.length === 0) flags.push('NO_DROPS');
    console.log(
      `- [${fullMap.id}] "${fullMap.title}" | BPM: ${fullMap.bpm} | Dur: ${fullMap.duration.toFixed(1)}s | Demo: ${fullMap.demoWindow.start.toFixed(1)}..${fullMap.demoWindow.end.toFixed(1)}s (${winDur.toFixed(1)}s) | Drops: [${fullMap.drops.map((d) => d.toFixed(1) + 's').join(', ')}] | Flags: ${flags.length ? flags.join(', ') : 'NONE'}`,
    );
    console.log(`  Sections: ${secSummary}`);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
