import { lngLatToLocal, localToLngLat, normalizeDeg } from './coords';
import type {
  BearingMode,
  BearingObservation,
  CampusConfig,
  LocalPoint,
  ObservationDiagnostic,
  StationEstimate,
  StationId,
} from './types';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const HALF_PI = Math.PI / 2;

export interface TriangulationOptions {
  /** Base 1-sigma bearing error (compass + ferrite null) in degrees (default 7°) */
  bearingSigmaDeg?: number;
  /** Grace distance outside campus polygon before soft boundary penalty activates (default 30m) */
  boundaryMarginM?: number;
  /** Soft boundary penalty scale in meters (default 40m) */
  boundarySigmaM?: number;
  /** Maximum distance outside campus before rejecting fix as out-of-bounds (default 250m) */
  maxOutsideCampusM?: number;
  /** Minimum acute intersection angle in degrees among inliers (default 8°) */
  minIntersectionDeg?: number;
  /** Maximum acceptable 2D error radius in meters (default 250m) */
  maxErrorRadiusM?: number;
  /** Error radius threshold separating 'locked' vs 'coarse' in meters (default 45m) */
  lockedRadiusM?: number;
  /** Minimum baseline distance between inlier observation origins in meters (default 5m) */
  minBaselineM?: number;
}

const DEFAULTS: Required<TriangulationOptions> = {
  bearingSigmaDeg: 7,
  boundaryMarginM: 30,
  boundarySigmaM: 40,
  maxOutsideCampusM: 250,
  minIntersectionDeg: 8,
  maxErrorRadiusM: 250,
  lockedRadiusM: 45,
  minBaselineM: 5,
};

const CAUCHY_C = 3.5;
const WELSCH_C = 2.2;
const BACKWARD_ALPHA = 0.8 * WELSCH_C * WELSCH_C;

interface PreparedObs {
  id: string;
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  thetaRad: number;
  mode: BearingMode;
  sigmaPos: number;
}

interface ObsEval {
  /** Signed angular residual in radians: (-pi/2, pi/2] bi, (-pi, pi] uni */
  e: number;
  absErrRad: number;
  /** Normalized profile-likelihood residual z = r * e / sigmaPerp */
  z: number;
  /** Exact partial derivatives of z w.r.t. (x, y) */
  dzdx: number;
  dzdy: number;
  /** Tangential angle derivatives de/dx, de/dy (for backward-ray penalty) */
  dedx: number;
  dedy: number;
  /** True when unidirectional and target lies in the backward half-plane (t < 0) */
  behindUni: boolean;
  /** Range from observer to candidate in meters */
  r: number;
}

interface PolygonDistance {
  inside: boolean;
  distance: number;
  nearest: LocalPoint;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function isLocalPointInPolygon(p: LocalPoint, poly: LocalPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function distanceToPolygonLocal(
  p: LocalPoint,
  poly: LocalPoint[],
): PolygonDistance {
  if (poly.length < 3 || isLocalPointInPolygon(p, poly)) {
    return { inside: true, distance: 0, nearest: { ...p } };
  }

  let bestDistSq = Infinity;
  let bestNearest: LocalPoint = { ...poly[0] };

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    let qx = a.x;
    let qy = a.y;
    if (lenSq > 1e-12) {
      const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq, 0, 1);
      qx = a.x + t * abx;
      qy = a.y + t * aby;
    }
    const dx = p.x - qx;
    const dy = p.y - qy;
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestNearest = { x: qx, y: qy };
    }
  }

  return {
    inside: false,
    distance: Math.sqrt(bestDistSq),
    nearest: bestNearest,
  };
}

function evalObs(
  obs: PreparedObs,
  x: number,
  y: number,
  sigmaThetaRad: number,
): ObsEval {
  const dx = x - obs.ox;
  const dy = y - obs.oy;
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);

  if (r < 1e-4) {
    return {
      e: 0,
      absErrRad: 0,
      z: 0,
      dzdx: 0,
      dzdy: 0,
      dedx: 0,
      dedy: 0,
      behindUni: false,
      r: 0,
    };
  }

  const t = dx * obs.ux + dy * obs.uy;
  const s = dx * obs.nx + dy * obs.ny;

  let e: number;
  let behindUni = false;
  if (obs.mode === 'bidirectional') {
    e = t >= 0 ? Math.atan2(s, t) : Math.atan2(-s, -t);
  } else {
    e = Math.atan2(s, t);
    behindUni = t < 0;
  }

  const rEpsSq = r2 + 1.0;
  const sigmaThetaSq = sigmaThetaRad * sigmaThetaRad;
  const sigmaPosSq = obs.sigmaPos * obs.sigmaPos;
  const sigmaPerp = Math.sqrt(rEpsSq * sigmaThetaSq + sigmaPosSq);
  const invSigmaPerp = 1 / sigmaPerp;

  const z = (r * e) * invSigmaPerp;
  const invR = 1 / r;
  const rx = dx * invR;
  const ry = dy * invR;

  // Exact derivatives:
  // de/dx = dy / r^2, de/dy = -dx / r^2
  // z = f(r) * e where f(r) = r / sigmaPerp
  // f(r) * de/dx = ry / sigmaPerp (no 1/r singularity!)
  // f'(r) = (sigmaTheta^2 + sigmaPos^2) / sigmaPerp^3
  const fPrime =
    (sigmaThetaSq + sigmaPosSq) * invSigmaPerp * invSigmaPerp * invSigmaPerp;
  const dzdx = ry * invSigmaPerp + e * fPrime * rx;
  const dzdy = -rx * invSigmaPerp + e * fPrime * ry;

  return {
    e,
    absErrRad: Math.abs(e),
    z,
    dzdx,
    dzdy,
    dedx: dy / Math.max(r2, 1.0),
    dedy: -dx / Math.max(r2, 1.0),
    behindUni,
    r,
  };
}

type LossKind = 'cauchy' | 'welsch';

interface ObjectiveResult {
  cost: number;
  gx: number;
  gy: number;
  h00: number;
  h01: number;
  h11: number;
}

function evalObjective(
  obsList: PreparedObs[],
  boundaryLocal: LocalPoint[],
  x: number,
  y: number,
  sigmaThetaRad: number,
  cfg: Required<TriangulationOptions>,
  lossKind: LossKind,
): ObjectiveResult {
  let cost = 0;
  let gx = 0;
  let gy = 0;
  let h00 = 0;
  let h01 = 0;
  let h11 = 0;

  for (let i = 0; i < obsList.length; i++) {
    const obs = obsList[i];
    const ev = evalObs(obs, x, y, sigmaThetaRad);

    let rho: number;
    let w: number;
    if (lossKind === 'cauchy') {
      const u = ev.z / CAUCHY_C;
      const denom = 1 + u * u;
      rho = 0.5 * CAUCHY_C * CAUCHY_C * Math.log(denom);
      w = 1 / denom;
    } else {
      const c2 = WELSCH_C * WELSCH_C;
      const expo = Math.exp(-(ev.z * ev.z) / (2 * c2));
      rho = c2 * (1 - expo);
      w = expo;
    }

    cost += rho;
    gx += w * ev.z * ev.dzdx;
    gy += w * ev.z * ev.dzdy;
    h00 += w * ev.dzdx * ev.dzdx;
    h01 += w * ev.dzdx * ev.dzdy;
    h11 += w * ev.dzdy * ev.dzdy;

    // Soft backward half-plane penalty for unidirectional rays so forward
    // hypotheses strictly beat backward ones while preserving outlier rejection.
    if (ev.behindUni && ev.absErrRad > HALF_PI) {
      const p = (ev.absErrRad - HALF_PI) / HALF_PI;
      const signE = ev.e >= 0 ? 1 : -1;
      const dpdx = (signE / HALF_PI) * ev.dedx;
      const dpdy = (signE / HALF_PI) * ev.dedy;
      cost += 0.5 * BACKWARD_ALPHA * p * p;
      gx += BACKWARD_ALPHA * p * dpdx;
      gy += BACKWARD_ALPHA * p * dpdy;
      h00 += BACKWARD_ALPHA * dpdx * dpdx;
      h01 += BACKWARD_ALPHA * dpdx * dpdy;
      h11 += BACKWARD_ALPHA * dpdy * dpdy;
    }
  }

  // Smooth campus boundary prior outside (polygon + grace margin)
  const polyDist = distanceToPolygonLocal({ x, y }, boundaryLocal);
  if (!polyDist.inside && polyDist.distance > cfg.boundaryMarginM) {
    const excess = polyDist.distance - cfg.boundaryMarginM;
    const invSigmaB = 1 / cfg.boundarySigmaM;
    const zb = excess * invSigmaB;
    const vx = (x - polyDist.nearest.x) / polyDist.distance;
    const vy = (y - polyDist.nearest.y) / polyDist.distance;
    const jx = vx * invSigmaB;
    const jy = vy * invSigmaB;

    cost += 0.5 * zb * zb;
    gx += zb * jx;
    gy += zb * jy;
    h00 += jx * jx;
    h01 += jx * jy;
    h11 += jy * jy;
  }

  return { cost, gx, gy, h00, h01, h11 };
}

function optimizeLM(
  obsList: PreparedObs[],
  boundaryLocal: LocalPoint[],
  start: LocalPoint,
  sigmaThetaRad: number,
  cfg: Required<TriangulationOptions>,
  lossKind: LossKind,
  maxIter: number,
): { point: LocalPoint; cost: number } {
  let x = start.x;
  let y = start.y;
  let lambda = 1e-3;
  let cur = evalObjective(obsList, boundaryLocal, x, y, sigmaThetaRad, cfg, lossKind);

  for (let iter = 0; iter < maxIter; iter++) {
    const gradNorm = Math.hypot(cur.gx, cur.gy);
    if (gradNorm < 1e-7) break;

    let accepted = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = cur.h00 + lambda;
      const b = cur.h01;
      const c = cur.h11 + lambda;
      const det = a * c - b * b;
      if (det <= 1e-18) {
        lambda *= 10;
        continue;
      }

      let stepX = -(c * cur.gx - b * cur.gy) / det;
      let stepY = -(-b * cur.gx + a * cur.gy) / det;

      // Trust-region step cap (max 400m per iteration) for numerical stability
      const stepNorm = Math.hypot(stepX, stepY);
      if (stepNorm > 400) {
        const s = 400 / stepNorm;
        stepX *= s;
        stepY *= s;
      }

      const nx = x + stepX;
      const ny = y + stepY;
      const next = evalObjective(
        obsList,
        boundaryLocal,
        nx,
        ny,
        sigmaThetaRad,
        cfg,
        lossKind,
      );

      if (next.cost < cur.cost - 1e-12) {
        x = nx;
        y = ny;
        cur = next;
        lambda = Math.max(1e-6, lambda * 0.3);
        accepted = true;
        if (Math.hypot(stepX, stepY) < 1e-3) {
          return { point: { x, y }, cost: cur.cost };
        }
        break;
      }

      lambda = Math.min(1e6, lambda * 5);
    }

    if (!accepted) break;
  }

  return { point: { x, y }, cost: cur.cost };
}

interface PairIntersection {
  point: LocalPoint;
  t1: number;
  t2: number;
  angleDeg: number;
  i: number;
  j: number;
}

function computePairwiseIntersections(
  obsList: PreparedObs[],
  maxDistFromOrigin: number,
): PairIntersection[] {
  const results: PairIntersection[] = [];
  const minSin = Math.sin(3 * DEG2RAD);

  for (let i = 0; i < obsList.length; i++) {
    for (let j = i + 1; j < obsList.length; j++) {
      const a = obsList[i];
      const b = obsList[j];
      const det = a.uy * b.ux - a.ux * b.uy;
      const absDet = Math.abs(det);
      if (absDet < minSin) continue;

      const dox = b.ox - a.ox;
      const doy = b.oy - a.oy;
      const t1 = (-dox * b.uy + doy * b.ux) / det;
      const t2 = (a.ux * doy - a.uy * dox) / det;

      const px = a.ox + t1 * a.ux;
      const py = a.oy + t1 * a.uy;
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (Math.hypot(px, py) > maxDistFromOrigin) continue;

      const angleDeg = Math.asin(Math.min(1, absDet)) * RAD2DEG;
      results.push({ point: { x: px, y: py }, t1, t2, angleDeg, i, j });
    }
  }

  return results;
}

function acuteAngleDeg(a: PreparedObs, b: PreparedObs): number {
  const sinVal = Math.abs(a.uy * b.ux - a.ux * b.uy);
  return Math.asin(Math.min(1, sinVal)) * RAD2DEG;
}

function maxOriginBaseline(obsList: PreparedObs[]): number {
  let maxD = 0;
  for (let i = 0; i < obsList.length; i++) {
    for (let j = i + 1; j < obsList.length; j++) {
      const d = Math.hypot(
        obsList[i].ox - obsList[j].ox,
        obsList[i].oy - obsList[j].oy,
      );
      if (d > maxD) maxD = d;
    }
  }
  return maxD;
}

function maxPairwiseAngleDeg(obsList: PreparedObs[]): number {
  let maxA = 0;
  for (let i = 0; i < obsList.length; i++) {
    for (let j = i + 1; j < obsList.length; j++) {
      const ang = acuteAngleDeg(obsList[i], obsList[j]);
      if (ang > maxA) maxA = ang;
    }
  }
  return maxA;
}

function emptyDiagnostics(obsList: PreparedObs[]): ObservationDiagnostic[] {
  return obsList.map((o) => ({
    observationId: o.id,
    residualDeg: 0,
    weight: 1,
    isOutlier: false,
  }));
}

/**
 * Robust bearing-only triangulation engine for 80m ARDF.
 *
 * Combines:
 * 1. Mixed bidirectional (ferrite-rod null) and unidirectional (sense) bearings.
 * 2. Profile-likelihood range + GPS positional uncertainty weighting so close,
 *    accurate bearings dominate distant or noisy ones.
 * 3. Multi-start pairwise intersection + campus grid seeding with 2-stage
 *    Cauchy -> Welsch redescending M-estimation to resist 40-80° campus reflections.
 * 4. Campus polygon boundary prior to suppress out-of-campus false intersections.
 * 5. Exact 2x2 Fisher information covariance for honest error-circle estimation.
 */
export function triangulateStation(
  stationId: StationId,
  observations: BearingObservation[],
  campus: CampusConfig,
  options?: TriangulationOptions,
): StationEstimate {
  const cfg: Required<TriangulationOptions> = { ...DEFAULTS, ...options };
  const sigmaThetaRad = cfg.bearingSigmaDeg * DEG2RAD;

  if (observations.length === 0) {
    return {
      stationId,
      status: 'none',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: 0,
      inlierCount: 0,
      outlierIds: [],
      maxIntersectionDeg: 0,
      diagnostics: [],
      reason: '尚未记录测向线',
    };
  }

  const prepared: PreparedObs[] = observations.map((obs) => {
    const loc = lngLatToLocal(obs.origin, campus.center);
    const thetaRad = normalizeDeg(obs.bearingDeg) * DEG2RAD;
    return {
      id: obs.id,
      ox: loc.x,
      oy: loc.y,
      ux: Math.sin(thetaRad),
      uy: Math.cos(thetaRad),
      nx: Math.cos(thetaRad),
      ny: -Math.sin(thetaRad),
      thetaRad,
      mode: obs.mode,
      sigmaPos: clamp(
        Number.isFinite(obs.gpsAccuracy) ? obs.gpsAccuracy : 8,
        3,
        60,
      ),
    };
  });

  if (prepared.length === 1) {
    return {
      stationId,
      status: 'single_line',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: 1,
      inlierCount: 1,
      outlierIds: [],
      maxIntersectionDeg: 0,
      diagnostics: emptyDiagnostics(prepared),
      reason: '仅 1 条测向线，请移动一段距离后再测 1 次',
    };
  }

  const totalBaseline = maxOriginBaseline(prepared);
  if (totalBaseline < cfg.minBaselineM) {
    return {
      stationId,
      status: 'poor_geometry',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: prepared.length,
      inlierCount: 0,
      outlierIds: [],
      maxIntersectionDeg: maxPairwiseAngleDeg(prepared),
      diagnostics: emptyDiagnostics(prepared),
      reason: `测向站位距离过近（仅 ${Math.round(totalBaseline)}m），请移动后再测`,
    };
  }

  const boundaryLocal = campus.boundary.map((pt) =>
    lngLatToLocal(pt, campus.center),
  );

  // Compute campus bounding box in local meters
  let minX = -500;
  let maxX = 500;
  let minY = -500;
  let maxY = 500;
  if (boundaryLocal.length >= 3) {
    minX = Math.min(...boundaryLocal.map((p) => p.x));
    maxX = Math.max(...boundaryLocal.map((p) => p.x));
    minY = Math.min(...boundaryLocal.map((p) => p.y));
    maxY = Math.max(...boundaryLocal.map((p) => p.y));
  }
  const campusSpan = Math.max(maxX - minX, maxY - minY, 1000);

  // 1. Gather multi-start candidate seeds
  const rawIntersections = computePairwiseIntersections(
    prepared,
    campusSpan * 3,
  );

  const rawSeeds: LocalPoint[] = [];

  // Prefer pairwise intersections consistent with unidirectional forward polarity
  for (const inter of rawIntersections) {
    const a = prepared[inter.i];
    const b = prepared[inter.j];
    const okA = a.mode === 'bidirectional' || inter.t1 > -25;
    const okB = b.mode === 'bidirectional' || inter.t2 > -25;
    if (okA && okB) {
      rawSeeds.push(inter.point);
    }
  }

  // 5x5 uniform grid inside campus bounding box for global coverage
  const gridN = 5;
  for (let gx = 0; gx < gridN; gx++) {
    for (let gy = 0; gy < gridN; gy++) {
      rawSeeds.push({
        x: minX + ((gx + 0.5) / gridN) * (maxX - minX),
        y: minY + ((gy + 0.5) / gridN) * (maxY - minY),
      });
    }
  }

  // Observer centroid seed
  const meanX = prepared.reduce((s, o) => s + o.ox, 0) / prepared.length;
  const meanY = prepared.reduce((s, o) => s + o.oy, 0) / prepared.length;
  rawSeeds.push({ x: meanX, y: meanY });

  // Score every seed under final Welsch objective & deduplicate top distinct basins
  const scoredSeeds = rawSeeds
    .map((pt) => ({
      point: pt,
      cost: evalObjective(
        prepared,
        boundaryLocal,
        pt.x,
        pt.y,
        sigmaThetaRad,
        cfg,
        'welsch',
      ).cost,
    }))
    .sort((a, b) => a.cost - b.cost);

  const selectedSeeds: LocalPoint[] = [];
  for (const s of scoredSeeds) {
    if (selectedSeeds.length >= 10) break;
    const tooClose = selectedSeeds.some(
      (k) => Math.hypot(k.x - s.point.x, k.y - s.point.y) < 15,
    );
    if (!tooClose) {
      selectedSeeds.push(s.point);
    }
  }

  // 2. Two-stage LM-IRLS optimization from each selected seed
  let bestPoint = selectedSeeds[0] ?? { x: 0, y: 0 };
  let bestCost = Infinity;

  for (const seed of selectedSeeds) {
    // Path A: Broad Cauchy -> Redescending Welsch polish
    const broad = optimizeLM(
      prepared,
      boundaryLocal,
      seed,
      sigmaThetaRad,
      cfg,
      'cauchy',
      15,
    );
    const polishedA = optimizeLM(
      prepared,
      boundaryLocal,
      broad.point,
      sigmaThetaRad,
      cfg,
      'welsch',
      25,
    );
    if (polishedA.cost < bestCost) {
      bestCost = polishedA.cost;
      bestPoint = polishedA.point;
    }

    // Path B: Direct Welsch from seed (protects tight pairwise seed from broad pull)
    const polishedB = optimizeLM(
      prepared,
      boundaryLocal,
      seed,
      sigmaThetaRad,
      cfg,
      'welsch',
      25,
    );
    if (polishedB.cost < bestCost) {
      bestCost = polishedB.cost;
      bestPoint = polishedB.point;
    }
  }

  // 3. Evaluate per-observation diagnostics & classify outliers
  const c2 = WELSCH_C * WELSCH_C;
  const evals = prepared.map((obs) =>
    evalObs(obs, bestPoint.x, bestPoint.y, sigmaThetaRad),
  );

  const diagnostics: ObservationDiagnostic[] = prepared.map((obs, idx) => {
    const ev = evals[idx];
    const residualDeg = ev.absErrRad * RAD2DEG;
    const weight = Math.exp(-(ev.z * ev.z) / (2 * c2));
    const isOutlier =
      ev.behindUni || (Math.abs(ev.z) > 2.8 && residualDeg > 20);
    return {
      observationId: obs.id,
      residualDeg: Math.round(residualDeg * 10) / 10,
      weight: Math.round(weight * 1000) / 1000,
      isOutlier,
    };
  });

  const inlierIndices = diagnostics
    .map((d, idx) => (d.isOutlier ? -1 : idx))
    .filter((idx) => idx >= 0);
  const outlierIds = diagnostics
    .filter((d) => d.isOutlier)
    .map((d) => d.observationId);

  const inlierObs = inlierIndices.map((idx) => prepared[idx]);

  // 4. Geometry & validity checks
  if (inlierObs.length < 2) {
    // Diagnose why fewer than 2 bearings agreed
    const allBehindUni =
      rawIntersections.length > 0 &&
      rawIntersections.every((inter) => {
        const a = prepared[inter.i];
        const b = prepared[inter.j];
        return (
          (a.mode === 'unidirectional' && inter.t1 < -5) ||
          (b.mode === 'unidirectional' && inter.t2 < -5)
        );
      });
    const allOutsideCampus =
      rawIntersections.length > 0 &&
      rawIntersections.every((inter) => {
        const pd = distanceToPolygonLocal(inter.point, boundaryLocal);
        return !pd.inside && pd.distance > cfg.maxOutsideCampusM;
      });
    const allAngle = maxPairwiseAngleDeg(prepared);

    let reason = '射线发散或偏差过大，请换位置重新测向';
    if (allAngle < cfg.minIntersectionDeg) {
      reason = `射线交角过小（仅 ${Math.round(allAngle)}°），请侧向移动后再测`;
    } else if (allBehindUni) {
      reason = '单向射线未在前方交会，请检查单向判别或改用双向模式';
    } else if (allOutsideCampus) {
      reason = '交会点落在校区范围外，请换位置复测';
    }

    return {
      stationId,
      status: 'poor_geometry',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: prepared.length,
      inlierCount: inlierObs.length,
      outlierIds,
      maxIntersectionDeg: Math.round(allAngle * 10) / 10,
      diagnostics,
      reason,
    };
  }

  const inlierBaseline = maxOriginBaseline(inlierObs);
  const maxIntersectionDeg = maxPairwiseAngleDeg(inlierObs);

  if (inlierBaseline < cfg.minBaselineM) {
    return {
      stationId,
      status: 'poor_geometry',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: prepared.length,
      inlierCount: inlierObs.length,
      outlierIds,
      maxIntersectionDeg: Math.round(maxIntersectionDeg * 10) / 10,
      diagnostics,
      reason: `有效测向站位距离过近（仅 ${Math.round(inlierBaseline)}m），请移动后再测`,
    };
  }

  if (maxIntersectionDeg < cfg.minIntersectionDeg) {
    return {
      stationId,
      status: 'poor_geometry',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: prepared.length,
      inlierCount: inlierObs.length,
      outlierIds,
      maxIntersectionDeg: Math.round(maxIntersectionDeg * 10) / 10,
      diagnostics,
      reason: `射线交角过小（仅 ${Math.round(maxIntersectionDeg)}°），请侧向移动后再测`,
    };
  }

  const polyDist = distanceToPolygonLocal(bestPoint, boundaryLocal);
  if (!polyDist.inside && polyDist.distance > cfg.maxOutsideCampusM) {
    return {
      stationId,
      status: 'poor_geometry',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: prepared.length,
      inlierCount: inlierObs.length,
      outlierIds,
      maxIntersectionDeg: Math.round(maxIntersectionDeg * 10) / 10,
      diagnostics,
      reason: '交会点落在校区范围外，请换位置复测',
    };
  }

  // 5. Fisher information matrix & honest 2D error circle radius
  let h00 = 0;
  let h01 = 0;
  let h11 = 0;
  let sumZ2 = 0;

  for (const idx of inlierIndices) {
    const ev = evals[idx];
    const w = Math.max(0.2, Math.exp(-(ev.z * ev.z) / (2 * c2)));
    h00 += w * ev.dzdx * ev.dzdx;
    h01 += w * ev.dzdx * ev.dzdy;
    h11 += w * ev.dzdy * ev.dzdy;
    sumZ2 += ev.z * ev.z;
  }

  const trace = h00 + h11;
  const disc = Math.sqrt(Math.max(0, (h00 - h11) ** 2 + 4 * h01 * h01));
  const muMin = 0.5 * (trace - disc);

  if (!Number.isFinite(muMin) || muMin <= 1e-8) {
    return {
      stationId,
      status: 'poor_geometry',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: prepared.length,
      inlierCount: inlierObs.length,
      outlierIds,
      maxIntersectionDeg: Math.round(maxIntersectionDeg * 10) / 10,
      diagnostics,
      reason: '几何交会不稳定，请换角度补测 1 条线',
    };
  }

  // Honest variance inflation when >= 3 inliers show excess scatter
  const dof = inlierIndices.length - 2;
  const chi2Red = dof > 0 ? sumZ2 / dof : 1;
  const scatterScale = Math.sqrt(clamp(chi2Red, 1, 9));

  const semiMajor1Sigma = scatterScale / Math.sqrt(muMin);
  // 1.5x semi-major axis gives ~68% 2D containment even along the elongated axis
  const errorRadiusM = Math.max(5, Math.round(1.5 * semiMajor1Sigma));

  if (!Number.isFinite(errorRadiusM) || errorRadiusM > cfg.maxErrorRadiusM) {
    return {
      stationId,
      status: 'poor_geometry',
      position: null,
      errorRadiusM: null,
      confidence: 0,
      observationCount: prepared.length,
      inlierCount: inlierObs.length,
      outlierIds,
      maxIntersectionDeg: Math.round(maxIntersectionDeg * 10) / 10,
      diagnostics,
      reason: `交会误差过大（约 ±${Math.min(999, errorRadiusM)}m），请拉近或换角度补测`,
    };
  }

  const status = errorRadiusM <= cfg.lockedRadiusM ? 'locked' : 'coarse';
  const radiusScore = clamp(1 - errorRadiusM / cfg.maxErrorRadiusM, 0.1, 1);
  const angleScore = clamp(maxIntersectionDeg / 60, 0.2, 1);
  const countBonus = clamp((inlierObs.length - 1) / 3, 0.35, 1);
  const confidence =
    Math.round(clamp(radiusScore * 0.55 + angleScore * 0.25 + countBonus * 0.2, 0.15, 0.99) * 100) /
    100;

  const outlierNote =
    outlierIds.length > 0 ? `（已自动忽略 ${outlierIds.length} 条疑似反射线）` : '';
  const reason =
    status === 'locked'
      ? `精准锁定 ±${errorRadiusM}m${outlierNote}`
      : `粗略锁定 ±${errorRadiusM}m，建议跑近补 1 线${outlierNote}`;

  return {
    stationId,
    status,
    position: localToLngLat(bestPoint, campus.center),
    errorRadiusM,
    confidence,
    observationCount: prepared.length,
    inlierCount: inlierObs.length,
    outlierIds,
    maxIntersectionDeg: Math.round(maxIntersectionDeg * 10) / 10,
    diagnostics,
    reason,
  };
}

/**
 * Solve triangulation estimates for all given stations.
 */
export function triangulateAllStations(
  observations: BearingObservation[],
  stationIds: StationId[],
  campus: CampusConfig,
  options?: TriangulationOptions,
): Record<StationId, StationEstimate> {
  const grouped = new Map<StationId, BearingObservation[]>();
  for (const obs of observations) {
    const arr = grouped.get(obs.stationId);
    if (arr) {
      arr.push(obs);
    } else {
      grouped.set(obs.stationId, [obs]);
    }
  }

  const result = {} as Record<StationId, StationEstimate>;
  for (const id of stationIds) {
    result[id] = triangulateStation(id, grouped.get(id) ?? [], campus, options);
  }
  return result;
}
