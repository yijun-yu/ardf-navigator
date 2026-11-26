import { haversineMeters } from './coords';
import type {
  LngLat,
  RouteDataSource,
  RouteLeg,
  RoutePlan,
  StationEstimate,
  StationId,
} from './types';

/** Assumed brisk campus ARDF running speed (~10.8 km/h, 5:33 min/km) for ETA display. */
export const DEFAULT_RUN_SPEED_MPS = 3.0;

export interface RouteTargetNode {
  stationId: StationId;
  position: LngLat;
}

export interface LegLookupResult {
  distanceM: number;
  path?: LngLat[];
  isRealRoad?: boolean;
}

export type PairDistanceProvider = (
  fromId: 'ORIGIN' | StationId,
  toId: StationId,
  from: LngLat,
  to: LngLat,
) => LegLookupResult | null;

/**
 * Extract all remaining unpunched target stations that currently have a valid
 * triangulated position estimate.
 */
export function extractRoutableTargets(
  targets: StationId[],
  punched: StationId[],
  estimates: Record<StationId, StationEstimate>,
): RouteTargetNode[] {
  const out: RouteTargetNode[] = [];
  for (const id of targets) {
    if (punched.includes(id)) continue;
    const est = estimates[id];
    if (est?.position) {
      out.push({ stationId: id, position: est.position });
    }
  }
  return out;
}

interface EdgeData {
  distanceM: number;
  path: LngLat[];
  isRealRoad: boolean;
}

function resolveEdge(
  fromId: 'ORIGIN' | StationId,
  toId: StationId,
  from: LngLat,
  to: LngLat,
  provider?: PairDistanceProvider,
): EdgeData {
  const supplied = provider?.(fromId, toId, from, to);
  if (supplied && Number.isFinite(supplied.distanceM) && supplied.distanceM >= 0) {
    return {
      distanceM: supplied.distanceM,
      path:
        supplied.path && supplied.path.length >= 2
          ? supplied.path
          : [from, to],
      isRealRoad: Boolean(supplied.isRealRoad),
    };
  }
  return {
    distanceM: haversineMeters(from, to),
    path: [from, to],
    isRealRoad: false,
  };
}

/**
 * Exact open-path Held-Karp DP TSP solver starting from `origin` and visiting
 * all `nodes` in any order (no return-to-start required).
 *
 * For K <= 6 stations (standard ARDF draw), solves globally optimal order in
 * < 0.05 ms with O(K^2 * 2^K) operations, supporting both symmetric Euclidean
 * and real-world walking road network matrices (including asymmetric edges).
 */
export function solveOptimalRoute(
  origin: LngLat,
  nodes: RouteTargetNode[],
  options?: {
    distanceProvider?: PairDistanceProvider;
    runSpeedMps?: number;
    refining?: boolean;
  },
): RoutePlan {
  const speed = options?.runSpeedMps ?? DEFAULT_RUN_SPEED_MPS;
  const refining = options?.refining ?? false;
  const n = nodes.length;

  if (n === 0) {
    return {
      origin,
      orderedStations: [],
      legs: [],
      totalDistanceM: 0,
      totalRunSec: 0,
      source: 'euclidean',
      refining,
    };
  }

  // Precompute start -> node_i and node_i -> node_j edges
  const startEdges: EdgeData[] = nodes.map((node) =>
    resolveEdge(
      'ORIGIN',
      node.stationId,
      origin,
      node.position,
      options?.distanceProvider,
    ),
  );

  const pairEdges: EdgeData[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j
        ? { distanceM: 0, path: [nodes[i].position], isRealRoad: true }
        : resolveEdge(
            nodes[i].stationId,
            nodes[j].stationId,
            nodes[i].position,
            nodes[j].position,
            options?.distanceProvider,
          ),
    ),
  );

  let bestOrder: number[];

  if (n === 1) {
    bestOrder = [0];
  } else if (n <= 12) {
    // Exact Held-Karp dynamic programming
    const size = 1 << n;
    const dp = new Float64Array(size * n);
    const parent = new Int8Array(size * n);
    dp.fill(Infinity);
    parent.fill(-1);

    for (let i = 0; i < n; i++) {
      const mask = 1 << i;
      dp[mask * n + i] = startEdges[i].distanceM;
    }

    for (let mask = 1; mask < size; mask++) {
      const base = mask * n;
      for (let last = 0; last < n; last++) {
        if ((mask & (1 << last)) === 0) continue;
        const curCost = dp[base + last];
        if (!Number.isFinite(curCost)) continue;

        for (let next = 0; next < n; next++) {
          if ((mask & (1 << next)) !== 0) continue;
          const nextMask = mask | (1 << next);
          const nextIdx = nextMask * n + next;
          const cand = curCost + pairEdges[last][next].distanceM;
          if (cand < dp[nextIdx]) {
            dp[nextIdx] = cand;
            parent[nextIdx] = last;
          }
        }
      }
    }

    const fullMask = size - 1;
    let bestLast = 0;
    let bestCost = Infinity;
    for (let i = 0; i < n; i++) {
      const c = dp[fullMask * n + i];
      if (c < bestCost) {
        bestCost = c;
        bestLast = i;
      }
    }

    bestOrder = new Array<number>(n);
    let mask = fullMask;
    let cur = bestLast;
    for (let pos = n - 1; pos >= 0; pos--) {
      bestOrder[pos] = cur;
      const prev = parent[mask * n + cur];
      mask ^= 1 << cur;
      cur = prev;
    }
  } else {
    // Safety fallback (nearest-neighbor) if > 12 custom nodes ever passed
    const visited = new Set<number>();
    bestOrder = [];
    let curIdx = -1;
    while (visited.size < n) {
      let bestNext = -1;
      let bestD = Infinity;
      for (let j = 0; j < n; j++) {
        if (visited.has(j)) continue;
        const d =
          curIdx === -1
            ? startEdges[j].distanceM
            : pairEdges[curIdx][j].distanceM;
        if (d < bestD) {
          bestD = d;
          bestNext = j;
        }
      }
      visited.add(bestNext);
      bestOrder.push(bestNext);
      curIdx = bestNext;
    }
  }

  // Assemble legs & summary metrics
  const legs: RouteLeg[] = [];
  let totalDistanceM = 0;
  let realCount = 0;

  for (let idx = 0; idx < bestOrder.length; idx++) {
    const toIdx = bestOrder[idx];
    const fromId: 'ORIGIN' | StationId =
      idx === 0 ? 'ORIGIN' : nodes[bestOrder[idx - 1]].stationId;
    const edge =
      idx === 0 ? startEdges[toIdx] : pairEdges[bestOrder[idx - 1]][toIdx];

    const dist = Math.round(edge.distanceM);
    totalDistanceM += dist;
    if (edge.isRealRoad) realCount++;

    legs.push({
      fromId,
      toStationId: nodes[toIdx].stationId,
      path: edge.path,
      distanceM: dist,
      durationSec: Math.max(1, Math.round(dist / speed)),
      isRealRoad: edge.isRealRoad,
    });
  }

  let source: RouteDataSource = 'euclidean';
  if (realCount === legs.length && legs.length > 0) {
    source = 'amap_walking';
  } else if (realCount > 0) {
    source = 'amap_partial';
  }

  return {
    origin,
    orderedStations: bestOrder.map((i) => nodes[i].stationId),
    legs,
    totalDistanceM,
    totalRunSec: Math.max(1, Math.round(totalDistanceM / speed)),
    source,
    refining,
  };
}

/** Format distance cleanly for runner HUD (e.g. "185m" or "1.25km"). */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(2)}km`;
}

/** Format ETA cleanly for runner HUD (e.g. "45秒" or "4分15秒"). */
export function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}秒`;
  const min = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${min}分${rem}秒` : `${min}分`;
}
