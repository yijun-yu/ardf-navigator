import { normalizeDeg, shortestAngleDelta } from './coords';
import type { AudioFrame, AutoBearingSnapshot } from './types';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const NUM_BINS = 18; // 10-degree bins over [0, 180)
const BIN_WIDTH_DEG = 180 / NUM_BINS;

interface BinSample {
  power: number;
  clipped: boolean;
}

/**
 * Solve 3x3 symmetric positive-definite linear system Ax = b via Gaussian elimination
 * with partial pivoting. Returns null if singular.
 */
function solve3x3(
  A: [[number, number, number], [number, number, number], [number, number, number]],
  b: [number, number, number],
): [number, number, number] | null {
  const M = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];

  for (let col = 0; col < 3; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) {
        pivotRow = r;
      }
    }
    if (Math.abs(M[pivotRow][col]) < 1e-10) return null;
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const pivot = M[col][col];
    for (let c = col; c < 4; c++) M[col][c] /= pivot;

    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c < 4; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  return [M[0][3], M[1][3], M[2][3]];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Half-turn (180°) automatic bearing finder for 80m ferrite-rod direction finders.
 *
 * Physics & DSP design:
 * 1. An 80m ferrite-rod antenna's received power follows a 180°-periodic dipole:
 *      P(theta) = c0 + a*cos(2*theta) + b*sin(2*theta)
 *    with minimum at the sharp null angle theta_null = 0.5 * atan2(-b, -a) mod 180°.
 * 2. Because the transmitter sends pulsed Morse code (on-off keying), naive
 *    averaging would confuse silent inter-dit/inter-word pauses with nulls.
 *    We bin samples into 18 ten-degree sectors over [0, 180) and take the
 *    85th-percentile noise-subtracted power in each bin (selecting key-down
 *    bursts while rejecting 1-frame static impulses).
 * 3. Isolated bins that happened to fall entirely inside a long Morse word pause
 *    (surrounded on both sides by strong bins) are automatically down-weighted,
 *    and Huber-IRLS fits the smooth harmonic dipole curve robustly.
 */
export class AutoBearingSweeper {
  private bins: BinSample[][] = Array.from({ length: NUM_BINS }, () => []);
  private lastHeadingDeg: number | null = null;
  private sweptDeg = 0;
  private totalSamples = 0;
  private clippedSamples = 0;

  reset(): void {
    this.bins = Array.from({ length: NUM_BINS }, () => []);
    this.lastHeadingDeg = null;
    this.sweptDeg = 0;
    this.totalSamples = 0;
    this.clippedSamples = 0;
  }

  addSample(frame: AudioFrame, headingDeg: number): AutoBearingSnapshot {
    const h = normalizeDeg(headingDeg);
    if (this.lastHeadingDeg !== null) {
      this.sweptDeg += Math.abs(shortestAngleDelta(this.lastHeadingDeg, h));
    }
    this.lastHeadingDeg = h;

    // Fold heading into [0, 180) for bidirectional dipole pattern
    const folded = h % 180;
    const binIdx = Math.min(NUM_BINS - 1, Math.floor(folded / BIN_WIDTH_DEG));

    // Uncorrelated noise-power subtraction: P_sig = max(0, tone^2 - noise^2)
    const sigPower = Math.max(
      0,
      frame.toneAmp * frame.toneAmp - frame.noiseFloor * frame.noiseFloor,
    );

    this.bins[binIdx].push({ power: sigPower, clipped: frame.clipped });
    this.totalSamples++;
    if (frame.clipped) this.clippedSamples++;

    return this.evaluate();
  }

  evaluate(): AutoBearingSnapshot {
    const clippedRatio =
      this.totalSamples > 0 ? this.clippedSamples / this.totalSamples : 0;

    // 1. Extract key-down power (85th percentile) in each populated 10° bin
    const rawBinPower: (number | null)[] = new Array(NUM_BINS).fill(null);
    let coveredBins = 0;
    const nonNullPowers: number[] = [];

    for (let i = 0; i < NUM_BINS; i++) {
      const arr = this.bins[i];
      if (arr.length === 0) continue;
      coveredBins++;
      const sorted = arr.map((s) => s.power).sort((a, b) => a - b);
      // Use 85th percentile (or max when only 1-2 samples) to capture key-down bursts
      // while rejecting isolated single-frame QRN impulses.
      const p = sorted.length >= 4 ? quantile(sorted, 0.85) : sorted[sorted.length - 1];
      rawBinPower[i] = p;
      nonNullPowers.push(p);
    }

    if (coveredBins < 6 || nonNullPowers.length < 6) {
      return {
        coveredBins,
        totalBins: NUM_BINS,
        sweptDeg: Math.round(this.sweptDeg),
        bearingDeg: null,
        quality: 0,
        rSquared: 0,
        modDepth: 0,
        clippedRatio: Math.round(clippedRatio * 100) / 100,
        ready: false,
        binPowers: rawBinPower.map(() => null),
        reason: `正在收集角度数据（已转 ${Math.round(this.sweptDeg)}° / 180°）`,
      };
    }

    // Normalize by 90th-percentile bin power so curve fits in [0, ~1.1]
    const sortedRef = [...nonNullPowers].sort((a, b) => a - b);
    const pRef = Math.max(quantile(sortedRef, 0.9), 1e-8);
    const normPowers: (number | null)[] = rawBinPower.map((v) =>
      v === null ? null : Math.min(1.35, v / pRef),
    );

    if (pRef < 1e-6) {
      return {
        coveredBins,
        totalBins: NUM_BINS,
        sweptDeg: Math.round(this.sweptDeg),
        bearingDeg: null,
        quality: 0,
        rSquared: 0,
        modDepth: 0,
        clippedRatio: Math.round(clippedRatio * 100) / 100,
        ready: false,
        binPowers: normPowers,
        reason: '未收到有效电台音频信号，请调大测向机音量或检查接线',
      };
    }

    // 2. Build weighted observations per populated bin, down-weighting isolated
    //    1-bin notches caused by turning through a long Morse word pause.
    interface FitPoint {
      binIdx: number;
      thetaRad: number;
      cos2: number;
      sin2: number;
      y: number;
      baseWeight: number;
    }

    const fitPts: FitPoint[] = [];
    for (let i = 0; i < NUM_BINS; i++) {
      const y = normPowers[i];
      if (y === null) continue;
      const left = normPowers[(i - 1 + NUM_BINS) % NUM_BINS];
      const right = normPowers[(i + 1) % NUM_BINS];

      let baseWeight = Math.min(1.0, Math.sqrt(this.bins[i].length / 3));

      // A true dipole null dips smoothly across ~40-60 deg; a sharp 1-bin drop
      // flanked by strong signal on BOTH sides is a Morse word-pause artifact!
      if (
        left !== null &&
        right !== null &&
        Math.min(left, right) > 0.35 &&
        y < 0.25 * Math.min(left, right)
      ) {
        baseWeight *= 0.08;
      }

      const centerDeg = (i + 0.5) * BIN_WIDTH_DEG;
      const thetaRad = centerDeg * DEG2RAD;
      fitPts.push({
        binIdx: i,
        thetaRad,
        cos2: Math.cos(2 * thetaRad),
        sin2: Math.sin(2 * thetaRad),
        y,
        baseWeight,
      });
    }

    // 3. Robust Huber-IRLS harmonic fit: y(theta) ≈ c0 + a*cos(2*theta) + b*sin(2*theta)
    const weights = fitPts.map((p) => p.baseWeight);
    let c0 = 0.5;
    let a = 0;
    let b = 0;

    const huberDelta = 0.14;
    for (let iter = 0; iter < 8; iter++) {
      let s11 = 0,
        s12 = 0,
        s13 = 0,
        s22 = 0,
        s23 = 0,
        s33 = 0;
      let r1 = 0,
        r2 = 0,
        r3 = 0;

      for (let k = 0; k < fitPts.length; k++) {
        const pt = fitPts[k];
        const w = weights[k];
        s11 += w;
        s12 += w * pt.cos2;
        s13 += w * pt.sin2;
        s22 += w * pt.cos2 * pt.cos2;
        s23 += w * pt.cos2 * pt.sin2;
        s33 += w * pt.sin2 * pt.sin2;

        r1 += w * pt.y;
        r2 += w * pt.cos2 * pt.y;
        r3 += w * pt.sin2 * pt.y;
      }

      const sol = solve3x3(
        [
          [s11 + 1e-6, s12, s13],
          [s12, s22 + 1e-6, s23],
          [s13, s23, s33 + 1e-6],
        ],
        [r1, r2, r3],
      );
      if (!sol) break;
      [c0, a, b] = sol;

      // Update robust weights (down-weight large residuals, especially negative pause dips)
      for (let k = 0; k < fitPts.length; k++) {
        const pt = fitPts[k];
        const pred = c0 + a * pt.cos2 + b * pt.sin2;
        const resid = pt.y - pred;
        const absR = Math.abs(resid);
        // Stronger down-weight on large negative residuals (Morse pause dropouts)
        const delta = resid < 0 ? huberDelta * 0.75 : huberDelta;
        const irlsW = absR <= delta ? 1 : delta / absR;
        weights[k] = pt.baseWeight * irlsW;
      }
    }

    const harmonicAmp = Math.hypot(a, b);
    const fittedMax = Math.max(c0 + harmonicAmp, 1e-6);
    const modDepth = Math.min(1, (2 * harmonicAmp) / fittedMax);

    // Weighted R-squared
    let wMeanY = 0;
    let wSum = 0;
    for (let k = 0; k < fitPts.length; k++) {
      wMeanY += weights[k] * fitPts[k].y;
      wSum += weights[k];
    }
    wMeanY /= Math.max(wSum, 1e-9);

    let ssTot = 0;
    let ssRes = 0;
    for (let k = 0; k < fitPts.length; k++) {
      const pt = fitPts[k];
      const pred = c0 + a * pt.cos2 + b * pt.sin2;
      ssTot += weights[k] * (pt.y - wMeanY) ** 2;
      ssRes += weights[k] * (pt.y - pred) ** 2;
    }
    const rSquared =
      ssTot > 1e-6 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;

    // Exact null angle in [0, 180)
    const twoNullRad = Math.atan2(-b, -a);
    let bearingDeg = (0.5 * twoNullRad * RAD2DEG) % 180;
    if (bearingDeg < 0) bearingDeg += 180;
    bearingDeg = Math.round(bearingDeg * 10) / 10;

    const coverageRatio = coveredBins / NUM_BINS;
    const quality =
      Math.round(
        Math.max(
          0,
          Math.min(
            1,
            rSquared * 0.5 +
              Math.min(1, modDepth / 0.7) * 0.3 +
              Math.min(1, coverageRatio / 0.85) * 0.2,
          ),
        ) * 100,
      ) / 100;

    // Validity & runner-facing diagnostic reason
    if (coveredBins < 12) {
      return {
        coveredBins,
        totalBins: NUM_BINS,
        sweptDeg: Math.round(this.sweptDeg),
        bearingDeg: modDepth >= 0.3 && rSquared >= 0.4 ? bearingDeg : null,
        quality,
        rSquared: Math.round(rSquared * 100) / 100,
        modDepth: Math.round(modDepth * 100) / 100,
        clippedRatio: Math.round(clippedRatio * 100) / 100,
        ready: false,
        binPowers: normPowers,
        reason: `继续慢慢转身（已覆盖 ${coveredBins * 10}° / 180°）`,
      };
    }

    if (clippedRatio > 0.35 && modDepth < 0.55) {
      return {
        coveredBins,
        totalBins: NUM_BINS,
        sweptDeg: Math.round(this.sweptDeg),
        bearingDeg: null,
        quality,
        rSquared: Math.round(rSquared * 100) / 100,
        modDepth: Math.round(modDepth * 100) / 100,
        clippedRatio: Math.round(clippedRatio * 100) / 100,
        ready: false,
        binPowers: normPowers,
        reason: '音量过大导致爆音饱和，请调小测向机音量后重扫',
      };
    }

    if (modDepth < 0.3) {
      return {
        coveredBins,
        totalBins: NUM_BINS,
        sweptDeg: Math.round(this.sweptDeg),
        bearingDeg: null,
        quality,
        rSquared: Math.round(rSquared * 100) / 100,
        modDepth: Math.round(modDepth * 100) / 100,
        clippedRatio: Math.round(clippedRatio * 100) / 100,
        ready: false,
        binPowers: normPowers,
        reason: '未检测到明显强弱变化（请确认测向机随身体一起转动，且未开满音量）',
      };
    }

    if (rSquared < 0.45) {
      return {
        coveredBins,
        totalBins: NUM_BINS,
        sweptDeg: Math.round(this.sweptDeg),
        bearingDeg: null,
        quality,
        rSquared: Math.round(rSquared * 100) / 100,
        modDepth: Math.round(modDepth * 100) / 100,
        clippedRatio: Math.round(clippedRatio * 100) / 100,
        ready: false,
        binPowers: normPowers,
        reason: '方向曲线杂波较大，请放慢速度再转半圈',
      };
    }

    return {
      coveredBins,
      totalBins: NUM_BINS,
      sweptDeg: Math.round(this.sweptDeg),
      bearingDeg,
      quality,
      rSquared: Math.round(rSquared * 100) / 100,
      modDepth: Math.round(modDepth * 100) / 100,
      clippedRatio: Math.round(clippedRatio * 100) / 100,
      ready: true,
      binPowers: normPowers,
      reason: `拟合锁定 ${Math.round(bearingDeg)}° / ${Math.round((bearingDeg + 180) % 360)}°（匹配度 ${Math.round(rSquared * 100)}%）`,
    };
  }
}
