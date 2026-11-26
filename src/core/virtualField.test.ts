import { describe, expect, it } from 'vitest';
import { AutoBearingSweeper } from './autoBearing';
import { CAMPUSES } from './campuses';
import {
  haversineMeters,
  isPointInPolygon,
  localToLngLat,
} from './coords';
import { createSeededRng } from './cwSynthesizer';
import { ArdfMorseDecoder } from './morseDecoder';
import { extractRoutableTargets, solveOptimalRoute } from './routePlanner';
import { triangulateAllStations, triangulateStation } from './triangulation';
import type { BearingObservation, StationId } from './types';
import {
  evaluateVirtualFieldSignal,
  findNearbyVirtualTransmitter,
  generateVirtualScenario,
} from './virtualField';

const ZJG = CAMPUSES.zijingang;

describe('virtual campus fox-hunt simulator (end-to-end Stages 1-5)', () => {
  it('generates valid hidden targets + decoys strictly inside ZJU campus bounds', () => {
    const targets: StationId[] = ['1', '2', '3', '4', '5', 'MO'];
    for (const campus of Object.values(CAMPUSES)) {
      const sc = generateVirtualScenario({
        campus,
        targetStations: targets,
        scope: 'campus',
        decoyCount: 3,
        seed: 1001,
      });

      expect(sc.transmitters).toHaveLength(9);
      const targetTxs = sc.transmitters.filter((t) => t.isTarget);
      const decoyTxs = sc.transmitters.filter((t) => !t.isTarget);
      expect(targetTxs).toHaveLength(6);
      expect(decoyTxs).toHaveLength(3);

      // All inside campus boundary & frequencies distinct
      const freqs = new Set<number>();
      for (const tx of sc.transmitters) {
        expect(isPointInPolygon(tx.position, campus.boundary)).toBe(true);
        expect(tx.freqMHz).toBeGreaterThanOrEqual(3.5);
        expect(tx.freqMHz).toBeLessThanOrEqual(3.6);
        freqs.add(tx.freqMHz);
      }
      expect(freqs.size).toBe(9);
    }
  });

  it('places nearby quick-test scenario within ~350m of runner anchor', () => {
    const anchor = ZJG.center;
    const sc = generateVirtualScenario({
      campus: ZJG,
      targetStations: ['1', '3', '5', '7', '9', 'MO'],
      scope: 'nearby',
      anchor,
      decoyCount: 2,
      seed: 2002,
    });

    for (const tx of sc.transmitters) {
      expect(isPointInPolygon(tx.position, ZJG.boundary)).toBe(true);
      const dist = haversineMeters(anchor, tx.position);
      expect(dist).toBeGreaterThanOrEqual(75);
      expect(dist).toBeLessThanOrEqual(360);
    }
  });

  it('enforces RF frequency selectivity and detects nearby punch range', () => {
    const sc = generateVirtualScenario({
      campus: ZJG,
      targetStations: ['1', '2', '3', '4', '5', 'MO'],
      scope: 'nearby',
      anchor: ZJG.center,
      seed: 3003,
    });

    const tx = sc.transmitters[0];
    const rng = createSeededRng(42);
    // On-frequency: detects transmitter & strong S-meter
    const onFreq = evaluateVirtualFieldSignal(
      sc,
      tx.freqMHz,
      ZJG.center,
      90,
      200,
      200,
      rng,
    );
    expect(onFreq.strongestTx?.stationId).toBe(tx.stationId);
    expect(onFreq.selectivity).toBeGreaterThan(0.95);
    expect(onFreq.sMeter).toBeGreaterThan(0.15);

    // Way off-frequency (3.500 MHz when slots start at 3.508+): silence
    const offFreq = evaluateVirtualFieldSignal(
      sc,
      3.5,
      ZJG.center,
      90,
      200,
      200,
      rng,
    );
    expect(offFreq.strongestTx).toBeNull();
    expect(offFreq.sMeter).toBe(0);

    // Standing 10m from transmitter -> punch prompt triggers!
    const nearPos = localToLngLat({ x: 8, y: 6 }, tx.position);
    const nearby = findNearbyVirtualTransmitter(sc, nearPos, 25);
    expect(nearby?.tx.stationId).toBe(tx.stationId);
    expect(nearby!.distanceM).toBeLessThan(15);
  });

  it('completes full closed-loop Stages 1->5: virtual audio -> Morse decode -> half-turn sweep -> triangulation -> TSP route', () => {
    const targets: StationId[] = ['1', '2', '3', '4', '5', 'MO'];
    const sc = generateVirtualScenario({
      campus: ZJG,
      targetStations: targets,
      scope: 'nearby',
      anchor: ZJG.center,
      decoyCount: 3,
      seed: 5555,
    });

    const rng = createSeededRng(777);

    // Step 1: Tune onto a non-target decoy and verify Morse decoder identifies it as non-target!
    const decoyTx = sc.transmitters.find((t) => !t.isTarget)!;
    const decoyDecoder = new ArdfMorseDecoder();
    for (let t = 0; t < 14000; t += 20) {
      // Point perpendicular to null so signal is strong while listening
      const s = evaluateVirtualFieldSignal(
        sc,
        decoyTx.freqMHz,
        ZJG.center,
        0,
        t,
        t,
        rng,
      );
      decoyDecoder.feedFrame(s.frame);
    }
    const decoySnap = decoyDecoder.getSnapshot();
    expect(decoySnap.status).toBe('locked');
    expect(decoySnap.lockedStation).toBe(decoyTx.stationId);
    expect(targets.includes(decoySnap.lockedStation!)).toBe(false);

    // Step 2: Locate 2 hidden target stations purely via simulated half-turn sweeps from 2 spots!
    const obsList: BearingObservation[] = [];
    const targetSampleTxs = sc.transmitters.filter((t) => t.isTarget).slice(0, 2);

    for (const tx of targetSampleTxs) {
      // Two perpendicular runner spots ~140m from the hidden transmitter
      const spotA = localToLngLat({ x: -140, y: -30 }, tx.position);
      const spotB = localToLngLat({ x: 30, y: -140 }, tx.position);

      for (const [sIdx, spot] of [spotA, spotB].entries()) {
        const sweeper = new AutoBearingSweeper();
        const durationMs = 4200;
        let lastSweep = sweeper.evaluate();
        for (let t = 0; t < durationMs; t += 20) {
          const heading = (15 + (t / durationMs) * 200) % 360;
          const sig = evaluateVirtualFieldSignal(
            sc,
            tx.freqMHz,
            spot,
            heading,
            t,
            t,
            rng,
          );
          lastSweep = sweeper.addSample(sig.frame, heading);
        }

        expect(lastSweep.ready).toBe(true);
        expect(lastSweep.bearingDeg).not.toBeNull();

        obsList.push({
          id: `e2e_${tx.stationId}_${sIdx}`,
          stationId: tx.stationId,
          origin: spot,
          bearingDeg: lastSweep.bearingDeg!,
          mode: 'bidirectional',
          gpsAccuracy: 5,
          timestamp: Date.now(),
        });
      }

      // Stage 2 triangulation accuracy check (< 20m error against true hidden position!)
      const est = triangulateStation(
        tx.stationId,
        obsList.filter((o) => o.stationId === tx.stationId),
        ZJG,
      );
      expect(est.status === 'locked' || est.status === 'coarse').toBe(true);
      expect(est.position).not.toBeNull();
      expect(haversineMeters(est.position!, tx.position)).toBeLessThan(20);
    }

    // Step 3: Stage 4 optimal TSP route across the located targets
    const allEst = triangulateAllStations(obsList, targets, ZJG);
    const routable = extractRoutableTargets(targets, [], allEst);
    expect(routable).toHaveLength(2);

    const plan = solveOptimalRoute(ZJG.center, routable);
    expect(plan.orderedStations).toHaveLength(2);
    expect(plan.totalDistanceM).toBeGreaterThan(0);
  });
});
