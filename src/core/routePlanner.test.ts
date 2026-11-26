import { describe, expect, it } from 'vitest';
import { CAMPUSES } from './campuses';
import { localToLngLat } from './coords';
import {
  extractRoutableTargets,
  formatDistance,
  formatDuration,
  solveOptimalRoute,
  type PairDistanceProvider,
  type RouteTargetNode,
} from './routePlanner';
import type { StationEstimate, StationId } from './types';

const ZJG = CAMPUSES.zijingang;

function node(id: StationId, x: number, y: number): RouteTargetNode {
  return {
    stationId: id,
    position: localToLngLat({ x, y }, ZJG.center),
  };
}

describe('exact TSP route planner', () => {
  it('returns empty plan when no located stations remain', () => {
    const plan = solveOptimalRoute(ZJG.center, []);
    expect(plan.orderedStations).toEqual([]);
    expect(plan.legs).toEqual([]);
    expect(plan.totalDistanceM).toBe(0);
    expect(plan.source).toBe('euclidean');
  });

  it('beats naive nearest-neighbor greedy trap with globally optimal order', () => {
    // Classic 1D greedy trap on X axis:
    // Origin = 0
    // Stations at: A = +100, B = -120, C = +250, D = +400
    // Greedy nearest-neighbor from 0:
    //   0 -> A(+100, 100m) -> C(+250, 150m) -> D(+400, 150m) -> B(-120, 520m) = 920m!
    // Globally optimal open-path TSP from 0:
    //   0 -> B(-120, 120m) -> A(+100, 220m) -> C(+250, 150m) -> D(+400, 150m) = 640m!
    const origin = localToLngLat({ x: 0, y: 0 }, ZJG.center);
    const nodes = [
      node('1', 100, 0),
      node('2', -120, 0),
      node('3', 250, 0),
      node('4', 400, 0),
    ];

    const plan = solveOptimalRoute(origin, nodes);
    expect(plan.orderedStations).toEqual(['2', '1', '3', '4']);
    expect(plan.totalDistanceM).toBeCloseTo(640, -1);
    expect(plan.legs).toHaveLength(4);
    expect(plan.legs[0].fromId).toBe('ORIGIN');
    expect(plan.legs[0].toStationId).toBe('2');
  });

  it('uses real walking road matrix to avoid cross-lake detours (Qizhen Lake scenario)', () => {
    // Straight-line layout:
    // Origin at South-West (-200, -100)
    // '1' at North-West (-200, +150)  -- straight line 250m (same side of lake)
    // '2' at South-East (+150, -100)  -- straight line 350m, across lake bridge
    // '3' at North-East (+150, +150)  -- straight line 350m from '1', BUT Qizhen Lake blocks 1<->3 directly!
    //
    // Suppose walking network has:
    //   ORIGIN -> 1 = 260m, ORIGIN -> 2 = 380m, ORIGIN -> 3 = 900m
    //   1 <-> 2 = 950m (around lake), 1 <-> 3 = 1100m (long north detour)
    //   2 <-> 3 = 260m (east bank straight footpath)
    // Wait: compare 2 orders:
    //   ORIGIN -> 1 (260) -> 3 (1100) -> 2 (260) = 1620m
    //   ORIGIN -> 2 (380) -> 3 (260) -> 1 (1100) = 1740m
    // Now suppose instead 1 <-> 2 is SHORT (south bridge 320m), while 1 <-> 3 is BLOCKED by lake (1200m):
    //   ORIGIN -> 1 (260) -> 2 (320) -> 3 (260) = 840m!
    // Whereas pure Euclidean order would be ORIGIN -> 1 (250) -> 3 (350) -> 2 (250) = 850m!
    const origin = localToLngLat({ x: -200, y: -100 }, ZJG.center);
    const nodes = [
      node('1', -200, 150),
      node('2', 150, -100),
      node('3', 150, 150),
    ];

    const eucPlan = solveOptimalRoute(origin, nodes);
    expect(eucPlan.orderedStations).toEqual(['1', '3', '2']);

    const roadMatrix: Record<string, number> = {
      'ORIGIN->1': 260,
      'ORIGIN->2': 380,
      'ORIGIN->3': 920,
      '1->2': 320,
      '2->1': 320,
      '1->3': 1200, // blocked by lake!
      '3->1': 1200,
      '2->3': 260,
      '3->2': 260,
    };

    const roadProvider: PairDistanceProvider = (fromId, toId, from, to) => {
      const d = roadMatrix[`${fromId}->${toId}`];
      if (d === undefined) return null;
      return { distanceM: d, path: [from, to], isRealRoad: true };
    };

    const roadPlan = solveOptimalRoute(origin, nodes, {
      distanceProvider: roadProvider,
    });
    expect(roadPlan.orderedStations).toEqual(['1', '2', '3']);
    expect(roadPlan.totalDistanceM).toBe(840);
    expect(roadPlan.source).toBe('amap_walking');
  });

  it('solves 6-station ARDF campus layout quickly and updates cleanly after punching', () => {
    const origin = localToLngLat({ x: 0, y: -300 }, ZJG.center);
    const sixNodes = [
      node('1', -250, -100),
      node('2', -200, 220),
      node('3', 50, 320),
      node('4', 320, 180),
      node('5', 280, -120),
      node('MO', 60, -220),
    ];

    const fullPlan = solveOptimalRoute(origin, sixNodes);
    expect(fullPlan.orderedStations).toHaveLength(6);
    expect(new Set(fullPlan.orderedStations).size).toBe(6);

    // Simulate punching the first recommended station -> remaining 5 recalculate
    const punchedId = fullPlan.orderedStations[0];
    const remainingNodes = sixNodes.filter((n) => n.stationId !== punchedId);
    const nextPlan = solveOptimalRoute(
      sixNodes.find((n) => n.stationId === punchedId)!.position,
      remainingNodes,
    );
    expect(nextPlan.orderedStations).toHaveLength(5);
    expect(nextPlan.orderedStations).not.toContain(punchedId);
    expect(nextPlan.totalDistanceM).toBeLessThan(fullPlan.totalDistanceM);
  });

  it('handles partial real-road fallback and helper extractors/formatters', () => {
    const origin = ZJG.center;
    const n1 = node('1', 100, 0);
    const n2 = node('2', 200, 0);

    const partialProvider: PairDistanceProvider = (fromId, toId, from, to) => {
      if (fromId === 'ORIGIN' && toId === '1') {
        return { distanceM: 120, path: [from, to], isRealRoad: true };
      }
      return null;
    };

    const plan = solveOptimalRoute(origin, [n1, n2], {
      distanceProvider: partialProvider,
    });
    expect(plan.source).toBe('amap_partial');
    expect(plan.legs[0].isRealRoad).toBe(true);
    expect(plan.legs[1].isRealRoad).toBe(false);

    const dummyEstimates = {
      '1': { stationId: '1', status: 'locked', position: n1.position } as StationEstimate,
      '2': { stationId: '2', status: 'single_line', position: null } as StationEstimate,
      'MO': { stationId: 'MO', status: 'coarse', position: n2.position } as StationEstimate,
    } as Record<StationId, StationEstimate>;

    const routable = extractRoutableTargets(['1', '2', 'MO'], ['1'], dummyEstimates);
    expect(routable.map((r) => r.stationId)).toEqual(['MO']);

    expect(formatDistance(240)).toBe('240m');
    expect(formatDistance(1350)).toBe('1.35km');
    expect(formatDuration(45)).toBe('45秒');
    expect(formatDuration(135)).toBe('2分15秒');
  });
});
