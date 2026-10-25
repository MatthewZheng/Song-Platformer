import type { Palette, PaletteSource, SongMap } from '../shell/api';
import { sectionIndexAt } from './songmap';

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) return [15, 23, 42];
  const num = parseInt(clean, 16);
  if (Number.isNaN(num)) return [15, 23, 42];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const hex = ((clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).padStart(6, '0');
  return `#${hex}`;
}

function hslToHex(hDeg: number, sPct: number, lPct: number): string {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, sPct / 100));
  const l = Math.max(0, Math.min(1, lPct / 100));

  if (s === 0) {
    const v = l * 255;
    return rgbToHex(v, v, v);
  }

  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, h + 1 / 3) * 255;
  const g = hue2rgb(p, q, h) * 255;
  const b = hue2rgb(p, q, h - 1 / 3) * 255;
  return rgbToHex(r, g, b);
}

export function lerpColorHex(hexA: string, hexB: string, t: number): string {
  const alpha = Math.max(0, Math.min(1, t));
  if (alpha <= 0) return hexA;
  if (alpha >= 1) return hexB;
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  return rgbToHex(r1 + (r2 - r1) * alpha, g1 + (g2 - g1) * alpha, b1 + (b2 - b1) * alpha);
}

export function lerpPalette(a: Palette, b: Palette, t: number): Palette {
  const alpha = Math.max(0, Math.min(1, t));
  if (alpha <= 0) return a;
  if (alpha >= 1) return b;
  // Smoothstep easing for silky color transitions
  const smooth = alpha * alpha * (3 - 2 * alpha);
  return {
    bg: lerpColorHex(a.bg, b.bg, smooth),
    primary: lerpColorHex(a.primary, b.primary, smooth),
    secondary: lerpColorHex(a.secondary, b.secondary, smooth),
    accent: lerpColorHex(a.accent, b.accent, smooth),
    highlight: lerpColorHex(a.highlight, b.highlight, smooth),
  };
}

/**
 * Maps song BPM to a starting hue on the Modern Synthwave -> Modern Warm spectrum:
 * - Slower BPM (~80-100 BPM) -> Cool Synthwave Blue / Cobalt / Cyan (~218° - 235°)
 * - Medium BPM (~105-128 BPM) -> In-between Synthwave Indigo / Violet / Sunset Magenta (~265° - 320°)
 * - Faster BPM (~132-165+ BPM) -> Modern Warm Crimson Red / Sunset Coral / Fiery Amber (~352° - 16°)
 */
export function bpmToStartingHue(bpm: number): number {
  const clamped = Math.max(75, Math.min(165, bpm || 120));
  // Normalize 96..145 BPM -> 0..1 so ~103 BPM (ctd) is unmistakably Blue (~218°),
  // ~123 BPM (fb) is intermediate Synthwave Violet/Magenta (~295°),
  // and ~144 BPM (ra) is Modern Warm Crimson Red (~358°).
  const u = Math.max(0, Math.min(1, (clamped - 96) / (145 - 96)));
  return (206 + u * 154) % 360;
}

/**
 * Builds a Modern Warm / Modern Synthwave 5-color swatch palette from an anchor hue
 * and section energy/progression index.
 */
export function buildProgressedSwatchPalette(
  baseHue: number,
  sectionIndex = 0,
  sectionEnergy = 0.5,
  sectionLabel = 'verse',
): Palette {
  // Progress the hue across sections and shift warmer on high-energy drops/builds
  const energyBias = (sectionEnergy - 0.45) * 26;
  const labelShift =
    sectionLabel === 'drop'
      ? 18
      : sectionLabel === 'build'
        ? 10
        : sectionLabel === 'breakdown' || sectionLabel === 'outro'
          ? -12
          : 0;
  const hAnchor = (baseHue + sectionIndex * 18 + energyBias + labelShift + 360) % 360;

  // Determine whether this hue sits in the Modern Warm (320°..360° or 0°..55°) or Synthwave (180°..320°) family
  const isWarmZone = hAnchor >= 320 || hAnchor <= 55;

  // 1. bg: Deep atmospheric twilight / obsidian-plum / midnight-cobalt base
  const bgHue = (hAnchor - 10 + 360) % 360;
  const bgSat = isWarmZone ? 56 : 62;
  const bgLight = 11 + Math.round(sectionEnergy * 4);

  // 2. primary: Main terrain / ground / structural swatch
  const primHue = hAnchor;
  const primSat = isWarmZone ? 84 : 82;
  const primLight = 55 + Math.round(sectionEnergy * 7);

  // 3. secondary: Harmonic analogous companion swatch (+24° toward warm coral/magenta/cyan)
  const secHue = (hAnchor + 24) % 360;
  const secSat = 88;
  const secLight = 62 + Math.round(sectionEnergy * 6);

  // 4. accent: High-visibility synthwave / warm sunset accent (+46° for headphones, comets, flares)
  const accHue = (hAnchor + 46) % 360;
  const accSat = 95;
  const accLight = 64;

  // 5. highlight: Luminous warm cream / neon pastel highlight
  const highHue = (hAnchor + 58) % 360;
  const highSat = 92;
  const highLight = 90;

  return {
    bg: hslToHex(bgHue, bgSat, bgLight),
    primary: hslToHex(primHue, primSat, primLight),
    secondary: hslToHex(secHue, secSat, secLight),
    accent: hslToHex(accHue, accSat, accLight),
    highlight: hslToHex(highHue, highSat, highLight),
  };
}

/**
 * Creates a PaletteSource whose `.at(songTime)` returns a BPM-anchored Modern Warm /
 * Modern Synthwave palette that progresses sensibly across sections and cross-fades
 * smoothly over 1.5 s at section boundaries.
 */
export function createPaletteSource(map: SongMap): PaletteSource {
  const baseHue = bpmToStartingHue(map.bpm || 120);
  const basePalette = buildProgressedSwatchPalette(baseHue, 0, 0.5, 'intro');

  const getForSection = (idx: number): Palette => {
    const sections = map.sections || [];
    const clampedIdx = Math.max(0, Math.min(sections.length - 1, idx));
    const sec = sections[clampedIdx];
    return buildProgressedSwatchPalette(
      baseHue,
      clampedIdx,
      sec?.energy ?? 0.5,
      sec?.label ?? 'verse',
    );
  };

  return {
    at(songTime: number): Palette {
      const sections = map.sections;
      if (!sections || sections.length === 0) return basePalette;
      const idx = sectionIndexAt(map, songTime);
      const sec = sections[idx];
      const currPal = getForSection(idx);

      // Smoothly cross-fade over 1.5s at the start of each section after section 0
      const fadeWindow = 1.5;
      if (idx > 0) {
        const elapsedInSec = songTime - sec.start;
        if (elapsedInSec >= 0 && elapsedInSec < fadeWindow) {
          const prevPal = getForSection(idx - 1);
          return lerpPalette(prevPal, currPal, elapsedInSec / fadeWindow);
        }
      }

      // Also add a subtle intra-section progression toward the next section's swatch
      if (idx < sections.length - 1) {
        const secDur = Math.max(1, sec.end - sec.start);
        const progressInSec = Math.max(0, Math.min(1, (songTime - sec.start) / secDur));
        const nextPal = getForSection(idx + 1);
        return lerpPalette(currPal, nextPal, progressInSec * 0.22);
      }

      return currPal;
    },
  };
}
