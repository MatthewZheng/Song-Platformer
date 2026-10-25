import * as THREE from 'three';
import type { GameContext, GameModule } from '../../shell/api';
import {
  DEFAULT_TILES_FRAGMENT_SHADER,
  isValidTilesShaderSource,
} from '../../shell/slots';
import {
  beatPhase,
  energyAt,
  lowAt,
  midAt,
  highAt,
  sectionIndexAt,
  sectionProgressAt,
} from '../../shared/songmap';
import { TilesBotController } from './bot';
import { defaultParams, generateLevel, type TilesLevel, type TilesParams } from './level';
import { computeLevelStaticMetrics, TilesSimEngine } from './sim';

export { defaultParams, paramRanges, generateLevel } from './level';
export { simulate } from './sim';

const rawSlotShaders = import.meta.glob('../../slots/*/tiles.backgroundShader.glsl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function getBundledSlotShaderForSong(songId: string): string | null {
  for (const [p, content] of Object.entries(rawSlotShaders)) {
    if (p.includes(`/slots/${songId}/tiles.backgroundShader.glsl`) && typeof content === 'string') {
      return content;
    }
  }
  return null;
}

const isSoftwareGl = (() => {
  if (typeof document === 'undefined') return true;
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
})();

// Render background at far clip plane (z = 0.999) so opaque 3D highway geometry
// automatically benefits from hardware Early-Z rejection (~40% fewer fragment executions)
const BG_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.999, 1.0);
}
`;

const LOOKAHEAD_SEC = 1.5;
const Z_SPAWN = -16.85;
const Z_HIT = 2.65;
const HIGHWAY_LENGTH = Z_HIT - Z_SPAWN; // 19.5 world units -> 13.0 units/s constant scroll
const LANE_CENTERS_X = [-1.65, -0.55, 0.55, 1.65] as const;
const LANE_KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] as const;
const LANE_LABELS = ['D', 'F', 'J', 'K'] as const;
const NOTE_POOL_SIZE = 32;
const PARTICLE_POOL_SIZE = 128;

interface ParticleState {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  age: number;
  maxAge: number;
  scale: number;
  color: THREE.Color;
}

interface QueuedPress {
  lane: number;
  pressTime: number;
}

function testFragmentShaderCompile(
  renderer: THREE.WebGLRenderer,
  fragmentSource: string,
): { ok: boolean; log: string } {
  try {
    const gl = renderer.getContext();
    if (!gl) return { ok: true, log: '' };
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    if (!sh) return { ok: true, log: '' };
    gl.shaderSource(sh, fragmentSource);
    gl.compileShader(sh);
    const ok = Boolean(gl.getShaderParameter(sh, gl.COMPILE_STATUS));
    const log = ok ? '' : String(gl.getShaderInfoLog(sh) || 'Unknown GLSL compile error');
    gl.deleteShader(sh);
    return { ok, log };
  } catch (err) {
    return { ok: false, log: String(err) };
  }
}

export function createTilesGame(): GameModule {
  let ctx!: GameContext;
  let level!: TilesLevel;
  let sim: TilesSimEngine | null = null;
  let cachedStaticMetrics: ReturnType<typeof computeLevelStaticMetrics> | null = null;
  const bot = new TilesBotController();

  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;

  // Fullscreen background shader quad
  let bgMat: THREE.ShaderMaterial | null = null;
  let bgUniforms: {
    uTime: { value: number };
    uSongTime: { value: number };
    uRes: { value: THREE.Vector2 };
    uLow: { value: number };
    uMid: { value: number };
    uHigh: { value: number };
    uEnergy: { value: number };
    uBeatPhase: { value: number };
    uSection: { value: number };
    uSectionProgress: { value: number };
    uPalette: { value: THREE.Vector3[] };
    uMissFlash: { value: number };
    uBloom: { value: number };
    uDesat: { value: number };
  } | null = null;

  // 3D Highway, Key Caps, Instanced Notes & Instanced Particles
  let highwayGroup: THREE.Group | null = null;
  let laneDividerMats: THREE.MeshBasicMaterial[] = [];
  let hitBarMat: THREE.MeshBasicMaterial | null = null;
  let keyCapGroups: THREE.Group[] = [];
  let keyCapRimMats: THREE.MeshBasicMaterial[] = [];
  let keyCapTopMats: THREE.MeshLambertMaterial[] = [];
  let gridLinesGroup: THREE.Group | null = null;

  // 3 InstancedMeshes for all falling notes (3 draw calls total instead of 96)
  let noteCoreInstanced: THREE.InstancedMesh | null = null;
  let noteEdgeInstanced: THREE.InstancedMesh | null = null;
  let noteFrontInstanced: THREE.InstancedMesh | null = null;
  let noteFrontMat: THREE.MeshBasicMaterial | null = null;
  let firstVisibleNoteIdx = 0;

  let particleInstanced: THREE.InstancedMesh | null = null;
  let activeParticleCount = 0;
  let particleColorsDirty = false;
  const particles: ParticleState[] = Array.from({ length: PARTICLE_POOL_SIZE }, () => ({
    active: false,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    rx: 0,
    ry: 0,
    age: 0,
    maxAge: 0.6,
    scale: 1,
    color: new THREE.Color('#ffffff'),
  }));
  let particleCursor = 0;

  // Pre-allocated scratch math objects (zero per-frame GC allocations)
  const _dummyObj = new THREE.Object3D();
  const _ZeroScaleMat = new THREE.Matrix4().makeScale(0, 0, 0);
  const _tmpColor = new THREE.Color();
  const _noteEdgeColor = new THREE.Color();

  // Cached parsed palette colors (only parsed when palette hex strings change)
  let lastPaletteSig = '';
  const cachedPalColors = {
    bg: new THREE.Color('#090a10'),
    primary: new THREE.Color('#00ff66'),
    secondary: new THREE.Color('#14b8a6'),
    accent: new THREE.Color('#f59e0b'),
    highlight: new THREE.Color('#f8fafc'),
  };
  const cachedPalColorArray = [
    cachedPalColors.primary,
    cachedPalColors.secondary,
    cachedPalColors.accent,
    cachedPalColors.highlight,
  ];

  // DOM HUD elements (5 Miss Pips at top + Key Cap labels at 82% height + Streak/Judgement readout)
  let hudRootEl: HTMLElement | null = null;
  let missPipEls: HTMLElement[] = [];
  let keyDomEls: HTMLElement[] = [];
  let streakTextEl: HTMLElement | null = null;
  let judgementTextEl: HTMLElement | null = null;
  let judgementFadeTimer = 0;
  let judgementVisible = false;
  let lastRenderedMisses = -1;
  let lastRenderedStreak = -1;
  const lastDomKeyPressed: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  let lastDomPaletteSig = '';

  // Smooth animation state
  let active = false;
  let shaderTime = 0;
  let smoothedLow = 0;
  let smoothedMid = 0;
  let smoothedHigh = 0;
  let smoothedEnergy = 0.5;
  let highwayPulseScale = 1.0;
  let cameraFovOffset = 0.0;
  const BASE_FOV = 50;
  let lastSectionIdx = -1;
  let lastLowOnsetIdx = -1;
  let shatterTriggered = false;
  let lastSimSongTime = -1;

  // Shader slot health & FPS tracking
  let shaderCompiledMetric = 1;
  let usingDefaultFallbackShader = false;
  let fpsAvg = 60;
  let lowFpsAccumSec = 0;

  // Queued keyboard presses per frame with exact sub-frame keydown timestamps
  const queuedPresses: QueuedPress[] = [];
  const scratchLanes: number[] = [];
  const scratchTimes: number[] = [];
  const heldLanes: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  const keyPressAnim: [number, number, number, number] = [0, 0, 0, 0];

  // Palette color interpolation vectors for shader uniform uPalette[5]
  const currentPalVecs = [
    new THREE.Vector3(0.04, 0.05, 0.08),
    new THREE.Vector3(0.0, 1.0, 0.4),
    new THREE.Vector3(0.1, 0.6, 0.55),
    new THREE.Vector3(0.85, 0.68, 0.2),
    new THREE.Vector3(0.95, 1.0, 0.96),
  ];
  const targetPalVecs = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];

  function syncCachedPaletteColors(pal: {
    bg: string;
    primary: string;
    secondary: string;
    accent: string;
    highlight: string;
  }): void {
    const sig = `${pal.bg}|${pal.primary}|${pal.secondary}|${pal.accent}|${pal.highlight}`;
    if (sig === lastPaletteSig) return;
    lastPaletteSig = sig;
    cachedPalColors.bg.set(pal.bg);
    cachedPalColors.primary.set(pal.primary);
    cachedPalColors.secondary.set(pal.secondary);
    cachedPalColors.accent.set(pal.accent);
    cachedPalColors.highlight.set(pal.highlight);
    targetPalVecs[0].set(cachedPalColors.bg.r, cachedPalColors.bg.g, cachedPalColors.bg.b);
    targetPalVecs[1].set(cachedPalColors.primary.r, cachedPalColors.primary.g, cachedPalColors.primary.b);
    targetPalVecs[2].set(cachedPalColors.secondary.r, cachedPalColors.secondary.g, cachedPalColors.secondary.b);
    targetPalVecs[3].set(cachedPalColors.accent.r, cachedPalColors.accent.g, cachedPalColors.accent.b);
    targetPalVecs[4].set(cachedPalColors.highlight.r, cachedPalColors.highlight.g, cachedPalColors.highlight.b);
  }

  // Lightweight throttled Web Audio chime synth
  let audioCtx: AudioContext | null = null;
  let lastSoundWallMs = 0;
  function playNoteFeedbackSound(kind: 'PERFECT' | 'GOOD' | 'MISS', lane: number): void {
    if (isSoftwareGl) return;
    const nowWall = performance.now();
    if (nowWall - lastSoundWallMs < 22 && kind !== 'MISS') return;
    lastSoundWallMs = nowWall;
    try {
      if (!audioCtx) {
        const Ctor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        audioCtx = new Ctor();
      }
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume();
      }
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const laneFreqs = [329.63, 392.0, 440.0, 523.25];
      if (kind === 'MISS') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(135, now);
        osc.frequency.exponentialRampToValueAtTime(75, now + 0.14);
        gain.gain.setValueAtTime(0.07, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.16);
      } else {
        osc.type = 'triangle';
        const baseFreq = laneFreqs[lane & 3] * (kind === 'PERFECT' ? 1.5 : 1.0);
        osc.frequency.setValueAtTime(baseFreq, now);
        gain.gain.setValueAtTime(kind === 'PERFECT' ? 0.055 : 0.035, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.09);
      }
    } catch {
      // ignore audio errors in headless environments
    }
  }

  function spawnParticleBurst(
    originX: number,
    originY: number,
    originZ: number,
    count: number,
    speedScale = 1.0,
  ): void {
    if (!particleInstanced) return;
    for (let i = 0; i < count; i++) {
      const p = particles[particleCursor];
      particleCursor = (particleCursor + 1) % PARTICLE_POOL_SIZE;
      if (!p.active) {
        activeParticleCount++;
      }
      p.active = true;
      p.x = originX + (Math.random() - 0.5) * 0.45;
      p.y = originY + (Math.random() - 0.5) * 0.15;
      p.z = originZ + (Math.random() - 0.5) * 0.35;
      const angle = Math.random() * Math.PI * 2;
      const speed = (1.6 + Math.random() * 3.4) * speedScale;
      p.vx = Math.cos(angle) * speed * 0.85;
      p.vy = (2.4 + Math.random() * 3.8) * speedScale;
      p.vz = Math.sin(angle) * speed * 0.65;
      p.rx = (Math.random() - 0.5) * 9;
      p.ry = (Math.random() - 0.5) * 9;
      p.age = 0;
      p.maxAge = 0.38 + Math.random() * 0.28;
      p.scale = 0.07 + Math.random() * 0.065;
      p.color.copy(cachedPalColorArray[i & 3]);
    }
    particleColorsDirty = true;
    particleInstanced.visible = true;
  }

  function triggerDeathShatter(): void {
    if (shatterTriggered) return;
    shatterTriggered = true;
    for (let l = 0; l < 4; l++) {
      spawnParticleBurst(LANE_CENTERS_X[l], 0.12, Z_HIT, 14, 1.45);
    }
    if (noteCoreInstanced) noteCoreInstanced.count = 0;
    if (noteEdgeInstanced) noteEdgeInstanced.count = 0;
    if (noteFrontInstanced) noteFrontInstanced.count = 0;
  }

  function applyDomKeyCapStyle(lane: number, pressed: boolean): void {
    if (lastDomKeyPressed[lane] === pressed && lastDomPaletteSig === lastPaletteSig) return;
    lastDomKeyPressed[lane] = pressed;
    const el = keyDomEls[lane];
    if (!el) return;
    const pal = ctx.palette.at(ctx.clock.now());
    el.style.borderColor = pressed ? pal.highlight : pal.accent;
    el.style.backgroundColor = pressed ? pal.accent : 'rgba(9, 13, 22, 0.92)';
    el.style.color = pressed ? '#050811' : '#f8fafc';
    el.style.transform = pressed ? 'scale(0.92) translateY(2px)' : 'scale(1) translateY(0px)';
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!active || !sim || sim.dying) return;
    if (e.repeat) return;

    let lane = -1;
    if (e.code === 'KeyD') lane = 0;
    else if (e.code === 'KeyF') lane = 1;
    else if (e.code === 'KeyJ') lane = 2;
    else if (e.code === 'KeyK') lane = 3;

    if (lane >= 0) {
      e.preventDefault();
      // Capture exact audio clock timestamp immediately on keydown to eliminate frame-interval latency
      const pressTime = ctx.clock.now();
      heldLanes[lane] = true;
      keyPressAnim[lane] = 1.0;
      queuedPresses.push({ lane, pressTime });
      applyDomKeyCapStyle(lane, true);
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    let lane = -1;
    if (e.code === 'KeyD') lane = 0;
    else if (e.code === 'KeyF') lane = 1;
    else if (e.code === 'KeyJ') lane = 2;
    else if (e.code === 'KeyK') lane = 3;
    if (lane >= 0) {
      heldLanes[lane] = false;
    }
  }

  function onWindowBlur(): void {
    heldLanes[0] = false;
    heldLanes[1] = false;
    heldLanes[2] = false;
    heldLanes[3] = false;
  }

  function loadAndCompileSongShader(): void {
    if (!renderer || !bgMat) return;
    const rawSlot =
      getBundledSlotShaderForSong(ctx.map.id) ?? ctx.slots?.tiles?.backgroundShader ?? null;

    if (rawSlot && isValidTilesShaderSource(rawSlot)) {
      const check = testFragmentShaderCompile(renderer, rawSlot);
      if (check.ok) {
        bgMat.fragmentShader = rawSlot;
        bgMat.needsUpdate = true;
        shaderCompiledMetric = 1;
        usingDefaultFallbackShader = false;
        return;
      } else {
        console.warn(
          `[tiles] Slot shader for '${ctx.map.id}' failed WebGL compilation (${check.log}); switching to default.frag.glsl`,
        );
      }
    } else if (rawSlot) {
      console.warn(
        `[tiles] Slot shader for '${ctx.map.id}' missing required uniforms; switching to default.frag.glsl`,
      );
    }

    bgMat.fragmentShader = DEFAULT_TILES_FRAGMENT_SHADER;
    bgMat.needsUpdate = true;
    const defCheck = testFragmentShaderCompile(renderer, DEFAULT_TILES_FRAGMENT_SHADER);
    shaderCompiledMetric = defCheck.ok ? 1 : 0;
    usingDefaultFallbackShader = true;
  }

  function buildSceneAndDom(): void {
    ctx.root.innerHTML = '';

    renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    // Cap pixel ratio at 1.25 so 2x Retina displays don't execute 4x fragment shader pixels
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.25));
    renderer.setSize(window.innerWidth, window.innerHeight);
    ctx.root.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    // Camera positioned and tilted so the hit line (Z_HIT = 2.65, Y = 0) lands at 82% of screen height
    camera = new THREE.PerspectiveCamera(
      BASE_FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    );
    camera.position.set(0, 4.2, 6.0);
    camera.lookAt(0, 0.9, -2.5);

    // Lightweight two-light rig (Hemisphere + Directional key light) for glossy piano notes
    const hemi = new THREE.HemisphereLight('#e0f2fe', '#090d16', 1.35);
    scene.add(hemi);
    const keyLight = new THREE.DirectionalLight('#ffffff', 2.0);
    keyLight.position.set(2.5, 9.0, 6.0);
    scene.add(keyLight);

    // 1. Three.js Note Highway Group (rendered FIRST with depthWrite: true for Early-Z culling)
    highwayGroup = new THREE.Group();
    scene.add(highwayGroup);

    const highwayCenterZ = (Z_SPAWN + Z_HIT) * 0.5;
    const totalWidth = 4.4;

    // Opaque obsidian highway bed (eliminates full-screen alpha overdraw)
    const bedGeo = new THREE.BoxGeometry(totalWidth + 0.16, 0.08, HIGHWAY_LENGTH + 1.4);
    const bedMat = new THREE.MeshLambertMaterial({
      color: 0x070a13,
    });
    const bedMesh = new THREE.Mesh(bedGeo, bedMat);
    bedMesh.position.set(0, -0.05, highwayCenterZ);
    highwayGroup.add(bedMesh);

    // Opaque alternating lane surface strips (offset by +0.02 Y so coplanar faces never Z-fight)
    const stripGeo = new THREE.PlaneGeometry(1.04, HIGHWAY_LENGTH + 1.0);
    stripGeo.rotateX(-Math.PI / 2);
    const stripEvenMat = new THREE.MeshLambertMaterial({ color: 0x0c1120 });
    const stripOddMat = new THREE.MeshLambertMaterial({ color: 0x10172a });
    for (let l = 0; l < 4; l++) {
      const stripMesh = new THREE.Mesh(stripGeo, l % 2 === 0 ? stripEvenMat : stripOddMat);
      stripMesh.position.set(LANE_CENTERS_X[l], 0.004, highwayCenterZ);
      highwayGroup.add(stripMesh);
    }

    // 5 Lane Divider Rails (unlit MeshBasicMaterial for crisp neon glow at minimal GPU cost)
    laneDividerMats = [];
    const outerRailGeo = new THREE.BoxGeometry(0.065, 0.11, HIGHWAY_LENGTH + 1.2);
    const innerRailGeo = new THREE.BoxGeometry(0.032, 0.04, HIGHWAY_LENGTH + 1.2);
    for (let r = 0; r < 5; r++) {
      const isOuter = r === 0 || r === 4;
      const railX = -2.2 + r * 1.1;
      const railMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
      });
      laneDividerMats.push(railMat);
      const railMesh = new THREE.Mesh(isOuter ? outerRailGeo : innerRailGeo, railMat);
      railMesh.position.set(railX, isOuter ? 0.04 : 0.018, highwayCenterZ);
      highwayGroup.add(railMesh);
    }

    // Scrolling horizontal beat markers on the highway
    gridLinesGroup = new THREE.Group();
    const gridLineMat = new THREE.MeshBasicMaterial({
      color: 0x334155,
    });
    const gridLineGeo = new THREE.PlaneGeometry(totalWidth - 0.1, 0.035);
    gridLineGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const line = new THREE.Mesh(gridLineGeo, gridLineMat);
      line.position.set(0, 0.008, Z_SPAWN + (i / 12) * HIGHWAY_LENGTH);
      gridLinesGroup.add(line);
    }
    highwayGroup.add(gridLinesGroup);

    // Hit line laser bar at Z_HIT (82% of screen height)
    const hitBarGeo = new THREE.BoxGeometry(totalWidth + 0.12, 0.035, 0.09);
    hitBarMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });
    const hitBarMesh = new THREE.Mesh(hitBarGeo, hitBarMat);
    hitBarMesh.position.set(0, 0.025, Z_HIT);
    highwayGroup.add(hitBarMesh);

    // 4 Composite 3D Key Caps at the Hit Line (D, F, J, K)
    keyCapGroups = [];
    keyCapRimMats = [];
    keyCapTopMats = [];
    const socketGeo = new THREE.BoxGeometry(1.02, 0.08, 0.88);
    const capBodyGeo = new THREE.BoxGeometry(0.92, 0.11, 0.76);
    const capRimGeo = new THREE.BoxGeometry(0.96, 0.04, 0.8);

    const socketMat = new THREE.MeshLambertMaterial({
      color: 0x090c14,
    });

    for (let l = 0; l < 4; l++) {
      const kGroup = new THREE.Group();
      kGroup.position.set(LANE_CENTERS_X[l], 0.02, Z_HIT + 0.48);

      const socketMesh = new THREE.Mesh(socketGeo, socketMat);
      socketMesh.position.y = -0.02;
      kGroup.add(socketMesh);

      const topMat = new THREE.MeshLambertMaterial({
        color: 0x111726,
        emissive: 0x1e293b,
        emissiveIntensity: 0.25,
      });
      keyCapTopMats.push(topMat);
      const capBodyMesh = new THREE.Mesh(capBodyGeo, topMat);
      capBodyMesh.position.y = 0.05;
      kGroup.add(capBodyMesh);

      const rimMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
      });
      keyCapRimMats.push(rimMat);
      const capRimMesh = new THREE.Mesh(capRimGeo, rimMat);
      capRimMesh.position.y = 0.02;
      kGroup.add(capRimMesh);

      highwayGroup.add(kGroup);
      keyCapGroups.push(kGroup);
    }

    // 2. Instanced Piano-Key Notes (3 InstancedMeshes = 3 total draw calls for all falling notes)
    const noteCoreGeo = new THREE.BoxGeometry(0.84, 0.13, 0.92);
    noteCoreGeo.translate(0, 0.085, 0);
    const glossyBlackPianoMat = new THREE.MeshPhongMaterial({
      color: 0x070a12,
      specular: 0x64748b,
      shininess: 90,
    });
    noteCoreInstanced = new THREE.InstancedMesh(noteCoreGeo, glossyBlackPianoMat, NOTE_POOL_SIZE);
    noteCoreInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    noteCoreInstanced.frustumCulled = false;
    noteCoreInstanced.count = 0;
    highwayGroup.add(noteCoreInstanced);

    const noteEdgeGeo = new THREE.BoxGeometry(0.92, 0.06, 0.98);
    noteEdgeGeo.translate(0, 0.045, 0);
    const noteEdgeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    noteEdgeInstanced = new THREE.InstancedMesh(noteEdgeGeo, noteEdgeMat, NOTE_POOL_SIZE);
    noteEdgeInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    noteEdgeInstanced.frustumCulled = false;
    noteEdgeInstanced.count = 0;
    for (let i = 0; i < NOTE_POOL_SIZE; i++) {
      noteEdgeInstanced.setColorAt(i, cachedPalColors.primary);
    }
    highwayGroup.add(noteEdgeInstanced);

    const noteFrontStrikeGeo = new THREE.BoxGeometry(0.86, 0.145, 0.09);
    noteFrontStrikeGeo.translate(0, 0.088, 0.43);
    noteFrontMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    noteFrontInstanced = new THREE.InstancedMesh(noteFrontStrikeGeo, noteFrontMat, NOTE_POOL_SIZE);
    noteFrontInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    noteFrontInstanced.frustumCulled = false;
    noteFrontInstanced.count = 0;
    highwayGroup.add(noteFrontInstanced);

    // 3. Fullscreen Background Shader Quad (rendered with depthTest: true at z=0.999 so Early-Z skips highway pixels)
    bgUniforms = {
      uTime: { value: 0 },
      uSongTime: { value: 0 },
      uRes: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uLow: { value: 0 },
      uMid: { value: 0 },
      uHigh: { value: 0 },
      uEnergy: { value: 0.5 },
      uBeatPhase: { value: 0 },
      uSection: { value: 0 },
      uSectionProgress: { value: 0 },
      uPalette: { value: currentPalVecs },
      uMissFlash: { value: 0 },
      uBloom: { value: 0 },
      uDesat: { value: 0 },
    };

    bgMat = new THREE.ShaderMaterial({
      uniforms: bgUniforms,
      vertexShader: BG_VERTEX_SHADER,
      fragmentShader: DEFAULT_TILES_FRAGMENT_SHADER,
      depthWrite: false,
      depthTest: true,
    });
    const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
    bgQuad.frustumCulled = false;
    bgQuad.renderOrder = 1;
    scene.add(bgQuad);

    // 4. Pooled InstancedMesh Particle System (hidden when activeParticleCount === 0)
    const shardGeo = new THREE.OctahedronGeometry(1.0, 0);
    const shardMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });
    particleInstanced = new THREE.InstancedMesh(shardGeo, shardMat, PARTICLE_POOL_SIZE);
    particleInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    particleInstanced.frustumCulled = false;
    particleInstanced.visible = false;
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      particleInstanced.setMatrixAt(i, _ZeroScaleMat);
      particleInstanced.setColorAt(i, cachedPalColors.highlight);
    }
    particleInstanced.instanceMatrix.needsUpdate = true;
    if (particleInstanced.instanceColor) particleInstanced.instanceColor.needsUpdate = true;
    scene.add(particleInstanced);

    // 5. DOM Overlay (5 Miss Pips at top + Key Cap labels D F J K at 82% height + Streak/Judgement)
    hudRootEl = document.createElement('div');
    hudRootEl.id = 'tiles-hud-overlay';
    hudRootEl.className = 'pointer-events-none absolute inset-0 select-none font-mono';
    hudRootEl.innerHTML = `
      <!-- Top Miss Pips (5 small slots at the top that fill as you miss) -->
      <div class="absolute top-16 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5">
        <div class="flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-950/90 px-4 py-1.5 shadow-lg">
          <span class="text-[10px] font-bold uppercase tracking-widest text-slate-400 mr-1">MISSES</span>
          <div id="tiles-miss-pips" data-testid="tiles-miss-pips" class="flex items-center gap-2">
            <span class="h-3 w-3 rounded-sm border border-slate-600 bg-slate-900"></span>
            <span class="h-3 w-3 rounded-sm border border-slate-600 bg-slate-900"></span>
            <span class="h-3 w-3 rounded-sm border border-slate-600 bg-slate-900"></span>
            <span class="h-3 w-3 rounded-sm border border-slate-600 bg-slate-900"></span>
            <span class="h-3 w-3 rounded-sm border border-slate-600 bg-slate-900"></span>
          </div>
          <span id="tiles-streak-badge" data-testid="tiles-streak-badge" class="ml-2 text-xs font-extrabold text-amber-300 tabular-nums">0 STREAK</span>
        </div>
        <div id="tiles-judgement-banner" class="h-5 text-sm font-black uppercase tracking-widest opacity-0"></div>
      </div>

      <!-- Key Cap Labels D F J K aligned with the 82% screen-height hit line -->
      <div
        id="tiles-keycaps-row"
        data-testid="tiles-keycaps-row"
        style="top: 82%;"
        class="-translate-y-1/2 absolute left-1/2 -translate-x-1/2 flex items-center justify-center gap-6 sm:gap-9"
      >
        ${LANE_LABELS.map(
          (lbl, idx) => `
          <div
            data-keycap-lane="${idx}"
            data-testid="tiles-keycap-${lbl}"
            class="flex h-11 w-14 items-center justify-center rounded-lg border-2 border-slate-600/90 bg-slate-950/90 text-base font-black tracking-wider text-slate-100 shadow-lg"
          >
            ${lbl}
          </div>
        `,
        ).join('')}
      </div>
    `;
    ctx.root.appendChild(hudRootEl);

    missPipEls = Array.from(
      hudRootEl.querySelectorAll<HTMLElement>('#tiles-miss-pips > span'),
    );
    keyDomEls = Array.from(
      hudRootEl.querySelectorAll<HTMLElement>('[data-keycap-lane]'),
    );
    streakTextEl = hudRootEl.querySelector<HTMLElement>('#tiles-streak-badge');
    judgementTextEl = hudRootEl.querySelector<HTMLElement>('#tiles-judgement-banner');
  }

  function updateDomHud(pal: { accent: string; highlight: string; primary: string }): void {
    if (!sim) return;

    if (sim.misses !== lastRenderedMisses) {
      lastRenderedMisses = sim.misses;
      for (let i = 0; i < missPipEls.length; i++) {
        const filled = i < sim.misses;
        const el = missPipEls[i];
        el.dataset.filled = filled ? 'true' : 'false';
        el.style.backgroundColor = filled ? '#f43f5e' : '#0f172a';
        el.style.borderColor = filled ? '#fda4af' : '#475569';
      }
    }

    if (sim.streak !== lastRenderedStreak && streakTextEl) {
      lastRenderedStreak = sim.streak;
      streakTextEl.textContent = `${sim.streak} STREAK`;
      streakTextEl.style.color =
        sim.streak >= 10 ? pal.highlight : sim.streak >= 4 ? pal.accent : '#cbd5e1';
    }

    const paletteChanged = lastDomPaletteSig !== lastPaletteSig;
    for (let l = 0; l < 4; l++) {
      const pressed = heldLanes[l] || sim.lanePressFlash[l] > 0.15;
      if (pressed !== lastDomKeyPressed[l] || paletteChanged) {
        lastDomKeyPressed[l] = pressed;
        const el = keyDomEls[l];
        if (!el) continue;
        el.style.borderColor = pressed ? pal.highlight : pal.accent;
        el.style.backgroundColor = pressed ? pal.accent : 'rgba(9, 13, 22, 0.92)';
        el.style.color = pressed ? '#050811' : '#f8fafc';
        el.style.transform = pressed ? 'scale(0.92) translateY(2px)' : 'scale(1) translateY(0px)';
      }
    }
    lastDomPaletteSig = lastPaletteSig;
  }

  return {
    id: 'tiles',
    title: 'TILES',
    listensTo: 'the melody',
    controls: [{ keys: [...LANE_KEYS], label: 'Hit the lanes' }],

    async preload(gameCtx: GameContext): Promise<void> {
      ctx = gameCtx;
      const rawLevel = ctx.level as Partial<TilesLevel> | null;
      const customParams: TilesParams = {
        ...defaultParams,
        ...(rawLevel?.params ?? {}),
      };
      if (
        rawLevel &&
        Array.isArray(rawLevel.notes) &&
        rawLevel.notes.length > 0 &&
        ctx.map.file !== 'full.mp3'
      ) {
        level = rawLevel as TilesLevel;
      } else {
        level = generateLevel(ctx.map, customParams, ctx.rng);
        ctx.level = level;
      }

      // Compute static level metrics ONCE at preload instead of every frame
      cachedStaticMetrics = computeLevelStaticMetrics(ctx.map, level);

      if (!renderer) {
        buildSceneAndDom();
      }
      loadAndCompileSongShader();
      if (!isSoftwareGl && renderer && scene && camera) {
        renderer.compile(scene, camera);
      }
    },

    enter(songTime: number): void {
      active = true;
      if (!level) {
        level = generateLevel(ctx.map, defaultParams, ctx.rng);
        cachedStaticMetrics = computeLevelStaticMetrics(ctx.map, level);
      }
      if (!sim) {
        sim = new TilesSimEngine({
          map: ctx.map,
          level,
          safeUntil: ctx.safeUntil,
          emit: (e) => ctx.emit(e),
        });
      } else {
        sim.reset(ctx.safeUntil);
      }
      bot.reset();
      queuedPresses.length = 0;
      heldLanes[0] = false;
      heldLanes[1] = false;
      heldLanes[2] = false;
      heldLanes[3] = false;
      keyPressAnim[0] = 0;
      keyPressAnim[1] = 0;
      keyPressAnim[2] = 0;
      keyPressAnim[3] = 0;
      lastDomKeyPressed[0] = false;
      lastDomKeyPressed[1] = false;
      lastDomKeyPressed[2] = false;
      lastDomKeyPressed[3] = false;
      lastDomPaletteSig = '';
      shatterTriggered = false;
      lastRenderedMisses = -1;
      lastRenderedStreak = -1;
      firstVisibleNoteIdx = 0;
      fpsAvg = 60;
      lowFpsAccumSec = 0;
      lastSectionIdx = sectionIndexAt(ctx.map, songTime);
      lastLowOnsetIdx = -1;
      lastSimSongTime = songTime;

      if (highwayGroup) {
        highwayGroup.position.set(0, 0, 0);
        highwayGroup.rotation.set(0, 0, 0);
        highwayGroup.scale.set(1, 1, 1);
      }
      activeParticleCount = 0;
      for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
        particles[i].active = false;
      }
      if (particleInstanced) {
        particleInstanced.visible = false;
      }

      const pal = ctx.palette.at(songTime);
      lastPaletteSig = '';
      syncCachedPaletteColors(pal);
      for (let idx = 0; idx < 5; idx++) {
        currentPalVecs[idx].copy(targetPalVecs[idx]);
      }
      updateDomHud(pal);

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onWindowBlur);
    },

    update(dt: number, songTime: number): void {
      if (!active || !sim) return;

      const clampedDt = Math.min(0.05, Math.max(0.001, dt));
      if (!isSoftwareGl) {
        fpsAvg = fpsAvg * 0.92 + (1 / clampedDt) * 0.08;
        if (!usingDefaultFallbackShader && bgMat) {
          if (fpsAvg < 55) {
            lowFpsAccumSec += clampedDt;
            if (lowFpsAccumSec >= 2.0) {
              console.warn(
                `[tiles] Custom slot shader dropped avgFps to ${fpsAvg.toFixed(1)} (< 55 fps) for 2.0s; switching to default.frag.glsl`,
              );
              bgMat.fragmentShader = DEFAULT_TILES_FRAGMENT_SHADER;
              bgMat.needsUpdate = true;
              usingDefaultFallbackShader = true;
            }
          } else {
            lowFpsAccumSec = Math.max(0, lowFpsAccumSec - clampedDt * 0.5);
          }
        }
      }

      sim.safeUntil = ctx.safeUntil;
      sim.recentEvents.length = 0;

      // Determine lane presses (from bot or player keyboard), sub-stepping at 1/120s in bot mode
      if (ctx.bot) {
        const STEP = 1 / 120;
        const startT =
          lastSimSongTime >= 0 && songTime >= lastSimSongTime && songTime - lastSimSongTime <= 2.0
            ? lastSimSongTime
            : Math.max(0, songTime - clampedDt);
        let tCursor = startT;
        while (tCursor + STEP < songTime) {
          tCursor += STEP;
          const subPresses = bot.step(
            level.notes,
            tCursor,
            ctx.safeUntil,
            ctx.rng,
            sim.handledNoteIds,
          );
          for (let i = 0; i < subPresses.length; i++) {
            keyPressAnim[subPresses[i]] = 1.0;
          }
          sim.step(STEP, tCursor, subPresses, undefined, true);
        }
        const remDt = Math.max(0.0001, songTime - tCursor);
        const finalPresses = bot.step(
          level.notes,
          songTime,
          ctx.safeUntil,
          ctx.rng,
          sim.handledNoteIds,
        );
        for (let i = 0; i < finalPresses.length; i++) {
          keyPressAnim[finalPresses[i]] = 1.0;
        }
        sim.step(remDt, songTime, finalPresses, undefined, true);
        lastSimSongTime = songTime;
      } else {
        scratchLanes.length = 0;
        scratchTimes.length = 0;
        for (let i = 0; i < queuedPresses.length; i++) {
          scratchLanes.push(queuedPresses[i].lane);
          scratchTimes.push(queuedPresses[i].pressTime);
        }
        queuedPresses.length = 0;
        sim.step(clampedDt, songTime, scratchLanes, scratchTimes, true);
        lastSimSongTime = songTime;
      }

      // Handle miss lowpass filter: drops to 700 Hz and ramps back to 20000 Hz over 1.2 s
      if (sim.needsLowpassDrop) {
        sim.needsLowpassDrop = false;
        ctx.fx.lowpass(700, 0.03);
      }
      if (sim.needsLowpassRampUp) {
        sim.needsLowpassRampUp = false;
        ctx.fx.lowpass(20000, 1.15);
      }

      const pal = ctx.palette.at(songTime);
      syncCachedPaletteColors(pal);

      // Trigger particle bursts & audio feedback for recent judgements
      for (let i = 0; i < sim.recentEvents.length; i++) {
        const ev = sim.recentEvents[i];
        playNoteFeedbackSound(ev.judgement, ev.lane);
        if (ev.judgement === 'PERFECT') {
          spawnParticleBurst(LANE_CENTERS_X[ev.lane], 0.14, Z_HIT, 12, 1.0);
        }
        if (judgementTextEl) {
          judgementTextEl.textContent =
            ev.judgement === 'PERFECT'
              ? 'PERFECT +100'
              : ev.judgement === 'GOOD'
                ? 'GOOD +50'
                : 'MISS';
          judgementTextEl.style.color =
            ev.judgement === 'PERFECT'
              ? pal.highlight
              : ev.judgement === 'GOOD'
                ? pal.accent
                : '#fb7185';
          if (!judgementVisible) {
            judgementTextEl.style.opacity = '1';
            judgementVisible = true;
          }
          judgementFadeTimer = 0.45;
        }
      }

      if (judgementFadeTimer > 0 && judgementTextEl) {
        judgementFadeTimer = Math.max(0, judgementFadeTimer - clampedDt);
        if (judgementFadeTimer <= 0 && judgementVisible) {
          judgementTextEl.style.opacity = '0';
          judgementVisible = false;
        }
      }

      // Smooth audio & envelope bands
      const mapEnergy = energyAt(ctx.map, songTime);
      const rawLow = Math.max(ctx.bands.low, lowAt(ctx.map, songTime));
      const rawMid = Math.max(ctx.bands.mid, midAt(ctx.map, songTime));
      const rawHigh = Math.max(ctx.bands.high, highAt(ctx.map, songTime));
      const rawEnergy = Math.max(ctx.bands.energy * 0.6 + mapEnergy * 0.4, mapEnergy);

      smoothedLow = THREE.MathUtils.damp(smoothedLow, rawLow, 14, clampedDt);
      smoothedMid = THREE.MathUtils.damp(smoothedMid, rawMid, 14, clampedDt);
      smoothedHigh = THREE.MathUtils.damp(smoothedHigh, rawHigh, 14, clampedDt);
      smoothedEnergy = THREE.MathUtils.damp(smoothedEnergy, rawEnergy, 8, clampedDt);

      // In valleys, motion slows; on peaks, motion accelerates
      const motionSpeed = 0.35 + 0.65 * smoothedEnergy;
      shaderTime += clampedDt * motionSpeed;

      // Smoothly interpolate section palette uniforms without string parsing
      for (let i = 0; i < 5; i++) {
        currentPalVecs[i].x = THREE.MathUtils.damp(
          currentPalVecs[i].x,
          targetPalVecs[i].x,
          6,
          clampedDt,
        );
        currentPalVecs[i].y = THREE.MathUtils.damp(
          currentPalVecs[i].y,
          targetPalVecs[i].y,
          6,
          clampedDt,
        );
        currentPalVecs[i].z = THREE.MathUtils.damp(
          currentPalVecs[i].z,
          targetPalVecs[i].z,
          6,
          clampedDt,
        );
      }

      const secIdx = sectionIndexAt(ctx.map, songTime);
      const secProg = sectionProgressAt(ctx.map, songTime);
      const bPhase = beatPhase(ctx.map, songTime);

      // Detect strong low onsets for highway scale pulse
      const lowOnsets = ctx.map.onsets?.low ?? [];
      for (let i = Math.max(0, lastLowOnsetIdx); i < lowOnsets.length; i++) {
        const lo = lowOnsets[i];
        if (lo.t > songTime) break;
        if (i > lastLowOnsetIdx && songTime - lo.t <= 0.08 && lo.s >= 0.45) {
          highwayPulseScale = Math.max(highwayPulseScale, 1.0 + lo.s * 0.055);
          lastLowOnsetIdx = i;
        }
      }
      highwayPulseScale = THREE.MathUtils.damp(highwayPulseScale, 1.0, 10, clampedDt);

      // Camera punches its FOV in on each drop
      if (secIdx !== lastSectionIdx) {
        lastSectionIdx = secIdx;
        const sec = ctx.map.sections[secIdx];
        if (sec?.label === 'drop') {
          cameraFovOffset = -6.5;
        }
      }
      const drops = ctx.map.drops;
      if (drops) {
        for (let i = 0; i < drops.length; i++) {
          if (Math.abs(songTime - drops[i]) <= 0.06) {
            cameraFovOffset = -6.5;
          }
        }
      }
      cameraFovOffset = THREE.MathUtils.damp(cameraFovOffset, 0, 5.5, clampedDt);
      if (camera) {
        const targetFov = BASE_FOV + cameraFovOffset;
        if (Math.abs(camera.fov - targetFov) > 0.02) {
          camera.fov = targetFov;
          camera.updateProjectionMatrix();
        }
      }

      // Update background shader uniforms
      if (bgUniforms) {
        bgUniforms.uTime.value = shaderTime;
        bgUniforms.uSongTime.value = songTime;
        bgUniforms.uLow.value = smoothedLow;
        bgUniforms.uMid.value = smoothedMid;
        bgUniforms.uHigh.value = smoothedHigh;
        bgUniforms.uEnergy.value = smoothedEnergy;
        bgUniforms.uBeatPhase.value = bPhase;
        bgUniforms.uSection.value = secIdx;
        bgUniforms.uSectionProgress.value = secProg;
        bgUniforms.uMissFlash.value = sim.uMissFlash;
        bgUniforms.uBloom.value = sim.uBloom;
        bgUniforms.uDesat.value = sim.uDesat;
      }

      // Update lane edges glowing with bands.mid (zero hex string parsing)
      const midGlow = Math.min(1.0, 0.35 + smoothedMid * 0.65);
      for (let idx = 0; idx < laneDividerMats.length; idx++) {
        const isOuter = idx === 0 || idx === 4;
        const baseCol = isOuter ? cachedPalColors.primary : cachedPalColors.secondary;
        const glowCol = isOuter ? cachedPalColors.accent : cachedPalColors.primary;
        laneDividerMats[idx].color.copy(baseCol).lerp(glowCol, midGlow);
      }

      if (hitBarMat) {
        hitBarMat.color.copy(cachedPalColors.highlight);
      }
      if (noteFrontMat) {
        noteFrontMat.color.copy(cachedPalColors.highlight);
      }

      // Update scrolling beat lines on the highway (constant scroll speed = HIGHWAY_LENGTH / 1.5)
      if (gridLinesGroup) {
        const scrollSpeed = HIGHWAY_LENGTH / LOOKAHEAD_SEC;
        const scrollOffset = (songTime * scrollSpeed) % HIGHWAY_LENGTH;
        const children = gridLinesGroup.children;
        for (let i = 0; i < children.length; i++) {
          const baseZ = (i / 12) * HIGHWAY_LENGTH;
          children[i].position.z = Z_SPAWN + ((baseZ + scrollOffset) % HIGHWAY_LENGTH);
        }
      }

      // Update 4 Key Caps smooth press damping & glow (zero hex string parsing)
      for (let l = 0; l < 4; l++) {
        const targetPress = heldLanes[l] ? 1.0 : 0.0;
        keyPressAnim[l] = THREE.MathUtils.damp(
          keyPressAnim[l],
          Math.max(targetPress, sim.lanePressFlash[l]),
          18,
          clampedDt,
        );
        const kGroup = keyCapGroups[l];
        if (kGroup) {
          kGroup.position.y = 0.02 - keyPressAnim[l] * 0.045;
        }
        const rimMat = keyCapRimMats[l];
        if (rimMat) {
          rimMat.color.copy(
            keyPressAnim[l] > 0.2 ? cachedPalColors.highlight : cachedPalColors.accent,
          );
        }
        const topMat = keyCapTopMats[l];
        if (topMat) {
          topMat.emissive.copy(cachedPalColors.primary);
          topMat.emissiveIntensity = 0.15 + keyPressAnim[l] * 0.9;
        }
      }

      // Handle 5th-miss death shatter & highway drop-away
      if (sim.dying) {
        triggerDeathShatter();
        if (highwayGroup) {
          const t = sim.deathTimer;
          highwayGroup.position.y = -t * t * 9.5;
          highwayGroup.rotation.x = t * 0.65;
          highwayGroup.rotation.z = Math.sin(t * 14) * 0.08;
        }
      } else if (
        highwayGroup &&
        noteCoreInstanced &&
        noteEdgeInstanced &&
        noteFrontInstanced
      ) {
        highwayGroup.position.y = 0;
        highwayGroup.rotation.x = 0;
        highwayGroup.rotation.z = 0;
        highwayGroup.scale.set(highwayPulseScale, 1.0, 1.0);

        const notes = level.notes;
        while (
          firstVisibleNoteIdx < notes.length &&
          (notes[firstVisibleNoteIdx].t < ctx.safeUntil ||
            notes[firstVisibleNoteIdx].t - songTime < -0.14)
        ) {
          firstVisibleNoteIdx++;
        }

        // Populate InstancedMesh transforms for visible notes in O(visible) time
        let instanceIdx = 0;
        const invLookahead = 1.0 / LOOKAHEAD_SEC;
        for (let i = firstVisibleNoteIdx; i < notes.length; i++) {
          const note = notes[i];
          if (note.t < ctx.safeUntil) continue;
          if (sim.hitNoteIds.has(note.id)) continue;

          const timeUntilHit = note.t - songTime;
          if (timeUntilHit > LOOKAHEAD_SEC) break;
          if (timeUntilHit < -0.14) continue;
          if (instanceIdx >= NOTE_POOL_SIZE) break;

          const progress = 1.0 - timeUntilHit * invLookahead;
          const zPos = Z_SPAWN + progress * HIGHWAY_LENGTH;
          _dummyObj.position.set(LANE_CENTERS_X[note.lane], 0.01, zPos);
          _dummyObj.rotation.set(0, 0, 0);
          _dummyObj.scale.set(1, 1, 1);
          _dummyObj.updateMatrix();

          noteCoreInstanced.setMatrixAt(instanceIdx, _dummyObj.matrix);
          noteEdgeInstanced.setMatrixAt(instanceIdx, _dummyObj.matrix);
          noteFrontInstanced.setMatrixAt(instanceIdx, _dummyObj.matrix);

          const baseLaneCol = note.isChord
            ? cachedPalColors.highlight
            : (note.lane & 1) === 0
              ? cachedPalColors.primary
              : cachedPalColors.accent;
          _noteEdgeColor.copy(baseLaneCol).lerp(cachedPalColors.highlight, smoothedMid * 0.35);
          noteEdgeInstanced.setColorAt(instanceIdx, _noteEdgeColor);

          instanceIdx++;
        }

        noteCoreInstanced.count = instanceIdx;
        noteEdgeInstanced.count = instanceIdx;
        noteFrontInstanced.count = instanceIdx;
        if (instanceIdx > 0) {
          noteCoreInstanced.instanceMatrix.needsUpdate = true;
          noteEdgeInstanced.instanceMatrix.needsUpdate = true;
          noteFrontInstanced.instanceMatrix.needsUpdate = true;
          if (noteEdgeInstanced.instanceColor) {
            noteEdgeInstanced.instanceColor.needsUpdate = true;
          }
        }
      }

      // Update pooled particles in-place ONLY when active particles exist
      if (particleInstanced && activeParticleCount > 0) {
        let stillActive = 0;
        for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
          const p = particles[i];
          if (!p.active) continue;
          p.age += clampedDt;
          if (p.age >= p.maxAge) {
            p.active = false;
            particleInstanced.setMatrixAt(i, _ZeroScaleMat);
            continue;
          }
          stillActive++;
          p.x += p.vx * clampedDt;
          p.y += p.vy * clampedDt;
          p.z += p.vz * clampedDt;
          p.vy -= 9.8 * clampedDt;

          const lifeLeft = 1.0 - p.age / p.maxAge;
          const s = p.scale * lifeLeft;
          _dummyObj.position.set(p.x, p.y, p.z);
          _dummyObj.rotation.set(p.age * p.rx, p.age * p.ry, 0);
          _dummyObj.scale.set(s, s, s);
          _dummyObj.updateMatrix();
          particleInstanced.setMatrixAt(i, _dummyObj.matrix);
          if (particleColorsDirty) {
            particleInstanced.setColorAt(i, p.color);
          }
        }
        activeParticleCount = stillActive;
        particleInstanced.instanceMatrix.needsUpdate = true;
        if (particleColorsDirty && particleInstanced.instanceColor) {
          particleInstanced.instanceColor.needsUpdate = true;
          particleColorsDirty = false;
        }
        if (activeParticleCount === 0) {
          particleInstanced.visible = false;
        }
      }

      updateDomHud(pal);
    },

    render(): void {
      if (!renderer || !scene || !camera) return;
      const pr = renderer.getPixelRatio();
      const targetW = Math.floor(window.innerWidth * pr);
      const targetH = Math.floor(window.innerHeight * pr);
      if (
        renderer.domElement.width !== targetW ||
        renderer.domElement.height !== targetH
      ) {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        if (bgUniforms) {
          bgUniforms.uRes.value.set(window.innerWidth, window.innerHeight);
        }
      }
      renderer.render(scene, camera);
    },

    exit(): void {
      active = false;
      queuedPresses.length = 0;
      heldLanes[0] = false;
      heldLanes[1] = false;
      heldLanes[2] = false;
      heldLanes[3] = false;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
      ctx.fx.reset();
    },

    getMetrics(): Record<string, number> {
      if (!sim || !level) {
        return {
          score: 0,
          alignMsMean: 0,
          alignMsMax: 0,
          gridSnapPct: 100,
          maxNps: 0,
          sameLaneGapViolations: 0,
          runwayNotes: 0,
          densityEnergyCorr: 1,
          botPerfectPct: 100,
          shaderCompiled: shaderCompiledMetric,
          avgFps: Math.round(fpsAvg),
        };
      }
      if (!cachedStaticMetrics) {
        cachedStaticMetrics = computeLevelStaticMetrics(ctx.map, level);
      }
      const totalJudged = sim.perfectHits + sim.goodHits + sim.misses;
      const botPerfectPct =
        totalJudged > 0 ? Math.round((sim.perfectHits / totalJudged) * 1000) / 10 : 100;

      return {
        score: Math.round(sim.score),
        hits: sim.perfectHits + sim.goodHits,
        misses: sim.misses,
        alignMsMean: cachedStaticMetrics.alignMsMean,
        alignMsMax: cachedStaticMetrics.alignMsMax,
        gridSnapPct: cachedStaticMetrics.gridSnapPct,
        maxNps: cachedStaticMetrics.maxNps,
        sameLaneGapViolations: cachedStaticMetrics.sameLaneGapViolations,
        runwayNotes: sim.runwayNotesJudged,
        densityEnergyCorr: cachedStaticMetrics.densityEnergyCorr,
        botPerfectPct,
        shaderCompiled: shaderCompiledMetric,
        avgFps: Math.round(fpsAvg),
      };
    },
  };
}
