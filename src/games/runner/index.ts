import * as THREE from 'three';
import type { GameContext, GameModule, Palette } from '../../shell/api';
import { beatPhase, sectionIndexAt } from '../../shared/songmap';
import { lerpColorHex } from '../../shared/palette';
import {
  decidePhase1BotAction,
  decidePhase2BotHop,
  type Phase2HopDir,
} from './bot';
import {
  CENTER_COL,
  cometHeadColAt,
  defaultParams,
  generateLevel,
  GRID_COLS,
  paramRanges,
  resolveRunnerSession,
  TRANSITION_DURATION_SEC,
  type Phase1ObstacleKind,
  type RunnerLevel,
  type RunnerParams,
} from './level';
import {
  buildRunnerMetrics,
  createRunnerSimState,
  simulate,
  stepRunnerSim,
  type RunnerSimInput,
  type RunnerSimState,
} from './sim';
import {
  BIRD_FLAP_A,
  BIRD_FLAP_B,
  buildSpriteTexture,
  CACTUS_GROUP,
  CACTUS_LARGE,
  CACTUS_MEDIUM,
  CACTUS_SMALL,
  CLOUD_SPRITE,
  createSmoothRoundedBoxGeometry,
  extractVoxelCells,
  HERO_DUCK_A,
  HERO_DUCK_B,
  HERO_HIT,
  HERO_JUMP,
  HERO_RUN_A,
  HERO_RUN_B,
  HERO_RUN_MID,
  updatePixelScoreTexture,
  updateSpriteTextureColors,
} from './sprites';

export { defaultParams, paramRanges, generateLevel, simulate };

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

const TILE_SIZE = 1.4;
const MAX_VOXEL_INSTANCES = 1800;

// Base dimensions for compact 2D T-Rex and environment
const HERO_2D_WIDTH = 0.94;
const HERO_2D_HEIGHT = 1.02;
const HERO_2D_BASE_Y = 0.5;

// Pre-allocated scratch math objects (zero GC in render loop)
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

export function createRunnerGame(): GameModule {
  let ctx!: GameContext;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let orthoCam: THREE.OrthographicCamera | null = null;
  let perspCam: THREE.PerspectiveCamera | null = null;
  let hemiLight: THREE.HemisphereLight | null = null;
  let dirLight: THREE.DirectionalLight | null = null;

  // Phase 1 2D group (smooth-filtered planes)
  let phase1Group: THREE.Group | null = null;
  let horizonGlowMesh: THREE.Mesh | null = null;
  let horizonGlowMat: THREE.MeshBasicMaterial | null = null;
  let duneMeshes: THREE.Mesh[] = [];
  let duneMat: THREE.MeshBasicMaterial | null = null;
  let heroPlane: THREE.Mesh | null = null;
  let heroPlaneMat: THREE.MeshBasicMaterial | null = null;
  let groundLineMesh: THREE.Mesh | null = null;
  let groundLineMat: THREE.MeshBasicMaterial | null = null;
  let pebbleMeshes: THREE.Mesh[] = [];
  let cloudMeshes: THREE.Mesh[] = [];
  let cloudMat: THREE.MeshBasicMaterial | null = null;
  let obsPoolMeshes: THREE.Mesh[] = [];
  let obsPoolMats: THREE.MeshBasicMaterial[] = [];
  let scorePlaneMesh: THREE.Mesh | null = null;
  let scoreTex: THREE.DataTexture | null = null;

  // Smooth anti-aliased sprite textures
  let texturesReady = false;
  const spriteTextures: Record<string, THREE.DataTexture> = {};
  let lastPaletteSignature = '';

  // Shared InstancedMesh with smooth rounded-edge voxel geometry (Transition + Phase 2)
  let voxelMesh: THREE.InstancedMesh | null = null;
  const heroVoxelsRunA = extractVoxelCells(HERO_RUN_A);
  const heroVoxelsRunMid = extractVoxelCells(HERO_RUN_MID);
  const heroVoxelsRunB = extractVoxelCells(HERO_RUN_B);
  const cactusSmallVoxels = extractVoxelCells(CACTUS_SMALL);

  // DOM card for "NEW CONTROLS" during transition
  let newControlsCardEl: HTMLElement | null = null;

  // Runtime state
  let active = false;
  let simState!: RunnerSimState;
  let params: RunnerParams = { ...defaultParams };
  let lastSectionIdx = 0;
  let nightModeTimer = 0;
  let nightModeMix = 0;

  // Smooth damped animation states (2D & 3D)
  let lastRenderSongTime = 0;
  let wasJumping2D = false;
  let heroSquashX = 1.0;
  let heroSquashY = 1.0;
  let heroTiltZ = 0.0;
  let dampedHeroY2D = 0.0;

  let dampedHeroX3D = 0.0;
  let dampedHeroZ3D = 0.0;
  let dampedHeroY3D = 0.05;
  let dampedHeroPitch3D = 0.0;
  let dampedHeroRoll3D = 0.0;
  let dampedCamRow = 0.0;

  // Held/buffered player inputs
  let jumpPressed = false;
  let jumpReleased = false;
  let jumpHeld = false;
  let duckHeld = false;
  let pendingHopDir: Exclude<Phase2HopDir, 'wait'> | null = null;

  // FPS tracking
  let fpsEstimate = 60;
  let lastUpdateWallMs = 0;

  function initTextures(): void {
    if (texturesReady) return;
    texturesReady = true;
    spriteTextures.runA = buildSpriteTexture(HERO_RUN_A, '#f8fafc', '#ef4444', '#22d3ee', '#0f172a');
    spriteTextures.runMid = buildSpriteTexture(HERO_RUN_MID, '#f8fafc', '#ef4444', '#22d3ee', '#0f172a');
    spriteTextures.runB = buildSpriteTexture(HERO_RUN_B, '#f8fafc', '#ef4444', '#22d3ee', '#0f172a');
    spriteTextures.jump = buildSpriteTexture(HERO_JUMP, '#f8fafc', '#ef4444', '#22d3ee', '#0f172a');
    spriteTextures.duckA = buildSpriteTexture(HERO_DUCK_A, '#f8fafc', '#ef4444', '#22d3ee', '#0f172a');
    spriteTextures.duckB = buildSpriteTexture(HERO_DUCK_B, '#f8fafc', '#ef4444', '#22d3ee', '#0f172a');
    spriteTextures.hit = buildSpriteTexture(HERO_HIT, '#f8fafc', '#ef4444', '#22d3ee', '#0f172a');

    spriteTextures.cactus_small = buildSpriteTexture(CACTUS_SMALL, '#f97316', '#fbbf24', '#fef3c7', '#0f172a');
    spriteTextures.cactus_medium = buildSpriteTexture(CACTUS_MEDIUM, '#f97316', '#fbbf24', '#fef3c7', '#0f172a');
    spriteTextures.cactus_large = buildSpriteTexture(CACTUS_LARGE, '#f97316', '#fbbf24', '#fef3c7', '#0f172a');
    spriteTextures.cactus_group = buildSpriteTexture(CACTUS_GROUP, '#f97316', '#fbbf24', '#fef3c7', '#0f172a');
    spriteTextures.birdA = buildSpriteTexture(BIRD_FLAP_A, '#fbbf24', '#f97316', '#fef3c7', '#0f172a');
    spriteTextures.birdB = buildSpriteTexture(BIRD_FLAP_B, '#fbbf24', '#f97316', '#fef3c7', '#0f172a');
    spriteTextures.cloud = buildSpriteTexture(CLOUD_SPRITE, '#64748b', '#64748b', '#94a3b8', '#1e293b');
  }

  function syncSpriteColorsToPalette(pal: Palette, pulseMix: number): void {
    const heroBody = pulseMix > 0.35 ? lerpColorHex(pal.highlight, pal.primary, pulseMix * 0.5) : pal.highlight;
    const heroHeadphones = pal.accent;
    const heroRim = pal.secondary;
    const outline = lerpColorHex(pal.bg, '#090a10', 0.5);
    const cactusBody = lerpColorHex(pal.secondary, pal.primary, 0.25);
    const birdBody = pal.accent;
    const cloudCol = lerpColorHex(pal.bg, pal.primary, 0.35);

    const sig = `${heroBody}|${heroHeadphones}|${heroRim}|${cactusBody}|${birdBody}`;
    if (sig === lastPaletteSignature) return;
    lastPaletteSignature = sig;

    updateSpriteTextureColors(spriteTextures.runA, HERO_RUN_A, heroBody, heroHeadphones, heroRim, outline);
    updateSpriteTextureColors(spriteTextures.runMid, HERO_RUN_MID, heroBody, heroHeadphones, heroRim, outline);
    updateSpriteTextureColors(spriteTextures.runB, HERO_RUN_B, heroBody, heroHeadphones, heroRim, outline);
    updateSpriteTextureColors(spriteTextures.jump, HERO_JUMP, heroBody, heroHeadphones, heroRim, outline);
    updateSpriteTextureColors(spriteTextures.duckA, HERO_DUCK_A, heroBody, heroHeadphones, heroRim, outline);
    updateSpriteTextureColors(spriteTextures.duckB, HERO_DUCK_B, heroBody, heroHeadphones, heroRim, outline);
    updateSpriteTextureColors(spriteTextures.hit, HERO_HIT, '#ef4444', heroHeadphones, '#ffffff', outline);

    updateSpriteTextureColors(spriteTextures.cactus_small, CACTUS_SMALL, cactusBody, pal.accent, pal.highlight, outline);
    updateSpriteTextureColors(spriteTextures.cactus_medium, CACTUS_MEDIUM, cactusBody, pal.accent, pal.highlight, outline);
    updateSpriteTextureColors(spriteTextures.cactus_large, CACTUS_LARGE, cactusBody, pal.accent, pal.highlight, outline);
    updateSpriteTextureColors(spriteTextures.cactus_group, CACTUS_GROUP, cactusBody, pal.accent, pal.highlight, outline);
    updateSpriteTextureColors(spriteTextures.birdA, BIRD_FLAP_A, birdBody, pal.secondary, pal.highlight, outline);
    updateSpriteTextureColors(spriteTextures.birdB, BIRD_FLAP_B, birdBody, pal.secondary, pal.highlight, outline);
    updateSpriteTextureColors(spriteTextures.cloud, CLOUD_SPRITE, cloudCol, cloudCol, pal.primary, pal.bg);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!active || !simState || simState.dying) return;
    const code = e.code;

    if (simState.phase === 'phase1') {
      if (code === 'Space' || code === 'KeyW' || code === 'ArrowUp') {
        e.preventDefault();
        jumpPressed = true;
        jumpHeld = true;
      } else if (code === 'KeyS' || code === 'ArrowDown') {
        e.preventDefault();
        duckHeld = true;
      }
    } else if (simState.phase === 'phase2') {
      if (code === 'Space' || code === 'KeyW' || code === 'ArrowUp') {
        e.preventDefault();
        pendingHopDir = 'forward';
      } else if (code === 'KeyA' || code === 'ArrowLeft') {
        e.preventDefault();
        pendingHopDir = 'left';
      } else if (code === 'KeyD' || code === 'ArrowRight') {
        e.preventDefault();
        pendingHopDir = 'right';
      } else if (code === 'KeyS' || code === 'ArrowDown') {
        e.preventDefault();
        pendingHopDir = 'back';
      }
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space' || e.code === 'KeyW' || e.code === 'ArrowUp') {
      jumpHeld = false;
      jumpReleased = true;
    }
    if (e.code === 'KeyS' || e.code === 'ArrowDown') {
      duckHeld = false;
    }
  }

  function getObstacleTexture(kind: Phase1ObstacleKind, songTime: number): THREE.DataTexture {
    if (kind === 'bird_low' || kind === 'bird_high') {
      const flap = Math.floor(songTime * 9.5) % 2 === 0;
      return flap ? spriteTextures.birdA : spriteTextures.birdB;
    }
    return spriteTextures[kind] || spriteTextures.cactus_small;
  }

  function setupScene(): void {
    if (renderer) return;
    initTextures();

    ctx.root.innerHTML = '';
    renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    ctx.root.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color('#131124');
    scene.fog = new THREE.FogExp2('#131124', 0.024);

    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const orthoHalfH = 4.2;
    orthoCam = new THREE.OrthographicCamera(
      -orthoHalfH * aspect,
      orthoHalfH * aspect,
      orthoHalfH,
      -orthoHalfH,
      0.1,
      100,
    );
    orthoCam.position.set(3.4, 1.55, 18);
    orthoCam.lookAt(3.4, 1.55, 0);

    perspCam = new THREE.PerspectiveCamera(50, aspect, 0.1, 120);
    perspCam.position.set(0, 10.2, 8.2);
    perspCam.lookAt(0, 0, -4.2);

    hemiLight = new THREE.HemisphereLight('#e0f2fe', '#1e1b4b', 1.45);
    scene.add(hemiLight);
    dirLight = new THREE.DirectionalLight('#fef3c7', 2.25);
    dirLight.position.set(6, 14, 9);
    scene.add(dirLight);

    // Phase 1 flat 2D planes group
    phase1Group = new THREE.Group();
    scene.add(phase1Group);

    // Subtle synthwave/warm horizon glow band behind the ground line
    horizonGlowMat = new THREE.MeshBasicMaterial({
      color: '#f43f5e',
      transparent: true,
      opacity: 0.18,
    });
    horizonGlowMesh = new THREE.Mesh(new THREE.PlaneGeometry(42, 1.35), horizonGlowMat);
    horizonGlowMesh.position.set(4.0, 0.65, -0.8);
    phase1Group.add(horizonGlowMesh);

    // Low parallax desert mesas/dunes in the background
    duneMat = new THREE.MeshBasicMaterial({
      color: '#6366f1',
      transparent: true,
      opacity: 0.16,
    });
    duneMeshes = [];
    for (let i = 0; i < 6; i++) {
      const w = 3.2 + (i % 3) * 1.4;
      const h = 0.45 + (i % 2) * 0.28;
      const dm = new THREE.Mesh(new THREE.PlaneGeometry(w, h), duneMat);
      dm.position.set(-6 + i * 4.8, h * 0.5, -0.6);
      phase1Group.add(dm);
      duneMeshes.push(dm);
    }

    heroPlaneMat = new THREE.MeshBasicMaterial({
      map: spriteTextures.runA,
      transparent: true,
      alphaTest: 0.05,
    });
    heroPlane = new THREE.Mesh(new THREE.PlaneGeometry(HERO_2D_WIDTH, HERO_2D_HEIGHT), heroPlaneMat);
    heroPlane.position.set(0, HERO_2D_BASE_Y, 0.2);
    phase1Group.add(heroPlane);

    groundLineMat = new THREE.MeshBasicMaterial({ color: '#f43f5e' });
    groundLineMesh = new THREE.Mesh(new THREE.PlaneGeometry(42, 0.06), groundLineMat);
    groundLineMesh.position.set(4, 0, 0);
    phase1Group.add(groundLineMesh);

    pebbleMeshes = [];
    for (let i = 0; i < 32; i++) {
      const w = 0.06 + (i % 3) * 0.05;
      const pm = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.035), groundLineMat);
      pm.position.set(-8 + i * 1.05, -0.1 - (i % 3) * 0.06, 0);
      phase1Group.add(pm);
      pebbleMeshes.push(pm);
    }

    cloudMeshes = [];
    cloudMat = new THREE.MeshBasicMaterial({
      map: spriteTextures.cloud,
      transparent: true,
      opacity: 0.55,
    });
    for (let i = 0; i < 4; i++) {
      const cm = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 0.58), cloudMat);
      cm.position.set(-2 + i * 5.4, 3.2 + (i % 2) * 0.75, -0.5);
      phase1Group.add(cm);
      cloudMeshes.push(cm);
    }

    obsPoolMeshes = [];
    obsPoolMats = [];
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: spriteTextures.cactus_small,
        transparent: true,
        alphaTest: 0.05,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), mat);
      mesh.visible = false;
      phase1Group.add(mesh);
      obsPoolMeshes.push(mesh);
      obsPoolMats.push(mat);
    }

    // 2D Pixel Score Plane at top-right of Ortho view
    const scoreW = 92;
    const scoreH = 9;
    scoreTex = new THREE.DataTexture(new Uint8Array(scoreW * scoreH * 4), scoreW, scoreH, THREE.RGBAFormat);
    scoreTex.colorSpace = THREE.SRGBColorSpace;
    scoreTex.magFilter = THREE.LinearFilter;
    scoreTex.minFilter = THREE.LinearFilter;
    updatePixelScoreTexture(scoreTex, 'HI 00000 00000', '#f8fafc');
    const scoreMat = new THREE.MeshBasicMaterial({
      map: scoreTex,
      transparent: true,
    });
    scorePlaneMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 0.29), scoreMat);
    scorePlaneMesh.position.set(7.4, 3.15, 0.2);
    phase1Group.add(scorePlaneMesh);

    // Shared InstancedMesh with smooth-edged rounded box geometry for Transition & Phase 2
    const smoothBoxGeo = createSmoothRoundedBoxGeometry(1, 1, 1, 0.22, 3);
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.36,
      metalness: 0.16,
    });
    voxelMesh = new THREE.InstancedMesh(smoothBoxGeo, boxMat, MAX_VOXEL_INSTANCES);
    voxelMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_VOXEL_INSTANCES * 3),
      3,
    );
    voxelMesh.frustumCulled = false;
    voxelMesh.count = 0;
    scene.add(voxelMesh);

    // New Controls Transition Card
    newControlsCardEl = document.createElement('div');
    newControlsCardEl.dataset.testid = 'runner-new-controls-card';
    newControlsCardEl.className =
      'pointer-events-none absolute inset-x-0 bottom-16 z-20 hidden justify-center font-mono select-none';
    newControlsCardEl.innerHTML = `
      <div class="rounded-lg border-2 border-amber-400 bg-slate-950/92 px-6 py-3 text-center shadow-2xl">
        <div class="text-xs font-extrabold uppercase tracking-wider text-amber-400">
          NEW CONTROLS: W or Space hop forward, A and D sideways, S back.
        </div>
      </div>
    `;
    ctx.root.appendChild(newControlsCardEl);
  }

  function pushVoxel(
    idx: number,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    hexColor: string,
    rotX = 0,
    rotZ = 0,
  ): number {
    if (!voxelMesh || idx >= MAX_VOXEL_INSTANCES) return idx;
    _dummy.position.set(x, y, z);
    _dummy.rotation.set(rotX, 0, rotZ);
    _dummy.scale.set(sx, sy, sz);
    _dummy.updateMatrix();
    voxelMesh.setMatrixAt(idx, _dummy.matrix);
    _color.set(hexColor);
    voxelMesh.setColorAt(idx, _color);
    return idx + 1;
  }

  function renderPhase1Scene(songTime: number, frameDt: number, pal: Palette): void {
    if (!scene || !phase1Group || !heroPlane || !heroPlaneMat || !groundLineMat || !voxelMesh) {
      return;
    }

    phase1Group.visible = true;
    voxelMesh.count = 0;

    // Smooth section-boundary pulse instead of a harsh binary flash
    const targetNightMix = nightModeTimer > 0 ? Math.sin((nightModeTimer / 0.35) * Math.PI) : 0;
    nightModeMix = THREE.MathUtils.damp(nightModeMix, targetNightMix, 14, frameDt);

    // Apply BPM-anchored Modern Warm / Synthwave palette to 2D background, horizon, ground, and sprites
    const bgBase = lerpColorHex(pal.bg, pal.primary, 0.12);
    const bgHex = nightModeMix > 0.01 ? lerpColorHex(bgBase, pal.primary, nightModeMix * 0.45) : bgBase;
    const fgHex = nightModeMix > 0.01 ? lerpColorHex(pal.primary, pal.highlight, nightModeMix) : pal.primary;

    (scene.background as THREE.Color).set(bgHex);
    groundLineMat.color.set(fgHex);
    if (horizonGlowMat) {
      horizonGlowMat.color.set(pal.secondary);
      horizonGlowMat.opacity = 0.14 + ctx.bands.energy * 0.12;
    }
    if (duneMat) {
      duneMat.color.set(pal.primary);
    }

    syncSpriteColorsToPalette(pal, nightModeMix);

    // High-tempo running animation: 4 steps per beat (~11-13 steps/sec) through 4-pose gait cycle
    const bpm = Math.max(85, ctx.map.bpm || 120);
    const strideHz = Math.max(11.0, (bpm / 60) * 4.0);
    const gaitIndex = Math.floor(songTime * strideHz) % 4;

    if (simState.hitFlashTimer > 0) {
      heroPlaneMat.map = spriteTextures.hit;
    } else if (simState.isJumping) {
      heroPlaneMat.map = spriteTextures.jump;
    } else if (simState.isDucking) {
      heroPlaneMat.map = gaitIndex % 2 === 0 ? spriteTextures.duckA : spriteTextures.duckB;
    } else {
      if (gaitIndex === 0) heroPlaneMat.map = spriteTextures.runA;
      else if (gaitIndex === 2) heroPlaneMat.map = spriteTextures.runB;
      else heroPlaneMat.map = spriteTextures.runMid;
    }
    heroPlaneMat.needsUpdate = true;

    wasJumping2D = simState.isJumping;
    heroSquashX = 1.0;
    heroSquashY = 1.0;
    heroTiltZ = 0.0;

    // Direct 1:1 vertical tracking from Chromium offline.js Trex.updateJump
    dampedHeroY2D = simState.heroY;

    // Blink when invulnerable after taking a hit
    const isInvuln = songTime > simState.session.safeUntil && songTime < simState.invulnUntil;
    heroPlane.visible = !isInvuln || Math.floor(songTime * 16) % 2 === 0;
    heroPlane.scale.set(1, 1, 1);
    heroPlane.rotation.z = 0;
    heroPlane.position.set(0, HERO_2D_BASE_Y + dampedHeroY2D, 0.2);

    // Scroll pebbles, dunes, & clouds smoothly
    const scrollDist = songTime * params.scrollSpeed2D;
    for (let i = 0; i < pebbleMeshes.length; i++) {
      const pm = pebbleMeshes[i];
      const baseX = -8 + i * 1.15;
      const wrappedX = ((((baseX - scrollDist) % 34) + 34) % 34) - 8;
      pm.position.x = wrappedX;
    }
    for (let i = 0; i < duneMeshes.length; i++) {
      const dm = duneMeshes[i];
      const baseX = -6 + i * 5.2;
      const wrappedX = ((((baseX - scrollDist * 0.14) % 30) + 30) % 30) - 8;
      dm.position.x = wrappedX;
    }
    for (let i = 0; i < cloudMeshes.length; i++) {
      const cm = cloudMeshes[i];
      const baseX = -4 + i * 6.5;
      const wrappedX = ((((baseX - scrollDist * 0.2) % 26) + 26) % 26) - 6;
      cm.position.x = wrappedX;
    }

    // Update obstacle planes (compact vegetation & smooth-gliding birds)
    for (let i = 0; i < obsPoolMeshes.length; i++) {
      obsPoolMeshes[i].visible = false;
    }

    let poolIdx = 0;
    for (const obs of simState.session.phase1Obstacles) {
      if (obs.removed || poolIdx >= obsPoolMeshes.length) continue;
      if (songTime < simState.session.safeUntil - 0.1) continue;
      const x = (obs.t - songTime) * params.scrollSpeed2D;
      if (x < -5 || x > 18) continue;

      const mesh = obsPoolMeshes[poolIdx];
      const mat = obsPoolMats[poolIdx];
      poolIdx++;

      mat.map = getObstacleTexture(obs.kind, songTime);
      mat.needsUpdate = true;
      mesh.visible = true;

      const beatPulse = 1 + ctx.bands.low * 0.06;
      if (obs.kind === 'bird_high') {
        const waveY = Math.sin(songTime * 8.5 + obs.id) * 0.05;
        mesh.scale.set(0.76, 0.48, 1);
        mesh.position.set(x, 1.06 + waveY, 0.15);
      } else if (obs.kind === 'bird_low') {
        const waveY = Math.sin(songTime * 8.5 + obs.id) * 0.05;
        mesh.scale.set(0.76, 0.48, 1);
        mesh.position.set(x, 0.46 + waveY, 0.15);
      } else {
        // Compact vegetation: ~0.56 units tall (shorter than the 1.02-unit T-Rex)
        mesh.scale.set(0.48, 0.56 * beatPulse, 1);
        mesh.position.set(x, 0.28 * beatPulse, 0.15);
      }
    }

    // Update 2D pixel score digits in palette highlight swatch
    if (scoreTex) {
      const scoreInt = Math.max(0, Math.floor(songTime * 10 + simState.score));
      const scorePad = String(scoreInt).padStart(5, '0');
      updatePixelScoreTexture(scoreTex, `HI ${scorePad} ${scorePad}`, pal.highlight);
    }
  }

  function renderTransitionAndPhase2(songTime: number, frameDt: number, pal: Palette): void {
    if (!scene || !phase1Group || !voxelMesh || !perspCam) return;

    const rawTransProgress =
      simState.phase === 'transition'
        ? Math.max(
            0,
            Math.min(1, (songTime - simState.session.transitionTime) / TRANSITION_DURATION_SEC),
          )
        : 1.0;
    // Quintic C2 smoothstep for silky transition interpolation
    const transProgress =
      rawTransProgress *
      rawTransProgress *
      rawTransProgress *
      (rawTransProgress * (rawTransProgress * 6 - 15) + 10);
    const isTransition = simState.phase === 'transition';

    // Seamless BPM-progressed background & horizon fog
    const bg2D = lerpColorHex(pal.bg, pal.primary, 0.12);
    const bgHex = isTransition ? lerpColorHex(bg2D, pal.bg, transProgress) : pal.bg;
    (scene.background as THREE.Color).set(bgHex);
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.color.set(bgHex);
    }
    if (hemiLight) {
      hemiLight.color.set(pal.highlight);
      hemiLight.groundColor.set(pal.bg);
    }

    phase1Group.visible = false;

    // Show "NEW CONTROLS" card during transition and first 2.8s of Phase 2
    if (newControlsCardEl) {
      const showCard =
        songTime >= simState.session.transitionTime &&
        songTime <= simState.session.transitionEndTime + 2.8;
      newControlsCardEl.classList.toggle('hidden', !showCard);
      newControlsCardEl.classList.toggle('flex', showCard);
    }

    let instIdx = 0;
    const phase = beatPhase(ctx.map, songTime);
    const beatBob = Math.sin(phase * Math.PI) * 0.12;

    // Smoothly damp camera row follow
    if (isTransition) {
      dampedCamRow = 0;
    } else {
      dampedCamRow = THREE.MathUtils.damp(dampedCamRow, simState.cameraRow, 18, frameDt);
    }

    // 1. Render Lane Grid Rows around dampedCamRow and ahead of the dinosaur
    const startRow = Math.max(0, Math.floor(dampedCamRow - 3));
    const endRow = Math.min(
      simState.session.rows.length - 1,
      Math.ceil(Math.max(dampedCamRow, simState.visualRow) + 14),
    );

    for (let r = startRow; r <= endRow; r++) {
      const rowData = simState.session.rows[r];
      if (!rowData) continue;
      const rowZ = -r * TILE_SIZE;

      // Determine if deep_scorch cracks are flaring on the 2 beats prior to a big comet
      let crackFlare = 0;
      if (rowData.type === 'deep_scorch') {
        for (const c of rowData.comets) {
          const dt0 = Math.abs(songTime - c.preFlareBeats[0]);
          const dt1 = Math.abs(songTime - c.preFlareBeats[1]);
          const dtHit = Math.abs(songTime - c.onsetTime);
          if (dt0 < 0.18 || dt1 < 0.18 || dtHit < 0.22) {
            crackFlare = Math.max(crackFlare, 1.0);
          }
        }
      }

      for (let col = 0; col < GRID_COLS; col++) {
        // Stagger left-to-right pop-out during transition with smooth easing
        const colNorm = col / (GRID_COLS - 1);
        const rawPop = isTransition
          ? Math.max(0.01, Math.min(1, (rawTransProgress - colNorm * 0.42) / 0.58))
          : 1.0;
        const popScale = rawPop * rawPop * (3 - 2 * rawPop);

        const tileX = (col - CENTER_COL) * TILE_SIZE;

        // Check if a passing comet head is lighting this ground tile
        let cometGlow = 0;
        if (rowData.type !== 'grass') {
          for (const c of rowData.comets) {
            const hc = cometHeadColAt(c, songTime);
            const dist = Math.abs(hc - col);
            if (dist < 1.6) {
              cometGlow = Math.max(cometGlow, 1 - dist / 1.6);
            }
          }
        }

        let tileColor = pal.primary;
        if (rowData.type === 'grass') {
          tileColor =
            (r + col) % 2 === 0
              ? lerpColorHex(pal.primary, pal.bg, 0.18)
              : lerpColorHex(pal.primary, pal.bg, 0.36);
        } else if (rowData.type === 'scorched_earth') {
          // Warm/synthwave charred ground tinted by section palette
          const baseChar = lerpColorHex('#1e1420', pal.bg, 0.35);
          tileColor = (r + col) % 2 === 0 ? baseChar : lerpColorHex(baseChar, '#120b14', 0.35);
          if (cometGlow > 0.05) {
            tileColor = lerpColorHex(tileColor, pal.accent, cometGlow * 0.75);
          }
        } else {
          // Deep scorch: obsidian ground with glowing cracks
          tileColor = '#09060c';
          if (crackFlare > 0 || cometGlow > 0.05) {
            const flareAmt = Math.max(crackFlare * 0.65, cometGlow * 0.85);
            tileColor = lerpColorHex(tileColor, pal.highlight, flareAmt);
          }
        }

        instIdx = pushVoxel(
          instIdx,
          tileX,
          -0.18 * popScale,
          rowZ,
          TILE_SIZE * 0.96 * popScale,
          0.32 * popScale,
          TILE_SIZE * 0.96 * popScale,
          tileColor,
        );

        // Smoldering specks on scorched_earth or glowing crack lines on deep_scorch
        if (rowData.type === 'scorched_earth' && (col * 3 + r) % 3 === 0) {
          instIdx = pushVoxel(
            instIdx,
            tileX + 0.18,
            0.03,
            rowZ - 0.12,
            0.18 * popScale,
            0.08 * popScale,
            0.18 * popScale,
            pal.accent,
          );
        } else if (rowData.type === 'deep_scorch') {
          const crackCol = crackFlare > 0 ? pal.highlight : pal.accent;
          instIdx = pushVoxel(
            instIdx,
            tileX,
            0.03,
            rowZ,
            TILE_SIZE * 0.75 * popScale,
            (crackFlare > 0 ? 0.14 : 0.06) * popScale,
            0.14 * popScale,
            crackCol,
          );
        }
      }

      // Grass row blockers: compact, smooth-edged voxel ferns & boulders
      if (rowData.type === 'grass') {
        for (const b of rowData.blockers) {
          const bx = (b.col - CENTER_COL) * TILE_SIZE;
          const colNorm = b.col / (GRID_COLS - 1);
          const rawPop = isTransition
            ? Math.max(0.01, Math.min(1, (rawTransProgress - colNorm * 0.42) / 0.58))
            : 1.0;
          const popScale = rawPop * rawPop * (3 - 2 * rawPop);

          if (b.kind === 'fern') {
            const fernH = (0.46 + beatBob * 0.7) * popScale;
            instIdx = pushVoxel(
              instIdx,
              bx,
              fernH * 0.5,
              rowZ,
              0.48 * popScale,
              fernH,
              0.48 * popScale,
              pal.secondary,
            );
            instIdx = pushVoxel(
              instIdx,
              bx,
              fernH + 0.12 * popScale,
              rowZ,
              0.68 * popScale,
              0.2 * popScale,
              0.68 * popScale,
              pal.accent,
            );
          } else {
            // Smooth rounded voxel boulder tinted with palette
            const rockBase = lerpColorHex('#475569', pal.primary, 0.35);
            const rockTop = lerpColorHex('#94a3b8', pal.highlight, 0.35);
            instIdx = pushVoxel(
              instIdx,
              bx,
              0.32 * popScale,
              rowZ,
              0.74 * popScale,
              0.62 * popScale,
              0.74 * popScale,
              rockBase,
            );
            instIdx = pushVoxel(
              instIdx,
              bx + 0.08,
              0.68 * popScale,
              rowZ - 0.06,
              0.46 * popScale,
              0.24 * popScale,
              0.46 * popScale,
              rockTop,
            );
          }
        }
      }

      // Comets on scorched_earth and deep_scorch rows
      if (!isTransition && rowData.type !== 'grass') {
        const highFlare = 1.0 + ctx.bands.high * 0.4;
        for (const c of rowData.comets) {
          const headCol = cometHeadColAt(c, songTime);
          if (headCol < -1.1 || headCol > GRID_COLS + 0.6) continue;

          const hx = (headCol - CENTER_COL) * TILE_SIZE;
          const headSize = (c.isBig ? 0.98 : 0.76) * TILE_SIZE * 0.7 * highFlare;

          instIdx = pushVoxel(
            instIdx,
            hx,
            0.54,
            rowZ,
            headSize,
            headSize,
            headSize,
            c.isBig ? pal.highlight : pal.accent,
          );
          instIdx = pushVoxel(
            instIdx,
            hx,
            0.54,
            rowZ,
            headSize * 0.65,
            headSize * 1.18,
            headSize * 0.65,
            '#ffffff',
          );

          // Harmless cosmetic fiery ember trail (~1.5 tiles long behind the head)
          const trailSegments = 5;
          for (let s = 1; s <= trailSegments; s++) {
            const frac = s / trailSegments;
            const trailCol = headCol - c.dir * c.trailLength * frac;
            const tx = (trailCol - CENTER_COL) * TILE_SIZE;
            const emberSize = Math.max(0.12, (1 - frac * 0.75) * 0.44);
            const emberColor = s <= 2 ? pal.highlight : pal.accent;
            instIdx = pushVoxel(
              instIdx,
              tx,
              0.4 + Math.sin(songTime * 18 + s) * 0.07,
              rowZ + ((s % 2) - 0.5) * 0.16,
              emberSize,
              emberSize,
              emberSize,
              emberColor,
            );
          }
        }
      }
    }

    // During transition, extrude a compact cactus into smooth 3D voxels to the right
    if (isTransition) {
      for (const cell of cactusSmallVoxels) {
        const colNorm = cell.colIndex / 11;
        const pop = Math.max(0.05, Math.min(1, (transProgress - colNorm * 0.4) / 0.6));
        const vScale = 0.056;
        instIdx = pushVoxel(
          instIdx,
          3.1 + cell.gx * vScale,
          0.08 + cell.gy * vScale,
          -1.4,
          vScale * 1.04,
          vScale * 1.04,
          vScale * (0.8 + pop * 3.0) * (cell.isEdge ? 0.78 : 1.0),
          pal.secondary,
        );
      }
    }

    // 2. Render Smooth-Edged Voxel T-Rex Hero with Exponential Damping
    const targetHeroX = (simState.visualCol - CENTER_COL) * TILE_SIZE;
    const targetHeroZ = -simState.visualRow * TILE_SIZE;
    const bpm = Math.max(85, ctx.map.bpm || 120);
    const strideHz = Math.max(11.0, (bpm / 60) * 4.0);
    const idleBob = !simState.hopping ? Math.abs(Math.sin(songTime * strideHz * Math.PI * 0.5)) * 0.04 : 0;
    const targetHeroY = 0.05 + simState.hopArcY + idleBob;

    dampedHeroX3D = THREE.MathUtils.damp(dampedHeroX3D, targetHeroX, 26, frameDt);
    dampedHeroZ3D = THREE.MathUtils.damp(dampedHeroZ3D, targetHeroZ, 26, frameDt);
    dampedHeroY3D = THREE.MathUtils.damp(dampedHeroY3D, targetHeroY, 30, frameDt);

    const hopVelZ = targetHeroZ - dampedHeroZ3D;
    const hopVelX = targetHeroX - dampedHeroX3D;
    dampedHeroPitch3D = THREE.MathUtils.damp(dampedHeroPitch3D, hopVelZ * 0.35, 20, frameDt);
    dampedHeroRoll3D = THREE.MathUtils.damp(dampedHeroRoll3D, -hopVelX * 0.35, 20, frameDt);

    const gaitIdx = Math.floor(songTime * strideHz) % 4;
    const activeHeroCells =
      gaitIdx === 0 ? heroVoxelsRunA : gaitIdx === 2 ? heroVoxelsRunB : heroVoxelsRunMid;
    const voxelUnit = 0.046;
    const isInvuln = songTime > simState.session.safeUntil && songTime < simState.invulnUntil;
    const blinkHide = isInvuln && Math.floor(songTime * 18) % 2 === 1;

    if (!blinkHide) {
      for (let i = 0; i < activeHeroCells.length; i++) {
        const cell = activeHeroCells[i];
        const colNorm = cell.colIndex / 22;
        const rawPop = isTransition
          ? Math.max(0.05, Math.min(1, (rawTransProgress - colNorm * 0.42) / 0.58))
          : 1.0;
        const pop = rawPop * rawPop * (3 - 2 * rawPop);

        let vx = dampedHeroX3D + cell.gx * voxelUnit - dampedHeroRoll3D * (cell.gy * voxelUnit);
        let vy = dampedHeroY3D + cell.gy * voxelUnit;
        let vz = dampedHeroZ3D + dampedHeroPitch3D * (cell.gy * voxelUnit);

        // If dying, burst hero voxels outward and downward over 0.85s
        if (simState.dying) {
          const bt = simState.deathTimer;
          const dirX = cell.gx * 0.28 + ((i % 5) - 2) * 0.4;
          const dirZ = ((i % 7) - 3) * 0.45;
          const velY = 2.8 + (cell.gy / 24) * 2.5;
          vx += dirX * bt * 2.4;
          vy = Math.max(0.04, vy + velY * bt - 0.5 * 13.5 * bt * bt);
          vz += dirZ * bt * 2.4;
        }

        let cellHex =
          cell.role === 'accent'
            ? pal.accent
            : cell.role === 'highlight'
              ? pal.secondary
              : pal.highlight;

        if (simState.hitFlashTimer > 0) {
          cellHex = '#ef4444';
        } else if (simState.emberFlickerTimer > 0 && (i + Math.floor(songTime * 25)) % 3 === 0) {
          cellHex = pal.accent;
        }

        // Taper outer perimeter voxels slightly in Z so the 3D T-Rex has smooth sculpted contours
        const edgeDepthMult = cell.isEdge ? 0.76 : 1.0;
        instIdx = pushVoxel(
          instIdx,
          vx,
          vy,
          vz,
          voxelUnit * 1.12,
          voxelUnit * 1.12,
          voxelUnit * (0.45 + pop * 4.6) * edgeDepthMult,
          cellHex,
          dampedHeroPitch3D * 0.5,
          dampedHeroRoll3D * 0.5,
        );
      }
    }

    voxelMesh.count = instIdx;
    voxelMesh.instanceMatrix.needsUpdate = true;
    if (voxelMesh.instanceColor) {
      voxelMesh.instanceColor.needsUpdate = true;
    }

    // 3. Smooth Camera Tween (Transition) & Damped Follow (Phase 2)
    const camZOffset = -dampedCamRow * TILE_SIZE;
    if (isTransition) {
      perspCam.position.set(
        THREE.MathUtils.lerp(2.6, 0, transProgress),
        THREE.MathUtils.lerp(2.0, 10.2, transProgress),
        THREE.MathUtils.lerp(13.2, 8.2, transProgress),
      );
      perspCam.lookAt(
        THREE.MathUtils.lerp(2.6, 0, transProgress),
        THREE.MathUtils.lerp(1.6, 0, transProgress),
        THREE.MathUtils.lerp(0, -4.2, transProgress),
      );
    } else {
      perspCam.position.set(dampedHeroX3D * 0.25, 10.2, camZOffset + 8.2);
      perspCam.lookAt(dampedHeroX3D * 0.15, 0, camZOffset - 4.2);
    }
  }

  return {
    id: 'runner',
    title: 'RUNNER',
    listensTo: 'the beat',
    controls: [
      { keys: ['Space', 'KeyW', 'ArrowUp'], label: 'Space or W: Jump' },
      { keys: ['KeyS', 'ArrowDown'], label: 'S or Down: Duck' },
    ],

    async preload(gameCtx: GameContext): Promise<void> {
      ctx = gameCtx;
      const lvl = ctx.level as RunnerLevel | null;
      if (!lvl || !lvl.defaultSession) {
        ctx.level = generateLevel(ctx.map, defaultParams, ctx.rng);
      }
      setupScene();
    },

    enter(songTime: number): void {
      active = true;
      jumpPressed = false;
      jumpReleased = false;
      jumpHeld = false;
      duckHeld = false;
      pendingHopDir = null;
      nightModeTimer = 0;
      nightModeMix = 0;
      lastPaletteSignature = '';
      lastSectionIdx = sectionIndexAt(ctx.map, songTime);
      lastUpdateWallMs = performance.now();
      lastRenderSongTime = songTime;

      wasJumping2D = false;
      heroSquashX = 1.0;
      heroSquashY = 1.0;
      heroTiltZ = 0.0;
      dampedHeroY2D = 0.0;
      dampedHeroX3D = 0.0;
      dampedHeroZ3D = 0.0;
      dampedHeroY3D = 0.05;
      dampedHeroPitch3D = 0.0;
      dampedHeroRoll3D = 0.0;
      dampedCamRow = 0.0;

      const baseLevel = (ctx.level as RunnerLevel) || generateLevel(ctx.map, defaultParams, ctx.rng);
      params = { ...defaultParams, ...(baseLevel.params || {}) };

      // The game restarts in 2D phase every time it is entered
      const normalizedEntry = songTime < 0.2 ? 0 : songTime;
      const session = resolveRunnerSession(
        ctx.map,
        params,
        baseLevel.seed,
        normalizedEntry,
        ctx.safeUntil,
        baseLevel.p95LowStrength,
      );
      simState = createRunnerSimState(ctx.map, params, session, ctx.map.duration);

      // Update HUD to show Runner's 2 lives
      ctx.emit({ type: 'lifeLost', livesLeft: 2 });

      if (newControlsCardEl) {
        newControlsCardEl.classList.add('hidden');
      }

      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
    },

    update(dt: number, songTime: number): void {
      if (!active || !simState) return;

      const nowWall = performance.now();
      const wallDt = Math.max(0.001, (nowWall - lastUpdateWallMs) / 1000);
      lastUpdateWallMs = nowWall;
      fpsEstimate = fpsEstimate * 0.92 + (1 / wallDt) * 0.08;

      // Detect section boundary for smooth Phase 1 color pulse
      const curSecIdx = sectionIndexAt(ctx.map, songTime);
      if (curSecIdx !== lastSectionIdx) {
        lastSectionIdx = curSecIdx;
        nightModeTimer = 0.35;
      }
      if (nightModeTimer > 0) {
        nightModeTimer = Math.max(0, nightModeTimer - dt);
      }

      simState.session.safeUntil = ctx.safeUntil;

      const clampedDt = Math.max(0.001, Math.min(0.06, dt));
      const fixedStep = 1 / 120;
      const numSteps = Math.max(1, Math.ceil(clampedDt / fixedStep));
      const subDt = clampedDt / numSteps;
      const startStepTime = songTime - clampedDt + subDt;

      for (let s = 0; s < numSteps; s++) {
        const stepTime = s === numSteps - 1 ? songTime : startStepTime + s * subDt;
        const input: RunnerSimInput = {};

        if (ctx.bot) {
          if (stepTime < simState.session.transitionTime) {
            const act = decidePhase1BotAction(
              simState.session,
              params,
              stepTime,
              simState.isJumping,
            );
            if (act === 'jump') input.jump = true;
            else if (act === 'duck') input.duck = true;
          } else if (stepTime >= simState.session.transitionEndTime && !simState.hopping) {
            const hop = decidePhase2BotHop(
              ctx.map,
              simState.session,
              simState.gridRow,
              simState.gridCol,
              stepTime,
              simState.cameraRow,
            );
            if (hop !== 'wait') {
              input.hopDir = hop;
            }
          }
        } else if (s === 0) {
          if (jumpPressed || (jumpHeld && !simState.isJumping)) {
            input.jump = true;
            jumpPressed = false;
            jumpReleased = false;
          }
          if (jumpReleased) {
            input.jumpReleased = true;
            jumpReleased = false;
          }
          input.duck = duckHeld;
          if (pendingHopDir) {
            input.hopDir = pendingHopDir;
            pendingHopDir = null;
          }
        } else {
          input.duck = duckHeld;
        }

        stepRunnerSim(simState, subDt, stepTime, input, (ev) => ctx.emit(ev));
      }
    },

    render(): void {
      if (!renderer || !scene || !orthoCam || !perspCam || !simState) return;

      const W = window.innerWidth;
      const H = Math.max(1, window.innerHeight);
      const pr = renderer.getPixelRatio();
      const targetW = Math.floor(W * pr);
      const targetH = Math.floor(H * pr);
      if (renderer.domElement.width !== targetW || renderer.domElement.height !== targetH) {
        const aspect = W / H;
        const orthoHalfH = 4.2;
        orthoCam.left = -orthoHalfH * aspect;
        orthoCam.right = orthoHalfH * aspect;
        orthoCam.top = orthoHalfH;
        orthoCam.bottom = -orthoHalfH;
        orthoCam.updateProjectionMatrix();

        perspCam.aspect = aspect;
        perspCam.updateProjectionMatrix();
        renderer.setSize(W, H);
      }

      const songTime = ctx.clock.now();
      const frameDt = Math.max(0.001, Math.min(0.05, Math.abs(songTime - lastRenderSongTime) || 1 / 60));
      lastRenderSongTime = songTime;
      const pal = ctx.palette.at(songTime);

      if (simState.phase === 'phase1') {
        renderPhase1Scene(songTime, frameDt, pal);
        renderer.render(scene, orthoCam);
      } else {
        renderTransitionAndPhase2(songTime, frameDt, pal);
        renderer.render(scene, perspCam);
      }
    },

    exit(): void {
      active = false;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (newControlsCardEl) {
        newControlsCardEl.classList.add('hidden');
      }
      ctx.fx.reset();
    },

    getMetrics(): Record<string, number> {
      if (!simState) {
        return {
          clearRate: 1,
          livesLost: 0,
          alignMsMean: 0,
          alignMsMax: 0,
          gapViolations: 0,
          runwayHazards: 0,
          transitionAfterEntry: 12.5,
          transitionOnPhrase: 1,
          unsafeRows: 0,
          trailDamage: 0,
          onBeatHopPct: 100,
          avgFps: Math.round(fpsEstimate),
        };
      }
      const m = buildRunnerMetrics(simState, fpsEstimate);
      return { ...m };
    },
  };
}
