import {
  bearingBetween,
  haversineMeters,
  isPointInPolygon,
  lngLatToLocal,
  localToLngLat,
} from './coords';
import {
  buildStationMorseSchedule,
  createSeededRng,
  sampleScheduleEnvelope,
  wpmToDitMs,
} from './cwSynthesizer';
import { STATIONS } from './stations';
import type {
  AudioFrame,
  CampusConfig,
  LngLat,
  StationId,
  VirtualFieldScenario,
  VirtualFieldScope,
  VirtualTransmitter,
} from './types';

export interface GenerateScenarioOptions {
  campus: CampusConfig;
  targetStations: StationId[];
  scope: VirtualFieldScope;
  /** Optional runner GPS anchor used for 'nearby' quick-test mode */
  anchor?: LngLat | null;
  /** Number of non-target decoy transmitters to also hide (default 3) */
  decoyCount?: number;
  /** Optional deterministic RNG seed for unit tests */
  seed?: number;
}

/**
 * Generate a realistic hidden-transmitter fox-hunt scenario inside a ZJU campus.
 * Includes the drawn target stations plus non-target decoy stations across
 * 3.508 - 3.592 MHz so runners can practice both locating and anti-mistake alarm.
 */
export function generateVirtualScenario(
  opts: GenerateScenarioOptions,
): VirtualFieldScenario {
  const { campus, targetStations, scope } = opts;
  const rng =
    opts.seed !== undefined ? createSeededRng(opts.seed) : () => Math.random();
  const decoyCount = opts.decoyCount ?? 3;

  // Select non-target decoy stations
  const nonTargets = STATIONS.map((s) => s.id).filter(
    (id) => !targetStations.includes(id),
  );
  for (let i = nonTargets.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [nonTargets[i], nonTargets[j]] = [nonTargets[j], nonTargets[i]];
  }
  const decoys = nonTargets.slice(0, Math.min(decoyCount, nonTargets.length));
  const allIds: { id: StationId; isTarget: boolean }[] = [
    ...targetStations.map((id) => ({ id, isTarget: true })),
    ...decoys.map((id) => ({ id, isTarget: false })),
  ];

  // Local ENU bounds of campus polygon
  const polyLocal = campus.boundary.map((p) => lngLatToLocal(p, campus.center));
  const minX = Math.min(...polyLocal.map((p) => p.x));
  const maxX = Math.max(...polyLocal.map((p) => p.x));
  const minY = Math.min(...polyLocal.map((p) => p.y));
  const maxY = Math.max(...polyLocal.map((p) => p.y));

  // Slightly inset campus perimeter so hidden stations stay comfortably inside
  const padX = Math.min(80, (maxX - minX) * 0.08);
  const padY = Math.min(80, (maxY - minY) * 0.08);

  const anchorValid =
    opts.anchor && isPointInPolygon(opts.anchor, campus.boundary);
  const effectiveAnchor = anchorValid ? opts.anchor! : campus.center;
  const anchorLocal = lngLatToLocal(effectiveAnchor, campus.center);

  const minSpacingM = scope === 'nearby' ? 50 : 120;
  const placed: LngLat[] = [];

  const pickPoint = (): LngLat => {
    for (let attempt = 0; attempt < 240; attempt++) {
      let candidate: LngLat;
      if (scope === 'nearby' && attempt < 180) {
        const angle = rng() * Math.PI * 2;
        const dist = 85 + rng() * 255; // 85m .. 340m around runner
        candidate = localToLngLat(
          {
            x: anchorLocal.x + Math.sin(angle) * dist,
            y: anchorLocal.y + Math.cos(angle) * dist,
          },
          campus.center,
        );
      } else {
        const x = minX + padX + rng() * Math.max(100, maxX - minX - 2 * padX);
        const y = minY + padY + rng() * Math.max(100, maxY - minY - 2 * padY);
        candidate = localToLngLat({ x, y }, campus.center);
      }

      if (!isPointInPolygon(candidate, campus.boundary)) continue;

      const minGap = attempt < 140 ? minSpacingM : minSpacingM * 0.5;
      const tooClose = placed.some(
        (existing) => haversineMeters(existing, candidate) < minGap,
      );
      if (!tooClose) {
        return candidate;
      }
    }
    return effectiveAnchor;
  };

  // Assign distinct well-separated RF frequencies across 3.508 .. 3.592 MHz
  const slotCount = allIds.length;
  const stepMHz = 0.084 / Math.max(1, slotCount);
  const freqSlots = Array.from({ length: slotCount }, (_, idx) => {
    const jitter = (rng() - 0.5) * stepMHz * 0.25;
    return Math.round((3.508 + (idx + 0.5) * stepMHz + jitter) * 1000) / 1000;
  });
  for (let i = freqSlots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [freqSlots[i], freqSlots[j]] = [freqSlots[j], freqSlots[i]];
  }

  const transmitters: VirtualTransmitter[] = allIds.map((item, idx) => {
    const pos = pickPoint();
    placed.push(pos);
    return {
      stationId: item.id,
      position: pos,
      freqMHz: freqSlots[idx],
      isTarget: item.isTarget,
      wpm: 11 + Math.floor(rng() * 4), // 11..14 WPM
      toneHz: 680 + Math.floor(rng() * 280), // 680..960 Hz
    };
  });

  return {
    campusId: campus.id,
    scope,
    createdAt: Date.now(),
    transmitters,
    penaltyCount: 0,
  };
}

export interface VirtualSignalSample {
  /** Dominant tuned transmitter if within receiver passband, else null */
  strongestTx: VirtualTransmitter | null;
  /** Frequency selectivity coupling factor in [0, 1] */
  selectivity: number;
  /** Distance from observer to strongestTx in meters (null if off-frequency) */
  distanceM: number | null;
  /** True compass bearing from observer to strongestTx (null if off-frequency) */
  trueBearingDeg: number | null;
  /** Instantaneous signal strength meter value in [0, 1] (for S-meter UI) */
  sMeter: number;
  /** Audio tone Hz for speaker synth */
  toneHz: number;
  /** Audible volume gain in [0, 0.28] for Web Audio monitor */
  audibleGain: number;
  /** Narrowband AudioFrame ready to feed directly into Stage 3 Morse & AutoBearing DSP */
  frame: AudioFrame;
}

/**
 * Evaluate the real-physics 80m receiver audio & narrowband AudioFrame at a
 * given dial frequency (3.500-3.600 MHz), observer position, heading, and time.
 */
export function evaluateVirtualFieldSignal(
  scenario: VirtualFieldScenario,
  tunedFreqMHz: number,
  observerPos: LngLat,
  headingDeg: number,
  elapsedMs: number,
  timestampMs: number,
  noiseRng?: () => number,
): VirtualSignalSample {
  const rng = noiseRng ?? Math.random;
  const noiseBase = 0.03;

  let strongestTx: VirtualTransmitter | null = null;
  let bestSelectivity = 0;

  for (const tx of scenario.transmitters) {
    const df = Math.abs(tx.freqMHz - tunedFreqMHz);
    if (df > 0.005) continue;
    // Gaussian IF filter selectivity (bandwidth ~3.6 kHz)
    const sel = Math.exp(-0.5 * (df / 0.0017) ** 2);
    if (sel > bestSelectivity) {
      bestSelectivity = sel;
      strongestTx = tx;
    }
  }

  let distanceM: number | null = null;
  let trueBearingDeg: number | null = null;
  let sigAmp = 0;
  let sMeter = 0;
  let toneHz = 800;
  let audibleGain = 0;

  if (strongestTx && bestSelectivity >= 0.06) {
    distanceM = haversineMeters(observerPos, strongestTx.position);
    trueBearingDeg = bearingBetween(observerPos, strongestTx.position);
    toneHz = strongestTx.toneHz;

    // Realistic campus path loss: louder nearby (< 40m), clearly readable across 1.5km campus
    const distFactor = Math.max(
      0.26,
      Math.min(1.0, 1 / (1 + Math.pow(distanceM / 420, 1.1))),
    );

    // 80m ferrite-rod figure-8 dipole pattern (sharp null along true bearing axis)
    const diffRad = ((headingDeg - trueBearingDeg) * Math.PI) / 180;
    const dirFactor = 0.08 + 0.92 * Math.abs(Math.sin(diffRad));

    const schedule = buildStationMorseSchedule(
      strongestTx.stationId,
      wpmToDitMs(strongestTx.wpm),
    );
    const env = sampleScheduleEnvelope(schedule, elapsedMs);

    // Peak SNR around ~22 dB nearby, ~14-18 dB across campus
    const maxSigAmp = noiseBase * Math.pow(10, 22 / 20);
    const carrierLevel = bestSelectivity * distFactor * dirFactor;
    sigAmp = env * maxSigAmp * carrierLevel;
    sMeter = Math.min(1, bestSelectivity * distFactor * (0.25 + 0.75 * dirFactor));
    audibleGain = Math.min(0.25, env * carrierLevel * 0.24);
  }

  // Realistic receiver thermal hiss (I/Q)
  const randI = (rng() - 0.5) * 2 * noiseBase * 0.7;
  const randQ = (rng() - 0.5) * 2 * noiseBase * 0.7;
  const noiseFloor = noiseBase * (0.9 + rng() * 0.2);
  const toneAmp = Math.hypot(sigAmp + randI, randQ);
  const snrDb =
    20 * Math.log10(Math.max(toneAmp, 1e-6) / Math.max(noiseFloor, 1e-6));
  const peakLevel = Math.min(1, toneAmp * 1.15 + noiseFloor);

  return {
    strongestTx,
    selectivity: bestSelectivity,
    distanceM,
    trueBearingDeg,
    sMeter,
    toneHz,
    audibleGain,
    frame: {
      timestampMs,
      toneAmp,
      noiseFloor,
      snrDb,
      peakLevel,
      clipped: peakLevel >= 0.94,
      dominantHz: toneHz,
    },
  };
}

/**
 * Find the closest hidden virtual transmitter within punch radius (default 25m).
 */
export function findNearbyVirtualTransmitter(
  scenario: VirtualFieldScenario,
  observerPos: LngLat,
  radiusM = 25,
): { tx: VirtualTransmitter; distanceM: number } | null {
  let best: { tx: VirtualTransmitter; distanceM: number } | null = null;
  for (const tx of scenario.transmitters) {
    const d = haversineMeters(observerPos, tx.position);
    if (d <= radiusM && (!best || d < best.distanceM)) {
      best = { tx, distanceM: d };
    }
  }
  return best;
}
