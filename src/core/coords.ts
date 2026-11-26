import type { LngLat, LocalPoint } from './types';

const PI = Math.PI;
const EARTH_A = 6378245.0;
const EARTH_EE = 0.00669342162296594323;
const EARTH_RADIUS_M = 6371000;

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) *
      2.0) /
    3.0;
  return ret;
}

/**
 * Convert raw browser GPS coordinates (WGS-84) to Amap Mars coordinates (GCJ-02).
 */
export function wgs84ToGcj02(wgs: LngLat): LngLat {
  if (outOfChina(wgs.lng, wgs.lat)) {
    return { ...wgs };
  }
  let dLat = transformLat(wgs.lng - 105.0, wgs.lat - 35.0);
  let dLng = transformLng(wgs.lng - 105.0, wgs.lat - 35.0);
  const radLat = (wgs.lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EARTH_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((EARTH_A * (1 - EARTH_EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((EARTH_A / sqrtMagic) * Math.cos(radLat) * PI);
  return {
    lng: wgs.lng + dLng,
    lat: wgs.lat + dLat,
  };
}

/**
 * Project a GCJ-02 point into local ENU (East-North) meters relative to an origin.
 * Accurate to sub-centimeter over campus scales (< 5 km).
 */
export function lngLatToLocal(point: LngLat, origin: LngLat): LocalPoint {
  const latRad = (origin.lat * PI) / 180;
  const metersPerDegLat = 111320.0;
  const metersPerDegLng = 111320.0 * Math.cos(latRad);
  return {
    x: (point.lng - origin.lng) * metersPerDegLng,
    y: (point.lat - origin.lat) * metersPerDegLat,
  };
}

/**
 * Inverse projection from local ENU meters back to GCJ-02 coordinates.
 */
export function localToLngLat(local: LocalPoint, origin: LngLat): LngLat {
  const latRad = (origin.lat * PI) / 180;
  const metersPerDegLat = 111320.0;
  const metersPerDegLng = 111320.0 * Math.cos(latRad);
  return {
    lng: origin.lng + local.x / metersPerDegLng,
    lat: origin.lat + local.y / metersPerDegLat,
  };
}

/**
 * Compute great-circle distance in meters between two LngLat points.
 */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const toRad = (deg: number) => (deg * PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ray-casting point-in-polygon check (works in LngLat space for campus-scale polygons).
 */
export function isPointInPolygon(point: LngLat, polygon: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Normalize an angle in degrees to [0, 360).
 */
export function normalizeDeg(deg: number): number {
  const mod = deg % 360;
  return mod < 0 ? mod + 360 : mod;
}

/**
 * Shortest signed angular difference (target - current) in (-180, 180].
 */
export function shortestAngleDelta(currentDeg: number, targetDeg: number): number {
  let delta = normalizeDeg(targetDeg - currentDeg);
  if (delta > 180) delta -= 360;
  return delta;
}

/**
 * Compute a destination point given origin, compass bearing (0=N, 90=E), and distance in meters.
 */
export function destinationPoint(
  origin: LngLat,
  bearingDeg: number,
  distanceMeters: number,
): LngLat {
  const rad = (normalizeDeg(bearingDeg) * PI) / 180;
  return localToLngLat(
    {
      x: Math.sin(rad) * distanceMeters,
      y: Math.cos(rad) * distanceMeters,
    },
    origin,
  );
}

/**
 * Compute compass bearing in degrees [0, 360) from `from` to `to` (0=N, 90=E).
 */
export function bearingBetween(from: LngLat, to: LngLat): number {
  const local = lngLatToLocal(to, from);
  const rad = Math.atan2(local.x, local.y);
  return normalizeDeg((rad * 180) / PI);
}

export function headingToCardinal(deg: number): string {
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const idx = Math.round(normalizeDeg(deg) / 45) % 8;
  return dirs[idx];
}
