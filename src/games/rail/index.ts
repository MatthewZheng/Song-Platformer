import * as THREE from 'three';
import type { GameContext, GameModule } from '../../shell/api';
import { beatAt, beatPhase, scoreOnBeat } from '../../shared/songmap';
import { shouldBotPulseRail } from './bot';
import { defaultParams, generateLevel } from './level';

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

export function createRailGame(): GameModule {
  let ctx!: GameContext;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let shipGroup: THREE.Group | null = null;
  let hullMat: THREE.MeshStandardMaterial | null = null;
  let wingMat: THREE.MeshStandardMaterial | null = null;

  let active = false;
  let misses = 0;
  let lastCheckedBeatIdx = -1;
  let hitCurrentBeat = false;
  let lastBotBeatTime = -999;
  let dying = false;
  let deathTimer = 0;
  let deathEmitted = false;
  let scoreTotal = 0;
  let hitsCount = 0;

  function onKeyDown(e: KeyboardEvent): void {
    if (!active || dying) return;
    if (e.code === 'Space') {
      e.preventDefault();
      triggerBeatAction(ctx.clock.now());
    }
  }

  function triggerBeatAction(songTime: number): void {
    const res = scoreOnBeat(ctx.map, songTime);
    if (res.onBeat) {
      hitCurrentBeat = true;
      hitsCount++;
      scoreTotal += res.points;
      ctx.emit({ type: 'score', points: res.points, onBeat: true, label: res.label });
    } else if (songTime >= ctx.safeUntil) {
      ctx.emit({ type: 'score', points: 0, onBeat: false, label: 'MISS' });
      registerMiss();
    }
  }

  function registerMiss(): void {
    if (dying) return;
    misses++;
    const livesLeft = Math.max(0, 3 - misses);
    ctx.emit({ type: 'lifeLost', livesLeft });
    if (misses >= 3) {
      dying = true;
      deathTimer = 0;
      deathEmitted = false;
    }
  }

  return {
    id: 'rail',
    title: 'RAIL',
    listensTo: 'the energy (enemy density, bullet patterns and city districts follow intensity and sections)',
    controls: [
      { keys: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft'], label: 'Dodge / Aim' },
      { keys: ['Space'], label: 'Fire on Beat' },
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
        renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
        renderer.setSize(window.innerWidth, window.innerHeight);
        ctx.root.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        scene.background = new THREE.Color('#0c0716');

        camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
        camera.position.set(0, 2.2, 5.4);
        camera.lookAt(0, 1.0, 0);

        scene.add(new THREE.HemisphereLight('#c084fc', '#1e1b4b', 1.4));
        const dir = new THREE.DirectionalLight('#f5d0fe', 2.2);
        dir.position.set(4, 8, 5);
        scene.add(dir);

        shipGroup = new THREE.Group();
        hullMat = new THREE.MeshStandardMaterial({
          color: 0xa855f7,
          emissive: 0x7e22ce,
          emissiveIntensity: 0.4,
          roughness: 0.25,
          metalness: 0.65,
        });
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.2, 6), hullMat);
        cone.rotation.x = -Math.PI * 0.5;
        cone.position.y = 1.1;
        shipGroup.add(cone);

        wingMat = new THREE.MeshStandardMaterial({
          color: 0x38bdf8,
          emissive: 0x38bdf8,
          emissiveIntensity: 0.35,
          roughness: 0.3,
          metalness: 0.5,
        });
        const wings = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.14, 0.8), wingMat);
        wings.position.y = 1.05;
        shipGroup.add(wings);

        scene.add(shipGroup);

        const grid = new THREE.GridHelper(24, 24, 0xa855f7, 0x1e1b4b);
        grid.position.y = -0.02;
        scene.add(grid);

        const bannerEl = document.createElement('div');
        bannerEl.className =
          'pointer-events-none absolute inset-x-0 bottom-14 flex flex-col items-center font-mono text-center select-none';
        bannerEl.innerHTML = `
          <div class="rounded border border-purple-500/40 bg-slate-950/85 px-4 py-2 text-xs text-slate-200">
            <span class="font-bold text-purple-400">RAIL STUB</span> · Press <kbd class="rounded bg-slate-800 px-1.5 py-0.5 font-bold">SPACE</kbd> on beats (3 misses = death)
          </div>
        `;
        ctx.root.appendChild(bannerEl);
      }
    },

    enter(songTime: number): void {
      active = true;
      misses = 0;
      dying = false;
      deathTimer = 0;
      deathEmitted = false;
      hitCurrentBeat = true;
      lastBotBeatTime = -999;
      lastCheckedBeatIdx = beatAt(ctx.map, songTime);
      window.addEventListener('keydown', onKeyDown);
    },

    update(dt: number, songTime: number): void {
      if (!active) return;

      const pal = ctx.palette.at(songTime);
      if (scene && scene.background instanceof THREE.Color) {
        scene.background.set(pal.bg);
      }
      if (hullMat) {
        hullMat.color.set(pal.primary);
        hullMat.emissive.set(dying ? '#ef4444' : pal.secondary);
      }
      if (wingMat) {
        wingMat.color.set(pal.highlight);
        wingMat.emissive.set(pal.accent);
      }

      if (dying) {
        deathTimer += dt;
        if (shipGroup) {
          shipGroup.rotation.z += dt * 16;
          shipGroup.rotation.x += dt * 10;
          const s = Math.max(0.05, 1 - deathTimer * 1.6);
          shipGroup.scale.set(s, s, s);
        }
        if (deathTimer >= 0.55 && !deathEmitted) {
          deathEmitted = true;
          ctx.emit({ type: 'death' });
        }
        return;
      }

      if (ctx.bot && songTime >= ctx.safeUntil) {
        const b = shouldBotPulseRail(ctx.map, songTime, lastBotBeatTime);
        if (b.pulse) {
          lastBotBeatTime = b.beatTime;
          triggerBeatAction(songTime);
        }
      }

      const curBeatIdx = beatAt(ctx.map, songTime);
      if (curBeatIdx > lastCheckedBeatIdx) {
        const prevBeatTime = ctx.map.beats[lastCheckedBeatIdx] ?? 0;
        if (
          songTime >= ctx.safeUntil &&
          prevBeatTime >= ctx.safeUntil &&
          !hitCurrentBeat &&
          songTime - prevBeatTime > 0.12
        ) {
          registerMiss();
        }
        lastCheckedBeatIdx = curBeatIdx;
        hitCurrentBeat = false;
      }

      const phase = beatPhase(ctx.map, songTime);
      const pulse = 1.0 + Math.sin(phase * Math.PI) * 0.28 + ctx.bands.high * 0.35;
      if (shipGroup) {
        shipGroup.rotation.set(0, Math.sin(songTime * 1.4) * 0.25, Math.cos(songTime * 2) * 0.2);
        shipGroup.scale.set(pulse, pulse, pulse);
      }
    },

    render(): void {
      if (!renderer || !scene || !camera) return;
      const pr = renderer.getPixelRatio();
      if (
        renderer.domElement.width !== Math.floor(window.innerWidth * pr) ||
        renderer.domElement.height !== Math.floor(window.innerHeight * pr)
      ) {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      }
      renderer.render(scene, camera);
    },

    exit(): void {
      active = false;
      window.removeEventListener('keydown', onKeyDown);
      ctx.fx.reset();
    },

    getMetrics(): Record<string, number> {
      return {
        score: scoreTotal,
        hits: hitsCount,
        misses,
      };
    },
  };
}
