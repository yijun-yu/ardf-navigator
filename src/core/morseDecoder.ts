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
  /** Precomputed natural logs of onUnits */
  logOnUnits: number[];
  /** True for inter-letter gaps (3u standard, up to ~7u Farnsworth); false for 1u intra gaps */
  isLetterGap: boolean[];
  /** True for templates composed solely of dahs ('0' and 'MO') */
  allDahs: boolean;
}

function buildTemplates(): StationTemplate[] {
  return STATIONS.map((st) => {
    const letters = st.morse.trim().split(/\s+/);
    const onUnits: number[] = [];
    const isLetterGap: boolean[] = [];
    for (let li = 0; li < letters.length; li++) {
      const sym = letters[li];
      for (let si = 0; si < sym.length; si++) {
        onUnits.push(sym[si] === '-' ? 3 : 1);
        if (si < sym.length - 1) {
          isLetterGap.push(false);
        } else if (li < letters.length - 1) {
          isLetterGap.push(true);
        }
      }
    }
    return {
      id: st.id,
      pulseCount: onUnits.length,
      onUnits,
      logOnUnits: onUnits.map((v) => Math.log(v)),
      isLetterGap,
      allDahs: onUnits.every((u) => u === 3),
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

interface DetailedMatchResult extends CycleMatchResult {
  uAvg: number;
  uIntra: number;
  uLetter: number | null;
}

function matchCycleDetailed(pulses: PulseRecord[]): DetailedMatchResult {
  const m = pulses.length;
  if (m < 5 || m > 10) {
    return {
      stationId: null,
      confidence: 0,
      secondBestScore: 0,
      estimatedWpm: null,
      symbols: '',
      uAvg: 100,
      uIntra: 100,
      uLetter: null,
    };
  }

  let bestId: StationId | null = null;
  let bestScore = 0;
  let secondScore = 0;
  let bestUAvg = 100;
  let bestUIntra = 100;
  let bestULetter: number | null = null;

  for (let ti = 0; ti < TEMPLATES.length; ti++) {
    const tpl = TEMPLATES[ti];
    if (tpl.pulseCount !== m) continue;

    // 1. Estimate additive edge-stretch bias `delta` (from room reverb, FFT window
    //    skirt, or heavy/light keying) using the reverb-invariant period sum:
    //    (on + intra) = (onUnits + 1) * u  =>  delta cancels out completely!
    let sumRawOn = 0;
    let sumOnUnits = 0;
    for (let i = 0; i < m; i++) {
      sumRawOn += Math.max(15, pulses[i].onMs);
      sumOnUnits += tpl.onUnits[i];
    }
    let sumRawIntra = 0;
    let intraCount = 0;
    let letterCount = 0;
    for (let i = 0; i < m - 1; i++) {
      if (tpl.isLetterGap[i]) {
        letterCount++;
      } else {
        sumRawIntra += Math.max(15, pulses[i].offMs);
        intraCount++;
      }
    }
    if (intraCount === 0) continue;

    const meanRawOn = sumRawOn / m;
    const meanOnUnits = sumOnUnits / m;
    const meanRawIntra = sumRawIntra / intraCount;
    const uPeriod = (meanRawOn + meanRawIntra) / (meanOnUnits + 1);

    // Physical speed sanity check (~4.0 WPM to 42 WPM)
    if (uPeriod < 28 || uPeriod > 300) continue;

    // Additive edge bias: positive = pulses stretched & gaps narrowed (reverb / heavy keying)
    const rawDelta = uPeriod - meanRawIntra;
    const normDelta = rawDelta / uPeriod;

    // Guard against unphysical edge bias:
    // - For all-dah stations ('0', 'MO'), reject negative bias < -0.32u so 5-dit bursts
    //   (even heavy-keyed 120ms/70ms -> normDelta = -0.47) can NEVER match '0'.
    // - Allow up to +0.64u positive bias for strong indoor speaker reverb.
    const minNormDelta = tpl.allDahs ? -0.32 : -0.42;
    if (normDelta < minNormDelta || normDelta > 0.64) continue;

    // Compensate additive edge bias symmetrically before log-space template scoring
    const appliedDelta = rawDelta;
    const logOn: number[] = new Array(m);
    for (let i = 0; i < m; i++) {
      logOn[i] = Math.log(Math.max(15, pulses[i].onMs - appliedDelta));
    }
    const logGap: number[] = new Array(m - 1);
    for (let i = 0; i < m - 1; i++) {
      logGap[i] = Math.log(Math.max(15, pulses[i].offMs + appliedDelta));
    }

    // 2. Optimal log(u_on), log(u_intra), and Farnsworth log(u_letter)
    let sumLogOn = 0;
    for (let i = 0; i < m; i++) {
      sumLogOn += logOn[i] - tpl.logOnUnits[i];
    }
    const logUOn = sumLogOn / m;

    let sumLogIntra = 0;
    let sumLogLetter = 0;
    for (let i = 0; i < m - 1; i++) {
      if (tpl.isLetterGap[i]) {
        sumLogLetter += logGap[i];
      } else {
        sumLogIntra += logGap[i];
      }
    }
    const logUIntra = sumLogIntra / intraCount;
    const logULetter = letterCount > 0 ? sumLogLetter / letterCount : null;

    const uOn = Math.exp(logUOn);
    const uIntra = Math.exp(logUIntra);
    const uLetter = logULetter !== null ? Math.exp(logULetter) : null;
    const uAvg = Math.sqrt(uOn * uIntra);

    if (uAvg < 28 || uAvg > 300) continue;

    const ratioDrift = logUOn - logUIntra;
    if (Math.abs(ratioDrift) > 0.55) continue;

    // Farnsworth letter-gap check: inter-letter pause must be clearly longer than intra gap
    let letterPriorPen = 0;
    if (uLetter !== null && logULetter !== null) {
      const letterRatioIntra = uLetter / uIntra;
      const letterRatioAvg = uLetter / uAvg;
      if (letterRatioIntra < 1.95 || letterRatioAvg > 11.5) continue;
      if (letterRatioIntra < 2.3) {
        const d = Math.log(2.3) - Math.log(letterRatioIntra);
        letterPriorPen = 4.0 * d * d;
      } else if (letterRatioAvg > 8.2) {
        const d = Math.log(letterRatioAvg) - Math.log(8.2);
        letterPriorPen = 1.5 * d * d;
      }
    }

    // Per-element log-space timing residuals + structural guards
    let errSqSum = 0;
    let maxOnErr = 0;
    for (let i = 0; i < m; i++) {
      const r = logOn[i] - (logUOn + tpl.logOnUnits[i]);
      const absR = Math.abs(r);
      if (absR > maxOnErr) maxOnErr = absR;
      errSqSum += r * r;
    }

    let maxIntraErr = 0;
    let maxLetterErr = 0;
    for (let i = 0; i < m - 1; i++) {
      if (tpl.isLetterGap[i] && logULetter !== null) {
        const r = logGap[i] - logULetter;
        const absR = Math.abs(r);
        if (absR > maxLetterErr) maxLetterErr = absR;
        errSqSum += 1.35 * r * r;
      } else {
        const r = logGap[i] - logUIntra;
        const absR = Math.abs(r);
        if (absR > maxIntraErr) maxIntraErr = absR;
        errSqSum += 1.35 * r * r;
      }
    }

    // Structural guards:
    // - A dit (~1u) must never match a dah (~3u) (ln(3) ≈ 1.10)
    // - A letter space (~3u..7u) must never sneak into an intra-gap slot (separates MO vs 0)
    // - Multiple letter spaces within MOE..MO5 must be mutually consistent
    if (maxOnErr > 0.62 || maxIntraErr > 0.68 || maxLetterErr > 0.55) {
      continue;
    }

    // Mild penalty for extreme edge stretch so clean matches beat stretched coincidences
    const excessDelta = Math.max(0, Math.abs(normDelta) - 0.28);
    const deltaPen = 1.4 * excessDelta * excessDelta;

    const weightCount = m + 1.35 * (m - 1) + 1.8;
    const totalMse =
      (errSqSum + 1.8 * ratioDrift * ratioDrift + letterPriorPen + deltaPen) /
      weightCount;
    const score = Math.exp(-4.2 * totalMse);

    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestId = tpl.id;
      bestUAvg = uAvg;
      bestUIntra = uIntra;
      // Report raw (uncompensated) letter gap so boundary checks match actual silence ms
      bestULetter = uLetter !== null ? Math.max(uIntra * 1.9, uLetter - appliedDelta) : null;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }

  const symbols = formatPulsesAsSymbols(pulses, bestUAvg);
  const margin = bestScore - secondScore;

  if (!bestId || bestScore < 0.66 || margin < 0.12) {
    return {
      stationId: null,
      confidence: Math.round(bestScore * 100) / 100,
      secondBestScore: Math.round(secondScore * 100) / 100,
      estimatedWpm: null,
      symbols,
      uAvg: bestUAvg,
      uIntra: bestUIntra,
      uLetter: bestULetter,
    };
  }

  return {
    stationId: bestId,
    confidence: Math.round(bestScore * 100) / 100,
    secondBestScore: Math.round(secondScore * 100) / 100,
    estimatedWpm: Math.round((1200 / bestUAvg) * 10) / 10,
    symbols,
    uAvg: bestUAvg,
    uIntra: bestUIntra,
    uLetter: bestULetter,
  };
}

/**
 * Score a candidate cycle of completed pulses against all 11 ARDF station
 * templates using continuous, Farnsworth-invariant log-time template matching.
 *
 * Key properties:
 * - Speed-invariant across ~4 to 42 WPM (solves optimal dot unit analytically).
 * - Farnsworth-invariant: supports both standard 3u inter-letter gaps and
 *   extended 4u-7u ARDF beacon letter pauses without false truncation.
 * - Explicitly distinguishes 0 ('-----', uniform 1u internal gaps) from
 *   MO ('-- ---', extended letter space between 2nd and 3rd dah).
 * - Rejects heavy-keyed 5-dit noise bursts from matching 0 or MO.
 */
export function matchCycleToStation(pulses: PulseRecord[]): CycleMatchResult {
  const det = matchCycleDetailed(pulses);
  return {
    stationId: det.stationId,
    confidence: det.confidence,
    secondBestScore: det.secondBestScore,
    estimatedWpm: det.estimatedWpm,
    symbols: det.symbols,
  };
}

function formatPulsesAsSymbols(pulses: PulseRecord[], unitMs: number): string {
  const safeU = Math.max(28, Math.min(300, unitMs));
  let out = '';
  for (let i = 0; i < pulses.length; i++) {
    out += pulses[i].onMs >= safeU * 1.9 ? '—' : '·';
    if (i < pulses.length - 1 && pulses[i].offMs >= safeU * 1.95) {
      out += ' ';
    }
  }
  return out;
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

const MAX_HISTORY_PULSES = 24;

/**
 * Streaming, noise-resistant, speed- & Farnsworth-adaptive 80m ARDF Morse decoder.
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

  private activeOnStartMs: number | null = null;
  private lastCompletedOnEndMs: number | null = null;

  // Rolling ring buffer of completed pulses (never blindly truncated on Farnsworth gaps)
  private pulseHistory: PulseRecord[] = [];
  private lastVotedEndMs = -1;
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
    this.pulseHistory = [];
    this.lastVotedEndMs = -1;
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

    // 1. Update rolling SNR envelope window (last 4.8 seconds so slow dah-heavy
    //    ARDF cycles like MO/MO5 always include true inter-cycle silence)
    const metric = Math.max(0, Math.min(35, frame.snrDb));
    this.metricWindow.push({ timestampMs: now, value: metric });
    const cutoff = now - 4800;
    while (
      this.metricWindow.length > 0 &&
      this.metricWindow[0].timestampMs < cutoff
    ) {
      this.metricWindow.shift();
    }

    // 2. Adaptive hysteresis Schmitt trigger
    let nextRaw = this.rawKeyDown;
    if (this.metricWindow.length >= 6) {
      const sorted = this.metricWindow
        .map((s) => s.value)
        .sort((a, b) => a - b);
      // 12th percentile catches true silence even under room reverb or high duty cycle
      const lowP = sorted[Math.floor(sorted.length * 0.12)];
      const highP = sorted[Math.floor(sorted.length * 0.92)];
      const spread = highP - lowP;

      if (spread >= 3.5 && highP >= 4.8) {
        // At high SNR (e.g. clean speaker or direct cable), thresholding at 39% of dB
        // range sits -20 dB down on the FFT window / room reverb skirt, inflating ON
        // pulses by +40ms and shrinking gaps by -40ms. Clamping near -6.5/-10 dB below
        // highP measures edges right around the 50% linear-amplitude midpoint while
        // falling back seamlessly to proportional thresholds at low SNR.
        const onTh = Math.max(lowP + 0.56 * spread, highP - 5.5);
        const offTh = Math.max(lowP + 0.42 * spread, highP - 8.5);
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

    // 3. Deglitch short transient spikes and micro-dropouts
    const dwellMs = now - this.stateStartMs;
    if (
      this.rawKeyDown &&
      !this.debouncedKeyDown &&
      dwellMs >= this.minPulseMs
    ) {
      this.onKeyDown(this.stateStartMs);
    } else if (
      !this.rawKeyDown &&
      this.debouncedKeyDown &&
      dwellMs >= this.minGapMs
    ) {
      this.onKeyUp(this.stateStartMs);
    }

    // 4. Live silence check to finalize a completed cycle without waiting for next pulse
    if (!this.debouncedKeyDown && this.lastCompletedOnEndMs !== null) {
      const silentMs = now - this.lastCompletedOnEndMs;
      const lastIdx = this.pulseHistory.length - 1;
      if (
        lastIdx >= 4 &&
        this.pulseHistory[lastIdx].endMs > this.lastVotedEndMs
      ) {
        this.tryEmitCycleAt(lastIdx, silentMs, null, now);
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

    const lastIdx = this.pulseHistory.length - 1;
    if (lastIdx >= 0 && this.lastCompletedOnEndMs !== null) {
      const gapMs = Math.max(0, edgeMs - this.lastCompletedOnEndMs);
      this.pulseHistory[lastIdx].offMs = gapMs;

      // If a huge silence gap (> 2.6s) separates transmissions, reset history cleanly
      if (gapMs > 2600) {
        if (
          lastIdx >= 4 &&
          this.pulseHistory[lastIdx].endMs > this.lastVotedEndMs
        ) {
          this.tryEmitCycleAt(lastIdx, gapMs, null, edgeMs);
        }
        this.pulseHistory = [];
      } else if (
        lastIdx >= 4 &&
        this.pulseHistory[lastIdx].endMs > this.lastVotedEndMs
      ) {
        // Check if the completed gap was a clean cycle break (in case live silence didn't trigger yet)
        this.tryEmitCycleAt(lastIdx, gapMs, null, edgeMs);
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
      this.pulseHistory = [];
      this.lastCompletedOnEndMs = edgeMs;
      return;
    }

    this.pulseHistory.push({
      startMs: edgeMs - onMs,
      endMs: edgeMs,
      onMs,
      offMs: 0,
    });
    if (this.pulseHistory.length > MAX_HISTORY_PULSES) {
      this.pulseHistory.shift();
    }
    this.lastCompletedOnEndMs = edgeMs;

    // Look back 1 pulse: now that we know the duration of the newly arrived pulse
    // (dit vs dah), we can definitively disambiguate equal-gap 'MO' (where next
    // pulse is a dah starting the next 'M') from 'MOE..MO5' (where next pulse is a dit).
    const prevIdx = this.pulseHistory.length - 2;
    if (
      prevIdx >= 4 &&
      this.pulseHistory[prevIdx].endMs > this.lastVotedEndMs
    ) {
      const gapAfterPrev = this.pulseHistory[prevIdx].offMs;
      this.tryEmitCycleAt(prevIdx, gapAfterPrev, onMs, edgeMs);
    }
  }

  /**
   * Search candidate cycles of length 5..10 ending at `endIdx` in `pulseHistory`
   * and vote if a valid boundary-verified station match is found.
   */
  private tryEmitCycleAt(
    endIdx: number,
    followingGapMs: number,
    nextPulseOnMs: number | null,
    nowMs: number,
  ): boolean {
    if (endIdx < 4 || endIdx >= this.pulseHistory.length) return false;
    if (this.pulseHistory[endIdx].endMs <= this.lastVotedEndMs) return false;

    let chosen: {
      det: DetailedMatchResult;
      length: number;
      segment: PulseRecord[];
    } | null = null;
    let hasPendingLongerMatch = false;

    for (let len = 10; len >= 5; len--) {
      const startIdx = endIdx - len + 1;
      if (startIdx < 0) continue;

      const segment = this.pulseHistory.slice(startIdx, endIdx + 1);
      const det = matchCycleDetailed(segment);
      if (!det.stationId) continue;

      // 1. Verify preceding boundary so we never match a mid-cycle suffix
      if (startIdx > 0) {
        const prevGap = this.pulseHistory[startIdx - 1].offMs;
        const minPrevGap =
          det.uLetter !== null
            ? Math.max(det.uIntra * 2.2, det.uLetter * 0.72)
            : det.uIntra * 2.5;
        if (prevGap < minPrevGap) continue;
      }

      // 2. Verify following boundary (Farnsworth-safe!)
      const followOk = this.isValidFollowingBoundary(
        det,
        followingGapMs,
        nextPulseOnMs,
      );
      if (!followOk) {
        // If a longer callsign (e.g. MO5 len=10) already matches cleanly and is only
        // waiting for silence to reach its cycle break, do NOT let a shorter suffix
        // (like the trailing 5 dits under heavy reverb looking like fast '0') preempt it!
        if (len > 5 && nextPulseOnMs === null && det.confidence >= 0.7) {
          hasPendingLongerMatch = true;
        }
        continue;
      }

      if (len === 5 && hasPendingLongerMatch) {
        continue;
      }

      // Prefer higher confidence; break close ties in favor of longer complete callsign
      if (
        !chosen ||
        det.confidence > chosen.det.confidence + 0.04 ||
        (Math.abs(det.confidence - chosen.det.confidence) <= 0.04 &&
          len > chosen.length)
      ) {
        chosen = { det, length: len, segment };
      }
    }

    if (!chosen) return false;

    this.lastVotedEndMs = this.pulseHistory[endIdx].endMs;
    this.recordMatch(chosen.det, nowMs);
    return true;
  }

  private isValidFollowingBoundary(
    det: DetailedMatchResult,
    followingGapMs: number,
    nextPulseOnMs: number | null,
  ): boolean {
    if (det.stationId === 'MO') {
      const letterG = det.uLetter ?? 3 * det.uIntra;
      const clearSilenceBreak = Math.max(260, 4.3 * det.uAvg, 1.42 * letterG);
      if (followingGapMs >= clearSilenceBreak) {
        return true;
      }
      // Equal-gap MO (e.g. M [610ms] O [610ms] M [610ms] O):
      // Confirmed as soon as the following pulse completes as a DAH (next 'M'),
      // because MOE/MOI/MOS/MOH/MO5 always follow 'O' with a DIT!
      if (
        nextPulseOnMs !== null &&
        followingGapMs >= Math.max(260, 3.8 * det.uAvg, 0.78 * letterG) &&
        nextPulseOnMs >= det.uAvg * 1.9
      ) {
        return true;
      }
      return false;
    }

    if (det.uLetter !== null) {
      // MOE, MOI, MOS, MOH, MO5: following cycle gap must clearly exceed letter gap
      const minFollow = Math.max(260, 4.2 * det.uAvg, 1.28 * det.uLetter);
      return followingGapMs >= minFollow;
    }

    // 6, 7, 8, 9, 0 (single-character digits, no internal letter gaps)
    const minFollow = Math.max(240, 4.0 * det.uAvg);
    return followingGapMs >= minFollow;
  }

  private recordMatch(match: DetailedMatchResult, nowMs: number): void {
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
      if (
        info.count > topCount ||
        (info.count === topCount && avg > topAvgConf)
      ) {
        topId = id;
        topCount = info.count;
        topAvgConf = avg;
      }
    }

    if (lastTwoAgree) {
      const id = this.recentVotes[n - 1].stationId;
      const avgConf =
        0.5 *
        (this.recentVotes[n - 1].confidence +
          this.recentVotes[n - 2].confidence);
      this.lockedStation = id;
      this.confidence = Math.round(avgConf * 100) / 100;
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
    } else if (this.candidateStation || this.pulseHistory.length > 0) {
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
