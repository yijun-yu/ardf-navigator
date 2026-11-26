import { describe, expect, it } from 'vitest';
import { CAMPUSES } from './campuses';
import {
  bearingBetween,
  haversineMeters,
  localToLngLat,
  normalizeDeg,
} from './coords';
import {
  distanceToPolygonLocal,
  triangulateAllStations,
  triangulateStation,
} from './triangulation';
import type { BearingMode, BearingObservation, LocalPoint } from './types';

const ZJG = CAMPUSES.zijingang;

function pt(x: number, y: number) {
  return localToLngLat({ x, y }, ZJG.center);
}

function makeObs(
  id: string,
  originLocal: LocalPoint,
  targetLocal: LocalPoint,
  opts?: {
    stationId?: BearingObservation['stationId'];
    mode?: BearingMode;
    errorDeg?: number;
    flip180?: boolean;
    gpsAccuracy?: number;
  },
): BearingObservation {
  const origin = pt(originLocal.x, originLocal.y);
  const target = pt(targetLocal.x, targetLocal.y);
  const trueBearing = bearingBetween(origin, target);
  const bearingDeg = normalizeDeg(
    trueBearing + (opts?.errorDeg ?? 0) + (opts?.flip180 ? 180 : 0),
  );
  return {
    id,
    stationId: opts?.stationId ?? '1',
    origin,
    bearingDeg,
    mode: opts?.mode ?? 'bidirectional',
    gpsAccuracy: opts?.gpsAccuracy ?? 5,
    timestamp: Date.now(),
  };
}

describe('triangulation engine', () => {
  it('returns none for 0 observations and single_line for 1 observation', () => {
    const r0 = triangulateStation('1', [], ZJG);
    expect(r0.status).toBe('none');
    expect(r0.position).toBeNull();

    const r1 = triangulateStation(
      '1',
      [makeObs('o1', { x: -100, y: 0 }, { x: 100, y: 100 })],
      ZJG,
    );
    expect(r1.status).toBe('single_line');
    expect(r1.position).toBeNull();
    expect(r1.observationCount).toBe(1);
  });

  it('eliminates 180-degree ambiguity with 2 bidirectional bearings regardless of flips', () => {
    const truthLocal = { x: 120, y: 90 };
    const truthLngLat = pt(truthLocal.x, truthLocal.y);
    const o1 = { x: -80, y: -40 };
    const o2 = { x: 140, y: -110 };

    const flipCombos: [boolean, boolean][] = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ];

    for (const [f1, f2] of flipCombos) {
      const obs = [
        makeObs('a', o1, truthLocal, { mode: 'bidirectional', flip180: f1 }),
        makeObs('b', o2, truthLocal, { mode: 'bidirectional', flip180: f2 }),
      ];
      const est = triangulateStation('1', obs, ZJG);
      expect(est.status === 'locked' || est.status === 'coarse').toBe(true);
      expect(est.position).not.toBeNull();
      expect(haversineMeters(est.position!, truthLngLat)).toBeLessThan(1.5);
      expect(est.outlierIds).toHaveLength(0);
    }
  });

  it('handles unidirectional forward convergence and rejects diverging rays', () => {
    const truthLocal = { x: 0, y: 150 };
    const truthLngLat = pt(truthLocal.x, truthLocal.y);
    const o1 = { x: -120, y: 0 };
    const o2 = { x: 120, y: 0 };

    const forward = [
      makeObs('u1', o1, truthLocal, { mode: 'unidirectional' }),
      makeObs('u2', o2, truthLocal, { mode: 'unidirectional' }),
    ];
    const estOk = triangulateStation('2', forward, ZJG);
    expect(estOk.status).toBe('locked');
    expect(haversineMeters(estOk.position!, truthLngLat)).toBeLessThan(1.5);

    // Flip both rays 180 deg -> rays diverge into southern half-plane
    const diverging = [
      makeObs('d1', o1, truthLocal, { mode: 'unidirectional', flip180: true }),
      makeObs('d2', o2, truthLocal, { mode: 'unidirectional', flip180: true }),
    ];
    const estBad = triangulateStation('2', diverging, ZJG);
    expect(estBad.status).toBe('poor_geometry');
    expect(estBad.position).toBeNull();
    expect(estBad.reason).toContain('单向');
  });

  it('supports mixed unidirectional and bidirectional bearings', () => {
    const truthLocal = { x: -100, y: 80 };
    const truthLngLat = pt(truthLocal.x, truthLocal.y);

    const mixedOk = [
      makeObs('m1', { x: 0, y: 0 }, truthLocal, { mode: 'unidirectional' }),
      makeObs('m2', { x: -100, y: -50 }, truthLocal, {
        mode: 'bidirectional',
        flip180: true,
      }),
    ];
    const estOk = triangulateStation('3', mixedOk, ZJG);
    expect(estOk.status).toBe('locked');
    expect(haversineMeters(estOk.position!, truthLngLat)).toBeLessThan(1.5);

    // Unidirectional ray points backward relative to intersection -> rejected
    const mixedBad = [
      makeObs('m1', { x: 0, y: 0 }, truthLocal, {
        mode: 'unidirectional',
        flip180: true,
      }),
      makeObs('m2', { x: -100, y: -50 }, truthLocal, { mode: 'bidirectional' }),
    ];
    const estBad = triangulateStation('3', mixedBad, ZJG);
    expect(estBad.status).toBe('poor_geometry');
    expect(estBad.position).toBeNull();
  });

  it('resists 60-degree and 80-degree campus building reflection outliers among 3 good bearings', () => {
    const truthLocal = { x: 80, y: 60 };
    const truthLngLat = pt(truthLocal.x, truthLocal.y);

    for (const reflectionErr of [60, -80]) {
      const obs = [
        makeObs('g1', { x: -120, y: -60 }, truthLocal, { errorDeg: 2 }),
        makeObs('g2', { x: 240, y: -80 }, truthLocal, { errorDeg: -2.5 }),
        makeObs('g3', { x: 40, y: 260 }, truthLocal, { errorDeg: 1.5 }),
        makeObs('bad_reflect', { x: -180, y: 180 }, truthLocal, {
          errorDeg: reflectionErr,
        }),
      ];

      const est = triangulateStation('4', obs, ZJG);
      expect(est.status).toBe('locked');
      expect(est.position).not.toBeNull();
      expect(haversineMeters(est.position!, truthLngLat)).toBeLessThan(15);
      expect(est.inlierCount).toBe(3);
      expect(est.outlierIds).toEqual(['bad_reflect']);

      const badDiag = est.diagnostics.find((d) => d.observationId === 'bad_reflect');
      expect(badDiag?.isOutlier).toBe(true);
      expect(badDiag!.residualDeg).toBeGreaterThan(40);
      expect(badDiag!.weight).toBeLessThan(0.05);
    }
  });

  it('uses campus boundary prior to reject far out-of-campus intersections', () => {
    // Two lines crossing ~2400m north of Zijingang campus center (far outside boundary)
    const farOutside = { x: 0, y: 2400 };
    const obsOut = [
      makeObs('out1', { x: -400, y: 600 }, farOutside),
      makeObs('out2', { x: 400, y: 600 }, farOutside),
    ];
    const estOut = triangulateStation('5', obsOut, ZJG);
    expect(estOut.status).toBe('poor_geometry');
    expect(estOut.position).toBeNull();
    expect(estOut.reason).toContain('校区');

    // 2 good lines crossing inside Zijingang (100, -100) + 1 bad line whose
    // intersections with both good lines fall outside Zijingang's boundary
    // ([-1487, 1465] x [-953, 1084]): (-2500, -100) and (100, 1460).
    const truthInside = { x: 100, y: -100 };
    const truthLngLat = pt(truthInside.x, truthInside.y);
    const obsWithOutlier = [
      makeObs('in1', { x: -400, y: -100 }, truthInside), // horizontal y = -100
      makeObs('in2', { x: 100, y: -500 }, truthInside),  // vertical x = 100
      makeObs('bad3', { x: -1000, y: 800 }, { x: -2500, y: -100 }),
    ];
    const estInside = triangulateStation('5', obsWithOutlier, ZJG);
    expect(estInside.status === 'locked' || estInside.status === 'coarse').toBe(true);
    expect(haversineMeters(estInside.position!, truthLngLat)).toBeLessThan(15);
    expect(estInside.outlierIds).toContain('bad3');
  });

  it('locks tightly on close-range final approach with modest baseline', () => {
    const truth = { x: 40, y: 40 };
    const obs = [
      makeObs('c1', { x: 25, y: 40 }, truth, { gpsAccuracy: 4 }),
      makeObs('c2', { x: 40, y: 25 }, truth, { gpsAccuracy: 4 }),
    ];
    const est = triangulateStation('1', obs, ZJG);
    expect(est.status).toBe('locked');
    expect(est.errorRadiusM!).toBeLessThanOrEqual(15);
    expect(haversineMeters(est.position!, pt(truth.x, truth.y))).toBeLessThan(1.5);
  });

  it('weights close accurate bearings far higher than distant noisy bearings', () => {
    const truthLocal = { x: 50, y: 50 };
    const truthLngLat = pt(truthLocal.x, truthLocal.y);

    // 2 distant bearings (~650m away) biased by +/-6 deg
    const far1 = makeObs('far1', { x: -600, y: 50 }, truthLocal, {
      errorDeg: 6,
      gpsAccuracy: 15,
    });
    const far2 = makeObs('far2', { x: 50, y: -600 }, truthLocal, {
      errorDeg: -6,
      gpsAccuracy: 15,
    });

    const farOnly = triangulateStation('6', [far1, far2], ZJG);
    expect(farOnly.position).not.toBeNull();
    const farErr = haversineMeters(farOnly.position!, truthLngLat);
    expect(farErr).toBeGreaterThan(50);

    // Now runner approaches to ~45m and captures 2 crisp bearings
    const near1 = makeObs('near1', { x: 5, y: 50 }, truthLocal, {
      errorDeg: 1,
      gpsAccuracy: 4,
    });
    const near2 = makeObs('near2', { x: 50, y: 5 }, truthLocal, {
      errorDeg: -1,
      gpsAccuracy: 4,
    });

    const combined = triangulateStation('6', [far1, far2, near1, near2], ZJG);
    expect(combined.status).toBe('locked');
    const combinedErr = haversineMeters(combined.position!, truthLngLat);
    expect(combinedErr).toBeLessThan(10);
    expect(combined.errorRadiusM!).toBeLessThan(farOnly.errorRadiusM! * 0.3);
  });

  it('rejects parallel lines, narrow acute angles, and too-short baselines', () => {
    // Parallel lines
    const parallel: BearingObservation[] = [
      {
        id: 'p1',
        stationId: '7',
        origin: pt(-100, 0),
        bearingDeg: 0,
        mode: 'bidirectional',
        gpsAccuracy: 5,
        timestamp: 1,
      },
      {
        id: 'p2',
        stationId: '7',
        origin: pt(100, 0),
        bearingDeg: 0,
        mode: 'bidirectional',
        gpsAccuracy: 5,
        timestamp: 2,
      },
    ];
    const estPar = triangulateStation('7', parallel, ZJG);
    expect(estPar.status).toBe('poor_geometry');
    expect(estPar.position).toBeNull();

    // Very narrow 4-degree crossing
    const narrow: BearingObservation[] = [
      {
        id: 'n1',
        stationId: '7',
        origin: pt(-20, 0),
        bearingDeg: 0,
        mode: 'bidirectional',
        gpsAccuracy: 5,
        timestamp: 1,
      },
      {
        id: 'n2',
        stationId: '7',
        origin: pt(20, 0),
        bearingDeg: 356,
        mode: 'bidirectional',
        gpsAccuracy: 5,
        timestamp: 2,
      },
    ];
    const estNarrow = triangulateStation('7', narrow, ZJG);
    expect(estNarrow.status).toBe('poor_geometry');
    expect(estNarrow.position).toBeNull();

    // Standing in virtually the same spot (2m baseline)
    const sameSpot: BearingObservation[] = [
      {
        id: 's1',
        stationId: '7',
        origin: pt(0, 0),
        bearingDeg: 0,
        mode: 'bidirectional',
        gpsAccuracy: 5,
        timestamp: 1,
      },
      {
        id: 's2',
        stationId: '7',
        origin: pt(2, 0),
        bearingDeg: 90,
        mode: 'bidirectional',
        gpsAccuracy: 5,
        timestamp: 2,
      },
    ];
    const estSpot = triangulateStation('7', sameSpot, ZJG);
    expect(estSpot.status).toBe('poor_geometry');
    expect(estSpot.position).toBeNull();
  });

  it('scales error radius monotonically with intersection angle and range', () => {
    const truth = { x: 0, y: 0 };
    const makePairAtAngle = (rangeM: number, sepDeg: number) => {
      const half = (sepDeg / 2) * (Math.PI / 180);
      const o1 = { x: -rangeM * Math.sin(half), y: -rangeM * Math.cos(half) };
      const o2 = { x: rangeM * Math.sin(half), y: -rangeM * Math.cos(half) };
      return [
        makeObs('a', o1, truth, { gpsAccuracy: 5 }),
        makeObs('b', o2, truth, { gpsAccuracy: 5 }),
      ];
    };

    const est90 = triangulateStation('8', makePairAtAngle(150, 90), ZJG);
    const est35 = triangulateStation('8', makePairAtAngle(150, 35), ZJG);
    const est15 = triangulateStation('8', makePairAtAngle(150, 15), ZJG);

    expect(est90.errorRadiusM!).toBeLessThan(est35.errorRadiusM!);
    expect(est35.errorRadiusM!).toBeLessThan(est15.errorRadiusM!);
    expect(est90.status).toBe('locked');
    expect(est15.status).toBe('coarse');

    const estNear90 = triangulateStation('8', makePairAtAngle(40, 90), ZJG);
    const estFar90 = triangulateStation('8', makePairAtAngle(300, 90), ZJG);
    expect(estNear90.errorRadiusM!).toBeLessThan(estFar90.errorRadiusM!);
  });

  it('handles 0/360 degree wraparound cleanly', () => {
    const truth = { x: 0, y: 120 };
    const truthLngLat = pt(truth.x, truth.y);
    const obs = [
      makeObs('w1', { x: -2, y: 0 }, truth, { mode: 'unidirectional' }), // ~1 deg
      makeObs('w2', { x: 100, y: 120 }, truth, { mode: 'unidirectional' }), // 270 deg
      makeObs('w3', { x: 2, y: 0 }, truth, { mode: 'unidirectional' }), // ~359 deg
    ];
    const est = triangulateStation('9', obs, ZJG);
    expect(est.status).toBe('locked');
    expect(haversineMeters(est.position!, truthLngLat)).toBeLessThan(1.5);
  });

  it('computes polygon distance accurately and batches multiple stations', () => {
    const square: LocalPoint[] = [
      { x: -100, y: -100 },
      { x: 100, y: -100 },
      { x: 100, y: 100 },
      { x: -100, y: 100 },
    ];
    expect(distanceToPolygonLocal({ x: 0, y: 0 }, square).inside).toBe(true);
    const out = distanceToPolygonLocal({ x: 150, y: 0 }, square);
    expect(out.inside).toBe(false);
    expect(out.distance).toBeCloseTo(50, 3);
    expect(out.nearest.x).toBeCloseTo(100, 3);

    const t1 = { x: 100, y: 100 };
    const tMo = { x: -150, y: -80 };
    const allObs = [
      makeObs('1a', { x: 0, y: 100 }, t1, { stationId: '1' }),
      makeObs('1b', { x: 100, y: 0 }, t1, { stationId: '1' }),
      makeObs('ma', { x: -150, y: 50 }, tMo, { stationId: 'MO' }),
      makeObs('mb', { x: 0, y: -80 }, tMo, { stationId: 'MO' }),
    ];
    const batch = triangulateAllStations(allObs, ['1', '2', 'MO'], ZJG);
    expect(batch['1'].status).toBe('locked');
    expect(batch['2'].status).toBe('none');
    expect(batch['MO'].status).toBe('locked');
    expect(haversineMeters(batch['1'].position!, pt(t1.x, t1.y))).toBeLessThan(2);
    expect(haversineMeters(batch['MO'].position!, pt(tMo.x, tMo.y))).toBeLessThan(2);
  });
});
