import type { AudioFx, LiveBands, SongClock, SongMap } from './api';

const CALIBRATION_STORAGE_KEY = 'song_arcade_calibration_offset_ms';

export function loadCalibrationOffsetSec(): number {
  try {
    const raw = window.localStorage.getItem(CALIBRATION_STORAGE_KEY);
    if (raw !== null) {
      const ms = Number(raw);
      if (Number.isFinite(ms)) return ms / 1000;
    }
  } catch {
    // localStorage unavailable
  }
  return 0;
}

export function saveCalibrationOffsetSec(offsetSec: number): void {
  try {
    const ms = Math.round(offsetSec * 1000);
    window.localStorage.setItem(CALIBRATION_STORAGE_KEY, String(ms));
  } catch {
    // localStorage unavailable
  }
}

export interface AudioEngine {
  clock: SongClock;
  fx: AudioFx;
  bands: LiveBands;
  loadAndStart(map: SongMap, entrySec?: number): Promise<void>;
  seekTo(songTimeSec: number): void;
  stop(): void;
  updateBands(songTime: number): void;
  getCalibrationOffsetSec(): number;
  setCalibrationOffsetSec(sec: number): void;
  isEnded(songTime: number): boolean;
}

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null;
  let audioBuffer: AudioBuffer | null = null;
  let sourceNode: AudioBufferSourceNode | null = null;
  let filterNode: BiquadFilterNode | null = null;
  let gainNode: GainNode | null = null;
  let analyserNode: AnalyserNode | null = null;
  let freqData: Uint8Array<ArrayBuffer> | null = null;

  let currentMap: SongMap | null = null;
  let startAt = 0;
  let fallbackStartWallSec = 0;
  let fallbackEntrySec = 0;
  let playing = false;
  let calibrationOffsetSec = loadCalibrationOffsetSec();

  const bands: LiveBands = {
    low: 0,
    mid: 0,
    high: 0,
    energy: 0,
  };

  let lastTargetHz = 20000;
  let lastTargetGain = 1.0;

  function ensureContext(): AudioContext {
    if (!ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AudioCtx();
    }
    if (!filterNode || !gainNode || !analyserNode) {
      filterNode = ctx.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.frequency.value = 20000;
      filterNode.Q.value = 0.707;

      gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;

      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.75;
      freqData = new Uint8Array(analyserNode.frequencyBinCount);

      filterNode.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(ctx.destination);
    }
    return ctx;
  }

  function startBufferAt(offsetSec: number): void {
    const duration = currentMap?.duration ?? audioBuffer?.duration ?? 100;
    const clampedOffset = Math.max(0, Math.min(Math.max(0, duration - 0.05), offsetSec));

    if (sourceNode) {
      try {
        sourceNode.onended = null;
        sourceNode.stop();
      } catch {
        // ignore
      }
      sourceNode.disconnect();
      sourceNode = null;
    }

    fallbackStartWallSec = performance.now() / 1000;
    fallbackEntrySec = clampedOffset;

    if (ctx && audioBuffer && filterNode) {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      sourceNode = ctx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(filterNode);
      startAt = ctx.currentTime - clampedOffset;
      sourceNode.start(0, clampedOffset);
      playing = true;
    } else {
      if (ctx) {
        startAt = ctx.currentTime - clampedOffset;
      }
      playing = true;
    }
  }

  const clock: SongClock = {
    now(): number {
      if (!playing) return fallbackEntrySec;
      if (ctx && ctx.state === 'running') {
        const hwLatency =
          ((ctx as unknown as { outputLatency?: number }).outputLatency || ctx.baseLatency || 0);
        const raw = ctx.currentTime - startAt - hwLatency + calibrationOffsetSec;
        return Math.max(0, raw);
      }
      // Fallback if AudioContext is suspended by headless browser policy before gesture
      const elapsed = performance.now() / 1000 - fallbackStartWallSec;
      return Math.max(0, fallbackEntrySec + elapsed + calibrationOffsetSec);
    },
  };

  const fx: AudioFx = {
    lowpass(hz: number, rampSec: number): void {
      if (!ctx || !filterNode) return;
      const clampedHz = Math.max(60, Math.min(20000, hz));
      if (Math.abs(clampedHz - lastTargetHz) < 15) return;
      lastTargetHz = clampedHz;
      const tau = Math.max(0.01, rampSec / 3);
      filterNode.frequency.setTargetAtTime(clampedHz, ctx.currentTime, tau);
    },
    gain(g: number, rampSec: number): void {
      if (!ctx || !gainNode) return;
      const clampedGain = Math.max(0, Math.min(2.0, g));
      if (Math.abs(clampedGain - lastTargetGain) < 0.01) return;
      lastTargetGain = clampedGain;
      const tau = Math.max(0.01, rampSec / 3);
      gainNode.gain.setTargetAtTime(clampedGain, ctx.currentTime, tau);
    },
    reset(): void {
      if (!ctx || !filterNode || !gainNode) return;
      lastTargetHz = 20000;
      lastTargetGain = 1.0;
      const now = ctx.currentTime;
      filterNode.frequency.setTargetAtTime(20000, now, 0.04);
      gainNode.gain.setTargetAtTime(1.0, now, 0.04);
    },
  };

  return {
    clock,
    fx,
    bands,

    async loadAndStart(map: SongMap, entrySec = 0): Promise<void> {
      currentMap = map;
      const audioCtx = ensureContext();
      fx.reset();

      audioBuffer = null;
      try {
        const res = await fetch(map.file);
        if (res.ok) {
          const arr = await res.arrayBuffer();
          audioBuffer = await audioCtx.decodeAudioData(arr);
        }
      } catch {
        // Fixture or offline test without MP3 binary: clock still runs via AudioContext/wall timer
      }

      startBufferAt(entrySec);
    },

    seekTo(songTimeSec: number): void {
      startBufferAt(songTimeSec);
    },

    stop(): void {
      playing = false;
      if (sourceNode) {
        try {
          sourceNode.onended = null;
          sourceNode.stop();
        } catch {
          // ignore
        }
        sourceNode.disconnect();
        sourceNode = null;
      }
    },

    updateBands(songTime: number): void {
      let rawLow = 0;
      let rawMid = 0;
      let rawHigh = 0;

      if (ctx && analyserNode && freqData && ctx.state === 'running' && audioBuffer) {
        analyserNode.getByteFrequencyData(freqData);
        const nyquist = ctx.sampleRate / 2;
        const binCount = freqData.length;
        const binHz = nyquist / binCount;

        let lowSum = 0;
        let lowN = 0;
        let midSum = 0;
        let midN = 0;
        let highSum = 0;
        let highN = 0;

        for (let i = 0; i < binCount; i++) {
          const hz = i * binHz;
          const val = freqData[i] / 255;
          if (hz < 150) {
            lowSum += val;
            lowN++;
          } else if (hz <= 2000) {
            midSum += val;
            midN++;
          } else if (hz <= 10000) {
            highSum += val;
            highN++;
          }
        }

        rawLow = lowN > 0 ? Math.min(1, (lowSum / lowN) * 1.25) : 0;
        rawMid = midN > 0 ? Math.min(1, (midSum / midN) * 1.45) : 0;
        rawHigh = highN > 0 ? Math.min(1, (highSum / highN) * 1.8) : 0;
      }

      // If AnalyserNode reads zero (e.g. muted headless run or fixture), use precomputed map envelope
      if (rawLow + rawMid + rawHigh < 0.01 && currentMap?.envelope) {
        const env = currentMap.envelope;
        const idx = Math.max(
          0,
          Math.min(env.energy.length - 1, Math.floor(songTime / Math.max(0.01, env.hop))),
        );
        rawLow = env.low[idx] ?? 0.4;
        rawMid = env.mid[idx] ?? 0.4;
        rawHigh = env.high[idx] ?? 0.35;
      }

      const rawEnergy = Math.min(1, rawLow * 0.45 + rawMid * 0.35 + rawHigh * 0.2);
      const alpha = 0.28;
      bands.low = bands.low + (rawLow - bands.low) * alpha;
      bands.mid = bands.mid + (rawMid - bands.mid) * alpha;
      bands.high = bands.high + (rawHigh - bands.high) * alpha;
      bands.energy = bands.energy + (rawEnergy - bands.energy) * alpha;
    },

    getCalibrationOffsetSec(): number {
      return calibrationOffsetSec;
    },

    setCalibrationOffsetSec(sec: number): void {
      calibrationOffsetSec = Math.max(-0.25, Math.min(0.25, sec));
      saveCalibrationOffsetSec(calibrationOffsetSec);
    },

    isEnded(songTime: number): boolean {
      if (!currentMap) return false;
      return songTime >= currentMap.duration;
    },
  };
}
