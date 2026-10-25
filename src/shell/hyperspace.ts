import type { LiveBands, Palette } from './api';
import { READJUST } from './config';

interface StarStreak {
  angle: number;
  dist: number;
  speed: number;
  colorKey: 'primary' | 'secondary' | 'accent' | 'highlight';
  width: number;
}

export interface HyperspaceOverlay {
  element: HTMLCanvasElement;
  start(nextTitle: string, listensTo: string): void;
  updateAndRender(dt: number, elapsedSec: number, palette: Palette, bands: LiveBands): void;
  hide(): void;
}

export function createHyperspaceOverlay(parent: HTMLElement): HyperspaceOverlay {
  const canvas = document.createElement('canvas');
  canvas.id = 'hyperspace-overlay';
  canvas.dataset.testid = 'hyperspace-overlay';
  canvas.className = 'pointer-events-none absolute inset-0 w-full h-full z-30 hidden';
  parent.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;
  let targetTitle = '';
  let targetListensTo = '';

  const colorKeys: Array<'primary' | 'secondary' | 'accent' | 'highlight'> = [
    'primary',
    'secondary',
    'accent',
    'highlight',
  ];

  const stars: StarStreak[] = Array.from({ length: 110 }, (_, i) => ({
    angle: (i / 110) * Math.PI * 2 + (i % 7) * 0.13,
    dist: ((i * 19) % 100) / 100,
    speed: 0.9 + (i % 5) * 0.35,
    colorKey: colorKeys[i % colorKeys.length],
    width: 1.5 + (i % 3) * 1.1,
  }));

  return {
    element: canvas,

    start(nextTitle: string, listensTo: string): void {
      targetTitle = nextTitle.toUpperCase();
      targetListensTo = listensTo;
      canvas.classList.remove('hidden');
      for (let i = 0; i < stars.length; i++) {
        stars[i].dist = ((i * 17) % 100) / 100;
      }
    },

    updateAndRender(dt: number, elapsedSec: number, palette: Palette, bands: LiveBands): void {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.max(320, Math.floor(window.innerWidth * dpr));
      const H = Math.max(240, Math.floor(window.innerHeight * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }

      const cx = W * 0.5;
      const cy = H * 0.5;
      const maxR = Math.hypot(cx, cy);

      // Background with radial tunnel gradient
      ctx.fillStyle = palette.bg || '#090a10';
      ctx.fillRect(0, 0, W, H);

      const lowPulse = 1.0 + bands.low * 1.6;
      const progress = Math.max(0, Math.min(1, elapsedSec / READJUST));

      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        s.dist += dt * s.speed * (1.2 + progress * 1.8);
        if (s.dist > 1.15) {
          s.dist -= 1.1;
        }

        const r0 = Math.max(8 * dpr, s.dist * maxR * 0.78);
        const streakLen = (28 + s.dist * 120) * lowPulse * dpr;
        const r1 = r0 + streakLen;

        const cos = Math.cos(s.angle);
        const sin = Math.sin(s.angle);

        ctx.strokeStyle = palette[s.colorKey] || '#38bdf8';
        ctx.lineWidth = s.width * dpr;
        ctx.beginPath();
        ctx.moveTo(cx + cos * r0, cy + sin * r0);
        ctx.lineTo(cx + cos * r1, cy + sin * r1);
        ctx.stroke();
      }

      // Center backing card for crisp text legibility
      const cardW = Math.min(W * 0.9, 780 * dpr);
      const cardH = 128 * dpr;
      ctx.fillStyle = 'rgba(9, 10, 16, 0.88)';
      ctx.strokeStyle = palette.primary || '#38bdf8';
      ctx.lineWidth = 2 * dpr;
      ctx.fillRect(cx - cardW * 0.5, cy - cardH * 0.5, cardW, cardH);
      ctx.strokeRect(cx - cardW * 0.5, cy - cardH * 0.5, cardW, cardH);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = palette.highlight || '#ffffff';
      ctx.font = `800 ${Math.round(28 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillText(`NEXT: ${targetTitle}`, cx, cy - 16 * dpr);

      ctx.fillStyle = palette.accent || '#f59e0b';
      ctx.font = `600 ${Math.round(14 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillText(`Listening to: ${targetListensTo}`, cx, cy + 24 * dpr);

      // White flash on the last 80 ms of READJUST
      const remaining = READJUST - elapsedSec;
      if (remaining <= 0.08 && remaining >= -0.05) {
        const flashAlpha = Math.max(0, Math.min(1, 1 - Math.max(0, remaining) / 0.08));
        ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha.toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }
    },

    hide(): void {
      canvas.classList.add('hidden');
    },
  };
}
