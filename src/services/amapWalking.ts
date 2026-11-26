/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LngLat, StationId } from '../core/types';
import type { LegLookupResult, RouteTargetNode } from '../core/routePlanner';

export interface CachedWalkingEdge {
  distanceM: number;
  /** Path oriented from canonical endpoint A -> canonical endpoint B */
  path: LngLat[];
  canonicalFromKey: string;
  updatedAt: number;
}

const GRID_DEG = 0.00015; // ~15m spatial quantization bucket
const MAX_CACHE_ENTRIES = 260;
const REQUEST_GAP_MS = 230; // ~4.3 QPS max, safely under Amap free-tier QPS limit

function quantizeCoord(pt: LngLat): string {
  const qLng = Math.round(pt.lng / GRID_DEG);
  const qLat = Math.round(pt.lat / GRID_DEG);
  return `${qLng},${qLat}`;
}

function makeUndirectedEdgeKey(a: LngLat, b: LngLat): {
  cacheKey: string;
  reversed: boolean;
  canonicalFromKey: string;
} {
  const qa = quantizeCoord(a);
  const qb = quantizeCoord(b);
  if (qa <= qb) {
    return { cacheKey: `${qa}|${qb}`, reversed: false, canonicalFromKey: qa };
  }
  return { cacheKey: `${qb}|${qa}`, reversed: true, canonicalFromKey: qb };
}

function extractLngLat(pt: any): LngLat | null {
  if (!pt) return null;
  if (typeof pt.getLng === 'function' && typeof pt.getLat === 'function') {
    return { lng: pt.getLng(), lat: pt.getLat() };
  }
  if (typeof pt.lng === 'number' && typeof pt.lat === 'number') {
    return { lng: pt.lng, lat: pt.lat };
  }
  if (Array.isArray(pt) && pt.length >= 2) {
    return { lng: Number(pt[0]), lat: Number(pt[1]) };
  }
  return null;
}

function parseWalkingRoute(
  from: LngLat,
  to: LngLat,
  route: any,
): { distanceM: number; path: LngLat[] } | null {
  const distanceM = Number(route?.distance);
  if (!Number.isFinite(distanceM) || distanceM < 0) return null;

  const path: LngLat[] = [from];
  const steps = Array.isArray(route?.steps) ? route.steps : [];
  for (const step of steps) {
    const stepPath = Array.isArray(step?.path) ? step.path : [];
    for (const rawPt of stepPath) {
      const pt = extractLngLat(rawPt);
      if (!pt) continue;
      const prev = path[path.length - 1];
      if (
        Math.abs(prev.lng - pt.lng) > 1e-6 ||
        Math.abs(prev.lat - pt.lat) > 1e-6
      ) {
        path.push(pt);
      }
    }
  }
  const last = path[path.length - 1];
  if (Math.abs(last.lng - to.lng) > 1e-6 || Math.abs(last.lat - to.lat) > 1e-6) {
    path.push(to);
  }

  return { distanceM, path };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const id = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(id);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Spatial-cached, QPS-throttled Amap Walking road network distance & polyline manager.
 */
export class AmapWalkingCache {
  private cache = new Map<string, CachedWalkingEdge>();
  private walkingInstance: any = null;
  private loadedAmapRef: any = null;

  lookup(from: LngLat, to: LngLat): LegLookupResult | null {
    const { cacheKey, reversed } = makeUndirectedEdgeKey(from, to);
    const entry = this.cache.get(cacheKey);
    if (!entry) return null;
    const orientedPath = reversed ? [...entry.path].reverse() : entry.path;
    return {
      distanceM: entry.distanceM,
      path: orientedPath,
      isRealRoad: true,
    };
  }

  private put(from: LngLat, to: LngLat, distanceM: number, path: LngLat[]): void {
    const { cacheKey, reversed, canonicalFromKey } = makeUndirectedEdgeKey(
      from,
      to,
    );
    const canonicalPath = reversed ? [...path].reverse() : path;
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(cacheKey, {
      distanceM,
      path: canonicalPath,
      canonicalFromKey,
      updatedAt: Date.now(),
    });
  }

  private async ensureWalking(AMap: any): Promise<any> {
    if (this.walkingInstance && this.loadedAmapRef === AMap) {
      return this.walkingInstance;
    }
    if (!AMap.Walking) {
      await new Promise<void>((resolve) => {
        if (typeof AMap.plugin === 'function') {
          AMap.plugin('AMap.Walking', () => resolve());
        } else {
          resolve();
        }
      });
    }
    if (!AMap.Walking) return null;
    this.walkingInstance = new AMap.Walking({
      hideMarkers: true,
      autoFitView: false,
    });
    this.loadedAmapRef = AMap;
    return this.walkingInstance;
  }

  private querySingle(
    walking: any,
    from: LngLat,
    to: LngLat,
  ): Promise<{ distanceM: number; path: LngLat[] } | null> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, 6000);

      try {
        walking.search(
          [from.lng, from.lat],
          [to.lng, to.lat],
          (status: string, result: any) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            if (status === 'complete' && result?.routes?.[0]) {
              resolve(parseWalkingRoute(from, to, result.routes[0]));
            } else {
              resolve(null);
            }
          },
        );
      } catch {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          resolve(null);
        }
      }
    });
  }

  /**
   * Progressively populate all missing Amap walking edges for `origin` and `nodes`.
   * Cached station-to-station edges are skipped instantly; new requests are spaced
   * cleanly to stay below Amap's QPS limit.
   */
  async warmEdges(
    AMap: any,
    origin: LngLat,
    nodes: RouteTargetNode[],
    signal: AbortSignal,
    onBatchUpdate: () => void,
  ): Promise<void> {
    if (!AMap || nodes.length === 0 || signal.aborted) return;

    const walking = await this.ensureWalking(AMap);
    if (!walking || signal.aborted) return;

    const jobs: { from: LngLat; to: LngLat }[] = [];
    const seen = new Set<string>();

    const enqueueIfMissing = (from: LngLat, to: LngLat) => {
      const { cacheKey } = makeUndirectedEdgeKey(from, to);
      if (seen.has(cacheKey) || this.cache.has(cacheKey)) return;
      seen.add(cacheKey);
      jobs.push({ from, to });
    };

    // Priority 1: origin -> each target station
    for (const node of nodes) {
      enqueueIfMissing(origin, node.position);
    }

    // Priority 2: station <-> station pairs (for K <= 6, at most 15 undirected pairs)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        enqueueIfMissing(nodes[i].position, nodes[j].position);
      }
    }

    if (jobs.length === 0) return;

    let fetchedSinceNotify = 0;
    for (let i = 0; i < jobs.length; i++) {
      if (signal.aborted) return;
      const job = jobs[i];
      const res = await this.querySingle(walking, job.from, job.to);
      if (signal.aborted) return;

      if (res) {
        this.put(job.from, job.to, res.distanceM, res.path);
        fetchedSinceNotify++;
        if (fetchedSinceNotify >= 2 || i === jobs.length - 1) {
          fetchedSinceNotify = 0;
          onBatchUpdate();
        }
      }

      if (i < jobs.length - 1) {
        await sleep(res ? REQUEST_GAP_MS : 450, signal);
      }
    }

    if (fetchedSinceNotify > 0 && !signal.aborted) {
      onBatchUpdate();
    }
  }

  /** Helper adapter directly compatible with solveOptimalRoute's distanceProvider */
  makeProvider() {
    return (
      _fromId: 'ORIGIN' | StationId,
      _toId: StationId,
      from: LngLat,
      to: LngLat,
    ): LegLookupResult | null => this.lookup(from, to);
  }
}

export const sharedWalkingCache = new AmapWalkingCache();
