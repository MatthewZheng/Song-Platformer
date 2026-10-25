import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  Palette,
  RailDistrictEntry,
  RailDistrictType,
  SectionLabel,
  SongMap,
  SongSection,
} from '../src/shell/api';
import {
  VALID_RAIL_DISTRICTS,
  VALID_SECTION_LABELS,
  buildPhrases,
  findNearest,
  meanEnvelopeEnergy,
  roundTime,
  snapToCandidateOrDownbeat,
  type DspOutput,
} from '../src/shared/songmap';

export interface SemanticResult {
  title: string;
  sections: SongSection[];
  drops: number[];
  palette: Palette & { perSection: Palette[] };
  rail: { districts: RailDistrictEntry[] };
  demoWindow: { start: number; end: number };
}

interface CandidateDemoWindow {
  start: number;
  end: number;
  duration: number;
  firstDrop: number;
  dropOffsetInWindow: number;
}

/**
 * Finds all valid demoWindow candidates (95..110s, starting on a downbeat,
 * ending on a phrase boundary, with a drop candidate 35..70s into the window).
 */
export function findValidDemoWindows(
  dsp: DspOutput,
  extraPhraseBoundaries: number[] = [],
): CandidateDemoWindow[] {
  const downbeats = dsp.downbeats;
  const phrases = buildPhrases(
    downbeats,
    [...dsp.sectionCandidates.map((s) => s.start), ...extraPhraseBoundaries],
  );
  const dropTimes = dsp.dropCandidates.map((d) => d.t);
  const candidates: CandidateDemoWindow[] = [];

  for (const start of downbeats) {
    for (const end of phrases) {
      const dur = roundTime(end - start);
      if (dur < 95.0 || dur > 110.0) continue;
      for (const dropT of dropTimes) {
        const offset = roundTime(dropT - start);
        if (offset >= 35.0 && offset <= 70.0 && dropT < end - 8.0) {
          candidates.push({
            start: roundTime(start),
            end: roundTime(end),
            duration: dur,
            firstDrop: roundTime(dropT),
            dropOffsetInWindow: offset,
          });
          break;
        }
      }
    }
  }

  // Sort by highest energy rise of the matched drop, then closeness to 102s duration and 50s drop offset
  const dropRiseMap = new Map<number, number>();
  for (const d of dsp.dropCandidates) {
    dropRiseMap.set(roundTime(d.t), d.energyRise);
  }

  candidates.sort((a, b) => {
    const riseA = dropRiseMap.get(a.firstDrop) ?? 0;
    const riseB = dropRiseMap.get(b.firstDrop) ?? 0;
    if (Math.abs(riseB - riseA) > 0.08) return riseB - riseA;
    const scoreA = Math.abs(a.duration - 102) + Math.abs(a.dropOffsetInWindow - 50) * 0.5;
    const scoreB = Math.abs(b.duration - 102) + Math.abs(b.dropOffsetInWindow - 50) * 0.5;
    return scoreA - scoreB;
  });

  // Deduplicate nearby starts within 4s
  const filtered: CandidateDemoWindow[] = [];
  for (const c of candidates) {
    if (!filtered.some((f) => Math.abs(f.start - c.start) < 4.0)) {
      filtered.push(c);
    }
    if (filtered.length >= 10) break;
  }

  // If no strict match found with existing dropCandidates, search all section boundaries > 35s
  if (filtered.length === 0) {
    const secStarts = dsp.sectionCandidates.slice(1).map((s) => s.start);
    for (const start of downbeats) {
      for (const end of phrases) {
        const dur = roundTime(end - start);
        if (dur < 95.0 || dur > 110.0) continue;
        for (const dropT of secStarts) {
          const offset = roundTime(dropT - start);
          if (offset >= 35.0 && offset <= 70.0 && dropT < end - 8.0) {
            filtered.push({
              start: roundTime(start),
              end: roundTime(end),
              duration: dur,
              firstDrop: roundTime(dropT),
              dropOffsetInWindow: offset,
            });
            break;
          }
        }
        if (filtered.length >= 6) break;
      }
      if (filtered.length >= 6) break;
    }
  }

  return filtered;
}

function getAudioBase64ForApi(mp3Path: string): string {
  const stat = fs.statSync(mp3Path);
  // If over 3.2 MB, transcode full song to mono 48kbps MP3 in memory so base64 stays compact
  if (stat.size > 3_200_000) {
    const buf = execFileSync(
      'ffmpeg',
      ['-v', 'quiet', '-i', mp3Path, '-ac', '1', '-ar', '16000', '-b:a', '48k', '-f', 'mp3', 'pipe:1'],
      { maxBuffer: 25 * 1024 * 1024 },
    );
    return buf.toString('base64');
  }
  return fs.readFileSync(mp3Path).toString('base64');
}

function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

function sanitizeHex(s: unknown, fallback: string): string {
  if (typeof s === 'string') {
    const clean = s.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(clean)) return clean.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(clean)) return `#${clean.toLowerCase()}`;
  }
  return fallback;
}

function sanitizeOneWordMood(mood: unknown, fallback = 'electric'): string {
  if (typeof mood !== 'string' || !mood.trim()) return fallback;
  const word = mood
    .trim()
    .split(/[\s,;/]+/)[0]
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase();
  return word || fallback;
}

export function buildDspFallbackSemantics(
  dsp: DspOutput,
  fallbackTitle: string,
): SemanticResult {
  const cands = dsp.sectionCandidates;
  const energies = cands.map((c) => c.energy);
  const maxE = Math.max(...energies, 0.01);
  const minE = Math.min(...energies);

  const validWindows = findValidDemoWindows(dsp);
  const chosenWindow = validWindows[0] ?? {
    start: dsp.downbeats[0] ?? 0,
    end: Math.min(dsp.duration, (dsp.downbeats[0] ?? 0) + 100),
    duration: Math.min(dsp.duration, 100),
    firstDrop: dsp.dropCandidates[0]?.t ?? cands[Math.min(2, cands.length - 1)]?.start ?? 45,
    dropOffsetInWindow: 45,
  };

  // Pick drops from DSP dropCandidates, ensuring chosenWindow.firstDrop is included
  const dropSet = new Set<number>();
  dropSet.add(roundTime(chosenWindow.firstDrop));
  for (const dc of dsp.dropCandidates.slice(0, 3)) {
    if (dc.energyRise >= 0.08) {
      dropSet.add(roundTime(dc.t));
    }
  }
  const drops = Array.from(dropSet).sort((a, b) => a - b);

  const sections: SongSection[] = cands.map((c, idx) => {
    const normE = (c.energy - minE) / Math.max(0.05, maxE - minE);
    let label: SectionLabel = 'verse';
    let mood = 'driving';

    const isDropStart = drops.some((d) => Math.abs(d - c.start) < 0.25);
    const nextIsDrop = idx + 1 < cands.length && drops.some((d) => Math.abs(d - cands[idx + 1].start) < 0.25);

    if (idx === 0) {
      label = 'intro';
      mood = normE > 0.5 ? 'charged' : 'atmospheric';
    } else if (idx === cands.length - 1) {
      label = 'outro';
      mood = 'fading';
    } else if (isDropStart) {
      label = 'drop';
      mood = 'explosive';
    } else if (nextIsDrop) {
      label = 'build';
      mood = 'rising';
    } else if (normE >= 0.78) {
      label = 'drop';
      mood = 'intense';
    } else if (normE <= 0.35) {
      label = 'breakdown';
      mood = 'suspended';
    } else if (idx > cands.length * 0.6) {
      label = 'bridge';
      mood = 'urgent';
    } else {
      label = 'verse';
      mood = 'pulsing';
    }

    return {
      start: roundTime(c.start),
      end: roundTime(c.end),
      label,
      energy: roundTime(c.energy),
      mood,
    };
  });

  // Ensure demoWindow contains at least one 'build' and one 'drop'
  const inWinIndices = sections
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.end > chosenWindow.start + 1 && s.start < chosenWindow.end - 1);
  if (inWinIndices.length >= 2) {
    const hasDrop = inWinIndices.some(({ s }) => s.label === 'drop');
    const hasBuild = inWinIndices.some(({ s }) => s.label === 'build');
    if (!hasDrop) {
      const dropSec =
        inWinIndices.find(({ s }) => Math.abs(s.start - chosenWindow.firstDrop) < 1.0) ??
        inWinIndices[Math.min(1, inWinIndices.length - 1)];
      sections[dropSec.i].label = 'drop';
    }
    if (!hasBuild) {
      const dropIdxInWin = inWinIndices.findIndex(({ s }) => s.label === 'drop');
      const buildTarget = dropIdxInWin > 0 ? inWinIndices[dropIdxInWin - 1] : inWinIndices[0];
      sections[buildTarget.i].label = 'build';
    }
  }

  const basePalette: Palette = {
    bg: '#090a10',
    primary: '#38bdf8',
    secondary: '#a855f7',
    accent: '#f59e0b',
    highlight: '#f8fafc',
  };

  const sectionPalettes: Record<SectionLabel, Palette> = {
    intro: { bg: '#080b14', primary: '#38bdf8', secondary: '#6366f1', accent: '#22d3ee', highlight: '#f0f9ff' },
    verse: { bg: '#0a0d18', primary: '#2dd4bf', secondary: '#3b82f6', accent: '#f59e0b', highlight: '#f8fafc' },
    build: { bg: '#12091c', primary: '#c084fc', secondary: '#ec4899', accent: '#f97316', highlight: '#fdf4ff' },
    drop: { bg: '#18070f', primary: '#f43f5e', secondary: '#f97316', accent: '#facc15', highlight: '#ffffff' },
    breakdown: { bg: '#071118', primary: '#06b6d4', secondary: '#6366f1', accent: '#a855f7', highlight: '#e0f2fe' },
    bridge: { bg: '#100c1c', primary: '#8b5cf6', secondary: '#ec4899', accent: '#14b8a6', highlight: '#f5f3ff' },
    outro: { bg: '#0b0f17', primary: '#fb923c', secondary: '#38bdf8', accent: '#fde047', highlight: '#fffbeb' },
  };

  const perSection = sections.map((s) => sectionPalettes[s.label] ?? basePalette);

  const districts: RailDistrictEntry[] = sections.map((s, idx) => {
    let district: RailDistrictType = 'approach';
    if (idx === 0 || s.label === 'intro') district = 'outskirts';
    else if (idx === sections.length - 1 || s.label === 'outro') district = 'sunrise';
    else if (s.label === 'drop') district = 'neon_core';
    else if (s.label === 'breakdown' || s.label === 'bridge') district = 'rain_rooftops';
    else district = 'approach';
    return { section: idx, district };
  });

  return {
    title: fallbackTitle,
    sections,
    drops,
    palette: {
      ...basePalette,
      perSection,
    },
    rail: { districts },
    demoWindow: {
      start: roundTime(chosenWindow.start),
      end: roundTime(chosenWindow.end),
    },
  };
}

/**
 * Validates and snaps Argon's raw JSON response against the DSP candidates and rules.
 * Throws a descriptive Error if validation fails so the caller can retry with the error message.
 */
export function validateAndSnapSemantics(
  raw: Record<string, unknown>,
  dsp: DspOutput,
  fallbackTitle: string,
): SemanticResult {
  const title =
    typeof raw.title === 'string' && raw.title.trim().length > 0
      ? raw.title.trim()
      : fallbackTitle;

  const rawSections = Array.isArray(raw.sections) ? raw.sections : [];
  if (rawSections.length < 4) {
    throw new Error(`Expected at least 4 sections, got ${rawSections.length}.`);
  }

  const candBoundaries = Array.from(
    new Set([
      0,
      ...dsp.sectionCandidates.map((c) => roundTime(c.start)),
      ...dsp.sectionCandidates.map((c) => roundTime(c.end)),
      roundTime(dsp.duration),
    ]),
  ).sort((a, b) => a - b);

  const snappedSections: SongSection[] = [];
  for (let i = 0; i < rawSections.length; i++) {
    const item = rawSections[i] as Record<string, unknown>;
    const rawStart = Number(item.start);
    const rawEnd = Number(item.end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      throw new Error(`Section ${i} has non-numeric start/end.`);
    }

    const start =
      i === 0
        ? 0
        : snappedSections[snappedSections.length - 1].end;
    const end =
      i === rawSections.length - 1
        ? roundTime(dsp.duration)
        : snapToCandidateOrDownbeat(rawEnd, candBoundaries, dsp.downbeats, 0.05);

    if (end <= start + 1.0) {
      // Skip degenerate merged slice if adjacent snapped to same boundary
      continue;
    }

    const rawLabel = String(item.label ?? '').toLowerCase().trim() as SectionLabel;
    if (!VALID_SECTION_LABELS.includes(rawLabel)) {
      throw new Error(`Invalid section label "${item.label}" at section ${i}.`);
    }

    const mood = sanitizeOneWordMood(item.mood, 'electric');
    const energy = meanEnvelopeEnergy(dsp.envelope, start, end);

    snappedSections.push({
      start: roundTime(start),
      end: roundTime(end),
      label: rawLabel,
      energy,
      mood,
    });
  }

  if (snappedSections.length < 4) {
    throw new Error(`After snapping to DSP boundaries, fewer than 4 sections remained (${snappedSections.length}).`);
  }
  snappedSections[snappedSections.length - 1].end = roundTime(dsp.duration);

  // Drops: chosen from dropCandidates (or section starts where label === 'drop')
  const allowedDropTimes = Array.from(
    new Set([
      ...dsp.dropCandidates.map((d) => roundTime(d.t)),
      ...snappedSections.filter((s) => s.label === 'drop').map((s) => s.start),
    ]),
  );
  const rawDrops = Array.isArray(raw.drops) ? raw.drops : [];
  const snappedDrops: number[] = [];
  for (const d of rawDrops) {
    const num = Number(d);
    if (!Number.isFinite(num)) continue;
    const snapped = findNearest(num, allowedDropTimes);
    if (snapped.dist <= 2.5 && !snappedDrops.some((x) => Math.abs(x - snapped.value) < 0.5)) {
      snappedDrops.push(roundTime(snapped.value));
    }
  }
  if (snappedDrops.length === 0) {
    throw new Error('No valid drops chosen from DSP drop candidates.');
  }
  snappedDrops.sort((a, b) => a - b);

  // Palette validation
  const rawPal = (raw.palette ?? {}) as Record<string, unknown>;
  if (!isHexColor(rawPal.bg) || !isHexColor(rawPal.primary) || !isHexColor(rawPal.accent)) {
    throw new Error('Palette is missing valid #RRGGBB hex colors for bg, primary, or accent.');
  }
  const basePalette: Palette = {
    bg: sanitizeHex(rawPal.bg, '#090a10'),
    primary: sanitizeHex(rawPal.primary, '#38bdf8'),
    secondary: sanitizeHex(rawPal.secondary, '#a855f7'),
    accent: sanitizeHex(rawPal.accent, '#f59e0b'),
    highlight: sanitizeHex(rawPal.highlight, '#f8fafc'),
  };

  const rawPerSec = Array.isArray(rawPal.perSection) ? rawPal.perSection : [];
  const perSection: Palette[] = snappedSections.map((_, idx) => {
    const p = (rawPerSec[idx] ?? rawPerSec[rawPerSec.length - 1] ?? basePalette) as Record<string, unknown>;
    return {
      bg: sanitizeHex(p.bg, basePalette.bg),
      primary: sanitizeHex(p.primary, basePalette.primary),
      secondary: sanitizeHex(p.secondary, basePalette.secondary),
      accent: sanitizeHex(p.accent, basePalette.accent),
      highlight: sanitizeHex(p.highlight, basePalette.highlight),
    };
  });

  // Rail districts validation
  const rawRail = (raw.rail ?? {}) as Record<string, unknown>;
  const rawDistricts = Array.isArray(rawRail.districts) ? rawRail.districts : [];
  const districts: RailDistrictEntry[] = snappedSections.map((sec, idx) => {
    const found = rawDistricts[idx] as Record<string, unknown> | undefined;
    const dName = String(found?.district ?? '').toLowerCase().trim() as RailDistrictType;
    const validDistrict: RailDistrictType = VALID_RAIL_DISTRICTS.includes(dName)
      ? dName
      : idx === 0
        ? 'outskirts'
        : idx === snappedSections.length - 1
          ? 'sunrise'
          : sec.label === 'drop'
            ? 'neon_core'
            : 'approach';
    return {
      section: idx,
      district: validDistrict,
    };
  });

  // Phrases (for demoWindow end check)
  const phrases = buildPhrases(
    dsp.downbeats,
    snappedSections.map((s) => s.start),
  );

  // Demo window validation
  const rawDemo = (raw.demoWindow ?? {}) as Record<string, unknown>;
  const rawWinStart = Number(rawDemo.start);
  const rawWinEnd = Number(rawDemo.end);
  if (!Number.isFinite(rawWinStart) || !Number.isFinite(rawWinEnd)) {
    throw new Error('demoWindow.start and demoWindow.end must be finite numbers.');
  }

  const winStart = snapToCandidateOrDownbeat(rawWinStart, dsp.downbeats, dsp.downbeats, 0.05);
  const winEnd = snapToCandidateOrDownbeat(rawWinEnd, phrases, phrases, 0.05);
  const winDur = roundTime(winEnd - winStart);

  if (winDur < 94.5 || winDur > 110.5) {
    throw new Error(
      `demoWindow duration must be 95-110 s (got ${winDur.toFixed(2)}s from ${winStart}s to ${winEnd}s).`,
    );
  }

  const dropsInWin = snappedDrops.filter((d) => d >= winStart + 34.5 && d <= winStart + 70.5 && d < winEnd - 5.0);
  if (dropsInWin.length === 0) {
    throw new Error(
      `demoWindow [${winStart}, ${winEnd}] must put a drop 35-70 s into the window (drops are at ${snappedDrops.join(', ')}).`,
    );
  }

  const winSections = snappedSections.filter((s) => s.end > winStart + 1.0 && s.start < winEnd - 1.0);
  const hasBuild = winSections.some((s) => s.label === 'build');
  const hasDrop = winSections.some((s) => s.label === 'drop') || dropsInWin.length > 0;
  if (!hasBuild || !hasDrop) {
    throw new Error(
      `demoWindow [${winStart}, ${winEnd}] must contain at least one 'build' and one 'drop' section (found: ${winSections.map((s) => s.label).join(', ')}).`,
    );
  }

  return {
    title,
    sections: snappedSections,
    drops: snappedDrops,
    palette: {
      ...basePalette,
      perSection,
    },
    rail: { districts },
    demoWindow: {
      start: roundTime(winStart),
      end: roundTime(winEnd),
    },
  };
}

export async function runSemanticAnalysis(
  dsp: DspOutput,
  mp3Path: string,
  fallbackTitle: string,
): Promise<SemanticResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[semantic] GEMINI_API_KEY not found; using DSP fallback.');
    return buildDspFallbackSemantics(dsp, fallbackTitle);
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const validDemoWindows = findValidDemoWindows(dsp);
  const audioBase64 = getAudioBase64ForApi(mp3Path);

  const dspSummary = {
    filename: path.basename(mp3Path),
    duration: dsp.duration,
    bpm: dsp.bpm,
    candidateSegments: dsp.sectionCandidates.map((c, index) => ({
      index,
      start: c.start,
      end: c.end,
      duration: roundTime(c.end - c.start),
      energy: c.energy,
      onsetDensity: c.onsetDensity,
    })),
    dropCandidates: dsp.dropCandidates,
    preverifiedDemoWindows: validDemoWindows.slice(0, 6),
  };

  const basePrompt = `You are scoring and labeling a song for Song Arcade.
Listen to the attached audio track from start to end and use the provided DSP summary.
CRITICAL RULE: Never invent timestamps. Every timestamp MUST come from the DSP candidate boundaries, dropCandidates, and preverifiedDemoWindows.

DSP Summary:
${JSON.stringify(dspSummary, null, 2)}

Return a JSON object with:
1. "title": The real song title (and artist if known, or clean title) if you recognize the audio, else derived cleanly from "${fallbackTitle}".
2. "sections": Label each candidate segment (you may merge adjacent candidates if they belong to the same musical section, keeping at least 4 sections total, and NEVER inventing new boundary times).
   - "start": exact start time from candidateSegments
   - "end": exact end time from candidateSegments
   - "label": one of "intro" | "verse" | "build" | "drop" | "breakdown" | "bridge" | "outro"
   - "mood": a single-word evocative mood (e.g. "frenetic", "brooding", "euphoric", "tense")
   IMPORTANT: Ensure the section leading into a major drop is labeled "build" and the high-energy payoff section starting at the drop is labeled "drop".
3. "drops": Array of numbers chosen strictly from "dropCandidates" (the "t" values) where actual musical drops/climaxes occur (must include the drop inside demoWindow).
4. "palette":
   - "bg", "primary", "secondary", "accent", "highlight" as 6-digit "#RRGGBB" hex strings matching the song's mood (dark readable bg, saturated neon accents).
   - "perSection": Array of palette objects (exact same length as "sections", one variant per section following the energy arc).
5. "rail":
   - "districts": Array of { "section": <0-based section index>, "district": "outskirts" | "approach" | "neon_core" | "rain_rooftops" | "sunrise" }, one per section following the song's arc (calm sections at outskirts, build at approach, biggest drop at neon_core, breakdown/bridge at rain_rooftops, ending at sunrise).
6. "demoWindow": { "start": number, "end": number }
   - Pick one of the "preverifiedDemoWindows" (or a downbeat start and phrase-boundary end that is 95-110s long, contains at least one "build" and one "drop" section, and puts the first drop 35-70s into the window).`;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      sections: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            start: { type: Type.NUMBER },
            end: { type: Type.NUMBER },
            label: { type: Type.STRING },
            mood: { type: Type.STRING },
          },
          required: ['start', 'end', 'label', 'mood'],
        },
      },
      drops: {
        type: Type.ARRAY,
        items: { type: Type.NUMBER },
      },
      palette: {
        type: Type.OBJECT,
        properties: {
          bg: { type: Type.STRING },
          primary: { type: Type.STRING },
          secondary: { type: Type.STRING },
          accent: { type: Type.STRING },
          highlight: { type: Type.STRING },
          perSection: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                bg: { type: Type.STRING },
                primary: { type: Type.STRING },
                secondary: { type: Type.STRING },
                accent: { type: Type.STRING },
                highlight: { type: Type.STRING },
              },
              required: ['bg', 'primary', 'secondary', 'accent', 'highlight'],
            },
          },
        },
        required: ['bg', 'primary', 'secondary', 'accent', 'highlight', 'perSection'],
      },
      rail: {
        type: Type.OBJECT,
        properties: {
          districts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                section: { type: Type.INTEGER },
                district: { type: Type.STRING },
              },
              required: ['section', 'district'],
            },
          },
        },
        required: ['districts'],
      },
      demoWindow: {
        type: Type.OBJECT,
        properties: {
          start: { type: Type.NUMBER },
          end: { type: Type.NUMBER },
        },
        required: ['start', 'end'],
      },
    },
    required: ['title', 'sections', 'drops', 'palette', 'rail', 'demoWindow'],
  };

  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const promptText =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nPREVIOUS ATTEMPT FAILED VALIDATION WITH ERROR:\n${lastError}\nFix this exact issue and return valid JSON.`;

    try {
      console.log(`[semantic] Calling gemini-4-argon (attempt ${attempt}/2) for ${path.basename(mp3Path)}...`);
      const interaction = await ai.interactions.create(
        {
          model: 'gemini-4-argon',
          input: [
            {
              type: 'audio',
              data: audioBase64,
              mime_type: 'audio/mp3',
            },
            {
              type: 'text',
              text: promptText,
            },
          ],
          generation_config: {
            thinking_level: 'medium',
          },
          response_format: responseSchema,
        },
        { timeout: 180_000 },
      );

      let fullOutput = interaction.output_text ?? '';
      if (!fullOutput && Array.isArray(interaction.steps)) {
        for (const step of interaction.steps) {
          if (step.type === 'model_output' && Array.isArray(step.content)) {
            for (const c of step.content) {
              if (c.type === 'text' && typeof c.text === 'string') {
                fullOutput += c.text;
              }
            }
          }
        }
      }

      const jsonMatch =
        fullOutput.match(/```json\s*([\s\S]*?)\s*```/) ||
        fullOutput.match(/(\{[\s\S]*\})/);
      const rawJsonStr = jsonMatch ? jsonMatch[1] : fullOutput.trim();
      const parsed = JSON.parse(rawJsonStr) as Record<string, unknown>;
      const validated = validateAndSnapSemantics(parsed, dsp, fallbackTitle);
      console.log(
        `[semantic] Validated "${validated.title}" (${validated.sections.length} sections, drops: [${validated.drops.join(', ')}], demoWindow: ${validated.demoWindow.start}..${validated.demoWindow.end}s)`,
      );
      return validated;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[semantic] Attempt ${attempt} validation/API error: ${lastError}`);
    }
  }

  console.warn(`[semantic] Both attempts failed for ${path.basename(mp3Path)}; using deterministic DSP fallback.`);
  return buildDspFallbackSemantics(dsp, fallbackTitle);
}

// CLI entry point: npx tsx scripts/semantic.ts <dsp.json> <mp3> [out.json]
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const dspPath = process.argv[2];
  const mp3Path = process.argv[3];
  const outPath = process.argv[4];
  if (!dspPath || !mp3Path) {
    console.error('Usage: npx tsx scripts/semantic.ts <dsp.json> <mp3> [out.json]');
    process.exit(1);
  }
  const dspData = JSON.parse(fs.readFileSync(dspPath, 'utf-8')) as DspOutput;
  const fallbackTitle = path.basename(mp3Path, path.extname(mp3Path)).toUpperCase();
  runSemanticAnalysis(dspData, mp3Path, fallbackTitle)
    .then((res) => {
      const jsonOut = JSON.stringify(res, null, 2);
      if (outPath) {
        fs.writeFileSync(outPath, jsonOut, 'utf-8');
        console.log(`[semantic] Wrote ${outPath}`);
      } else {
        console.log(jsonOut);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
