import { STATIONS } from './stations';
import type {
  AudioFrame,
  MorseDecoderSnapshot,
  MorseLockStatus,
  StationId,
} from './types';

interface StationTemplate {
  id: StationId;
  pulseCount: number;
  /** Expected pulse durations in dot units (1 = dit, 3 = dah) */
  onUnits: number[];
  /** Expected internal gap durations in dot units (1 = intra-char, 3 = inter-letter) */
  gapUnits: number[];
  /** Precomputed natural logs for fast scoring */
  logOnUnits: number[];
  logGapUnits: number[];
}

function buildTemplates(): StationTemplate[] {
  return STATIONS.map((st) => {
    const letters = st.morse.trim().split(/\s+/);
    const onUnits: number[] = [];
    const gapUnits: number[] = [];
    for (let li = 0; li < letters.length; li++) {
      const sym = letters[li];
      for (let si = 0; si < sym.length; si++) {
        onUnits.push(sym[si] === '-' ? 3 : 1);
        if (si < sym.length - 1) {
          gapUnits.push(1);
        } else if (li < letters.length - 1) {
          gapUnits.push(3);
        }
      }
    }
    return {
      id: st.id,
      pulseCount: onUnits.length,
      onUnits,
      gapUnits,
      logOnUnits: onUnits.map((v) => Math.log(v)),
      logGapUnits: gapUnits.map((v) => Math.log(v)),
    };
  });
}

const TEMPLATES: StationTemplate[] = buildTemplates();

export interface PulseRecord {
  startMs: number;
  endMs: number;
  onMs: number;
  /** Gap after this pulse in ms (0 if not yet terminated by next pulse) */
  offMs: number;
}

export interface CycleMatchResult {
  stationId: StationId | null;
  confidence: number;
  secondBestScore: number;
  estimatedWpm: number | null;
  symbols: string;
}

/**
 * Score a candidate cycle of completed pulses against all 11 ARDF station
 * templates using continuous log-time template matching.
 *
 * Key properties:
 * - Speed-invariant across ~5 to 35 WPM (solves optimal dot unit analytically).
 * - Tolerates moderate keying-weight skew (heavy/light receiver filter ringing).
 * - Explicitly distinguishes 0 ('-----', uniform 1u internal gaps) from
 *   MO ('-- ---', 3u letter space between 2nd and 3rd dah).
 * - Rejects partial fragments like '.....' from matching 0 or MO via ON/OFF
 *   ratio consistency penalty.
 */
export function matchCycleToStation(pulses: PulseRecord[]): CycleMatchResult {
  const m = pulses.length;
  if (m < 5 || m > 10) {
    return {
      stationId: null,
      confidence: 0,
      secondBestScore: 0,
      estimatedWpm: null,
      symbols: '',
    };
  }

  const logOn = pulses.map((p) => Math.log(Math.max(15, p.onMs)));
  const logGap: number[] = [];
  for (let i = 0; i < m - 1; i++) {
    logGap.push(Math.log(Math.max(15, pulses[i].offMs)));
  }

  let bestId: StationId | null = null;
  let bestScore = 0;
  let secondScore = 0;
  let bestU = 100;

  for (let ti = 0; ti < TEMPLATES.length; ti++) {
    const tpl = TEMPLATES[ti];
    if (tpl.pulseCount !== m) continue;

    // Optimal log(u_on) and log(u_off) for this template
    let sumOn = 0;
    for (let i = 0; i < m; i++) {
      sumOn += logOn[i] - tpl.logOnUnits[i];
    }
    const logUOn = sumOn / m;

    let sumGap = 0;
    for (let i = 0; i < m - 1; i++) {
      sumGap += logGap[i] - tpl.logGapUnits[i];
    }
    const logUGap = sumGap / (m - 1);

    const uOn = Math.exp(logUOn);
    const uGap = Math.exp(logUGap);
    const uAvg = Math.sqrt(uOn * uGap);

    // Physical speed sanity check (roughly 4.5 WPM to 38 WPM)
    if (uAvg < 30 || uAvg > 270) continue;

    // Timing residual MSE in log space + worst-element structural guard
    let errSqSum = 0;
    let maxOnErr = 0;
    for (let i = 0; i < m; i++) {
      const r = logOn[i] - (logUOn + tpl.logOnUnits[i]);
      const absR = Math.abs(r);
      if (absR > maxOnErr) maxOnErr = absR;
      errSqSum += r * r;
    }
    let maxGapErr = 0;
    for (let i = 0; i < m - 1; i++) {
      const r = logGap[i] - (logUGap + tpl.logGapUnits[i]);
      const absR = Math.abs(r);
      if (absR > maxGapErr) maxGapErr = absR;
      // Slightly higher weight on internal gap structure so MO vs 0 separates decisively
      errSqSum += 1.35 * r * r;
    }

    // Coupling penalty between ON unit and OFF unit (prevents '.....' matching '-----')
    const ratioDrift = logUOn - logUGap;

    // Structural guard: a dit (~1u) must never be allowed to match a dah (~3u)
    // (ln(3) ≈ 1.10; even ±50% timing jitter stays below 0.45).
    if (maxOnErr > 0.62 || maxGapErr > 0.68 || Math.abs(ratioDrift) > 0.62) {
      continue;
    }

    const weightCount = m + 1.35 * (m - 1) + 1.8;
    const totalMse = (errSqSum + 1.8 * ratioDrift * ratioDrift) / weightCount;
    const score = Math.exp(-4.2 * totalMse);

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestId = tpl.id;
      bestU = uAvg;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  // Build human-readable symbol string using best estimated unit
  const symbols = formatPulsesAsSymbols(pulses, bestU);

  const margin = bestScore - secondScore;
  if (!bestId || bestScore < 0.66 || margin < 0.12) {
    return {
      stationId: null,
      confidence: Math.round(bestScore * 100) / 100,
      secondBestScore: Math.round(secondScore * 100) / 100,
      estimatedWpm: null,
      symbols,
    };
  }

  return {
    stationId: bestId,
    confidence: Math.round(bestScore * 100) / 100,
    secondBestScore: Math.round(secondScore * 100) / 100,
    estimatedWpm: Math.round((1200 / bestU) * 10) / 10,
    symbols,
  };
}

function formatPulsesAsSymbols(pulses: PulseRecord[], unitMs: number): string {
  const safeU = Math.max(30, Math.min(270, unitMs));
  let out = '';
  for (let i = 0; i < pulses.length; i++) {
    out += pulses[i].onMs >= safeU * 1.9 ? '—' : '·';
    if (i < pulses.length - 1 && pulses[i].offMs >= safeU * 2.0) {
      out += ' ';
    }
  }
  return out;
}

/**
 * Estimate local dot unit of a candidate pulse segment to determine whether
 * a silence gap is a full inter-cycle break (>= ~4.2u) vs an intra/letter gap.
 */
function estimateSegmentDotUnit(pulses: PulseRecord[]): number {
  const ons = pulses.map((p) => p.onMs).sort((a, b) => a - b);
  const gaps = pulses
    .slice(0, -1)
    .map((p) => p.offMs)
    .filter((g) => g > 0)
    .sort((a, b) => a - b);

  const minOn = ons[0];
  const maxOn = ons[ons.length - 1];

  // If mixed dits and dahs exist, shortest ON is ~1u and longest ON is ~3u
  if (maxOn / Math.max(1, minOn) >= 1.85) {
    return Math.max(32, Math.min(250, 0.5 * (minOn + maxOn / 3)));
  }

  // Uniform ON durations (e.g. '0' or 'MO' = all dahs, or partial dits)
  const medOn = ons[Math.floor(ons.length / 2)];
  if (gaps.length >= 2) {
    const shortGap = 0.5 * (gaps[0] + gaps[1]);
    if (medOn / Math.max(1, shortGap) >= 1.8) {
      return Math.max(32, Math.min(250, 0.5 * (shortGap + medOn / 3)));
    }
  }

  return Math.max(32, Math.min(250, medOn / 2.2));
}

interface MetricSample {
  timestampMs: number;
  value: number;
}

interface VoteEntry {
  stationId: StationId;
  confidence: number;
  wpm: number | null;
  timestampMs: number;
}

/**
 * Streaming, noise-resistant, speed-adaptive 80m ARDF Morse decoder.
 * Feed AudioFrames at ~40-60 Hz; query snapshot for real-time station lock.
 */
export class ArdfMorseDecoder {
  private readonly metricWindow: MetricSample[] = [];
  // Reject 1-frame (0ms dwell) QRN spikes while preserving 2-frame (~40-60ms) fast 20 WPM dits
  private readonly minPulseMs = 18;
  private readonly minGapMs = 18;

  private rawKeyDown = false;
  private debouncedKeyDown = false;
  private stateStartMs = 0;
  private lastFrameMs = 0;

  // Pending pulse awaiting deglitch confirmation
  private activeOnStartMs: number | null = null;
  private lastCompletedOnEndMs: number | null = null;

  // Current cycle pulses being accumulated
  private cyclePulses: PulseRecord[] = [];
  private recentVotes: VoteEntry[] = [];

  private lockedStation: StationId | null = null;
  private candidateStation: StationId | null = null;
  private confidence = 0;
  private estimatedWpm: number | null = null;
  private recentSymbols = '';
  private agreeCount = 0;

  reset(): void {
    this.metricWindow.length = 0;
    this.rawKeyDown = false;
    this.debouncedKeyDown = false;
    this.stateStartMs = 0;
    this.lastFrameMs = 0;
    this.activeOnStartMs = null;
    this.lastCompletedOnEndMs = null;
    this.cyclePulses = [];
    this.recentVotes = [];
    this.lockedStation = null;
    this.candidateStation = null;
    this.confidence = 0;
    this.estimatedWpm = null;
    this.recentSymbols = '';
    this.agreeCount = 0;
  }

  feedFrame(frame: AudioFrame): MorseDecoderSnapshot {
    const now = frame.timestampMs;
    if (this.lastFrameMs > 0 && now < this.lastFrameMs) {
      return this.getSnapshot();
    }
    this.lastFrameMs = now;

    // 1. Update rolling SNR envelope window (last 2.8 seconds)
    const metric = Math.max(0, Math.min(35, frame.snrDb));
    this.metricWindow.push({ timestampMs: now, value: metric });
    const cutoff = now - 2800;
    while (this.metricWindow.length > 0 && this.metricWindow[0].timestampMs < cutoff) {
      this.metricWindow.shift();
    }

    // 2. Adaptive hysteresis Schmitt trigger
    let nextRaw = this.rawKeyDown;
    if (this.metricWindow.length >= 6) {
      const sorted = this.metricWindow.map((s) => s.value).sort((a, b) => a - b);
      const lowP = sorted[Math.floor(sorted.length * 0.2)];
      const highP = sorted[Math.floor(sorted.length * 0.9)];
      const spread = highP - lowP;

      if (spread >= 4.2 && highP >= 5.2) {
        const onTh = lowP + 0.56 * spread;
        const offTh = lowP + 0.36 * spread;
        if (!this.rawKeyDown && metric >= onTh) {
          nextRaw = true;
        } else if (this.rawKeyDown && metric <= offTh) {
          nextRaw = false;
        }
      } else {
        nextRaw = false;
      }
    } else {
      nextRaw = metric >= 7.5;
    }

    if (nextRaw !== this.rawKeyDown) {
      this.rawKeyDown = nextRaw;
      this.stateStartMs = now;
    }

    // 3. Deglitch short transient spikes (< 26ms) and micro-dropouts (< 26ms)
    const dwellMs = now - this.stateStartMs;
    if (this.rawKeyDown && !this.debouncedKeyDown && dwellMs >= this.minPulseMs) {
      // Rising edge confirmed (actually started at stateStartMs)
      this.onKeyDown(this.stateStartMs);
    } else if (!this.rawKeyDown && this.debouncedKeyDown && dwellMs >= this.minGapMs) {
      // Falling edge confirmed (actually ended at stateStartMs)
      this.onKeyUp(this.stateStartMs);
    }

    // 4. Live silence check to finalize a completed cycle without waiting for next pulse
    if (!this.debouncedKeyDown && this.lastCompletedOnEndMs !== null) {
      const silentMs = now - this.lastCompletedOnEndMs;
      if (this.cyclePulses.length >= 5) {
        const unitMs = estimateSegmentDotUnit(this.cyclePulses);
        const cycleBreakMs = Math.max(240, 4.1 * unitMs);
        if (silentMs >= cycleBreakMs) {
          this.flushCycle(now);
        }
      } else if (this.cyclePulses.length > 0 && silentMs >= 900) {
        // Discard incomplete mid-cycle fragment after long silence
        this.cyclePulses = [];
      }

      // Expire stale lock if signal completely vanishes for > 5 seconds
      if (silentMs >= 5000 && (this.lockedStation || this.candidateStation)) {
        this.lockedStation = null;
        this.candidateStation = null;
        this.confidence = 0;
        this.agreeCount = 0;
        this.recentVotes = [];
      }
    }

    return this.getSnapshot();
  }

  private onKeyDown(edgeMs: number): void {
    this.debouncedKeyDown = true;

    if (this.cyclePulses.length > 0 && this.lastCompletedOnEndMs !== null) {
      const gapMs = Math.max(0, edgeMs - this.lastCompletedOnEndMs);
      const prev = this.cyclePulses[this.cyclePulses.length - 1];
      prev.offMs = gapMs;

      // Check if that gap was actually a cycle boundary before starting the new pulse
      if (this.cyclePulses.length >= 5) {
        const unitMs = estimateSegmentDotUnit(this.cyclePulses);
        const cycleBreakMs = Math.max(240, 4.1 * unitMs);
        if (gapMs >= cycleBreakMs) {
          this.flushCycle(edgeMs);
        }
      } else {
        // Discard short mid-cycle startup fragment if followed by a huge pause
        const maxOn = Math.max(...this.cyclePulses.map((p) => p.onMs));
        if (gapMs >= Math.max(320, maxOn * 1.85)) {
          this.cyclePulses = [];
        }
      }
    }

    this.activeOnStartMs = edgeMs;
  }

  private onKeyUp(edgeMs: number): void {
    this.debouncedKeyDown = false;
    if (this.activeOnStartMs === null) return;

    const onMs = Math.max(15, edgeMs - this.activeOnStartMs);
    this.activeOnStartMs = null;

    // Ignore absurdly long continuous carrier (> 1.8s = not Morse keying)
    if (onMs > 1800) {
      this.cyclePulses = [];
      this.lastCompletedOnEndMs = edgeMs;
      return;
    }

    this.cyclePulses.push({
      startMs: edgeMs - onMs,
      endMs: edgeMs,
      onMs,
      offMs: 0,
    });
    this.lastCompletedOnEndMs = edgeMs;

    // If buffer overflowed > 11 pulses (e.g. noise click split a cycle pause),
    // split at the largest internal gap to recover immediately
    if (this.cyclePulses.length > 11) {
      let maxGapIdx = -1;
      let maxGap = 0;
      for (let i = 0; i < this.cyclePulses.length - 1; i++) {
        if (this.cyclePulses[i].offMs > maxGap) {
          maxGap = this.cyclePulses[i].offMs;
          maxGapIdx = i;
        }
      }
      if (maxGapIdx >= 4 && maxGapIdx <= 9) {
        const head = this.cyclePulses.slice(0, maxGapIdx + 1);
        const tail = this.cyclePulses.slice(maxGapIdx + 1);
        this.cyclePulses = head;
        this.flushCycle(edgeMs);
        this.cyclePulses = tail;
      } else {
        this.cyclePulses = this.cyclePulses.slice(-10);
      }
    }
  }

  private flushCycle(nowMs: number): void {
    const segment = this.cyclePulses;
    this.cyclePulses = [];
    if (segment.length < 5 || segment.length > 10) return;

    const match = matchCycleToStation(segment);
    if (match.symbols) {
      this.recentSymbols = match.symbols;
    }

    if (!match.stationId) return;

    this.candidateStation = match.stationId;
    if (match.estimatedWpm !== null) {
      this.estimatedWpm = match.estimatedWpm;
    }

    // Prune old votes (> 14s old)
    this.recentVotes = this.recentVotes.filter(
      (v) => nowMs - v.timestampMs <= 14000,
    );
    this.recentVotes.push({
      stationId: match.stationId,
      confidence: match.confidence,
      wpm: match.estimatedWpm,
      timestampMs: nowMs,
    });
    if (this.recentVotes.length > 5) {
      this.recentVotes.shift();
    }

    // Immediate retune detection: if currently locked to station A, and a crisp
    // new cycle matches station B, unlock A immediately to avoid stale info.
    if (
      this.lockedStation &&
      this.lockedStation !== match.stationId &&
      match.confidence >= 0.78
    ) {
      this.lockedStation = null;
      this.agreeCount = 1;
      this.confidence = match.confidence;
      return;
    }

    // Consensus voting:
    // Lock when the last 2 consecutive cycles agree OR >= 3 of last 4 agree.
    const n = this.recentVotes.length;
    const lastTwoAgree =
      n >= 2 &&
      this.recentVotes[n - 1].stationId === this.recentVotes[n - 2].stationId;

    const counts = new Map<StationId, { count: number; sumConf: number }>();
    for (const v of this.recentVotes) {
      const prev = counts.get(v.stationId) ?? { count: 0, sumConf: 0 };
      prev.count += 1;
      prev.sumConf += v.confidence;
      counts.set(v.stationId, prev);
    }

    let topId: StationId | null = null;
    let topCount = 0;
    let topAvgConf = 0;
    for (const [id, info] of counts.entries()) {
      const avg = info.sumConf / info.count;
      if (info.count > topCount || (info.count === topCount && avg > topAvgConf)) {
        topId = id;
        topCount = info.count;
        topAvgConf = avg;
      }
    }

    if (lastTwoAgree) {
      const id = this.recentVotes[n - 1].stationId;
      const avgConf =
        0.5 *
        (this.recentVotes[n - 1].confidence + this.recentVotes[n - 2].confidence);
      this.lockedStation = id;
      this.confidence = Math.round(avgConf * 100) / 100;
      // Count trailing streak
      let streak = 0;
      for (let i = n - 1; i >= 0 && this.recentVotes[i].stationId === id; i--) {
        streak++;
      }
      this.agreeCount = streak;
    } else if (topId && topCount >= 3 && topAvgConf >= 0.72) {
      this.lockedStation = topId;
      this.confidence = Math.round(topAvgConf * 100) / 100;
      this.agreeCount = topCount;
    } else {
      this.confidence = match.confidence;
      this.agreeCount = 1;
    }
  }

  getSnapshot(): MorseDecoderSnapshot {
    let status: MorseLockStatus = 'listening';
    if (this.lockedStation) {
      status = 'locked';
    } else if (this.candidateStation || this.cyclePulses.length > 0) {
      status = 'identifying';
    }

    return {
      status,
      lockedStation: this.lockedStation,
      candidateStation: this.candidateStation,
      confidence: this.confidence,
      estimatedWpm: this.estimatedWpm,
      recentSymbols: this.recentSymbols,
      keyDown: this.debouncedKeyDown,
      agreeCount: this.agreeCount,
    };
  }
}
