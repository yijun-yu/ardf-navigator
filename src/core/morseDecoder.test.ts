import { describe, expect, it } from 'vitest';
import {
  generateSyntheticAudioFrames,
  wpmToDitMs,
} from './cwSynthesizer';
import {
  ArdfMorseDecoder,
  matchCycleToStation,
  type PulseRecord,
} from './morseDecoder';
import { STATIONS } from './stations';
import type { StationId } from './types';

function runDecoderOnStation(
  stationId: StationId,
  opts?: {
    wpm?: number;
    snrDb?: number;
    durationMs?: number;
    phaseOffsetMs?: number;
    weightRatio?: number;
    impulseProb?: number;
    seed?: number;
  },
) {
  const decoder = new ArdfMorseDecoder();
  const samples = generateSyntheticAudioFrames({
    stationId,
    wpm: opts?.wpm ?? 12,
    snrDb: opts?.snrDb ?? 16,
    durationMs: opts?.durationMs ?? 12000,
    phaseOffsetMs: opts?.phaseOffsetMs ?? 0,
    weightRatio: opts?.weightRatio ?? 1.0,
    impulseProb: opts?.impulseProb ?? 0,
    seed: opts?.seed ?? 101,
  });

  let snap = decoder.getSnapshot();
  for (const s of samples) {
    snap = decoder.feedFrame(s.frame);
  }
  return snap;
}

describe('ArdfMorseDecoder', () => {
  it('accurately decodes and locks all 11 Chinese 80m ARDF stations', () => {
    for (let i = 0; i < STATIONS.length; i++) {
      const st = STATIONS[i];
      const snap = runDecoderOnStation(st.id, {
        wpm: 12,
        snrDb: 16,
        durationMs: 13000,
        seed: 200 + i,
      });
      expect(snap.status, `station ${st.id} (${st.callsign})`).toBe('locked');
      expect(snap.lockedStation, `station ${st.id}`).toBe(st.id);
      expect(snap.confidence).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('reliably distinguishes 0 (-----) from MO (-- ---) across speeds and keying weights', () => {
    const configs = [
      { wpm: 8, weightRatio: 1.0, durationMs: 18000 },
      { wpm: 12, weightRatio: 1.15, durationMs: 13000 },
      { wpm: 18, weightRatio: 0.9, durationMs: 10000 },
    ];

    for (const cfg of configs) {
      const snapZero = runDecoderOnStation('0', { ...cfg, snrDb: 14, seed: 301 });
      expect(snapZero.lockedStation).toBe('0');
      expect(snapZero.status).toBe('locked');

      const snapMo = runDecoderOnStation('MO', { ...cfg, snrDb: 14, seed: 302 });
      expect(snapMo.lockedStation).toBe('MO');
      expect(snapMo.status).toBe('locked');
    }
  });

  it('adapts to slow (8 WPM) and fast (20 WPM) transmitters without manual speed config', () => {
    const slow = runDecoderOnStation('3', { wpm: 8, durationMs: 20000, seed: 401 });
    expect(slow.lockedStation).toBe('3');
    expect(slow.estimatedWpm!).toBeGreaterThan(6.5);
    expect(slow.estimatedWpm!).toBeLessThan(9.5);

    const fast = runDecoderOnStation('5', { wpm: 20, durationMs: 10000, seed: 402 });
    expect(fast.lockedStation).toBe('5');
    expect(fast.estimatedWpm!).toBeGreaterThan(17);
    expect(fast.estimatedWpm!).toBeLessThan(23);
  });

  it('recovers cleanly when tuning in mid-cycle under noise and static impulses', () => {
    const snap = runDecoderOnStation('4', {
      wpm: 13,
      snrDb: 11,
      durationMs: 16000,
      phaseOffsetMs: 780, // starts mid-callsign
      impulseProb: 0.012, // occasional 1-frame static pops
      seed: 505,
    });
    expect(snap.status).toBe('locked');
    expect(snap.lockedStation).toBe('4');
  });

  it('rejects pure 5-dit noise bursts from falsely matching 0 or MO', () => {
    const u = wpmToDitMs(12); // 100ms
    const fiveDits: PulseRecord[] = Array.from({ length: 5 }, (_, idx) => ({
      startMs: idx * 2 * u,
      endMs: idx * 2 * u + u,
      onMs: u,
      offMs: idx < 4 ? u : 0,
    }));
    const res = matchCycleToStation(fiveDits);
    expect(res.stationId).toBeNull();
  });

  it('switches lock quickly when user tunes from one station to another', () => {
    const decoder = new ArdfMorseDecoder();
    const part1 = generateSyntheticAudioFrames({
      stationId: '1',
      wpm: 13,
      snrDb: 16,
      durationMs: 10000,
      startTimeMs: 0,
      seed: 601,
    });
    const part2 = generateSyntheticAudioFrames({
      stationId: '8',
      wpm: 13,
      snrDb: 16,
      durationMs: 10000,
      startTimeMs: 10500,
      seed: 602,
    });

    let snap = decoder.getSnapshot();
    for (const s of part1) snap = decoder.feedFrame(s.frame);
    expect(snap.lockedStation).toBe('1');

    for (const s of part2) snap = decoder.feedFrame(s.frame);
    expect(snap.status).toBe('locked');
    expect(snap.lockedStation).toBe('8');
  });

  it('does not falsely lock on pure background noise', () => {
    const decoder = new ArdfMorseDecoder();
    const noiseOnly = generateSyntheticAudioFrames({
      stationId: '1',
      wpm: 12,
      snrDb: -30, // practically zero signal
      durationMs: 10000,
      seed: 707,
    });
    let snap = decoder.getSnapshot();
    for (const s of noiseOnly) snap = decoder.feedFrame(s.frame);
    expect(snap.lockedStation).toBeNull();
  });

  it('decodes Farnsworth-spaced ARDF beacons (4.6u letter gap, 11u cycle gap) without truncation', () => {
    const farnsworthStations: StationId[] = ['1', '2', '3', '4', '5'];
    for (let i = 0; i < farnsworthStations.length; i++) {
      const id = farnsworthStations[i];
      const decoder = new ArdfMorseDecoder();
      const samples = generateSyntheticAudioFrames({
        stationId: id,
        wpm: 12.5,
        snrDb: 18,
        letterGapUnits: 4.6,
        cycleGapUnits: 11.2,
        phaseOffsetMs: 900,
        durationMs: 18000,
        seed: 800 + i,
      });
      let snap = decoder.getSnapshot();
      for (const s of samples) snap = decoder.feedFrame(s.frame);
      expect(snap.status, `Farnsworth station ${id}`).toBe('locked');
      expect(snap.lockedStation, `Farnsworth station ${id}`).toBe(id);
    }
  });

  it('decodes equal-gap continuous MO (-- [6.8u] --- [6.8u]) even when tuning in mid-cycle on O', () => {
    const decoder = new ArdfMorseDecoder();
    const samples = generateSyntheticAudioFrames({
      stationId: 'MO',
      wpm: 13.5,
      snrDb: 18,
      letterGapUnits: 6.8,
      cycleGapUnits: 6.8,
      phaseOffsetMs: 1250, // starts on 'O'
      durationMs: 16000,
      seed: 901,
    });
    let snap = decoder.getSnapshot();
    for (const s of samples) snap = decoder.feedFrame(s.frame);
    expect(snap.status).toBe('locked');
    expect(snap.lockedStation).toBe('MO');
  });

  it('compensates indoor speaker reverb (+45ms pulse stretch / -45ms gap shrink) without false 0 match', () => {
    const u = 96; // ~12.5 WPM
    const delta = 45; // strong room echo
    // MO5 with Farnsworth 4.6u letter gap and +45ms/-45ms reverb distortion
    const onUnits = [3, 3, 3, 3, 3, 1, 1, 1, 1, 1];
    const gapUnits = [1, 4.6, 1, 1, 4.6, 1, 1, 1, 1];
    let t = 0;
    const pulses: PulseRecord[] = onUnits.map((ou, idx) => {
      const onMs = ou * u + delta;
      const offMs = idx < gapUnits.length ? gapUnits[idx] * u - delta : 0;
      const rec = { startMs: t, endMs: t + onMs, onMs, offMs };
      t += onMs + offMs;
      return rec;
    });
    const res = matchCycleToStation(pulses);
    expect(res.stationId).toBe('5');
    expect(res.confidence).toBeGreaterThanOrEqual(0.85);

    // Heavy-keyed 5-dit burst (120ms ON / 70ms OFF) must still NEVER match '0'
    const heavyFiveDits: PulseRecord[] = Array.from({ length: 5 }, (_, idx) => ({
      startMs: idx * 190,
      endMs: idx * 190 + 120,
      onMs: 120,
      offMs: idx < 4 ? 70 : 0,
    }));
    expect(matchCycleToStation(heavyFiveDits).stationId).toBeNull();
  });
});
