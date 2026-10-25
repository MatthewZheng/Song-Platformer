/**
 * Bold 5x5 bitmap pixel font renderer for canvas title screen & arcade overlays.
 */
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '11111', '10001', '10001'],
  B: ['11110', '10001', '11110', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '11110', '10000', '11111'],
  F: ['11111', '10000', '11110', '10000', '10000'],
  G: ['01111', '10000', '10111', '10001', '01111'],
  H: ['10001', '10001', '11111', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '11100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001'],
  O: ['01110', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '11110', '10000', '10000'],
  Q: ['01110', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '11110', '10010', '10001'],
  S: ['01111', '10000', '01110', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10101', '11011', '10001'],
  X: ['10001', '01010', '00100', '01010', '10001'],
  Y: ['10001', '01010', '00100', '00100', '00100'],
  Z: ['11111', '00010', '00100', '01000', '11111'],
  '0': ['01110', '10011', '10101', '11001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00110', '01000', '11111'],
  '3': ['11110', '00001', '01110', '00001', '11110'],
  '4': ['10010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '11110'],
  '6': ['01111', '10000', '11110', '10001', '01110'],
  '7': ['11111', '00010', '00100', '01000', '01000'],
  '8': ['01110', '10001', '01110', '10001', '01110'],
  '9': ['01110', '10001', '01111', '00001', '11110'],
  ':': ['00000', '00100', '00000', '00100', '00000'],
  '-': ['00000', '00000', '11111', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000'],
};

export function measurePixelTextWidth(text: string, pixelSize: number, letterSpacing = pixelSize): number {
  if (!text) return 0;
  return text.length * 5 * pixelSize + Math.max(0, text.length - 1) * letterSpacing;
}

export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  topY: number,
  pixelSize: number,
  fillColor = '#f8fafc',
  shadowColor = '#f59e0b',
): void {
  const upper = text.toUpperCase();
  const spacing = Math.max(2, Math.round(pixelSize * 1.25));
  const totalW = measurePixelTextWidth(upper, pixelSize, spacing);
  let curX = Math.round(centerX - totalW / 2);

  for (let c = 0; c < upper.length; c++) {
    const ch = upper[c];
    const grid = GLYPHS[ch] ?? GLYPHS[' '];
    for (let row = 0; row < 5; row++) {
      const line = grid[row];
      for (let col = 0; col < 5; col++) {
        if (line[col] === '1') {
          const px = curX + col * pixelSize;
          const py = Math.round(topY + row * pixelSize);
          if (shadowColor) {
            ctx.fillStyle = shadowColor;
            ctx.fillRect(px + Math.max(2, Math.round(pixelSize * 0.35)), py + Math.max(2, Math.round(pixelSize * 0.35)), pixelSize, pixelSize);
          }
          ctx.fillStyle = fillColor;
          ctx.fillRect(px, py, pixelSize, pixelSize);
        }
      }
    }
    curX += 5 * pixelSize + spacing;
  }
}
