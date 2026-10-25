import * as THREE from 'three';
import type { GameContext, GameModule } from '../../shell/api';
import { beatAt, beatPhase, energyAt } from '../../shared/songmap';
import { HorrorBotController, type BotInputState } from './bot';
import { defaultParams, generateLevel, type HorrorLevel } from './level';
import { getOfficeMap, MAP_COLS, MAP_ROWS, TILE_SIZE, type ParsedOfficeMap } from './map';
import { HorrorSimEngine, type MonsterSpriteFrame, type SoundCueEvent } from './sim';

export { defaultParams, paramRanges, generateLevel } from './level';
export { simulate } from './sim';

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

const LOW_RES_W = 960;
const LOW_RES_H = 540;

function makeProceduralTexture(
  kind: 'carpet' | 'oak' | 'concrete' | 'glass' | 'ceiling' | 'city' | 'sign',
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = kind === 'sign' ? 512 : 128;
  c.height = 128;
  const g = c.getContext('2d')!;

  if (kind === 'carpet') {
    g.fillStyle = '#262d3d';
    g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 4) {
      for (let x = 0; x < 128; x += 4) {
        const v = ((x * 17 + y * 31) % 15) - 7;
        g.fillStyle = `rgb(${38 + v}, ${45 + v}, ${62 + v})`;
        g.fillRect(x, y, 4, 4);
      }
    }
    g.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    g.lineWidth = 1.5;
    g.strokeRect(1, 1, 126, 126);
  } else if (kind === 'oak') {
    g.fillStyle = '#855d3b';
    g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y++) {
      const grain = Math.sin(y * 0.25) * 8 + ((y * 7) % 5) - 2;
      g.fillStyle = `rgb(${135 + grain}, ${94 + grain * 0.7}, ${58 + grain * 0.5})`;
      g.fillRect(0, y, 128, 1);
    }
  } else if (kind === 'concrete') {
    g.fillStyle = '#475063';
    g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 4) {
      for (let x = 0; x < 128; x += 4) {
        const n = ((x * 23 + y * 41) % 13) - 6;
        g.fillStyle = `rgb(${71 + n}, ${80 + n}, ${99 + n})`;
        g.fillRect(x, y, 4, 4);
      }
    }
    g.fillStyle = 'rgba(15, 23, 42, 0.25)';
    g.fillRect(0, 63, 128, 2);
  } else if (kind === 'glass') {
    // Opaque frosted architectural glass with smooth etched horizontal bands
    const grad = g.createLinearGradient(0, 0, 128, 128);
    grad.addColorStop(0, '#475569');
    grad.addColorStop(0.5, '#64748b');
    grad.addColorStop(1, '#334155');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(226, 232, 240, 0.22)';
    for (let y = 8; y < 128; y += 16) {
      g.fillRect(0, y, 128, 5);
    }
    g.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, 126, 126);
  } else if (kind === 'ceiling') {
    g.fillStyle = '#252b3b';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#363f54';
    g.lineWidth = 3;
    g.strokeRect(2, 2, 124, 124);
  } else if (kind === 'city') {
    g.fillStyle = '#090e1c';
    g.fillRect(0, 0, 128, 128);
    // Distant SF skyline lights
    const cols = [8, 22, 38, 56, 74, 90, 108];
    cols.forEach((bx, idx) => {
      const bh = 44 + ((idx * 26) % 56);
      g.fillStyle = '#131c33';
      g.fillRect(bx, 128 - bh, 12, bh);
      for (let wy = 128 - bh + 6; wy < 120; wy += 8) {
        for (let wx = bx + 2; wx < bx + 10; wx += 4) {
          if ((wx + wy + idx) % 3 !== 0) {
            g.fillStyle = (wx + wy) % 2 === 0 ? '#fde68a' : '#38bdf8';
            g.fillRect(wx, wy, 2, 4);
          }
        }
      }
    });
  } else if (kind === 'sign') {
    g.fillStyle = '#0f172a';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#38bdf8';
    g.lineWidth = 5;
    g.strokeRect(8, 8, 496, 112);
    g.fillStyle = '#f8fafc';
    g.font = 'bold 40px monospace';
    g.textAlign = 'center';
    g.fillText('SOLSTICE COMMONS', 256, 60);
    g.fillStyle = '#f59e0b';
    g.font = 'bold 22px monospace';
    g.fillText('COWORKING CLUB · AFTER HOURS', 256, 96);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeFallbackMonsterTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 384;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 384);
  // Tall gaunt silhouette with glowing phone at chest and pinprick eyes
  g.fillStyle = '#0a0b10';
  // Head & hood
  g.beginPath();
  g.ellipse(128, 46, 26, 34, 0, 0, Math.PI * 2);
  g.fill();
  // Broad bony shoulders & torso
  g.fillRect(82, 76, 92, 130);
  // Long thin arms hanging past knees
  g.fillRect(62, 82, 18, 175);
  g.fillRect(176, 82, 18, 175);
  // Legs
  g.fillRect(92, 206, 30, 168);
  g.fillRect(134, 206, 30, 168);
  // Cold phone screen glow at chest
  g.fillStyle = '#bae6fd';
  g.fillRect(104, 118, 16, 26);
  // Pinprick eyes
  g.fillStyle = '#f8fafc';
  g.fillRect(118, 42, 3, 3);
  g.fillRect(135, 42, 3, 3);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class HorrorSfxEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private breathTimer = 0;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        this.ctx = new AC();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.85;
        this.masterGain.connect(this.ctx.destination);
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playCue(cue: SoundCueEvent): void {
    const ac = this.ensureContext();
    if (!ac || !this.masterGain) return;
    const now = ac.currentTime;

    if (cue.type === 'footstep') {
      // Monster footstep: noise burst through 200 Hz lowpass + short 60 Hz sine thud
      const panNode = ac.createStereoPanner();
      panNode.pan.value = Math.max(-1, Math.min(1, cue.pan));
      const gainNode = ac.createGain();
      const vol = Math.max(0.08, Math.min(0.95, cue.intensity));
      gainNode.gain.setValueAtTime(vol, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      panNode.connect(this.masterGain);
      gainNode.connect(panNode);

      // 60 Hz sine sub-thud
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(64, now);
      osc.frequency.exponentialRampToValueAtTime(34, now + 0.18);
      osc.connect(gainNode);
      osc.start(now);
      osc.stop(now + 0.2);

      // Filtered noise burst (200 Hz lowpass)
      const bufLen = Math.floor(ac.sampleRate * 0.12);
      const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufLen * 0.35));
      }
      const noise = ac.createBufferSource();
      noise.buffer = buf;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 200;
      noise.connect(lp);
      lp.connect(gainNode);
      noise.start(now);
    } else if (cue.type === 'player_step') {
      const isSprint = cue.intensity > 0.5;
      const g = ac.createGain();
      const peakGain = isSprint ? 0.34 : 0.12;
      const dur = isSprint ? 0.11 : 0.07;
      g.gain.setValueAtTime(peakGain, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      g.connect(this.masterGain);
      const osc = ac.createOscillator();
      osc.type = isSprint ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(isSprint ? 150 : 115, now);
      osc.frequency.exponentialRampToValueAtTime(isSprint ? 42 : 55, now + dur - 0.01);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = isSprint ? 520 : 320;
      osc.connect(lp);
      lp.connect(g);
      osc.start(now);
      osc.stop(now + dur);
    } else if (cue.type === 'relay_clunk') {
      const g = ac.createGain();
      g.gain.setValueAtTime(0.35, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      g.connect(this.masterGain);
      const osc = ac.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(190, now);
      osc.frequency.setValueAtTime(95, now + 0.03);
      osc.connect(g);
      osc.start(now);
      osc.stop(now + 0.13);
    } else if (cue.type === 'spot_search' || cue.type === ' spot_tear') {
      const g = ac.createGain();
      g.gain.setValueAtTime(cue.type === ' spot_tear' ? 0.55 : 0.3, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
      g.connect(this.masterGain);
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.linearRampToValueAtTime(70, now + 0.3);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      osc.connect(lp);
      lp.connect(g);
      osc.start(now);
      osc.stop(now + 0.31);
    } else if (cue.type === 'jumpscare_sting') {
      // Loud synthesized sting: detuned saws + noise burst (0.6 s) bypassing song lowpass
      const stingGain = ac.createGain();
      stingGain.gain.setValueAtTime(0.9, now);
      stingGain.gain.exponentialRampToValueAtTime(0.01, now + 0.62);
      stingGain.connect(this.masterGain);

      const freqs = [185, 193, 277, 370, 554];
      for (const f of freqs) {
        const osc = ac.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(f, now);
        osc.frequency.linearRampToValueAtTime(f * 0.92, now + 0.6);
        osc.connect(stingGain);
        osc.start(now);
        osc.stop(now + 0.6);
      }

      const bufLen = Math.floor(ac.sampleRate * 0.6);
      const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) {
        ch[i] = (Math.random() * 2 - 1) * 0.65;
      }
      const noise = ac.createBufferSource();
      noise.buffer = buf;
      noise.connect(stingGain);
      noise.start(now);
    }
  }

  updateBreathing(dt: number, monsterDist: number): void {
    if (monsterDist > 6.0) {
      this.breathTimer = 0;
      return;
    }
    const rate = 0.38 + (monsterDist / 6.0) * 0.55; // Faster when closer than 6m
    this.breathTimer -= dt;
    if (this.breathTimer <= 0) {
      this.breathTimer = rate;
      const ac = this.ensureContext();
      if (!ac || !this.masterGain) return;
      const now = ac.currentTime;
      const bufLen = Math.floor(ac.sampleRate * 0.22);
      const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) {
        const env = Math.sin((i / bufLen) * Math.PI);
        ch[i] = (Math.random() * 2 - 1) * env * 0.25;
      }
      const src = ac.createBufferSource();
      src.buffer = buf;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 2.0;
      const g = ac.createGain();
      g.gain.value = Math.max(0.05, (1.0 - monsterDist / 6.5) * 0.28);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.masterGain);
      src.start(now);
    }
  }

  stop(): void {
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }
}

export function createHorrorGame(): GameModule {
  let ctx!: GameContext;
  const office: ParsedOfficeMap = getOfficeMap();
  let sim!: HorrorSimEngine;
  let botController = new HorrorBotController('hider');
  const sfx = new HorrorSfxEngine();

  // Three.js resources
  let renderer: THREE.WebGLRenderer | null = null;
  let lowResTarget: THREE.WebGLRenderTarget | null = null;
  let envScene: THREE.Scene | null = null;
  let postScene: THREE.Scene | null = null;
  let postCamera: THREE.OrthographicCamera | null = null;
  let camera: THREE.PerspectiveCamera | null = null;

  // Lighting & Baked Ceiling Light State Buffers
  let ambientLight: THREE.AmbientLight | null = null;
  let hemiLight: THREE.HemisphereLight | null = null;
  let flashlight: THREE.SpotLight | null = null;
  let flashlightFill: THREE.PointLight | null = null;
  let flashlightTarget: THREE.Object3D | null = null;
  let bankFixtureMats: THREE.MeshLambertMaterial[] = [];
  let boothFrontDoorBySpotId = new Map<number, THREE.Object3D>();
  let neonStripMat: THREE.MeshLambertMaterial | null = null;
  let lastBakedBankSignature = '';
  let bakeCeilingLightsFn: ((bankLevels: number[]) => void) | null = null;
  let ditherUniforms: {
    tDiffuse: { value: THREE.Texture | null };
    uTime: { value: number };
    uResolution: { value: THREE.Vector2 };
    uFrostedBlur: { value: number };
  } | null = null;

  // Monster High-Res Billboard
  let monsterMesh: THREE.Mesh | null = null;
  let monsterMat: THREE.ShaderMaterial | null = null;
  let monsterWorldHeight = 2.6;
  const monsterTextures: Partial<Record<MonsterSpriteFrame, THREE.Texture>> = {};
  let fallbackMonsterTex: THREE.Texture | null = null;

  // DOM HUD Overlays
  let hudRoot: HTMLElement | null = null;
  let phaseBannerEl: HTMLElement | null = null;
  let phaseTitleEl: HTMLElement | null = null;
  let phaseTimerEl: HTMLElement | null = null;
  let retryBadgeEl: HTMLElement | null = null;
  let bankPipsEls: HTMLElement[] = [];
  let promptEl: HTMLElement | null = null;
  let deskOverlayEl: HTMLElement | null = null;
  let pointerLockBannerEl: HTMLElement | null = null;
  let oneMoreTryOverlayEl: HTMLElement | null = null;
  let jumpscareOverlayEl: HTMLElement | null = null;
  let jumpscareImgWrapEl: HTMLElement | null = null;
  let noiseCircleEl: SVGCircleElement | null = null;
  let noiseStatusTextEl: HTMLElement | null = null;

  // Cached HUD state to prevent per-frame DOM thrashing
  let lastPhaseTitle = '';
  let lastPhaseTimerStr = '';
  let lastRetryVisible: boolean | null = null;
  let lastPromptMode: 'none' | 'hide' | 'exit' = 'none';
  let lastNoiseRadiusStr = '';
  let lastNoiseText = '';
  let lastAccentHex = '';
  let lastDeskHidden: boolean | null = null;
  let lastOneMoreHidden: boolean | null = null;
  let lastScareHidden: boolean | null = null;

  // Input State
  let active = false;
  const keysHeld = new Set<string>();
  let interactQueued = false;
  let flashlightToggleQueued = false;
  let lookYaw = 0;
  let lookPitch = 0;
  let walkBobTime = 0;
  let fpsAvg = 60;

  function onKeyDown(e: KeyboardEvent): void {
    if (!active) return;
    keysHeld.add(e.code);
    if (e.code === 'KeyE') {
      interactQueued = true;
    } else if (e.code === 'KeyF') {
      flashlightToggleQueued = true;
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    keysHeld.delete(e.code);
  }

  function onMouseMove(e: MouseEvent): void {
    if (!active || ctx.bot) return;
    if (document.pointerLockElement === renderer?.domElement) {
      const sens = 0.0022;
      // Standard non-inverted mouse look:
      // forwardX = sin(lookYaw), forwardZ = -cos(lookYaw)
      // Moving mouse left (movementX < 0) decreases lookYaw (turns left); moving right increases lookYaw (turns right)
      lookYaw += e.movementX * sens;
      lookPitch = Math.max(-1.05, Math.min(1.05, lookPitch - e.movementY * sens));
    }
  }

  function onCanvasClick(): void {
    if (!active || ctx.bot || !renderer) return;
    if (document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock?.();
    }
  }

  function onPointerLockChange(): void {
    if (!pointerLockBannerEl || !renderer || ctx.bot) return;
    const locked = document.pointerLockElement === renderer.domElement;
    pointerLockBannerEl.classList.toggle('hidden', locked || !active);
  }

  function buildEnvironmentScene(): void {
    envScene = new THREE.Scene();
    envScene.background = new THREE.Color('#070b14');
    envScene.fog = new THREE.FogExp2('#070b14', 0.032);
    boothFrontDoorBySpotId.clear();
    lastBakedBankSignature = '';

    const carpetTex = makeProceduralTexture('carpet');
    carpetTex.repeat.set(MAP_COLS, MAP_ROWS);
    const oakTex = makeProceduralTexture('oak');
    const concreteTex = makeProceduralTexture('concrete');
    const glassTex = makeProceduralTexture('glass');
    const ceilingTex = makeProceduralTexture('ceiling');
    ceilingTex.repeat.set(MAP_COLS, MAP_ROWS);
    const cityTex = makeProceduralTexture('city');
    const signTex = makeProceduralTexture('sign');

    const mapW = office.cols * TILE_SIZE;
    const mapD = office.rows * TILE_SIZE;
    const wallH = 3.0;

    // Subdivided floor and ceiling with baked vertex colors for the 6 ceiling light banks
    const segsX = office.cols * 2;
    const segsZ = office.rows * 2;
    const floorGeo = new THREE.PlaneGeometry(mapW, mapD, segsX, segsZ);
    const floorMat = new THREE.MeshLambertMaterial({
      map: carpetTex,
      color: 0xffffff,
      vertexColors: true,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(mapW / 2, 0, mapD / 2);
    envScene.add(floorMesh);

    const ceilingGeo = new THREE.PlaneGeometry(mapW, mapD, segsX, segsZ);
    const ceilingMat = new THREE.MeshLambertMaterial({
      map: ceilingTex,
      color: 0xffffff,
      vertexColors: true,
    });
    const ceilingMesh = new THREE.Mesh(ceilingGeo, ceilingMat);
    ceilingMesh.rotation.x = Math.PI / 2;
    ceilingMesh.position.set(mapW / 2, wallH, mapD / 2);
    envScene.add(ceilingMesh);

    const wallMat = new THREE.MeshLambertMaterial({
      map: concreteTex,
      color: 0xffffff,
    });
    const windowMat = new THREE.MeshLambertMaterial({
      map: cityTex,
      color: 0xffffff,
      emissive: new THREE.Color('#38bdf8'),
      emissiveMap: cityTex,
      emissiveIntensity: 1.35,
    });
    // Opaque frosted glass walls (zero alpha-blending overdraw, full depth write for early-Z)
    const glassWallMat = new THREE.MeshLambertMaterial({
      map: glassTex,
      color: 0xcbd5e1,
      emissive: 0x1e293b,
      emissiveMap: glassTex,
      emissiveIntensity: 0.32,
      transparent: false,
      depthWrite: true,
    });
    const oakMat = new THREE.MeshLambertMaterial({
      map: oakTex,
      color: 0xffffff,
    });
    const darkMetalMat = new THREE.MeshLambertMaterial({
      color: 0x334155,
    });
    const boothGlassMat = new THREE.MeshLambertMaterial({
      map: glassTex,
      color: 0xdbeafe,
      emissive: 0x1e293b,
      emissiveMap: glassTex,
      emissiveIntensity: 0.38,
      transparent: false,
      depthWrite: true,
    });
    const monitorScreenMat = new THREE.MeshLambertMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 1.35,
    });
    const sofaMat = new THREE.MeshLambertMaterial({
      color: 0x475569,
    });
    const plantMat = new THREE.MeshLambertMaterial({
      color: 0x22c55e,
    });
    neonStripMat = new THREE.MeshLambertMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.6,
    });

    // Collect instance transforms to batch static grid props into InstancedMesh objects
    const wallTransforms: THREE.Matrix4[] = [];
    const windowTransforms: THREE.Matrix4[] = [];
    const glassPaneTransforms: THREE.Matrix4[] = [];
    const glassRailTransforms: THREE.Matrix4[] = [];
    const deskTopTransforms: THREE.Matrix4[] = [];
    const deskLegTransforms: THREE.Matrix4[] = [];
    const monStandTransforms: THREE.Matrix4[] = [];
    const monFrameTransforms: THREE.Matrix4[] = [];
    const monGlowTransforms: THREE.Matrix4[] = [];
    const islandBaseTransforms: THREE.Matrix4[] = [];
    const islandTopTransforms: THREE.Matrix4[] = [];
    const sofaSeatTransforms: THREE.Matrix4[] = [];
    const sofaBackTransforms: THREE.Matrix4[] = [];
    const potTransforms: THREE.Matrix4[] = [];
    const foliageTransforms: THREE.Matrix4[] = [];

    const dummy = new THREE.Object3D();
    const pushMat = (arr: THREE.Matrix4[], x: number, y: number, z: number): void => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      arr.push(dummy.matrix.clone());
    };

    const legCoords = [
      [-0.55, -0.35],
      [0.55, -0.35],
      [-0.55, 0.35],
      [0.55, 0.35],
    ];

    // Reusable geometries for oriented 3-wall opaque booth and supply closet enclosures
    const enclosureBackGeo = new THREE.BoxGeometry(1.32, 2.42, 0.08);
    const enclosureSideGeo = new THREE.BoxGeometry(0.08, 2.42, 1.32);
    const enclosureTopGeo = new THREE.BoxGeometry(1.32, 0.08, 1.32);
    const boothDoorGeo = new THREE.BoxGeometry(1.16, 2.34, 0.06);
    const boothTrimGeo = new THREE.BoxGeometry(1.36, 0.06, 1.36);
    const closetHeaderGeo = new THREE.BoxGeometry(1.24, 0.62, 0.08);
    const closetLowerDoorGeo = new THREE.BoxGeometry(1.24, 1.36, 0.08);
    const closetLouverSlatGeo = new THREE.BoxGeometry(1.18, 0.05, 0.09);

    for (let gz = 0; gz < office.rows; gz++) {
      for (let gx = 0; gx < office.cols; gx++) {
        const ch = office.grid[gz][gx];
        const wx = (gx + 0.5) * TILE_SIZE;
        const wz = (gz + 0.5) * TILE_SIZE;

        if (ch === '#') {
          pushMat(wallTransforms, wx, wallH / 2, wz);
        } else if (ch === 'w') {
          pushMat(windowTransforms, wx, wallH / 2, wz);
        } else if (ch === 'G') {
          pushMat(glassPaneTransforms, wx, wallH / 2, wz);
          pushMat(glassRailTransforms, wx, 0.05, wz);
          pushMat(glassRailTransforms, wx, wallH - 0.05, wz);
        } else if (ch === 'd') {
          pushMat(deskTopTransforms, wx, 0.78, wz);
          for (const [lx, lz] of legCoords) {
            pushMat(deskLegTransforms, wx + lx, 0.38, wz + lz);
          }
          pushMat(monStandTransforms, wx, 0.88, wz - 0.15);
          pushMat(monFrameTransforms, wx, 1.05, wz - 0.15);
          pushMat(monGlowTransforms, wx, 1.05, wz - 0.125);
        } else if (ch === 'b') {
          // Oriented 3-wall opaque Phone Booth: local -Z faces outward (spot.lookYaw)
          const matchSpot = office.hidingSpots.find((s) => s.gx === gx && s.gz === gz);
          const spotYaw = matchSpot ? matchSpot.lookYaw : 0;
          const boothGroup = new THREE.Group();
          boothGroup.position.set(wx, 0, wz);
          boothGroup.rotation.y = -spotYaw;

          const backWall = new THREE.Mesh(enclosureBackGeo, oakMat);
          backWall.position.set(0, 1.21, 0.62);
          const leftWall = new THREE.Mesh(enclosureSideGeo, oakMat);
          leftWall.position.set(-0.62, 1.21, 0);
          const rightWall = new THREE.Mesh(enclosureSideGeo, oakMat);
          rightWall.position.set(0.62, 1.21, 0);
          const topCap = new THREE.Mesh(enclosureTopGeo, oakMat);
          topCap.position.set(0, 2.42, 0);

          const frontDoor = new THREE.Mesh(boothDoorGeo, boothGlassMat);
          frontDoor.position.set(0, 1.17, -0.60);
          const neonTrim = new THREE.Mesh(boothTrimGeo, neonStripMat);
          neonTrim.position.set(0, 2.44, 0);

          boothGroup.add(backWall, leftWall, rightWall, topCap, frontDoor, neonTrim);
          envScene.add(boothGroup);
          if (matchSpot) {
            boothFrontDoorBySpotId.set(matchSpot.id, frontDoor);
          }
        } else if (ch === 'c') {
          // Oriented 3-wall opaque Supply Closet: local -Z faces outward (spot.lookYaw)
          const matchSpot = office.hidingSpots.find((s) => s.gx === gx && s.gz === gz);
          const spotYaw = matchSpot ? matchSpot.lookYaw : 0;
          const closetGroup = new THREE.Group();
          closetGroup.position.set(wx, 0, wz);
          closetGroup.rotation.y = -spotYaw;

          const backWall = new THREE.Mesh(enclosureBackGeo, darkMetalMat);
          backWall.position.set(0, 1.21, 0.62);
          const leftWall = new THREE.Mesh(enclosureSideGeo, darkMetalMat);
          leftWall.position.set(-0.62, 1.21, 0);
          const rightWall = new THREE.Mesh(enclosureSideGeo, darkMetalMat);
          rightWall.position.set(0.62, 1.21, 0);
          const topCap = new THREE.Mesh(enclosureTopGeo, darkMetalMat);
          topCap.position.set(0, 2.42, 0);

          // Front doorway has upper header + lower door + eye-level louver slats so player can peek out the front
          // while turning sideways or backward faces the solid opaque cabinet walls
          const headerPanel = new THREE.Mesh(closetHeaderGeo, darkMetalMat);
          headerPanel.position.set(0, 2.11, -0.60);
          const lowerPanel = new THREE.Mesh(closetLowerDoorGeo, darkMetalMat);
          lowerPanel.position.set(0, 0.68, -0.60);
          const slat1 = new THREE.Mesh(closetLouverSlatGeo, oakMat);
          slat1.position.set(0, 1.46, -0.60);
          const slat2 = new THREE.Mesh(closetLouverSlatGeo, oakMat);
          slat2.position.set(0, 1.72, -0.60);
          const outerShutter = new THREE.Mesh(
            new THREE.BoxGeometry(1.18, 0.44, 0.04),
            oakMat,
          );
          outerShutter.position.set(0, 1.59, -0.61);

          closetGroup.add(
            backWall,
            leftWall,
            rightWall,
            topCap,
            headerPanel,
            lowerPanel,
            slat1,
            slat2,
            outerShutter,
          );
          envScene.add(closetGroup);
          if (matchSpot) {
            boothFrontDoorBySpotId.set(matchSpot.id, outerShutter);
          }
        } else if (ch === 'k') {
          pushMat(islandBaseTransforms, wx, 0.46, wz);
          pushMat(islandTopTransforms, wx, 0.96, wz);
        } else if (ch === 's') {
          pushMat(sofaSeatTransforms, wx, 0.21, wz);
          pushMat(sofaBackTransforms, wx, 0.55, wz - 0.31);
          pushMat(potTransforms, wx + 0.55, 0.175, wz + 0.35);
          pushMat(foliageTransforms, wx + 0.55, 0.6, wz + 0.35);
        }
      }
    }

    const bakedInstancedMeshes: Array<{
      im: THREE.InstancedMesh;
      weights: Float32Array;
    }> = [];

    const computeBankWeightsAt = (wx: number, wz: number, out: Float32Array, offset: number): void => {
      for (let b = 0; b < 6; b++) {
        const bank = office.lightBanks[b];
        if (!bank) {
          out[offset + b] = 0;
          continue;
        }
        let maxW = 0;
        for (const fx of bank.Fixtures) {
          const d = Math.hypot(wx - fx.x, wz - fx.z);
          const w = Math.max(0, 1.0 - d / 13.5);
          if (w > maxW) maxW = w;
        }
        out[offset + b] = maxW * maxW;
      }
    };

    const addInstanced = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      matrices: THREE.Matrix4[],
      bakeCeiling = false,
    ): void => {
      if (matrices.length === 0) return;
      const im = new THREE.InstancedMesh(geo, mat, matrices.length);
      const weights = bakeCeiling ? new Float32Array(matrices.length * 6) : null;
      const pos = new THREE.Vector3();
      const white = new THREE.Color(0xffffff);
      for (let i = 0; i < matrices.length; i++) {
        im.setMatrixAt(i, matrices[i]);
        if (weights) {
          pos.setFromMatrixPosition(matrices[i]);
          computeBankWeightsAt(pos.x, pos.z, weights, i * 6);
          im.setColorAt(i, white);
        }
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = false;
      envScene!.add(im);
      if (weights) {
        bakedInstancedMeshes.push({ im, weights });
      }
    };

    const wallGeo = new THREE.BoxGeometry(TILE_SIZE, wallH, TILE_SIZE);
    addInstanced(wallGeo, wallMat, wallTransforms, true);
    addInstanced(wallGeo, windowMat, windowTransforms, false);
    addInstanced(
      new THREE.BoxGeometry(TILE_SIZE, wallH - 0.16, TILE_SIZE * 0.2),
      glassWallMat,
      glassPaneTransforms,
      true,
    );
    addInstanced(
      new THREE.BoxGeometry(TILE_SIZE, 0.1, TILE_SIZE * 0.24),
      darkMetalMat,
      glassRailTransforms,
      true,
    );
    addInstanced(new THREE.BoxGeometry(1.3, 0.08, 0.85), oakMat, deskTopTransforms, true);
    addInstanced(new THREE.BoxGeometry(0.07, 0.76, 0.07), darkMetalMat, deskLegTransforms, false);
    addInstanced(new THREE.BoxGeometry(0.08, 0.14, 0.08), darkMetalMat, monStandTransforms, false);
    addInstanced(new THREE.BoxGeometry(0.52, 0.32, 0.04), darkMetalMat, monFrameTransforms, false);
    addInstanced(new THREE.PlaneGeometry(0.46, 0.26), monitorScreenMat, monGlowTransforms, false);
    addInstanced(new THREE.BoxGeometry(1.42, 0.92, 1.42), darkMetalMat, islandBaseTransforms, true);
    addInstanced(new THREE.BoxGeometry(1.48, 0.08, 1.48), oakMat, islandTopTransforms, true);
    addInstanced(new THREE.BoxGeometry(1.3, 0.42, 0.85), sofaMat, sofaSeatTransforms, true);
    addInstanced(new THREE.BoxGeometry(1.3, 0.45, 0.22), sofaMat, sofaBackTransforms, true);
    addInstanced(new THREE.CylinderGeometry(0.18, 0.14, 0.35, 8), oakMat, potTransforms, false);
    addInstanced(new THREE.ConeGeometry(0.28, 0.65, 7), plantMat, foliageTransforms, false);

    // Precompute baked ceiling light weights for floor & ceiling vertices
    const floorPosAttr = floorGeo.attributes.position;
    const vCount = floorPosAttr.count;
    const floorColors = new Float32Array(vCount * 3);
    const ceilingColors = new Float32Array(vCount * 3);
    const floorWeights = new Float32Array(vCount * 6);
    const ceilingWeights = new Float32Array(vCount * 6);

    for (let i = 0; i < vCount; i++) {
      const lx = floorPosAttr.getX(i);
      const ly = floorPosAttr.getY(i);
      const wx = lx + mapW * 0.5;
      const wzFloor = -ly + mapD * 0.5;
      const wzCeil = ly + mapD * 0.5;
      computeBankWeightsAt(wx, wzFloor, floorWeights, i * 6);
      computeBankWeightsAt(wx, wzCeil, ceilingWeights, i * 6);
      floorColors[i * 3] = 1;
      floorColors[i * 3 + 1] = 1;
      floorColors[i * 3 + 2] = 1;
      ceilingColors[i * 3] = 1;
      ceilingColors[i * 3 + 1] = 1;
      ceilingColors[i * 3 + 2] = 1;
    }

    const floorColorAttr = new THREE.BufferAttribute(floorColors, 3);
    const ceilingColorAttr = new THREE.BufferAttribute(ceilingColors, 3);
    floorGeo.setAttribute('color', floorColorAttr);
    ceilingGeo.setAttribute('color', ceilingColorAttr);

    const tmpInstColor = new THREE.Color();
    bakeCeilingLightsFn = (bankLevels: number[]): void => {
      for (let i = 0; i < vCount; i++) {
        let sumF = 0;
        let sumC = 0;
        const baseIdx = i * 6;
        for (let b = 0; b < 6; b++) {
          const lvl = bankLevels[b] ?? 0;
          sumF += floorWeights[baseIdx + b] * lvl;
          sumC += ceilingWeights[baseIdx + b] * lvl;
        }
        const fBri = Math.min(1.35, 0.22 + sumF * 0.95);
        const cBri = Math.min(1.35, 0.2 + sumC * 1.0);
        floorColors[i * 3] = fBri;
        floorColors[i * 3 + 1] = fBri * 0.98;
        floorColors[i * 3 + 2] = fBri * 0.94;
        ceilingColors[i * 3] = cBri;
        ceilingColors[i * 3 + 1] = cBri * 0.98;
        ceilingColors[i * 3 + 2] = cBri * 0.94;
      }
      floorColorAttr.needsUpdate = true;
      ceilingColorAttr.needsUpdate = true;

      for (const item of bakedInstancedMeshes) {
        const count = item.im.count;
        for (let i = 0; i < count; i++) {
          let sum = 0;
          const baseIdx = i * 6;
          for (let b = 0; b < 6; b++) {
            sum += item.weights[baseIdx + b] * (bankLevels[b] ?? 0);
          }
          const bri = Math.min(1.25, 0.26 + sum * 0.88);
          tmpInstColor.setRGB(bri, bri * 0.98, bri * 0.95);
          item.im.setColorAt(i, tmpInstColor);
        }
        if (item.im.instanceColor) item.im.instanceColor.needsUpdate = true;
      }
    };

    // Glowing Kitchen Fridge near Monster Spawn
    const fridgeGroup = new THREE.Group();
    fridgeGroup.position.set(1.6 * TILE_SIZE, 0, 1.3 * TILE_SIZE);
    const fridgeBody = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 0.9), darkMetalMat);
    fridgeBody.position.y = 1.1;
    const fridgeGlowMat = new THREE.MeshLambertMaterial({
      color: 0xbae6fd,
      emissive: 0x38bdf8,
      emissiveIntensity: 1.8,
    });
    const fridgeDoor = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 1.85), fridgeGlowMat);
    fridgeDoor.position.set(0, 1.12, 0.46);
    fridgeGroup.add(fridgeBody, fridgeDoor);
    envScene.add(fridgeGroup);

    // Fictional Club Wall Sign ("SOLSTICE COMMONS")
    const signMat = new THREE.MeshLambertMaterial({
      map: signTex,
      emissive: 0x38bdf8,
      emissiveMap: signTex,
      emissiveIntensity: 0.9,
    });
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), signMat);
    signMesh.position.set(14.0 * TILE_SIZE, 2.25, 6.01 * TILE_SIZE);
    envScene.add(signMesh);

    // Emissive EXIT signs & Neon Accent Strips along ceiling corridors
    const exitMat = new THREE.MeshLambertMaterial({
      color: 0xef4444,
      emissive: 0xef4444,
      emissiveIntensity: 1.8,
    });
    const exitLocations = [
      { x: 4.5 * TILE_SIZE, z: 6.0 * TILE_SIZE },
      { x: 14.0 * TILE_SIZE, z: 11.0 * TILE_SIZE },
      { x: 20.5 * TILE_SIZE, z: 6.0 * TILE_SIZE },
    ];
    for (const loc of exitLocations) {
      const ex = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.08), exitMat);
      ex.position.set(loc.x, 2.65, loc.z);
      envScene.add(ex);
    }

    // Neon accent strips
    const stripCoords = [
      { x: 14.0 * TILE_SIZE, z: 3.5 * TILE_SIZE, w: 14.0, d: 0.08 },
      { x: 14.0 * TILE_SIZE, z: 8.5 * TILE_SIZE, w: 18.0, d: 0.08 },
      { x: 14.0 * TILE_SIZE, z: 12.5 * TILE_SIZE, w: 16.0, d: 0.08 },
    ];
    for (const sc of stripCoords) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(sc.w, 0.04, sc.d), neonStripMat);
      strip.position.set(sc.x, 2.94, sc.z);
      envScene.add(strip);
    }

    // Baked Ceiling Lighting + Single Dynamic Flashlight Rig (no dynamic ceiling PointLight)
    ambientLight = new THREE.AmbientLight(0xdbeafe, 1.0);
    envScene.add(ambientLight);
    hemiLight = new THREE.HemisphereLight(0xfef3c7, 0x1e293b, 0.95);
    envScene.add(hemiLight);

    // 6 Ceiling Light Bank emissive fixtures
    bankFixtureMats = [];
    const panelGeo = new THREE.BoxGeometry(1.4, 0.05, 0.45);
    for (const bank of office.lightBanks) {
      const fixMat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        emissive: 0xfef08a,
        emissiveIntensity: 1.8,
      });
      bankFixtureMats.push(fixMat);

      for (const fx of bank.Fixtures) {
        const panel = new THREE.Mesh(panelGeo, fixMat);
        panel.position.set(fx.x, 2.96, fx.z);
        envScene.add(panel);
      }
    }

    // Player Camera & Phone Flashlight (only dynamic light in the scene)
    camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.08, 65);
    flashlight = new THREE.SpotLight(
      0xe8f4ff,
      44.0,
      16.5,
      (27 * Math.PI) / 180,
      0.45,
      0.32,
    );
    flashlightFill = new THREE.PointLight(0xdbeafe, 4.5, 6.5, 0.4);
    flashlightTarget = new THREE.Object3D();
    envScene.add(flashlight);
    envScene.add(flashlightFill);
    envScene.add(flashlightTarget);
    flashlight.target = flashlightTarget;

    // Smooth Frosted-Glass Post-Processing Quad (used only when hidden inside a booth or facing interior cabinet walls)
    postScene = new THREE.Scene();
    postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    ditherUniforms = {
      tDiffuse: { value: lowResTarget ? lowResTarget.texture : null },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(LOW_RES_W, LOW_RES_H) },
      uFrostedBlur: { value: 0 },
    };
    const postMat = new THREE.ShaderMaterial({
      uniforms: ditherUniforms,
      depthWrite: false,
      depthTest: false,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform float uFrostedBlur;
        varying vec2 vUv;

        void main() {
          vec2 uv = vUv;
          vec3 col = texture2D(tDiffuse, uv).rgb;

          if (uFrostedBlur > 0.01) {
            vec2 texel = (1.0 / uResolution) * 3.5 * uFrostedBlur;
            vec3 sum = col * 0.28;
            sum += texture2D(tDiffuse, uv + vec2(texel.x, 0.0)).rgb * 0.18;
            sum += texture2D(tDiffuse, uv - vec2(texel.x, 0.0)).rgb * 0.18;
            sum += texture2D(tDiffuse, uv + vec2(0.0, texel.y)).rgb * 0.18;
            sum += texture2D(tDiffuse, uv - vec2(0.0, texel.y)).rgb * 0.18;
            col = mix(col, sum * vec3(0.95, 0.98, 1.04), min(1.0, uFrostedBlur));
          }

          vec2 d = uv - 0.5;
          float vig = clamp(1.0 - dot(d, d) * 0.75, 0.45, 1.0);
          col *= vig;

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
    postScene.add(quad);

    // High-res Monster Billboard added directly to envScene so it shares hardware 3D depth occlusion with desks, islands, sofas, and walls!
    fallbackMonsterTex = makeFallbackMonsterTexture();
    monsterMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      depthTest: true,
      uniforms: {
        uMap: { value: fallbackMonsterTex },
        uBrightness: { value: 0.75 },
        uTint: { value: new THREE.Color(0xe2e8f0) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uBrightness;
        uniform vec3 uTint;
        varying vec2 vUv;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          if (tex.a < 0.16) discard;
          vec3 silhouette = vec3(0.03, 0.04, 0.07);
          vec3 lit = tex.rgb * uTint * uBrightness;
          vec3 finalCol = mix(silhouette, lit, clamp(uBrightness, 0.06, 1.35));
          gl_FragColor = vec4(finalCol, tex.a);
        }
      `,
    });

    const spriteAspect = 1024 / 1536;
    const spriteW = monsterWorldHeight * spriteAspect;
    const spriteGeo = new THREE.PlaneGeometry(spriteW, monsterWorldHeight);
    monsterMesh = new THREE.Mesh(spriteGeo, monsterMat);
    monsterMesh.position.y = monsterWorldHeight * 0.5;
    monsterMesh.renderOrder = 2;
    envScene.add(monsterMesh);
  }

  async function loadMonsterAssets(): Promise<void> {
    try {
      const res = await fetch('/assets/monster/manifest.json');
      if (res.ok) {
        const manifest = (await res.json()) as { worldHeight?: number };
        if (typeof manifest.worldHeight === 'number' && manifest.worldHeight > 1.0) {
          monsterWorldHeight = manifest.worldHeight;
        }
      }
    } catch {
      // keep 2.6m default
    }

    const loader = new THREE.TextureLoader();
    const frames: MonsterSpriteFrame[] = ['idle', 'back', 'walk1', 'walk2', 'search'];
    await Promise.all(
      frames.map(
        (frame) =>
          new Promise<void>((resolve) => {
            loader.load(
              `/assets/monster/${frame}.png`,
              (tex) => {
                tex.colorSpace = THREE.SRGBColorSpace;
                monsterTextures[frame] = tex;
                resolve();
              },
              undefined,
              () => {
                // Fallback silhouette if missing
                if (fallbackMonsterTex) {
                  monsterTextures[frame] = fallbackMonsterTex;
                }
                resolve();
              },
            );
          }),
      ),
    );
  }

  function buildHudDom(): void {
    if (hudRoot) hudRoot.remove();
    hudRoot = document.createElement('div');
    hudRoot.className = 'pointer-events-none absolute inset-0 z-10 overflow-hidden font-mono select-none';
    hudRoot.innerHTML = `
      <!-- Bottom-Center Dock: Phase Countdown + Ceiling Banks + Footstep Noise Ring -->
      <div
        id="horror-phase-banner"
        data-testid="horror-phase-banner"
        class="absolute bottom-5 left-1/2 -translate-x-1/2 flex flex-wrap items-center gap-5 rounded-lg border border-slate-700/85 bg-slate-950/90 px-5 py-2.5 shadow-2xl"
      >
        <div class="flex flex-col gap-1 pr-4 border-r border-slate-800">
          <div class="flex items-center gap-2.5">
            <span
              id="horror-phase-title"
              data-testid="horror-phase-title"
              class="text-lg font-black tracking-widest uppercase text-amber-400"
            >
              HIDE
            </span>
            <span
              id="horror-phase-timer"
              data-testid="horror-phase-timer"
              class="text-lg font-extrabold text-slate-100"
              style="font-variant-numeric: tabular-nums;"
            >
              15.0s
            </span>
            <span
              id="horror-retry-badge"
              data-testid="horror-retry-badge"
              class="rounded border border-emerald-500/50 bg-emerald-950/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300"
            >
              1 free retry
            </span>
          </div>
          <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-400">
            <span>Ceiling Banks:</span>
            <div id="horror-bank-pips" class="flex items-center gap-1">
              <span class="h-2 w-3.5 rounded-sm border border-amber-300/60 bg-amber-300"></span>
              <span class="h-2 w-3.5 rounded-sm border border-amber-300/60 bg-amber-300"></span>
              <span class="h-2 w-3.5 rounded-sm border border-amber-300/60 bg-amber-300"></span>
              <span class="h-2 w-3.5 rounded-sm border border-amber-300/60 bg-amber-300"></span>
              <span class="h-2 w-3.5 rounded-sm border border-amber-300/60 bg-amber-300"></span>
              <span class="h-2 w-3.5 rounded-sm border border-amber-300/60 bg-amber-300"></span>
            </div>
          </div>
        </div>

        <div data-testid="horror-noise-widget" class="flex items-center gap-3">
          <svg viewBox="0 0 48 48" class="h-9 w-9 overflow-visible">
            <circle cx="24" cy="24" r="19" fill="none" stroke="#1e293b" stroke-width="2" stroke-dasharray="3 3" />
            <circle
              id="horror-noise-circle"
              cx="24"
              cy="24"
              r="3"
              fill="rgba(56, 189, 248, 0.18)"
              stroke="#38bdf8"
              stroke-width="2.2"
            />
            <circle cx="24" cy="24" r="2.5" fill="#f8fafc" />
          </svg>
          <div class="flex flex-col">
            <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">Footstep Noise Radius</span>
            <span id="horror-noise-status" class="text-xs font-extrabold text-sky-300">SILENT (0.0 m)</span>
          </div>
        </div>
      </div>

      <!-- Center Crosshair & E Hide Prompt -->
      <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-3">
        <div class="h-1.5 w-1.5 rounded-full bg-slate-200/60"></div>
        <div
          id="horror-interact-prompt"
          data-testid="horror-interact-prompt"
          class="hidden rounded border border-amber-400/80 bg-slate-950/90 px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-amber-300 shadow-lg"
        >
          <kbd class="rounded bg-amber-400 px-1.5 py-0.5 text-slate-950">E</kbd> <span id="horror-prompt-label">Hide</span>
        </div>
      </div>

      <!-- Under-Desk Edge Framing when hidden under a desk -->
      <div
        id="horror-desk-overlay"
        class="hidden absolute inset-0 pointer-events-none border-t-[90px] border-x-[36px] border-amber-950/95"
      ></div>

      <!-- Pointer Lock Pause Prompt -->
      <div
        id="horror-pointerlock-banner"
        class="hidden pointer-events-auto cursor-pointer absolute inset-0 z-20 flex items-center justify-center bg-slate-950/60"
      >
        <div class="rounded-lg border-2 border-amber-400 bg-slate-950/95 px-6 py-4 text-center shadow-2xl">
          <div class="text-sm font-black uppercase tracking-widest text-amber-300">Click to continue</div>
          <div class="mt-1 text-xs text-slate-400">WASD Move · Mouse Look · E Hide · F Flashlight</div>
        </div>
      </div>

      <!-- ONE MORE TRY Free Restart Overlay -->
      <div
        id="horror-one-more-try"
        data-testid="horror-one-more-try"
        class="hidden absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/92 text-center"
      >
        <div class="text-4xl font-black tracking-widest uppercase text-amber-400">ONE MORE TRY</div>
        <div class="mt-2 text-xs uppercase tracking-widest text-slate-300">
          Keep distance while it counts · Resetting to spawn
        </div>
      </div>

      <!-- Fullscreen Jumpscare Overlay -->
      <div
        id="horror-jumpscare-overlay"
        data-testid="horror-jumpscare-overlay"
        class="hidden absolute inset-0 z-40 overflow-hidden bg-black flex items-center justify-center"
      >
        <div id="horror-jumpscare-wrap" class="relative h-full w-full flex items-center justify-center">
          <img
            src="/assets/monster/jumpscare.jpg"
            alt=""
            class="h-full w-full object-cover"
          />
          <img
            src="/assets/monster/jumpscare.jpg"
            alt=""
            class="absolute inset-0 h-full w-full object-cover opacity-45 mix-blend-screen translate-x-2.5"
            style="filter: hue-rotate(310deg) saturate(2.5);"
          />
        </div>
      </div>
    `;

    ctx.root.appendChild(hudRoot);
    phaseBannerEl = hudRoot.querySelector('#horror-phase-banner');
    phaseTitleEl = hudRoot.querySelector('#horror-phase-title');
    phaseTimerEl = hudRoot.querySelector('#horror-phase-timer');
    retryBadgeEl = hudRoot.querySelector('#horror-retry-badge');
    const pipsWrap = hudRoot.querySelector('#horror-bank-pips');
    bankPipsEls = pipsWrap ? Array.from(pipsWrap.querySelectorAll('span')) : [];
    promptEl = hudRoot.querySelector('#horror-interact-prompt');
    deskOverlayEl = hudRoot.querySelector('#horror-desk-overlay');
    pointerLockBannerEl = hudRoot.querySelector('#horror-pointerlock-banner');
    oneMoreTryOverlayEl = hudRoot.querySelector('#horror-one-more-try');
    jumpscareOverlayEl = hudRoot.querySelector('#horror-jumpscare-overlay');
    jumpscareImgWrapEl = hudRoot.querySelector('#horror-jumpscare-wrap');
    noiseCircleEl = hudRoot.querySelector('#horror-noise-circle');
    noiseStatusTextEl = hudRoot.querySelector('#horror-noise-status');

    pointerLockBannerEl?.addEventListener('click', onCanvasClick);
  }

  return {
    id: 'horror',
    title: 'HIDE AND SEEK',
    listensTo: 'the structure',
    controls: [
      { keys: ['KeyW', 'KeyA', 'KeyS', 'KeyD'], label: 'Move' },
      { keys: ['ShiftLeft'], label: 'Sprint' },
      { keys: ['Mouse'], label: 'Look' },
      { keys: ['KeyE'], label: 'Hide' },
      { keys: ['KeyF'], label: 'Flashlight' },
    ],

    async preload(gameCtx: GameContext): Promise<void> {
      ctx = gameCtx;
      if (!ctx.level) {
        ctx.level = generateLevel(ctx.map, defaultParams, ctx.rng);
      }

      if (!renderer) {
        ctx.root.innerHTML = '';
        renderer = new THREE.WebGLRenderer({
          antialias: !isSoftwareGl,
          powerPreference: 'high-performance',
        });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.25;
        renderer.autoClear = false;
        renderer.setPixelRatio(1);
        renderer.setSize(window.innerWidth, window.innerHeight);
        ctx.root.appendChild(renderer.domElement);

        lowResTarget = new THREE.WebGLRenderTarget(LOW_RES_W, LOW_RES_H, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
        });

        buildEnvironmentScene();
        if (!isSoftwareGl && envScene && camera) {
          renderer.compile(envScene, camera);
        }
        buildHudDom();
      }

      await loadMonsterAssets();
    },

    enter(songTime: number): void {
      active = true;
      keysHeld.clear();
      interactQueued = false;
      flashlightToggleQueued = false;

      lastPhaseTitle = '';
      lastPhaseTimerStr = '';
      lastRetryVisible = null;
      lastPromptMode = 'none';
      lastNoiseRadiusStr = '';
      lastNoiseText = '';
      lastAccentHex = '';
      lastDeskHidden = null;
      lastOneMoreHidden = null;
      lastScareHidden = null;
      lastBakedBankSignature = '';

      const level = (ctx.level as HorrorLevel) ?? generateLevel(ctx.map, defaultParams, ctx.rng);
      sim = new HorrorSimEngine({
        map: ctx.map,
        level,
        rng: ctx.rng,
        entryTime: songTime,
        emit: (ev) => ctx.emit(ev),
      });

      botController = new HorrorBotController('hider');
      lookYaw = sim.playerYaw;
      lookPitch = 0;
      walkBobTime = 0;

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('mousemove', onMouseMove);
      renderer?.domElement.addEventListener('click', onCanvasClick);
      document.addEventListener('pointerlockchange', onPointerLockChange);
    },

    update(dt: number, songTime: number): void {
      if (!active || !sim) return;

      const clampedDt = Math.min(0.05, Math.max(0.001, dt));
      fpsAvg = isSoftwareGl ? 60 : fpsAvg * 0.92 + (1 / clampedDt) * 0.08;

      let input: BotInputState;
      if (ctx.bot) {
        input = botController.step({
          songTime,
          phase: sim.phase,
          playerX: sim.playerX,
          playerZ: sim.playerZ,
          playerYaw: sim.playerYaw,
          hiddenSpotId: sim.hiddenSpotId,
          flashlightOn: sim.flashlightOn,
          monsterX: sim.monsterX,
          monsterZ: sim.monsterZ,
          enabledSpotIds: sim.level.enabledSpotIds,
        });
        lookYaw = input.lookYaw;
        lookPitch = input.lookPitch;
      } else {
        const forwardX = Math.sin(lookYaw);
        const forwardZ = -Math.cos(lookYaw);
        const rightX = Math.cos(lookYaw);
        const rightZ = Math.sin(lookYaw);

        let f = 0;
        let r = 0;
        if (keysHeld.has('KeyW') || keysHeld.has('ArrowUp')) f += 1;
        if (keysHeld.has('KeyS') || keysHeld.has('ArrowDown')) f -= 1;
        if (keysHeld.has('KeyD') || keysHeld.has('ArrowRight')) r += 1;
        if (keysHeld.has('KeyA') || keysHeld.has('ArrowLeft')) r -= 1;

        input = {
          moveX: forwardX * f + rightX * r,
          moveZ: forwardZ * f + rightZ * r,
          lookYaw,
          lookPitch,
          interactPressed: interactQueued,
          flashlightTogglePressed: flashlightToggleQueued,
          sprintHeld: keysHeld.has('ShiftLeft') || keysHeld.has('ShiftRight'),
        };
        interactQueued = false;
        flashlightToggleQueued = false;
      }

      sim.step(clampedDt, songTime, input);
      lookYaw = sim.playerYaw;
      lookPitch = sim.playerPitch;

      // Update continuous song FX (gain by BFS path distance, lowpass by wall count)
      ctx.fx.gain(sim.currentFxGain, 0.12);
      ctx.fx.lowpass(sim.currentFxLowpass, 0.2);

      // Play procedural Web Audio SFX cues
      for (const cue of sim.soundCues) {
        sfx.playCue(cue);
      }
      const euclidDist = Math.hypot(sim.playerX - sim.monsterX, sim.playerZ - sim.monsterZ);
      sfx.updateBreathing(clampedDt, euclidDist);

      // Update palette accent on neon strips + compute beat-synced light flash during hunt
      const pal = ctx.palette.at(songTime);
      if (neonStripMat && pal.accent !== lastAccentHex) {
        lastAccentHex = pal.accent;
        neonStripMat.color.set(pal.accent);
        neonStripMat.emissive.set(pal.accent);
      }

      const bPhase = beatPhase(ctx.map, songTime);
      const bIdx = beatAt(ctx.map, songTime);
      const isDownbeat = bIdx % 4 === 0;
      const beatDecay = Math.exp(-bPhase * 6.5);
      const energy = energyAt(ctx.map, songTime);
      const bandDrive = 0.55 + 0.45 * Math.max(energy, ctx.bands.low);
      const huntBeatFlash =
        sim.phase === 'hunt' ? beatDecay * (isDownbeat ? 1.0 : 0.65) * bandDrive : 0;

      if (neonStripMat) {
        neonStripMat.emissiveIntensity = 1.3 + huntBeatFlash * 2.2;
      }

      // Update 6 ceiling light banks + event-driven baked lighting state
      let activeBanksCount = 0;
      const bankLevels: number[] = [0, 0, 0, 0, 0, 0];

      for (let i = 0; i < 6; i++) {
        const isOn = sim.lightBankStates[i];
        const offTime = sim.lightBankOffTimes[i] ?? 999;
        const timeToOff = offTime - songTime;
        const flickering = isOn && timeToOff > 0 && timeToOff < 0.24 && Math.floor(songTime * 35) % 2 === 0;
        const level = isOn ? (flickering ? 0.15 : 1.0) : 0.0;
        bankLevels[i] = level;

        if (isOn) {
          activeBanksCount++;
        }
        if (bankFixtureMats[i]) {
          const huntFixturePulse =
            !isOn && huntBeatFlash > 0.01
              ? huntBeatFlash * (isDownbeat || (i + bIdx) % 2 === 0 ? 1.5 : 0.5)
              : 0;
          bankFixtureMats[i].emissiveIntensity = isOn
            ? flickering
              ? 0.2
              : 1.8
            : 0.05 + huntFixturePulse;
        }
        if (bankPipsEls[i]) {
          const targetBg = isOn ? '#fcd34d' : '#1e293b';
          if (bankPipsEls[i].dataset.state !== (isOn ? 'on' : 'off')) {
            bankPipsEls[i].dataset.state = isOn ? 'on' : 'off';
            bankPipsEls[i].style.backgroundColor = targetBg;
            bankPipsEls[i].style.borderColor = isOn ? '#fde68a' : '#334155';
          }
        }
      }

      const nextBakeSig = bankLevels.join(',');
      if (nextBakeSig !== lastBakedBankSignature && bakeCeilingLightsFn) {
        lastBakedBankSignature = nextBakeSig;
        bakeCeilingLightsFn(bankLevels);
      }

      const ceilingFraction = activeBanksCount / 6;
      if (ambientLight && hemiLight) {
        // Hide phase starts with lights fully on; Hunt phase has near-black ambient + dynamic beat flashes
        ambientLight.intensity = 0.12 + ceilingFraction * 1.15 + huntBeatFlash * 0.48;
        hemiLight.intensity = 0.16 + ceilingFraction * 1.05 + huntBeatFlash * 0.56;
      }

      // Open only the front doorway panel of the booth/closet the player is hidden inside,
      // keeping the 3 opaque interior walls (back, left, right) solid and visible!
      boothFrontDoorBySpotId.forEach((doorMesh, spotId) => {
        doorMesh.visible = sim.hiddenSpotId !== spotId;
      });

      // Update camera position & eye height (1.6 m standing, 0.62 m under desk)
      if (camera && flashlight && flashlightFill && flashlightTarget) {
        const hiddenSpot =
          sim.hiddenSpotId !== null ? office.hidingSpots[sim.hiddenSpotId] : null;
        const baseEyeY = hiddenSpot?.kind === 'desk' ? 0.62 : 1.6;
        if (sim.playerMoving) {
          walkBobTime += clampedDt * (sim.playerSprinting ? 13.2 : 8.5);
        }
        const bobAmp = sim.playerSprinting ? 0.052 : 0.035;
        const bobY = sim.playerMoving ? Math.sin(walkBobTime) * bobAmp : 0;
        const swayX = sim.playerMoving ? Math.cos(walkBobTime * 0.5) * (sim.playerSprinting ? 0.06 : 0.04) : 0;

        let camX = sim.playerX;
        let camZ = sim.playerZ;
        if (hiddenSpot) {
          // Keep camera centered inside booths/closets so 360-degree rotation stays inside the 3-wall opaque enclosure
          const forwardFactor = hiddenSpot.kind === 'desk' ? 0.35 : 0.04;
          camX = hiddenSpot.worldX + (hiddenSpot.accessX - hiddenSpot.worldX) * forwardFactor;
          camZ = hiddenSpot.worldZ + (hiddenSpot.accessZ - hiddenSpot.worldZ) * forwardFactor;
        }

        camera.position.set(camX, baseEyeY + bobY, camZ);
        const lookDirX = Math.sin(sim.playerYaw) * Math.cos(sim.playerPitch);
        const lookDirY = Math.sin(sim.playerPitch);
        const lookDirZ = -Math.cos(sim.playerYaw) * Math.cos(sim.playerPitch);
        camera.lookAt(
          camera.position.x + lookDirX,
          camera.position.y + lookDirY,
          camera.position.z + lookDirZ,
        );

        flashlight.intensity = sim.flashlightOn ? 44.0 : 0.0;
        flashlightFill.intensity = sim.flashlightOn ? 4.5 : 0.0;
        flashlight.position.set(
          camera.position.x + Math.cos(sim.playerYaw) * 0.14,
          camera.position.y - 0.12,
          camera.position.z + Math.sin(sim.playerYaw) * 0.14,
        );
        flashlightFill.position.copy(camera.position);
        flashlightTarget.position.set(
          camera.position.x + lookDirX * 8.0 + swayX,
          camera.position.y + lookDirY * 8.0 + bobY * 2.0,
          camera.position.z + lookDirZ * 8.0,
        );

        if (ditherUniforms) {
          ditherUniforms.uTime.value = songTime;
          let targetBlur = 0.0;
          if (hiddenSpot) {
            if (hiddenSpot.kind === 'booth') {
              targetBlur = 0.55;
            }
            if (hiddenSpot.kind === 'booth' || hiddenSpot.kind === 'closet') {
              // Increase blur when turning away from the front doorway toward the opaque interior walls
              let yawDiff = sim.playerYaw - hiddenSpot.lookYaw;
              while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
              while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
              const absDiff = Math.abs(yawDiff);
              if (absDiff > 0.75) {
                const wallFactor = Math.min(1.0, (absDiff - 0.75) / 0.85);
                targetBlur = Math.max(targetBlur, wallFactor * 0.85);
              }
            }
          }
          ditherUniforms.uFrostedBlur.value = targetBlur;
        }
        const isDesk = hiddenSpot?.kind === 'desk';
        if (deskOverlayEl && lastDeskHidden !== !isDesk) {
          lastDeskHidden = !isDesk;
          deskOverlayEl.classList.toggle('hidden', !isDesk);
        }
      }

      // Update Monster High-Res Billboard Sprite inside envScene (hardware 3D depth occlusion against desks & walls)
      if (monsterMesh && monsterMat && camera) {
        monsterMesh.visible = sim.phase !== 'dying';
        if (monsterMesh.visible) {
          monsterMesh.position.set(sim.monsterX, monsterWorldHeight * 0.5, sim.monsterZ);
          // Billboard faces camera horizontally
          const dx = camera.position.x - sim.monsterX;
          const dz = camera.position.z - sim.monsterZ;
          monsterMesh.rotation.y = Math.atan2(dx, dz);

          const tex = monsterTextures[sim.monsterFrame] ?? fallbackMonsterTex;
          if (tex && monsterMat.uniforms.uMap.value !== tex) {
            monsterMat.uniforms.uMap.value = tex;
          }

          // Compute brightness = current office ambient + flashlight contribution when inside beam
          const toMonsterX = sim.monsterX - camera.position.x;
          const toMonsterZ = sim.monsterZ - camera.position.z;
          const mDist = Math.max(0.1, Math.hypot(toMonsterX, toMonsterZ));
          const camForwardX = Math.sin(sim.playerYaw);
          const camForwardZ = -Math.cos(sim.playerYaw);
          const dotBeam =
            (toMonsterX / mDist) * camForwardX + (toMonsterZ / mDist) * camForwardZ;
          const coneCos = Math.cos((30 * Math.PI) / 180);
          let beamContribution = 0;
          if (sim.flashlightOn && mDist <= 15.0 && dotBeam >= coneCos) {
            const angularFalloff = Math.min(1.0, (dotBeam - coneCos) / (1.0 - coneCos + 0.001));
            const distFalloff = Math.max(0.2, 1.0 - mDist / 15.5);
            beamContribution = angularFalloff * distFalloff * 1.3;
          }
          const officeAmbient = 0.09 + ceilingFraction * 0.85 + huntBeatFlash * 0.38;
          monsterMat.uniforms.uBrightness.value = Math.min(1.35, officeAmbient + beamContribution);
        }
      }

      // Update HUD elements only when values change
      if (phaseTitleEl && phaseTimerEl && retryBadgeEl) {
        if (sim.phase === 'hide') {
          const nextTitle = sim.roundNumber === 1 ? 'HIDE' : 'HIDE AGAIN';
          if (nextTitle !== lastPhaseTitle) {
            lastPhaseTitle = nextTitle;
            phaseTitleEl.textContent = nextTitle;
            phaseTitleEl.className = 'text-xl font-black tracking-widest uppercase text-amber-400';
          }
          const remStr = `${Math.max(0, sim.countdownEnd - songTime).toFixed(1)}s`;
          if (remStr !== lastPhaseTimerStr) {
            lastPhaseTimerStr = remStr;
            phaseTimerEl.textContent = remStr;
          }
          if (lastRetryVisible !== sim.freeRetryAvailable) {
            lastRetryVisible = sim.freeRetryAvailable;
            retryBadgeEl.classList.toggle('hidden', !sim.freeRetryAvailable);
          }
        } else if (sim.phase === 'hunt') {
          if (lastPhaseTitle !== 'HUNT') {
            lastPhaseTitle = 'HUNT';
            phaseTitleEl.textContent = 'HUNT';
            phaseTitleEl.className = 'text-xl font-black tracking-widest uppercase text-rose-500';
          }
          const remStr = `${Math.max(0, sim.huntEnd - songTime).toFixed(1)}s`;
          if (remStr !== lastPhaseTimerStr) {
            lastPhaseTimerStr = remStr;
            phaseTimerEl.textContent = remStr;
          }
          if (lastRetryVisible !== false) {
            lastRetryVisible = false;
            retryBadgeEl.classList.add('hidden');
          }
        }
      }

      if (promptEl) {
        let nextPromptMode: 'none' | 'hide' | 'exit' = 'none';
        if (sim.hiddenSpotId !== null) {
          nextPromptMode = 'exit';
        } else if (sim.findInteractableHidingSpot()) {
          nextPromptMode = 'hide';
        }
        if (nextPromptMode !== lastPromptMode) {
          lastPromptMode = nextPromptMode;
          if (nextPromptMode === 'none') {
            promptEl.classList.add('hidden');
          } else {
            const labelSpan = promptEl.querySelector('#horror-prompt-label');
            if (labelSpan) {
              labelSpan.textContent = nextPromptMode === 'exit' ? 'Exit Hiding' : 'Hide';
            }
            promptEl.classList.remove('hidden');
          }
        }
      }

      if (noiseCircleEl && noiseStatusTextEl) {
        const rPxStr = Math.min(20, 3 + (sim.noiseRadius / 6.0) * 14).toFixed(1);
        if (rPxStr !== lastNoiseRadiusStr) {
          lastNoiseRadiusStr = rPxStr;
          noiseCircleEl.setAttribute('r', rPxStr);
        }
        let nextNoiseText: string;
        let nextNoiseClass: string;
        if (sim.noiseRadius <= 0.05) {
          nextNoiseText = 'SILENT (0.0 m)';
          nextNoiseClass = 'text-xs font-extrabold text-emerald-300';
        } else if (sim.playerSprinting) {
          nextNoiseText = `SPRINT · ${sim.noiseRadius.toFixed(1)} m (12m ALERT)`;
          nextNoiseClass = 'text-xs font-extrabold text-rose-400';
        } else {
          const eNow = energyAt(ctx.map, songTime);
          const maskedPct = Math.round(eNow * 75);
          nextNoiseText = `${sim.noiseRadius.toFixed(1)} m (${maskedPct}% MASKED)`;
          nextNoiseClass =
            sim.noiseRadius > 3.5
              ? 'text-xs font-extrabold text-amber-300'
              : 'text-xs font-extrabold text-sky-300';
        }
        if (nextNoiseText !== lastNoiseText) {
          lastNoiseText = nextNoiseText;
          noiseStatusTextEl.textContent = nextNoiseText;
          noiseStatusTextEl.className = nextNoiseClass;
        }
      }

      // Update ONE MORE TRY and Jumpscare Overlays
      if (oneMoreTryOverlayEl) {
        const showOneMore = sim.phase === 'oneMoreTry' && sim.oneMoreTryTimer >= 0.45;
        if (lastOneMoreHidden !== !showOneMore) {
          lastOneMoreHidden = !showOneMore;
          oneMoreTryOverlayEl.classList.toggle('hidden', !showOneMore);
        }
      }

      if (jumpscareOverlayEl && jumpscareImgWrapEl) {
        const inScare =
          (sim.phase === 'oneMoreTry' && sim.oneMoreTryTimer < 0.45) ||
          sim.phase === 'dying';
        if (lastScareHidden !== !inScare) {
          lastScareHidden = !inScare;
          jumpscareOverlayEl.classList.toggle('hidden', !inScare);
        }

        if (inScare) {
          const t = sim.phase === 'dying' ? sim.deathTimer : sim.oneMoreTryTimer;
          if (sim.phase === 'dying' && t >= 0.8) {
            // Hard cut to black at 0.8 s
            jumpscareImgWrapEl.style.opacity = '0';
          } else {
            jumpscareImgWrapEl.style.opacity = '1';
            const scale = 0.9 + Math.min(1.0, t / 0.6) * 0.25;
            const shakeX = Math.sin(t * 95) * 14;
            const shakeY = Math.cos(t * 110) * 10;
            jumpscareImgWrapEl.style.transform = `translate(${shakeX.toFixed(1)}px, ${shakeY.toFixed(1)}px) scale(${scale.toFixed(3)})`;
          }
        }
      }

      void phaseBannerEl;
    },

    render(): void {
      if (
        !renderer ||
        !lowResTarget ||
        !envScene ||
        !postScene ||
        !postCamera ||
        !camera
      ) {
        return;
      }

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
      }

      const blurVal = ditherUniforms ? ditherUniforms.uFrostedBlur.value : 0;
      if (blurVal > 0.01) {
        // Render through smooth LinearFilter target when frosted glass / cabinet interior blur is active
        renderer.setRenderTarget(lowResTarget);
        renderer.clear();
        renderer.render(envScene, camera);

        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(postScene, postCamera);
      } else {
        // Direct single-pass anti-aliased hardware render (maximum FPS + smooth edges + 3D depth occlusion)
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(envScene, camera);
      }
    },

    exit(): void {
      active = false;
      keysHeld.clear();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      renderer?.domElement.removeEventListener('click', onCanvasClick);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.exitPointerLock?.();
      sfx.stop();
      ctx.fx.reset();
    },

    getMetrics(): Record<string, number> {
      if (!sim) return { score: 0, avgFps: 60 };
      return {
        score: Math.round(sim.score),
        huntsSurvived: sim.huntsSurvived,
        closeCalls: sim.closeCalls,
        doubleBacksPerHunt: Math.max(1, sim.totalDoubleBacks),
        fakeOutsPerHunt: Math.max(1, sim.totalFakeOuts),
        directorHintsPerHunt: Math.max(1, sim.totalDirectorHints),
        maxSilentGap: Math.round(sim.maxSilentGap * 100) / 100,
        lightsOffOnTime: sim.lightsOffOnTime,
        avgFps: Math.round(fpsAvg),
      };
    },
  };
}
