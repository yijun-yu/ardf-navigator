import {
  buildStationMorseSchedule,
  sampleScheduleEnvelope,
  wpmToDitMs,
} from '../core/cwSynthesizer';
import type { AudioFrame, StationId } from '../core/types';

export interface SimToneConfig {
  stationId: StationId;
  wpm: number;
  snrDb: number;
  toneHz: number;
  audible: boolean;
  /** Optional simulated directional attenuation (null angle & current heading) */
  trueNullDeg: number | null;
  headingDeg: number | null;
}

export interface AudioInputCallbacks {
  onFrame: (frame: AudioFrame) => void;
  onError: (message: string) => void;
}

const MIN_CW_HZ = 350;
const MAX_CW_HZ = 2000;
const FRAME_INTERVAL_MS = 20;

function median(values: number[]): number {
  if (values.length === 0) return 1e-6;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? 0.5 * (sorted[mid - 1] + sorted[mid])
    : sorted[mid];
}

/**
 * Unified real-time audio input controller supporting:
 * 1. Live microphone / USB-C sound card capture (with NS/AEC/AGC strictly disabled)
 *    + narrowband adaptive CW pitch tracker.
 * 2. Built-in synthetic 80m CW audio generator (with optional audible speaker monitor
 *    and simulated dipole directional fading) for zero-hardware testing.
 */
export class AudioInputController {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timerId: number | null = null;

  // Pitch lock hysteresis state for live mic capture
  private lockedBin: number | null = null;
  private lockedSilentFrames = 0;
  private challengerBin: number | null = null;
  private challengerStreak = 0;

  // Simulated audio generator state
  private simConfig: SimToneConfig | null = null;
  private simStartMs = 0;
  private simOsc: OscillatorNode | null = null;
  private simGain: GainNode | null = null;

  private readonly callbacks: AudioInputCallbacks;

  constructor(callbacks: AudioInputCallbacks) {
    this.callbacks = callbacks;
  }

  async startMic(): Promise<boolean> {
    this.stop();

    if (!navigator.mediaDevices?.getUserMedia) {
      this.callbacks.onError('当前浏览器不支持麦克风音频采集（请确认使用 HTTPS 打开）');
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Near-zero temporal smoothing prevents key-up tails from smearing short Morse gaps
      analyser.smoothingTimeConstant = 0.05;
      source.connect(analyser);

      this.ctx = ctx;
      this.stream = stream;
      this.sourceNode = source;
      this.analyser = analyser;
      this.lockedBin = null;
      this.lockedSilentFrames = 0;
      this.challengerBin = null;
      this.challengerStreak = 0;

      const timeBuf = new Float32Array(analyser.fftSize);
      const freqBuf = new Float32Array(analyser.frequencyBinCount);
      const binHz = ctx.sampleRate / analyser.fftSize;
      const minBin = Math.max(1, Math.floor(MIN_CW_HZ / binHz));
      const maxBin = Math.min(
        analyser.frequencyBinCount - 2,
        Math.ceil(MAX_CW_HZ / binHz),
      );

      this.timerId = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getFloatTimeDomainData(timeBuf);
        this.analyser.getFloatFrequencyData(freqBuf);

        let peakLevel = 0;
        for (let i = 0; i < timeBuf.length; i++) {
          const a = Math.abs(timeBuf[i]);
          if (a > peakLevel) peakLevel = a;
        }
        const clipped = peakLevel >= 0.94;

        // Convert relevant CW band dBFS to linear amplitudes
        const mags: number[] = [];
        let peakBin = minBin;
        let peakMag = 0;
        for (let b = minBin; b <= maxBin; b++) {
          const db = Number.isFinite(freqBuf[b]) ? freqBuf[b] : -120;
          const lin = Math.pow(10, db / 20);
          mags.push(lin);
          if (lin > peakMag) {
            peakMag = lin;
            peakBin = b;
          }
        }

        // Median magnitude across band = robust broadband noise floor
        const noiseFloor = Math.max(median(mags), 1e-6);

        // Adaptive pitch lock with hysteresis so key-up silence doesn't jump pitch,
        // while still switching cleanly if initially locked onto ambient room hum.
        if (this.lockedBin === null) {
          if (peakMag > noiseFloor * 2.4) {
            this.lockedBin = peakBin;
            this.lockedSilentFrames = 0;
          }
        } else {
          const curMag = Math.max(
            Math.pow(10, (freqBuf[this.lockedBin] ?? -120) / 20),
            Math.pow(10, (freqBuf[this.lockedBin - 1] ?? -120) / 20),
            Math.pow(10, (freqBuf[this.lockedBin + 1] ?? -120) / 20),
          );
          if (curMag < noiseFloor * 1.9) {
            this.lockedSilentFrames++;
          } else {
            this.lockedSilentFrames = 0;
          }

          if (
            Math.abs(peakBin - this.lockedBin) > 2 &&
            peakMag > noiseFloor * 2.6 &&
            peakMag > curMag * 1.45
          ) {
            if (
              this.challengerBin !== null &&
              Math.abs(peakBin - this.challengerBin) <= 1
            ) {
              this.challengerStreak++;
              if (this.challengerStreak >= 3) {
                this.lockedBin = peakBin;
                this.lockedSilentFrames = 0;
                this.challengerBin = null;
                this.challengerStreak = 0;
              }
            } else {
              this.challengerBin = peakBin;
              this.challengerStreak = 1;
            }
          } else {
            this.challengerStreak = 0;
            // Release dead lock after ~2.5s of no energy at locked bin
            if (this.lockedSilentFrames > 125) {
              this.lockedBin = null;
              this.lockedSilentFrames = 0;
            }
          }
        }

        const activeBin = this.lockedBin ?? peakBin;
        const mPrev = Math.pow(10, (freqBuf[activeBin - 1] ?? -120) / 20);
        const mCur = Math.pow(10, (freqBuf[activeBin] ?? -120) / 20);
        const mNext = Math.pow(10, (freqBuf[activeBin + 1] ?? -120) / 20);
        const toneAmp = Math.hypot(mPrev, mCur, mNext);
        const snrDb =
          20 * Math.log10(Math.max(toneAmp, 1e-7) / Math.max(noiseFloor, 1e-7));

        this.callbacks.onFrame({
          timestampMs: performance.now(),
          toneAmp,
          noiseFloor,
          snrDb,
          peakLevel,
          clipped,
          dominantHz: Math.round(activeBin * binHz),
        });
      }, FRAME_INTERVAL_MS);

      return true;
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.name === 'NotAllowedError'
            ? '麦克风权限被拒绝，请在浏览器设置中允许麦克风访问'
            : `音频打开失败：${err.message}`
          : '无法打开麦克风音频流';
      this.callbacks.onError(msg);
      return false;
    }
  }

  startSimTone(config: SimToneConfig): void {
    this.stop();
    this.simConfig = { ...config };
    this.simStartMs = performance.now();

    if (config.audible) {
      this.ensureSimAudioGraph(config.toneHz);
    }

    this.timerId = window.setInterval(() => {
      const cfg = this.simConfig;
      if (!cfg) return;

      const now = performance.now();
      const elapsed = now - this.simStartMs;
      const schedule = buildStationMorseSchedule(
        cfg.stationId,
        wpmToDitMs(cfg.wpm),
      );
      const env = sampleScheduleEnvelope(schedule, elapsed);

      let dirFactor = 1.0;
      if (cfg.trueNullDeg !== null && cfg.headingDeg !== null) {
        const diffRad = ((cfg.headingDeg - cfg.trueNullDeg) * Math.PI) / 180;
        dirFactor = 0.08 + 0.92 * Math.abs(Math.sin(diffRad));
      }

      const noiseBase = 0.03;
      const sigPeak = noiseBase * Math.pow(10, cfg.snrDb / 20);
      const sigAmp = env * sigPeak * dirFactor;

      // Mild random receiver hiss
      const randI = (Math.random() - 0.5) * 2 * noiseBase * 0.7;
      const randQ = (Math.random() - 0.5) * 2 * noiseBase * 0.7;
      const noiseFloor = noiseBase * (0.9 + Math.random() * 0.2);
      const toneAmp = Math.hypot(sigAmp + randI, randQ);
      const snrDb =
        20 * Math.log10(Math.max(toneAmp, 1e-6) / Math.max(noiseFloor, 1e-6));
      const peakLevel = Math.min(1, toneAmp * 1.15 + noiseFloor);

      if (cfg.audible) {
        this.ensureSimAudioGraph(cfg.toneHz);
        if (this.simGain && this.ctx) {
          const targetGain = Math.min(0.28, env * dirFactor * 0.22);
          this.simGain.gain.setTargetAtTime(
            targetGain,
            this.ctx.currentTime,
            0.008,
          );
        }
      } else if (this.simGain && this.ctx) {
        this.simGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.008);
      }

      this.callbacks.onFrame({
        timestampMs: now,
        toneAmp,
        noiseFloor,
        snrDb,
        peakLevel,
        clipped: peakLevel >= 0.94,
        dominantHz: cfg.toneHz,
      });
    }, FRAME_INTERVAL_MS);
  }

  /**
   * Stream custom real-time virtual-field physics frames (driven by real GPS +
   * compass + virtual 3.50-3.60 MHz dial) into the exact same DSP pipeline and
   * optional Web Audio speaker oscillator.
   */
  startCustomStream(
    provider: (elapsedMs: number, nowMs: number) => {
      frame: AudioFrame;
      toneHz: number;
      audibleGain: number;
      audible: boolean;
    },
  ): void {
    this.stop();
    this.simStartMs = performance.now();

    this.timerId = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - this.simStartMs;
      const sample = provider(elapsed, now);

      if (sample.audible && sample.audibleGain > 0.002) {
        this.ensureSimAudioGraph(sample.toneHz);
        if (this.simOsc && this.simGain && this.ctx) {
          this.simOsc.frequency.setTargetAtTime(
            sample.toneHz,
            this.ctx.currentTime,
            0.015,
          );
          this.simGain.gain.setTargetAtTime(
            sample.audibleGain,
            this.ctx.currentTime,
            0.008,
          );
        }
      } else if (this.simGain && this.ctx) {
        this.simGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
      }

      this.callbacks.onFrame(sample.frame);
    }, FRAME_INTERVAL_MS);
  }

  updateSimConfig(patch: Partial<SimToneConfig>): void {
    if (!this.simConfig) return;
    const prevStation = this.simConfig.stationId;
    this.simConfig = { ...this.simConfig, ...patch };
    if (patch.stationId && patch.stationId !== prevStation) {
      this.simStartMs = performance.now();
    }
    if (this.simOsc && this.ctx && patch.toneHz) {
      this.simOsc.frequency.setTargetAtTime(
        patch.toneHz,
        this.ctx.currentTime,
        0.01,
      );
    }
  }

  private ensureSimAudioGraph(toneHz: number): void {
    if (this.simOsc && this.simGain && this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = this.ctx ?? new AudioCtx();
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = toneHz;
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      this.ctx = ctx;
      this.simOsc = osc;
      this.simGain = gain;
    } catch {
      // Audio playback blocked by autoplay policy; silent frame injection still works
    }
  }

  stop(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.simOsc) {
      try {
        this.simOsc.stop();
        this.simOsc.disconnect();
      } catch {
        // ignore
      }
      this.simOsc = null;
    }
    if (this.simGain) {
      try {
        this.simGain.disconnect();
      } catch {
        // ignore
      }
      this.simGain = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.analyser = null;
    this.simConfig = null;
    this.lockedBin = null;
  }
}

/**
 * Play a short non-blocking alert beep (warning for non-target or chime for sweep complete).
 */
export function playAlertBeep(kind: 'alarm' | 'done'): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    if (kind === 'alarm') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.setValueAtTime(380, now + 0.14);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
      osc.start(now);
      osc.stop(now + 0.34);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.setValueAtTime(990, now + 0.11);
      gain.gain.setValueAtTime(0.16, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.3);
    }
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 450);
  } catch {
    // ignore if audio context unavailable
  }
}
