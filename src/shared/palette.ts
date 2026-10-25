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
  return {
    bg: lerpColorHex(a.bg, b.bg, alpha),
    primary: lerpColorHex(a.primary, b.primary, alpha),
    secondary: lerpColorHex(a.secondary, b.secondary, alpha),
    accent: lerpColorHex(a.accent, b.accent, alpha),
    highlight: lerpColorHex(a.highlight, b.highlight, alpha),
  };
}

/**
 * Creates a PaletteSource whose `.at(songTime)` returns the current section's palette,
 * cross-faded smoothly over 1.0 s across section boundaries.
 */
export function createPaletteSource(map: SongMap): PaletteSource {
  const base: Palette = {
    bg: map.palette?.bg || '#090a10',
    primary: map.palette?.primary || '#38bdf8',
    secondary: map.palette?.secondary || '#a855f7',
    accent: map.palette?.accent || '#f59e0b',
    highlight: map.palette?.highlight || '#f8fafc',
  };

  const getForSection = (idx: number): Palette => {
    const per = map.palette?.perSection;
    if (!per || per.length === 0) return base;
    const clamped = Math.max(0, Math.min(per.length - 1, idx));
    return per[clamped] || base;
  };

  return {
    at(songTime: number): Palette {
      const sections = map.sections;
      if (!sections || sections.length === 0) return base;
      const idx = sectionIndexAt(map, songTime);
      const sec = sections[idx];
      const currPal = getForSection(idx);

      // Cross-fade over 1.0s at the start of each section after section 0
      if (idx > 0) {
        const elapsedInSec = songTime - sec.start;
        if (elapsedInSec >= 0 && elapsedInSec < 1.0) {
          const prevPal = getForSection(idx - 1);
          return lerpPalette(prevPal, currPal, elapsedInSec / 1.0);
        }
      }
      return currPal;
    },
  };
}
