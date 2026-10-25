import * as THREE from 'three';

/**
 * Nano-Banana reference sprite asset generated for the classic T-Rex with pixel headphones:
 * `/src/assets/images/trex_headphones_sprite_1792959126147.jpg`
 *
 * Legend for grid sprites:
 *  '.' = transparent
 *  '#' = primary T-Rex body
 *  '@' = pixel headphone band & earcup
 *  '*' = headphone neon rim / eye highlight
 */
export const NANOBANANA_TREX_ASSET_URL =
  '/src/assets/images/trex_headphones_sprite_1792959126147.jpg';

export interface PixelGridSprite {
  width: number;
  height: number;
  rows: string[];
}

export interface VoxelCell {
  gx: number; // centered X in pixel units
  gy: number; // Y from bottom (0..height-1)
  colIndex: number; // 0..width-1 (for left-to-right stagger)
  role: 'body' | 'accent' | 'highlight';
  isEdge: boolean; // true when on silhouette perimeter (for smooth 3D edge bevel tapering)
}

// Exact Classic Google T-Rex silhouette (22x24) wearing pixel headphones arched over the crown
// Matches the Nano-Banana sprite: flat blocky snout, square eye, open mouth slot + lower jaw,
// tiny L-shaped 2-pixel front arm, stepped upward-pointing tail, and classic two-leg stride.
const CLASSIC_TREX_UPPER_18: string[] = [
  '..........@@@@@@......', // 0: pixel headphone top arch
  '.........@@....@@.....', // 1: headphone side arms over crown
  '........@@.##########.', // 2: classic flat T-Rex crown + notched snout corner
  '.......*@@*##*########', // 3: neon-rimmed earcup + square eye (*) + wide blocky snout
  '.......*@@*###########', // 4: earcup + upper snout
  '.......*@@*###########', // 5: earcup base + snout
  '........**.###########', // 6: lower earcup rim + upper jaw
  '...........#####......', // 7: classic open mouth slot
  '..........##########..', // 8: classic stepped lower jaw shelf
  '#........#######......', // 9: tail tip + neck
  '##......########......', // 10: stepped tail + upper back
  '###....###########....', // 11: tail + back + chest + tiny L-arm top
  '####..##########.#....', // 12: tail + torso + tiny L-arm downward claw
  '.###############......', // 13: full classic T-Rex belly
  '..##############......', // 14: mid belly
  '...############.......', // 15: lower belly / hip
  '....##########........', // 16: hip
  '.....########.........', // 17: upper leg join
];

export const HERO_RUN_A: PixelGridSprite = {
  width: 22,
  height: 24,
  rows: [
    ...CLASSIC_TREX_UPPER_18,
    '.....###..###.........', // 18: thighs
    '.....##....###........', // 19: right leg lifted with toe, left leg extending
    '.....##...............', // 20: left shin
    '.....##...............', // 21: left ankle
    '.....###..............', // 22: left 2-pixel forward toe planted
    '......................', // 23
  ],
};

export const HERO_RUN_MID: PixelGridSprite = {
  width: 22,
  height: 24,
  rows: [
    ...CLASSIC_TREX_UPPER_18,
    '.....###..###.........', // 18: thighs
    '.....##...##..........', // 19: passing stride
    '.....##...##..........', // 20: both shins mid-pass
    '.....###..###.........', // 21: mid-stride feet
    '......................', // 22
    '......................', // 23
  ],
};

export const HERO_RUN_B: PixelGridSprite = {
  width: 22,
  height: 24,
  rows: [
    ...CLASSIC_TREX_UPPER_18,
    '.....###..###.........', // 18: thighs
    '.....###...##.........', // 19: left leg lifted with toe, right leg extending
    '...........##.........', // 20: right shin
    '...........##.........', // 21: right ankle
    '...........###........', // 22: right 2-pixel forward toe planted
    '......................', // 23
  ],
};

export const HERO_JUMP: PixelGridSprite = {
  width: 22,
  height: 24,
  rows: [
    ...CLASSIC_TREX_UPPER_18,
    '.....###..###.........', // 18
    '.....##....##.........', // 19
    '.....##....##.........', // 20
    '.....###...###........', // 21: classic standing/airborne twin feet
    '......................', // 22
    '......................', // 23
  ],
};

// Classic Chrome T-Rex forward horizontal crouch with pixel headphones (rows 0..8 clear for high birds)
const CLASSIC_TREX_DUCK_UPPER_18: string[] = [
  '..........................', // 0
  '..........................', // 1
  '..........................', // 2
  '..........................', // 3
  '..........................', // 4
  '..........................', // 5
  '..........................', // 6
  '..........................', // 7
  '.............@@@@@@.......', // 8: headphone arch on lowered head
  '............@@....@@......', // 9
  '#..........*@@*##########.', // 10: tail tip + earcup + flat T-Rex snout
  '##.........*@@*##*########', // 11: tail + earcup + eye + blocky snout
  '####.......*@@*###########', // 12: horizontal back + snout
  '.#####......**.#####......', // 13: horizontal torso + open mouth
  '..##################XXXX..'.replace(/XXXX/g, '####'), // 14: torso + lower jaw
  '...##############.........', // 15: belly + tiny front arm
  '....############.#........', // 16: lower belly + L-arm claw
  '.....##########...........', // 17: hip
];

export const HERO_DUCK_A: PixelGridSprite = {
  width: 26,
  height: 24,
  rows: [
    ...CLASSIC_TREX_DUCK_UPPER_18,
    '......###...###...........', // 18
    '......##.....###..........', // 19
    '......##..................', // 20
    '......###.................', // 21
    '..........................', // 22
    '..........................', // 23
  ],
};

export const HERO_DUCK_B: PixelGridSprite = {
  width: 26,
  height: 24,
  rows: [
    ...CLASSIC_TREX_DUCK_UPPER_18,
    '......###...###...........', // 18
    '......###....##...........', // 19
    '.............##...........', // 20
    '.............###..........', // 21
    '..........................', // 22
    '..........................', // 23
  ],
};

export const HERO_HIT: PixelGridSprite = {
  width: 22,
  height: 24,
  rows: [
    '..........@@@@@@......',
    '.........@@....@@.....',
    '........@@.##########.',
    '.......*@@*#***#######', // wide startled square eye
    '.......*@@*#*#*#######',
    '.......*@@*###########',
    '........**.#####......',
    '...........#####......',
    '..........##########..',
    '#........#######......',
    '##......########......',
    '###....###########....',
    '####..##########.#....',
    '.###############......',
    '..##############......',
    '...############.......',
    '....##########........',
    '.....########.........',
    '.....###..###.........',
    '.....##....##.........',
    '.....##....##.........',
    '.....###...###........',
    '......................',
    '......................',
  ],
};

// Compact, classic-proportioned saguaro cacti (shorter than the T-Rex so jumps clear effortlessly)
export const CACTUS_SMALL: PixelGridSprite = {
  width: 11,
  height: 13,
  rows: [
    '....###....',
    '....###....',
    '.#..###....',
    '###.###..#.',
    '###.###.###',
    '#######.###',
    '.#########.',
    '....######.',
    '....###....',
    '....###....',
    '....###....',
    '....###....',
    '...#####...',
  ],
};

export const CACTUS_MEDIUM: PixelGridSprite = {
  width: 13,
  height: 15,
  rows: [
    '.....###.....',
    '....#####....',
    '.##.#####....',
    '.##.#####.##.',
    '.##.#####.##.',
    '.########.##.',
    '..##########.',
    '....########.',
    '....#####....',
    '....#####....',
    '....#####....',
    '....#####....',
    '....#####....',
    '....#####....',
    '...#######...',
  ],
};

export const CACTUS_LARGE: PixelGridSprite = {
  width: 15,
  height: 16,
  rows: [
    '......###......',
    '.....#####.....',
    '..##.#####.....',
    '.###.#####.##..',
    '.###.#####.###.',
    '.#########.###.',
    '..############.',
    '.....#########.',
    '..##.#####.....',
    '..########.....',
    '.....#####.....',
    '.....#####.....',
    '.....#####.....',
    '.....#####.....',
    '.....#####.....',
    '....#######....',
  ],
};

export const CACTUS_GROUP: PixelGridSprite = {
  width: 22,
  height: 15,
  rows: [
    '...##......###........',
    '..####....#####...##..',
    '#.#..#.#####...####.',
    '###..#.#####.#.####.',
    '.#####.#######.######.',
    '..####...#####..####..',
    '..####...#####..####..',
    '..####...#####..####..',
    '..####...#####..####..',
    '..####...#####..####..',
    '..####...#####..####..',
    '..####...#####..####..',
    '..####...#####..####..',
    '..####...#####..####..',
    '.######.#######.#####.',
  ],
};

export const BIRD_FLAP_A: PixelGridSprite = {
  width: 18,
  height: 12,
  rows: [
    '.......###........',
    '......#####.......',
    '.....######.......',
    '..##.#######......',
    '.####.#######.....',
    '######.#########..',
    '..#####.#########.',
    '....#############.',
    '......########....',
    '.......#####......',
    '..................',
    '..................',
  ],
};

export const BIRD_FLAP_B: PixelGridSprite = {
  width: 18,
  height: 12,
  rows: [
    '..................',
    '..................',
    '..................',
    '..##..............',
    '.####.............',
    '######.#########..',
    '..#####.#########.',
    '....#############.',
    '.....###########..',
    '.....######.......',
    '......####........',
    '.......##.........',
  ],
};

export const CLOUD_SPRITE: PixelGridSprite = {
  width: 26,
  height: 9,
  rows: [
    '.........######...........',
    '.......##########.........',
    '.....##############.......',
    '...##################.....',
    '..######################..',
    '.########################.',
    '##########################',
    '.########################.',
    '..........................',
  ],
};

function isCellFilled(sprite: PixelGridSprite, r: number, c: number): boolean {
  if (r < 0 || r >= sprite.height || c < 0 || c >= sprite.width) return false;
  const ch = sprite.rows[r]?.[c];
  return Boolean(ch && ch !== '.' && ch !== ' ');
}

export function extractVoxelCells(sprite: PixelGridSprite): VoxelCell[] {
  const cells: VoxelCell[] = [];
  const halfW = sprite.width / 2;
  for (let r = 0; r < sprite.height; r++) {
    const rowStr = sprite.rows[r] || '';
    const gy = sprite.height - 1 - r;
    for (let c = 0; c < sprite.width; c++) {
      const ch = rowStr[c];
      if (!ch || ch === '.' || ch === ' ') continue;
      const role: VoxelCell['role'] =
        ch === '@' ? 'accent' : ch === '*' ? 'highlight' : 'body';
      const nUp = isCellFilled(sprite, r - 1, c);
      const nDown = isCellFilled(sprite, r + 1, c);
      const nLeft = isCellFilled(sprite, r, c - 1);
      const nRight = isCellFilled(sprite, r, c + 1);
      const isEdge = !(nUp && nDown && nLeft && nRight);
      cells.push({
        gx: c - halfW + 0.5,
        gy,
        colIndex: c,
        role,
        isEdge,
      });
    }
  }
  return cells;
}

function hexToRgba(hex: string): [number, number, number, number] {
  const clean = hex.replace('#', '').trim();
  const n = parseInt(clean, 16);
  if (Number.isNaN(n)) return [83, 83, 83, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/**
 * Builds a high-resolution (6x supersampled), smooth-edged anti-aliased DataTexture
 * from a PixelGridSprite. Applies corner-rounding SDF smoothing and a subtle outer contour
 * so sprites in 2D have silky smooth edges while keeping the iconic pixel-art silhouette.
 */
export function buildSpriteTexture(
  sprite: PixelGridSprite,
  bodyHex = '#f8fafc',
  accentHex = '#ef4444',
  highlightHex = '#22d3ee',
  outlineHex = '#0f172a',
): THREE.DataTexture {
  const SCALE = 6;
  const W = sprite.width * SCALE;
  const H = sprite.height * SCALE;
  const data = new Uint8Array(W * H * 4);
  recolorSpriteTextureData(data, sprite, SCALE, bodyHex, accentHex, highlightHex, outlineHex);

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function updateSpriteTextureColors(
  tex: THREE.DataTexture,
  sprite: PixelGridSprite,
  bodyHex: string,
  accentHex: string,
  highlightHex: string,
  outlineHex = '#0f172a',
): void {
  const SCALE = 6;
  const data = tex.image.data as Uint8Array;
  recolorSpriteTextureData(data, sprite, SCALE, bodyHex, accentHex, highlightHex, outlineHex);
  tex.needsUpdate = true;
}

function recolorSpriteTextureData(
  data: Uint8Array,
  sprite: PixelGridSprite,
  scale: number,
  bodyHex: string,
  accentHex: string,
  highlightHex: string,
  outlineHex: string,
): void {
  const gw = sprite.width;
  const gh = sprite.height;
  const W = gw * scale;
  const H = gh * scale;

  const bodyRgba = hexToRgba(bodyHex);
  const accentRgba = hexToRgba(accentHex);
  const highRgba = hexToRgba(highlightHex);
  const outRgba = hexToRgba(outlineHex);

  const getChar = (r: number, c: number): string => {
    if (r < 0 || r >= gh || c < 0 || c >= gw) return '.';
    const ch = sprite.rows[r]?.[c];
    return !ch || ch === ' ' ? '.' : ch;
  };

  const colorForChar = (ch: string): [number, number, number, number] => {
    if (ch === '@') return accentRgba;
    if (ch === '*') return highRgba;
    return bodyRgba;
  };

  // Sample continuous signed-distance / corner-smoothed coverage at subpixel (u, v) in [0..1]
  for (let r = 0; r < gh; r++) {
    for (let c = 0; c < gw; c++) {
      const ch = getChar(r, c);
      const nUp = getChar(r - 1, c) !== '.';
      const nDown = getChar(r + 1, c) !== '.';
      const nLeft = getChar(r, c - 1) !== '.';
      const nRight = getChar(r, c + 1) !== '.';

      const chUp = getChar(r - 1, c);
      const chDown = getChar(r + 1, c);
      const chLeft = getChar(r, c - 1);
      const chRight = getChar(r, c + 1);

      for (let sy = 0; sy < scale; sy++) {
        const v = (sy + 0.5) / scale; // 0 = top of cell, 1 = bottom of cell
        const py = (gh - 1 - r) * scale + (scale - 1 - sy);
        for (let sx = 0; sx < scale; sx++) {
          const u = (sx + 0.5) / scale; // 0 = left of cell, 1 = right of cell
          const px = c * scale + sx;
          const idx = (py * W + px) * 4;

          if (ch !== '.') {
            // Inside a filled cell: round exposed outer corners smoothly
            let cornerCut = 0;
            const radius = 0.42;
            if (!nUp && !nLeft && u < radius && v < radius) {
              const dist = Math.hypot(radius - u, radius - v);
              if (dist > radius) cornerCut = Math.min(1, (dist - radius) * scale);
            } else if (!nUp && !nRight && u > 1 - radius && v < radius) {
              const dist = Math.hypot(u - (1 - radius), radius - v);
              if (dist > radius) cornerCut = Math.min(1, (dist - radius) * scale);
            } else if (!nDown && !nLeft && u < radius && v > 1 - radius) {
              const dist = Math.hypot(radius - u, v - (1 - radius));
              if (dist > radius) cornerCut = Math.min(1, (dist - radius) * scale);
            } else if (!nDown && !nRight && u > 1 - radius && v > 1 - radius) {
              const dist = Math.hypot(u - (1 - radius), v - (1 - radius));
              if (dist > radius) cornerCut = Math.min(1, (dist - radius) * scale);
            }

            const col = colorForChar(ch);
            // Darken perimeter subpixels slightly for a crisp, smooth anti-aliased edge
            const nearTopEdge = !nUp && v < 0.22;
            const nearBotEdge = !nDown && v > 0.78;
            const nearLeftEdge = !nLeft && u < 0.22;
            const nearRightEdge = !nRight && u > 0.78;
            const edgeMix =
              nearTopEdge || nearBotEdge || nearLeftEdge || nearRightEdge ? 0.22 : 0.0;

            const rVal = Math.round(col[0] * (1 - edgeMix) + outRgba[0] * edgeMix);
            const gVal = Math.round(col[1] * (1 - edgeMix) + outRgba[1] * edgeMix);
            const bVal = Math.round(col[2] * (1 - edgeMix) + outRgba[2] * edgeMix);
            const alpha = Math.round(255 * (1 - cornerCut * 0.85));

            data[idx] = rVal;
            data[idx + 1] = gVal;
            data[idx + 2] = bVal;
            data[idx + 3] = alpha;
          } else {
            // Empty cell: fill inner diagonal fillets when two orthogonal neighbors are filled!
            // This eliminates stair-stepping on diagonal slopes (like the T-Rex back and tail).
            const filletRadius = 0.46;
            let fillChar = '.';
            let fillAlpha = 0;

            if (nUp && nLeft && u + v < filletRadius) {
              fillChar = chUp !== '.' ? chUp : chLeft;
              fillAlpha = Math.min(1, (filletRadius - (u + v)) * scale * 0.9);
            } else if (nUp && nRight && (1 - u) + v < filletRadius) {
              fillChar = chUp !== '.' ? chUp : chRight;
              fillAlpha = Math.min(1, (filletRadius - ((1 - u) + v)) * scale * 0.9);
            } else if (nDown && nLeft && u + (1 - v) < filletRadius) {
              fillChar = chDown !== '.' ? chDown : chLeft;
              fillAlpha = Math.min(1, (filletRadius - (u + (1 - v))) * scale * 0.9);
            } else if (nDown && nRight && (1 - u) + (1 - v) < filletRadius) {
              fillChar = chDown !== '.' ? chDown : chRight;
              fillAlpha = Math.min(1, (filletRadius - ((1 - u) + (1 - v))) * scale * 0.9);
            }

            if (fillChar !== '.' && fillAlpha > 0.02) {
              const col = colorForChar(fillChar);
              data[idx] = col[0];
              data[idx + 1] = col[1];
              data[idx + 2] = col[2];
              data[idx + 3] = Math.round(fillAlpha * 240);
            } else {
              data[idx] = 0;
              data[idx + 1] = 0;
              data[idx + 2] = 0;
              data[idx + 3] = 0;
            }
          }
        }
      }
    }
  }
}

/**
 * Creates a smooth-edged beveled/rounded 3D box geometry (`BufferGeometry`) so 3D voxels
 * on the T-Rex, vegetation, and terrain have soft rounded edges and smooth specular normals.
 */
export function createSmoothRoundedBoxGeometry(
  width = 1,
  height = 1,
  depth = 1,
  radius = 0.2,
  segments = 3,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(width, height, depth, segments, segments, segments);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const halfD = depth * 0.5;
  const r = Math.min(radius, halfW * 0.48, halfH * 0.48, halfD * 0.48);
  const innerW = Math.max(0.001, halfW - r);
  const innerH = Math.max(0.001, halfH - r);
  const innerD = Math.max(0.001, halfD - r);

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const cx = Math.max(-innerW, Math.min(innerW, v.x));
    const cy = Math.max(-innerH, Math.min(innerH, v.y));
    const cz = Math.max(-innerD, Math.min(innerD, v.z));
    const dx = v.x - cx;
    const dy = v.y - cy;
    const dz = v.z - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-5) {
      pos.setXYZ(i, cx + (dx / len) * r, cy + (dy / len) * r, cz + (dz / len) * r);
    }
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// 5x5 pixel-font digits for the 2D Phase 1 score plane
const DIGIT_GLYPHS: Record<string, string[]> = {
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
  H: ['10001', '10001', '11111', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000'],
};

/**
 * Updates a smooth-filtered DataTexture displaying score digits (e.g. "HI 00420").
 */
export function updatePixelScoreTexture(
  tex: THREE.DataTexture,
  text: string,
  fgHex = '#f8fafc',
): void {
  const W = tex.image.width;
  const H = tex.image.height;
  const data = tex.image.data as Uint8Array;
  data.fill(0);

  const [rCol, gCol, bCol] = hexToRgba(fgHex);
  const str = text.toUpperCase();
  let curX = 2;

  for (let i = 0; i < str.length; i++) {
    const glyph = DIGIT_GLYPHS[str[i]] ?? DIGIT_GLYPHS[' '];
    for (let row = 0; row < 5; row++) {
      const texY = H - 2 - row;
      if (texY < 0 || texY >= H) continue;
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === '1') {
          const px = curX + col;
          if (px >= 0 && px < W) {
            const idx = (texY * W + px) * 4;
            data[idx] = rCol;
            data[idx + 1] = gCol;
            data[idx + 2] = bCol;
            data[idx + 3] = 255;
          }
        }
      }
    }
    curX += 6;
  }
  tex.needsUpdate = true;
}
