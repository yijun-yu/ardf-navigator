import { describe, expect, it } from 'vitest';
import { AutoBearingSweeper } from './autoBearing';
import { generateSyntheticAudioFrames } from './cwSynthesizer';

function bearingErrorMod180(estDeg: number, trueDeg: number): number {
  let diff = Math.abs((estDeg % 180) - (trueDeg % 180));
  if (diff > 90) diff = 180 - diff;
  return diff;
}

describe('AutoBearingSweeper (half-turn dipole fitter)', () => {
  it('fits accurate null bearing within 5° across varied true angles despite Morse keying gaps', () => {
    const trueAngles = [12, 65, 118, 168];

    for (let idx = 0; idx < trueAngles.length; idx++) {
      const trueNull = trueAngles[idx];
      const sweeper = new AutoBearingSweeper();

      // 4-second smooth 200° half-turn while station '3' (MOS) keys Morse code
      const durationMs = 4200;
      const samples = generateSyntheticAudioFrames({
        stationId: idx % 2 === 0 ? '3' : 'MO',
        wpm: 13,
        snrDb: 18,
        durationMs,
        headingFn: (t) => (25 + (t / durationMs) * 200) % 360,
        trueNullDeg: trueNull,
        nullLeakage: 0.08,
        seed: 800 + idx,
      });

      let snap = sweeper.evaluate();
      for (const s of samples) {
        snap = sweeper.addSample(s.frame, s.headingDeg!);
      }

      expect(snap.ready, `angle ${trueNull}`).toBe(true);
      expect(snap.bearingDeg).not.toBeNull();
      expect(bearingErrorMod180(snap.bearingDeg!, trueNull)).toBeLessThan(5);
      expect(snap.rSquared).toBeGreaterThan(0.65);
      expect(snap.modDepth).toBeGreaterThan(0.5);
    }
  });

  it('works cleanly across 0°/180° wraparound null bearing', () => {
    const sweeper = new AutoBearingSweeper();
    const durationMs = 4500;
    const trueNull = 2; // right near 0° / 180° boundary

    const samples = generateSyntheticAudioFrames({
      stationId: '1',
      wpm: 14,
      snrDb: 17,
      durationMs,
      headingFn: (t) => (300 + (t / durationMs) * 210) % 360,
      trueNullDeg: trueNull,
      nullLeakage: 0.1,
      seed: 901,
    });

    let snap = sweeper.evaluate();
    for (const s of samples) {
      snap = sweeper.addSample(s.frame, s.headingDeg!);
    }

    expect(snap.ready).toBe(true);
    expect(bearingErrorMod180(snap.bearingDeg!, trueNull)).toBeLessThan(5);
  });

  it('rejects insufficient rotation coverage (< 120°)', () => {
    const sweeper = new AutoBearingSweeper();
    const durationMs = 2000;
    const samples = generateSyntheticAudioFrames({
      stationId: '2',
      wpm: 12,
      snrDb: 18,
      durationMs,
      headingFn: (t) => 40 + (t / durationMs) * 70, // only turned 70°
      trueNullDeg: 90,
      seed: 902,
    });

    let snap = sweeper.evaluate();
    for (const s of samples) {
      snap = sweeper.addSample(s.frame, s.headingDeg!);
    }
    expect(snap.ready).toBe(false);
    expect(snap.coveredBins).toBeLessThan(12);
  });

  it('rejects saturated/flat clipped audio with clear warning', () => {
    const sweeper = new AutoBearingSweeper();
    const durationMs = 4000;
    const samples = generateSyntheticAudioFrames({
      stationId: '4',
      wpm: 12,
      snrDb: 26,
      durationMs,
      headingFn: (t) => (t / durationMs) * 200,
      trueNullDeg: 75,
      nullLeakage: 0.65, // flat + heavily overdriven
      clipGain: 8.0,
      seed: 903,
    });

    let snap = sweeper.evaluate();
    for (const s of samples) {
      snap = sweeper.addSample(s.frame, s.headingDeg!);
    }
    expect(snap.ready).toBe(false);
    expect(snap.clippedRatio).toBeGreaterThan(0.35);
  });

  it('rejects static/flat signal when user did not rotate receiver', () => {
    const sweeper = new AutoBearingSweeper();
    const durationMs = 4000;
    // Heading changes, but audio has no directional modulation (nullLeakage = 1.0)
    const samples = generateSyntheticAudioFrames({
      stationId: '5',
      wpm: 12,
      snrDb: 18,
      durationMs,
      headingFn: (t) => (t / durationMs) * 200,
      trueNullDeg: 50,
      nullLeakage: 1.0,
      seed: 904,
    });

    let snap = sweeper.evaluate();
    for (const s of samples) {
      snap = sweeper.addSample(s.frame, s.headingDeg!);
    }
    expect(snap.ready).toBe(false);
    expect(snap.modDepth).toBeLessThan(0.3);
  });
});
