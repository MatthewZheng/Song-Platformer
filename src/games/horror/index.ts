import * as THREE from 'three';
import type { GameContext, GameModule } from '../../shell/api';
import { beatAt, beatPhase, scoreOnBeat } from '../../shared/songmap';
import { shouldBotPulseHorror } from './bot';
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

export function createHorrorGame(): GameModule {
  let ctx!: GameContext;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let monsterGroup: THREE.Group | null = null;
  let coreMat: THREE.MeshStandardMaterial | null = null;
  let eyeMat: THREE.MeshStandardMaterial | null = null;

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
    id: 'horror',
    title: 'HORROR',
    listensTo: 'the structure (hunts start on section changes; the music IS the monster)',
    controls: [
      { keys: ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown'], label: 'Move / Hide' },
      { keys: ['Space', 'ShiftLeft'], label: 'Hold Breath on Beat' },
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
          preserveDrawingBuffer: true,
        });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
        renderer.setSize(window.innerWidth, window.innerHeight);
        ctx.root.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        scene.background = new THREE.Color('#09050a');

        camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
        camera.position.set(0, 2.0, 5.2);
        camera.lookAt(0, 1.1, 0);

        scene.add(new THREE.HemisphereLight('#f43f5e', '#0f172a', 1.3));
        const dir = new THREE.DirectionalLight('#fecdd3', 2.0);
        dir.position.set(-4, 7, 5);
        scene.add(dir);

        monsterGroup = new THREE.Group();
        coreMat = new THREE.MeshStandardMaterial({
          color: 0xef4444,
          emissive: 0x991b1b,
          emissiveIntensity: 0.45,
          roughness: 0.25,
          metalness: 0.6,
        });
        const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.15, 1), coreMat);
        core.position.y = 1.2;
        monsterGroup.add(core);

        eyeMat = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xfacc15,
          emissiveIntensity: 0.8,
          roughness: 0.1,
        });
        const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), eyeMat);
        eyeL.position.set(-0.35, 1.35, 0.95);
        const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 12), eyeMat);
        eyeR.position.set(0.35, 1.35, 0.95);
        monsterGroup.add(eyeL, eyeR);

        scene.add(monsterGroup);

        const grid = new THREE.GridHelper(24, 24, 0xef4444, 0x1e1b4b);
        grid.position.y = -0.02;
        scene.add(grid);

        const bannerEl = document.createElement('div');
        bannerEl.className =
          'pointer-events-none absolute inset-x-0 bottom-14 flex flex-col items-center font-mono text-center select-none';
        bannerEl.innerHTML = `
          <div class="rounded border border-rose-500/40 bg-slate-950/85 px-4 py-2 text-xs text-slate-200">
            <span class="font-bold text-rose-400">HORROR STUB</span> · Press <kbd class="rounded bg-slate-800 px-1.5 py-0.5 font-bold">SPACE</kbd> on beats (3 misses = death)
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
      if (coreMat) {
        coreMat.color.set(pal.primary);
        coreMat.emissive.set(dying ? '#ef4444' : pal.secondary);
      }
      if (eyeMat) {
        eyeMat.emissive.set(pal.highlight);
      }

      if (dying) {
        deathTimer += dt;
        if (monsterGroup) {
          monsterGroup.rotation.x += dt * 12;
          monsterGroup.rotation.y += dt * 15;
          const s = Math.max(0.05, 1 - deathTimer * 1.6);
          monsterGroup.scale.set(s, s, s);
        }
        if (deathTimer >= 0.55 && !deathEmitted) {
          deathEmitted = true;
          ctx.emit({ type: 'death' });
        }
        return;
      }

      if (ctx.bot && songTime >= ctx.safeUntil) {
        const b = shouldBotPulseHorror(ctx.map, songTime, lastBotBeatTime);
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
      const pulse = 1.0 + Math.sin(phase * Math.PI) * 0.28 + ctx.bands.energy * 0.35;
      if (monsterGroup) {
        monsterGroup.rotation.set(Math.sin(songTime * 2) * 0.15, songTime * 0.9, 0);
        monsterGroup.scale.set(pulse, pulse, pulse);
      }
    },

    render(): void {
      if (!renderer || !scene || !camera) return;
      if (renderer.domElement.width !== window.innerWidth || renderer.domElement.height !== window.innerHeight) {
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
