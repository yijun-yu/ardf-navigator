import { getStation } from './stations';
import type { AudioFrame, StationId } from './types';

export interface MorseSegment {
  on: boolean;
  durationMs: number;
  kind: 'dit' | 'dah' | 'intra' | 'letter' | 'cycle';
}

export interface StationSchedule {
  stationId: StationId;
  ditMs: number;
  cycleDurationMs: number;
  segments: MorseSegment[];
}

/**
 * Convert WPM (standard PARIS timing: 1 dit = 1200 / WPM ms) to dit duration in ms.
 */
export function wpmToDitMs(wpm: number): number {
  return 1200 / Math.max(4, Math.min(40, wpm));
}

/**
 * Build exact on/off Morse timing schedule for one full callsign cycle of a station.
 * Preserves exact 3-unit inter-letter spaces (critical for distinguishing MO vs 0).
 */
export function buildStationMorseSchedule(
  stationId: StationId,
  ditMs: number,
  options?: {
    cycleGapUnits?: number;
    /** Optional keying weight multiplier on ON durations (e.g. 1.15 for heavy keying) */
    weightRatio?: number;
  },
): StationSchedule {
  const spec = getStation(stationId);
  const cycleGapUnits = options?.cycleGapUnits ?? 7;
  const weight = options?.weightRatio ?? 1.0;
  const letters = spec.morse.trim().split(/\s+/);
  const segments: MorseSegment[] = [];

  for (let li = 0; li < letters.length; li++) {
    const symbols = letters[li];
    for (let si = 0; si < symbols.length; si++) {
      const ch = symbols[si];
      const isDah = ch === '-';
      segments.push({
        on: true,
        durationMs: (isDah ? 3 : 1) * ditMs * weight,
        kind: isDah ? 'dah' : 'dit',
      });

      const hasNextSymbol = si < symbols.length - 1;
      const hasNextLetter = li < letters.length - 1;

      if (hasNextSymbol) {
        // Intra-character gap (1 dit unit, compensated if keying weight != 1)
        const gapMs = Math.max(0.45 * ditMs, ditMs * (2 - weight));
        segments.push({
          on: false,
          durationMs: gapMs,
          kind: 'intra',
        });
      } else if (hasNextLetter) {
        // Inter-letter gap (3 dit units)
        segments.push({
          on: false,
          durationMs: 3 * ditMs,
          kind: 'letter',
        });
      } else {
        // Inter-cycle repeat gap (default 7 dit units)
        segments.push({
          on: false,
          durationMs: cycleGapUnits * ditMs,
          kind: 'cycle',
        });
      }
    }
  }

  const cycleDurationMs = segments.reduce((sum, s) => sum + s.durationMs, 0);
  return {
    stationId,
    ditMs,
    cycleDurationMs,
    segments,
  };
}

/**
 * Sample smoothed CW key envelope in [0, 1] at a given time along a repeating schedule.
 */
export function sampleScheduleEnvelope(
  schedule: StationSchedule,
  timeMs: number,
): number {
  const pos =
    ((timeMs % schedule.cycleDurationMs) + schedule.cycleDurationMs) %
    schedule.cycleDurationMs;
  let acc = 0;
  for (let i = 0; i < schedule.segments.length; i++) {
    const seg = schedule.segments[i];
    if (pos < acc + seg.durationMs) {
      return seg.on ? 1 : 0;
    }
    acc += seg.durationMs;
  }
  return 0;
}

/** Deterministic fast PRNG (Mulberry32) for reproducible DSP unit tests. */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianNoise(rng: () => number): number {
  const u1 = Math.max(1e-7, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export interface SyntheticFrameOptions {
  stationId: StationId;
  wpm?: number;
  durationMs: number;
  frameIntervalMs?: number;
  /** Peak signal-to-noise ratio in dB when pointing perpendicular to null */
  snrDb?: number;
  dominantHz?: number;
  startTimeMs?: number;
  /** Start phase offset into the Morse cycle in ms (simulates mid-cycle tune-in) */
  phaseOffsetMs?: number;
  cycleGapUnits?: number;
  weightRatio?: number;
  /** Random impulse static pop probability per frame (0..1) */
  impulseProb?: number;
  /** Optional heading trajectory (deg) for dipole directional modulation */
  headingFn?: (timeMs: number) => number;
  /** True ferrite-rod null bearing in degrees [0, 180) when headingFn is provided */
  trueNullDeg?: number;
  /** Imperfect null leakage floor in [0, 0.5] (default 0.08) */
  nullLeakage?: number;
  /** Simulate input clipping when amplitude exceeds this threshold (default 0.94) */
  clipGain?: number;
  seed?: number;
}

/**
 * Generate realistic narrowband AudioFrame sequence for testing both
 * Morse decoding and half-turn auto-bearing fitting under noise and fading.
 */
export function generateSyntheticAudioFrames(
  opts: SyntheticFrameOptions,
): { frame: AudioFrame; headingDeg?: number }[] {
  const wpm = opts.wpm ?? 12;
  const ditMs = wpmToDitMs(wpm);
  const frameIntervalMs = opts.frameIntervalMs ?? 20;
  const snrDb = opts.snrDb ?? 18;
  const dominantHz = opts.dominantHz ?? 800;
  const startTimeMs = opts.startTimeMs ?? 0;
  const phaseOffsetMs = opts.phaseOffsetMs ?? 0;
  const nullLeakage = opts.nullLeakage ?? 0.08;
  const impulseProb = opts.impulseProb ?? 0;
  const clipGain = opts.clipGain ?? 1.0;
  const rng = createSeededRng(opts.seed ?? 42);

  const schedule = buildStationMorseSchedule(opts.stationId, ditMs, {
    cycleGapUnits: opts.cycleGapUnits,
    weightRatio: opts.weightRatio,
  });

  const noiseBase = 0.03;
  const signalPeakAmp = noiseBase * Math.pow(10, snrDb / 20);
  const steps = Math.floor(opts.durationMs / frameIntervalMs);
  const out: { frame: AudioFrame; headingDeg?: number }[] = [];

  for (let i = 0; i < steps; i++) {
    const t = i * frameIntervalMs;
    const timestampMs = startTimeMs + t;
    const env = sampleScheduleEnvelope(schedule, t + phaseOffsetMs);

    let dirFactor = 1.0;
    let headingDeg: number | undefined;
    if (opts.headingFn && opts.trueNullDeg !== undefined) {
      headingDeg = opts.headingFn(t);
      const diffRad = ((headingDeg - opts.trueNullDeg) * Math.PI) / 180;
      dirFactor = nullLeakage + (1 - nullLeakage) * Math.abs(Math.sin(diffRad));
    }

    // Correlated narrowband tone + Rayleigh-like noisy fluctuation
    const sigAmp = env * signalPeakAmp * dirFactor;
    const noiseJitter = Math.max(0.45, 1 + 0.16 * gaussianNoise(rng));
    const noiseFloor = noiseBase * noiseJitter;

    // In-phase & quadrature Gaussian noise added to coherent CW signal
    const nI = noiseBase * 0.72 * gaussianNoise(rng);
    const nQ = noiseBase * 0.72 * gaussianNoise(rng);
    let toneAmp = Math.hypot(sigAmp + nI, nQ);

    // Optional single-frame QRN atmospheric static spike
    if (impulseProb > 0 && rng() < impulseProb) {
      toneAmp += signalPeakAmp * (0.6 + rng() * 0.8);
    }

    // Apply gain & soft/hard ADC clipping
    const rawPeak = Math.min(1.0, (toneAmp * 1.35 + noiseFloor * 1.4) * clipGain);
    const clipped = rawPeak >= 0.94;
    if (clipped) {
      toneAmp = Math.min(toneAmp * clipGain, 0.72);
    } else {
      toneAmp *= clipGain;
    }
    const scaledNoise = noiseFloor * clipGain;
    const instSnrDb = 20 * Math.log10(Math.max(toneAmp, 1e-6) / Math.max(scaledNoise, 1e-6));

    out.push({
      frame: {
        timestampMs,
        toneAmp,
        noiseFloor: scaledNoise,
        snrDb: instSnrDb,
        peakLevel: rawPeak,
        clipped,
        dominantHz,
      },
      headingDeg,
    });
  }

  return out;
}
