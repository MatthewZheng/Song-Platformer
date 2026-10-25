import './index.css';
import * as THREE from 'three';
import { ORDER, READJUST, RUNWAY } from './shell/config';
import type { GameEvent, GameId } from './shell/api';

declare global {
  interface Window {
    __playtest?: {
      ready: boolean;
      startedAtSongTime: number;
      songTime: number;
      metrics: Record<string, number>;
      events: GameEvent[];
    };
  }
}

const isSoftwareGl = (() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return true;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
  const gpu = String(gl.getParameter(param));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
})();

function mountShell(root: HTMLElement) {
  root.innerHTML = '';

  const stageContainer = document.createElement('div');
  stageContainer.id = 'stage-container';
  stageContainer.dataset.testid = 'stage-container';
  stageContainer.className = 'absolute inset-0 w-full h-full';
  root.appendChild(stageContainer);

  const renderer = new THREE.WebGLRenderer({
    antialias: !isSoftwareGl,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  stageContainer.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#090a0f');
  scene.fog = new THREE.FogExp2('#090a0f', 0.035);

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    120,
  );
  camera.position.set(0, 3.2, 7.2);
  camera.lookAt(0.6, 1.0, 0);

  const hemiLight = new THREE.HemisphereLight('#7dd3fc', '#1e1b4b', 1.4);
  scene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight('#fde68a', 2.4);
  keyLight.position.set(5, 8, 6);
  scene.add(keyLight);

  // Composite multi-part centerpiece representing the 4 song layers
  const rig = new THREE.Group();
  rig.position.set(1.2, 0, 0);
  rig.rotation.y = Math.PI * 0.18;

  const gameColors: Record<GameId, number> = {
    runner: 0xf59e0b,
    horror: 0xef4444,
    tiles: 0x38bdf8,
    rail: 0xa855f7,
  };

  ORDER.forEach((gameId, idx) => {
    const angle = (idx / ORDER.length) * Math.PI * 2;
    const radius = 2.0;
    const height = 1.2 + idx * 0.35;

    const pillarGroup = new THREE.Group();
    pillarGroup.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);

    const baseGeo = new THREE.CylinderGeometry(0.42, 0.5, 0.18, 6);
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.7,
      metalness: 0.3,
    });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.y = 0.09;
    pillarGroup.add(baseMesh);

    const pillarGeo = new THREE.BoxGeometry(0.48, height, 0.48);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: gameColors[gameId],
      emissive: gameColors[gameId],
      emissiveIntensity: 0.28,
      roughness: 0.35,
      metalness: 0.45,
    });
    const mesh = new THREE.Mesh(pillarGeo, pillarMat);
    mesh.position.y = 0.18 + height / 2;
    pillarGroup.add(mesh);

    rig.add(pillarGroup);
  });

  const ringGeo = new THREE.TorusGeometry(2.0, 0.05, 12, 48);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    emissive: 0x38bdf8,
    emissiveIntensity: 0.4,
    roughness: 0.25,
    metalness: 0.6,
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.rotation.x = Math.PI / 2;
  ringMesh.position.y = 0.04;
  rig.add(ringMesh);

  const coreGeo = new THREE.OctahedronGeometry(0.75, 0);
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xf8fafc,
    emissive: 0x38bdf8,
    emissiveIntensity: 0.5,
    roughness: 0.2,
    metalness: 0.7,
  });
  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  coreMesh.position.y = 1.45;
  rig.add(coreMesh);
  scene.add(rig);

  const grid = new THREE.GridHelper(28, 28, 0x334155, 0x1e293b);
  grid.position.y = -0.02;
  scene.add(grid);

  // Plain DOM overlay
  const overlay = document.createElement('main');
  overlay.className =
    'pointer-events-none absolute inset-0 flex flex-col justify-between p-8 select-none';
  overlay.innerHTML = `
    <div class="flex items-start justify-between">
      <div>
        <svg viewBox="0 0 320 48" class="h-11 w-auto" aria-label="Song Arcade">
          <rect x="2" y="6" width="36" height="36" rx="6" fill="#0f172a" stroke="#f59e0b" stroke-width="2.5"/>
          <path d="M13 30V16L29 13V27" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="11" cy="30" r="3.5" fill="#f59e0b"/>
          <circle cx="27" cy="27" r="3.5" fill="#a855f7"/>
          <text x="50" y="33" fill="#f8fafc" font-family="monospace" font-weight="800" font-size="26" letter-spacing="2">SONG ARCADE</text>
        </svg>
        <p class="mt-1 font-mono text-xs tracking-widest uppercase text-slate-400">
          One continuous song · Four games (${ORDER.join(' → ')})
        </p>
      </div>
      <div class="font-mono text-right text-xs text-slate-400" style="font-variant-numeric: tabular-nums;">
        <div>READJUST ${READJUST.toFixed(1)}s · RUNWAY ${RUNWAY.toFixed(1)}s</div>
        <div id="hud-clock" class="text-sm font-bold text-amber-400">CLOCK 0.00s</div>
      </div>
    </div>

    <div id="title-card" class="pointer-events-auto max-w-md rounded-lg border border-slate-800 bg-slate-950/90 p-6 shadow-2xl">
      <h1 class="font-mono text-lg font-bold tracking-wide text-slate-100">
        Four layers of a song. Zero pauses.
      </h1>
      <p class="mt-2 text-sm text-slate-300 leading-relaxed">
        Start in <strong>Runner</strong> (beat), jump through <strong>Horror</strong> (structure),
        <strong>Tiles</strong> (melody), and <strong>Rail</strong> (energy) on every death until the track ends.
      </p>
      <div class="mt-5 flex items-center gap-3">
        <button
          id="start-btn"
          type="button"
          data-start="true"
          class="cursor-pointer rounded bg-amber-400 px-5 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-slate-950 transition hover:bg-amber-300"
        >
          Start Run
        </button>
      </div>
    </div>

    <div class="font-mono text-xs text-slate-400">
      WASD / Arrows Move · Space Action · \` Dev Panel
    </div>
  `;
  root.appendChild(overlay);

  const params = new URLSearchParams(window.location.search);
  const entrySec = Number(params.get('t') ?? '0') || 0;

  window.__playtest = {
    ready: true,
    startedAtSongTime: entrySec,
    songTime: entrySec,
    metrics: {},
    events: [],
  };

  const titleCard = overlay.querySelector<HTMLElement>('#title-card');
  const startBtn = overlay.querySelector<HTMLButtonElement>('#start-btn');
  const clockEl = overlay.querySelector<HTMLElement>('#hud-clock');

  const renderScene = () => {
    renderer.render(scene, camera);
  };

  const startRun = () => {
    document.body.dataset.state = 'playing';
    if (titleCard) titleCard.style.display = 'none';
    startBtn?.blur();
    renderScene();
  };

  startBtn?.addEventListener('click', startRun);
  window.addEventListener('keydown', (e) => {
    if (document.body.dataset.state === 'title' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      startRun();
    }
  });

  if (params.get('autostart') === '1' || params.get('bot') === '1') {
    startRun();
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderScene();
  });

  renderScene();
  if (clockEl) {
    clockEl.textContent = `CLOCK ${entrySec.toFixed(2)}s`;
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  mountShell(rootEl);
}
