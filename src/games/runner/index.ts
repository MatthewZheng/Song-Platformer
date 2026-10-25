import * as THREE from 'three';
import type { GameContext, GameModule } from '../../shell/api';
import { beatAt, beatPhase, scoreOnBeat } from '../../shared/songmap';
import { shouldBotPulse } from './bot';
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

export function createRunnerGame(): GameModule {
  let ctx!: GameContext;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let heroGroup: THREE.Group | null = null;
  let coreMat: THREE.MeshStandardMaterial | null = null;
  let ringMat: THREE.MeshStandardMaterial | null = null;
  let bannerEl: HTMLElement | null = null;

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
    id: 'runner',
    title: 'RUNNER',
    listensTo: 'the beat (obstacles and traffic land on onsets)',
    controls: [
      { keys: ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'], label: 'Switch Lanes' },
      { keys: ['Space', 'ArrowUp', 'KeyW'], label: 'Jump on Beat' },
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
        scene.background = new THREE.Color('#090a10');

        camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
        camera.position.set(0, 2.4, 5.5);
        camera.lookAt(0, 0.8, 0);

        scene.add(new THREE.HemisphereLight('#7dd3fc', '#1e1b4b', 1.4));
        const dir = new THREE.DirectionalLight('#fde68a', 2.2);
        dir.position.set(4, 8, 5);
        scene.add(dir);

        heroGroup = new THREE.Group();
        coreMat = new THREE.MeshStandardMaterial({
          color: 0xf59e0b,
          emissive: 0xf59e0b,
          emissiveIntensity: 0.35,
          roughness: 0.3,
          metalness: 0.5,
        });
        const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.4, 1.2), coreMat);
        body.position.y = 1.0;
        heroGroup.add(body);

        ringMat = new THREE.MeshStandardMaterial({
          color: 0x38bdf8,
          emissive: 0x38bdf8,
          emissiveIntensity: 0.4,
          roughness: 0.2,
          metalness: 0.7,
        });
        const headphones = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.12, 12, 32), ringMat);
        headphones.position.y = 1.35;
        heroGroup.add(headphones);

        scene.add(heroGroup);

        const grid = new THREE.GridHelper(24, 24, 0xf59e0b, 0x1e293b);
        grid.position.y = -0.02;
        scene.add(grid);

        bannerEl = document.createElement('div');
        bannerEl.className =
          'pointer-events-none absolute inset-x-0 bottom-14 flex flex-col items-center font-mono text-center select-none';
        bannerEl.innerHTML = `
          <div class="rounded border border-amber-500/40 bg-slate-950/85 px-4 py-2 text-xs text-slate-200">
            <span class="font-bold text-amber-400">RUNNER STUB</span> · Press <kbd class="rounded bg-slate-800 px-1.5 py-0.5 font-bold">SPACE</kbd> on beats (3 misses = death)
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
        coreMat.emissive.set(dying ? '#ef4444' : pal.accent);
      }
      if (ringMat) {
        ringMat.color.set(pal.highlight);
        ringMat.emissive.set(pal.secondary);
      }

      if (dying) {
        deathTimer += dt;
        if (heroGroup) {
          heroGroup.rotation.y += dt * 14;
          heroGroup.rotation.z += dt * 9;
          const s = Math.max(0.05, 1 - deathTimer * 1.6);
          heroGroup.scale.set(s, s, s);
        }
        if (deathTimer >= 0.55 && !deathEmitted) {
          deathEmitted = true;
          ctx.emit({ type: 'death' });
        }
        return;
      }

      // Bot auto-pulse on beat
      if (ctx.bot && songTime >= ctx.safeUntil) {
        const b = shouldBotPulse(ctx.map, songTime, lastBotBeatTime);
        if (b.pulse) {
          lastBotBeatTime = b.beatTime;
          triggerBeatAction(songTime);
        }
      }

      // Beat miss check after safeUntil
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
      const pulse = 1.0 + Math.sin(phase * Math.PI) * 0.25 + ctx.bands.low * 0.35;
      if (heroGroup) {
        heroGroup.rotation.set(0, songTime * 1.2, 0);
        heroGroup.scale.set(pulse, pulse, pulse);
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
