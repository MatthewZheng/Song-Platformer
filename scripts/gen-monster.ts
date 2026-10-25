import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT_DIR, 'assets-raw', 'monster');
const OUT_DIR = path.join(ROOT_DIR, 'public', 'assets', 'monster');

export type FrameName = 'idle' | 'back' | 'walk1' | 'walk2' | 'search' | 'jumpscare';

const SPRITE_FRAMES: FrameName[] = ['idle', 'back', 'walk1', 'walk2', 'search'];
const ALL_FRAMES: FrameName[] = ['idle', 'back', 'walk1', 'walk2', 'search', 'jumpscare'];

const SHARED_ART_DIRECTION = `An original horror creature for a first-person stealth game set in a modern coworking office at night. It must not resemble any existing character from a film, game or story. Photoreal, high detail, cinematic, lit by a single cold white flashlight from the camera's position plus a faint cold glow from below, deep shadows, film grain.`;

const CREATURE_DESC = `The creature: "The Night Shift"
A gaunt human-like figure about 2.6 m tall, towering over an average adult, the coworker who never went home. An untucked, wrinkled gray hoodie over a creased collared shirt. A company lanyard with a blank, cracked ID badge. Dark sweatpants, bare feet. The arms are too long and hang past its knees, with long thin fingers. One hand holds a cracked phone at chest height, and its cold screen lights the face from below. Gray-white skin over hollow cheeks. Sunken, unblinking eyes with pinprick pupils. A slack jaw. It stands perfectly upright and still. It is much larger than a person: broad, bony shoulders on a towering frame.`;

const BLOOD_FULL = `Blood: dark, dried stains soak the hoodie's cuffs and front, spatter the collar and the cracked badge, and streak down its long fingers. Blood is smeared around its mouth and down its chin, darkest at the lips. Keep it tasteful and restrained: stains and smears that read clearly in the flashlight, no open wounds, no gore, no viscera, no dripping gore.`;

const BLOOD_TONED_DOWN = `Stains: dark dried stains on the gray hoodie cuffs and front and a faint dark smear at the mouth. Restraint: no open wounds, no gore, no viscera.`;

const SPRITE_FRAMING = `Full body character sprite, centered horizontally, complete head to bare feet visible in frame with a small margin around head and feet, on a flat pure #00FF00 chroma-key green background, no shadow on the background, no floor, no text, no watermark.`;

const POSE_PROMPTS: Record<FrameName, string> = {
  idle: `Pose (idle): facing the camera directly, standing still and upright, one hand holding the cracked phone at chest height lighting its face from below, the other overly long arm hanging past its knee.`,
  back: `Same creature, same size, same clothes, same blood stains, same lighting, same flat pure #00FF00 background; change only the pose. Pose (back): facing directly away from the camera toward a wall, head slightly bowed as if counting. Cold phone glow visible around the edge of its head and shoulders. Full body head to bare feet centered on flat pure #00FF00 background, no floor, no shadow on background.`,
  walk1: `Same creature, same size, same clothes, same blood stains, same lighting, same flat pure #00FF00 background; change only the lower legs pose. Pose (walk1): facing the camera, mid-stride with its right leg (viewer's left side) lifted slightly off the ground and its left foot (viewer's right side) planted flat at the bottom, opposite of walk2. Full body head to bare feet centered on flat pure #00FF00 background, no floor, no shadow on background.`,
  walk2: `Same creature, same size, same clothes, same blood stains, same lighting, same flat pure #00FF00 background; change only the pose. Pose (walk2): facing the camera, mid-stride with the right foot stepping forward and left foot back, overly long arms hanging loosely, slow and deliberate stride, phone at chest height lighting the face. Full body head to bare feet centered on flat pure #00FF00 background, no floor, no shadow on background.`,
  search: `Same creature, same size, same clothes, same blood stains, same lighting, same flat pure #00FF00 background; change only the pose. Pose (search): bent stiffly at the waist, head turned sideways, one long thin-fingered arm reaching forward at waist height as if opening a phone booth door or looking under a desk. Full body head to bare feet centered on flat pure #00FF00 background, no floor, no shadow on background.`,
  jumpscare: `Same creature ("The Night Shift"), same face, same gray hoodie and lanyard, same lighting. Extreme close-up of the gaunt face lunging straight at the camera, filling the 16:9 frame. Jaw open wide, dark stains smeared around the mouth and chin, sunken unblinking eyes with pinprick pupils locked on the viewer, cold phone light from below, intense motion blur at the edges, pitch black #000000 background, no text.`,
};

export interface FrameManifestEntry {
  file: string;
  width: number;
  height: number;
  anchor: { x: number; y: number };
}

export interface MonsterManifest {
  worldHeight: number;
  frames: Record<FrameName, FrameManifestEntry>;
}

function buildPrompt(frame: FrameName, tonedDown: boolean): string {
  const bloodText = tonedDown ? BLOOD_TONED_DOWN : BLOOD_FULL;
  if (frame === 'jumpscare') {
    return [SHARED_ART_DIRECTION, CREATURE_DESC, bloodText, POSE_PROMPTS.jumpscare].join('\n\n');
  }
  return [
    SHARED_ART_DIRECTION,
    CREATURE_DESC,
    bloodText,
    SPRITE_FRAMING,
    POSE_PROMPTS[frame],
  ].join('\n\n');
}

function extractImageBufferFromInteraction(interaction: unknown): Buffer | null {
  const inter = interaction as {
    output_image?: string | { data?: string };
    steps?: Array<{
      type?: string;
      content?: Array<{ type?: string; data?: string; image?: { data?: string } }>;
    }>;
    outputs?: Array<{ type?: string; data?: string }>;
  };

  if (typeof inter.output_image === 'string' && inter.output_image.length > 100) {
    return Buffer.from(inter.output_image, 'base64');
  }
  if (
    inter.output_image &&
    typeof inter.output_image === 'object' &&
    typeof inter.output_image.data === 'string'
  ) {
    return Buffer.from(inter.output_image.data, 'base64');
  }
  if (Array.isArray(inter.outputs)) {
    for (const out of inter.outputs) {
      if (out.type === 'image' && typeof out.data === 'string') {
        return Buffer.from(out.data, 'base64');
      }
    }
  }
  if (Array.isArray(inter.steps)) {
    for (const step of inter.steps) {
      if (Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item.type === 'image' && typeof item.data === 'string') {
            return Buffer.from(item.data, 'base64');
          }
          if (item.image && typeof item.image.data === 'string') {
            return Buffer.from(item.image.data, 'base64');
          }
        }
      }
    }
  }
  return null;
}

async function callNanoBanana(
  ai: GoogleGenAI,
  frame: FrameName,
  baseIdleRawBuffer: Buffer | null,
  tonedDown: boolean,
): Promise<Buffer> {
  const promptText = buildPrompt(frame, tonedDown);
  const aspectRatio = frame === 'jumpscare' ? '16:9' : '3:4';

  const inputPayload =
    frame !== 'idle' && baseIdleRawBuffer
      ? [
          {
            type: 'image' as const,
            data: baseIdleRawBuffer.toString('base64'),
            mime_type: 'image/png',
          },
          {
            type: 'text' as const,
            text: promptText,
          },
        ]
      : promptText;

  const interaction = await ai.interactions.create(
    {
      model: 'gemini-nano-banana-2.1',
      input: inputPayload,
      response_modalities: ['image', 'text'],
      generation_config: {
        image_config: {
          aspect_ratio: aspectRatio,
          image_size: '2K',
        },
      },
    },
    { timeout: 180_000 },
  );

  const imgBuf = extractImageBufferFromInteraction(interaction);
  if (!imgBuf) {
    const textMsg = (interaction as { output_text?: string }).output_text || 'No image returned';
    throw new Error(`Model returned no image for "${frame}": ${textMsg.slice(0, 240)}`);
  }
  return imgBuf;
}

async function generateFrameWithRetry(
  ai: GoogleGenAI,
  frame: FrameName,
  baseIdleRawBuffer: Buffer | null,
): Promise<Buffer> {
  try {
    console.log(`[gen-monster] Generating frame "${frame}" with gemini-nano-banana-2.1...`);
    return await callNanoBanana(ai, frame, baseIdleRawBuffer, false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[gen-monster] Frame "${frame}" declined or failed on first attempt (${msg}). Retrying once with blood toned down...`,
    );
    const buf = await callNanoBanana(ai, frame, baseIdleRawBuffer, true);
    console.log(`[gen-monster] Frame "${frame}" succeeded with toned-down blood.`);
    return buf;
  }
}

/**
 * Chroma-keys pure/near #00FF00 background to transparent with soft edge feathering
 * and green-spill suppression, trims to content bounds, and scales character to
 * 1536 px tall with feet aligned to bottom and body horizontally centered on a
 * 1024x1536 canvas.
 */
async function processSpriteFrame(rawBuffer: Buffer, outPath: string): Promise<{ width: number; height: number }> {
  const { data, info } = await sharp(rawBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const rgba = Buffer.from(data);

  // Sample corners to get exact background green in case of slight shade drift
  let bgR = 0;
  let bgG = 255;
  let bgB = 0;
  const cornerCoords = [
    [2, 2],
    [w - 3, 2],
    [2, h - 3],
    [w - 3, h - 3],
  ];
  let validCorners = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const [cx, cy] of cornerCoords) {
    const idx = (cy * w + cx) * 4;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    if (g > 140 && g > r * 1.3 && g > b * 1.3) {
      sumR += r;
      sumG += g;
      sumB += b;
      validCorners++;
    }
  }
  if (validCorners > 0) {
    bgR = sumR / validCorners;
    bgG = sumG / validCorners;
    bgB = sumB / validCorners;
  }

  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];

      // Color distance from background green + green dominance metric
      const dr = r - bgR;
      const dg = g - bgG;
      const db = b - bgB;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);

      const maxRB = Math.max(r, b);
      const greenExcess = g - maxRB;

      // Combine distance to #00FF00 and green excess for soft alpha key
      let alpha = 1.0;
      if (dist < 62 || (greenExcess > 65 && g > 110)) {
        alpha = 0.0;
      } else if (dist < 118 || greenExcess > 22) {
        const aDist = Math.min(1, Math.max(0, (dist - 62) / (118 - 62)));
        const aExcess = Math.min(1, Math.max(0, 1 - (greenExcess - 22) / (65 - 22)));
        alpha = Math.min(aDist, aExcess);
      }

      // Green-spill suppression on all kept pixels
      if (alpha > 0 && g > maxRB) {
        const spillFactor = alpha < 0.95 ? 1.0 : 0.65;
        rgba[i + 1] = Math.round(g - (g - maxRB) * spillFactor);
      }

      const finalAlpha = Math.round(alpha * 255);
      rgba[i + 3] = finalAlpha;

      if (finalAlpha > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) {
    minX = 0;
    minY = 0;
    maxX = w - 1;
    maxY = h - 1;
  }

  const cropW = Math.max(1, maxX - minX + 1);
  const cropH = Math.max(1, maxY - minY + 1);

  const TARGET_H = 1536;
  const TARGET_W = 1024;
  const scale = TARGET_H / cropH;
  const scaledW = Math.min(TARGET_W, Math.max(1, Math.round(cropW * scale)));
  const scaledH = Math.min(TARGET_H, Math.max(1, Math.round(cropH * scale)));

  const trimmedBuffer = await sharp(rgba, {
    raw: { width: w, height: h, channels: 4 },
  })
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .resize(scaledW, scaledH, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // Align feet to bottom edge (top = TARGET_H - scaledH) and center body horizontally
  const leftOffset = Math.floor((TARGET_W - scaledW) / 2);
  const topOffset = TARGET_H - scaledH;

  const tmpPath = `${outPath}.tmp.png`;
  await sharp({
    create: {
      width: TARGET_W,
      height: TARGET_H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: trimmedBuffer, left: leftOffset, top: topOffset }])
    .png({ compressionLevel: 9 })
    .toFile(tmpPath);

  fs.renameSync(tmpPath, outPath);
  return { width: TARGET_W, height: TARGET_H };
}

async function processJumpscare(rawBuffer: Buffer, outPath: string): Promise<{ width: number; height: number }> {
  const TARGET_W = 1920;
  const TARGET_H = 1080;
  const tmpPath = `${outPath}.tmp.jpg`;
  await sharp(rawBuffer)
    .resize(TARGET_W, TARGET_H, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(tmpPath);
  fs.renameSync(tmpPath, outPath);
  return { width: TARGET_W, height: TARGET_H };
}

async function buildContactSheet(): Promise<void> {
  const thumbH = 420;
  const spriteThumbW = 280;
  const jumpThumbW = 560;
  const pad = 16;
  const sheetW = SPRITE_FRAMES.length * (spriteThumbW + pad) + jumpThumbW + pad * 2;
  const sheetH = thumbH + pad * 2;

  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  let xCursor = pad;

  for (const frame of SPRITE_FRAMES) {
    const p = path.join(OUT_DIR, `${frame}.png`);
    if (fs.existsSync(p)) {
      const thumb = await sharp(p)
        .resize(spriteThumbW, thumbH, {
          fit: 'contain',
          background: { r: 32, g: 34, b: 40, alpha: 1 },
        })
        .png()
        .toBuffer();
      composites.push({ input: thumb, left: xCursor, top: pad });
    }
    xCursor += spriteThumbW + pad;
  }

  const jumpPath = path.join(OUT_DIR, 'jumpscare.jpg');
  if (fs.existsSync(jumpPath)) {
    const jThumb = await sharp(jumpPath)
      .resize(jumpThumbW, thumbH, {
        fit: 'contain',
        background: { r: 16, g: 16, b: 20, alpha: 1 },
      })
      .png()
      .toBuffer();
    composites.push({ input: jThumb, left: xCursor, top: pad });
  }

  const sheetPath = path.join(RAW_DIR, 'contact-sheet.png');
  const tmpSheet = `${sheetPath}.tmp.png`;
  await sharp({
    create: {
      width: sheetW,
      height: sheetH,
      channels: 4,
      background: { r: 24, g: 26, b: 32, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toFile(tmpSheet);
  fs.renameSync(tmpSheet, sheetPath);
  console.log(`[gen-monster] Wrote contact sheet -> ${sheetPath}`);
}

async function updateManifest(): Promise<void> {
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const frames: Partial<Record<FrameName, FrameManifestEntry>> = {};

  for (const frame of SPRITE_FRAMES) {
    const file = `${frame}.png`;
    const fullPath = path.join(OUT_DIR, file);
    let width = 1024;
    let height = 1536;
    if (fs.existsSync(fullPath)) {
      const meta = await sharp(fullPath).metadata();
      width = meta.width ?? 1024;
      height = meta.height ?? 1536;
    }
    frames[frame] = {
      file,
      width,
      height,
      anchor: { x: 0.5, y: 1.0 },
    };
  }

  const jumpFile = 'jumpscare.jpg';
  const jumpFull = path.join(OUT_DIR, jumpFile);
  let jw = 1920;
  let jh = 1080;
  if (fs.existsSync(jumpFull)) {
    const meta = await sharp(jumpFull).metadata();
    jw = meta.width ?? 1920;
    jh = meta.height ?? 1080;
  }
  frames.jumpscare = {
    file: jumpFile,
    width: jw,
    height: jh,
    anchor: { x: 0.5, y: 0.5 },
  };

  const manifest: MonsterManifest = {
    worldHeight: 2.6,
    frames: frames as Record<FrameName, FrameManifestEntry>,
  };

  const tmpManifest = `${manifestPath}.tmp.json`;
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(tmpManifest, manifestPath);
  console.log(`[gen-monster] Wrote manifest -> ${manifestPath}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const args = process.argv.slice(2);
  let onlyFrame: FrameName | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--only' && args[i + 1]) {
      const candidate = args[i + 1] as FrameName;
      if (!ALL_FRAMES.includes(candidate)) {
        console.error(`[gen-monster] Unknown frame "${candidate}". Valid frames: ${ALL_FRAMES.join(', ')}`);
        process.exit(1);
      }
      onlyFrame = candidate;
      break;
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[gen-monster] GEMINI_API_KEY is missing in environment.');
    process.exit(1);
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const targetFrames: FrameName[] = onlyFrame ? [onlyFrame] : ALL_FRAMES;
  const idleRawPath = path.join(RAW_DIR, 'idle.png');
  let baseIdleBuffer: Buffer | null = fs.existsSync(idleRawPath)
    ? fs.readFileSync(idleRawPath)
    : null;

  // Ensure base idle exists if generating an edit frame with --only
  if (onlyFrame && onlyFrame !== 'idle' && !baseIdleBuffer) {
    console.log('[gen-monster] Base idle.png not found; generating base "idle" first...');
    try {
      baseIdleBuffer = await generateFrameWithRetry(ai, 'idle', null);
      fs.writeFileSync(idleRawPath, baseIdleBuffer);
      await processSpriteFrame(baseIdleBuffer, path.join(OUT_DIR, 'idle.png'));
    } catch (err) {
      console.error('[gen-monster] Failed to generate base idle frame:', err);
    }
  }

  for (const frame of targetFrames) {
    try {
      const rawBuf = await generateFrameWithRetry(
        ai,
        frame,
        frame === 'idle' ? null : baseIdleBuffer,
      );
      const rawExt = frame === 'jumpscare' ? 'png' : 'png';
      const rawFilePath = path.join(RAW_DIR, `${frame}.${rawExt}`);
      fs.writeFileSync(rawFilePath, rawBuf);
      if (frame === 'idle') {
        baseIdleBuffer = rawBuf;
      }

      if (frame === 'jumpscare') {
        const outPath = path.join(OUT_DIR, 'jumpscare.jpg');
        await processJumpscare(rawBuf, outPath);
        console.log(`[gen-monster] Processed jumpscare -> ${outPath}`);
      } else {
        const outPath = path.join(OUT_DIR, `${frame}.png`);
        await processSpriteFrame(rawBuf, outPath);
        console.log(`[gen-monster] Processed sprite "${frame}" -> ${outPath}`);
      }
    } catch (err) {
      console.error(`[gen-monster] Error on frame "${frame}" (keeping existing frames):`, err);
    }
  }

  await updateManifest();
  await buildContactSheet();
}

main().catch((err) => {
  console.error('[gen-monster] Fatal error:', err);
  process.exit(1);
});
