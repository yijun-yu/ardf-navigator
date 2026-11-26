import { describe, expect, it } from 'vitest';
import {
  destinationPoint,
  haversineMeters,
  isPointInPolygon,
  lngLatToLocal,
  localToLngLat,
  normalizeDeg,
  shortestAngleDelta,
  wgs84ToGcj02,
} from './coords';
import { CAMPUSES } from './campuses';
import { drawRandomSixTargets, STATIONS } from './stations';

describe('coords utilities', () => {
  it('applies non-zero GCJ-02 shift in Hangzhou (ZJU Zijingang)', () => {
    const wgs = { lng: 120.0772, lat: 30.3052 };
    const gcj = wgs84ToGcj02(wgs);
    const shift = haversineMeters(wgs, gcj);
    // In Hangzhou, WGS84->GCJ02 offset is typically ~400-600m
    expect(shift).toBeGreaterThan(250);
    expect(shift).toBeLessThan(800);
  });

  it('round-trips local ENU meter projection accurately', () => {
    const origin = CAMPUSES.zijingang.center;
    const target = { lng: origin.lng + 0.005, lat: origin.lat - 0.003 };
    const local = lngLatToLocal(target, origin);
    const back = localToLngLat(local, origin);
    expect(haversineMeters(target, back)).toBeLessThan(0.05);
  });

  it('computes destination point along compass bearings', () => {
    const origin = CAMPUSES.zijingang.center;
    const north = destinationPoint(origin, 0, 100);
    const east = destinationPoint(origin, 90, 100);
    expect(north.lat).toBeGreaterThan(origin.lat);
    expect(Math.abs(north.lng - origin.lng)).toBeLessThan(1e-7);
    expect(east.lng).toBeGreaterThan(origin.lng);
    expect(haversineMeters(origin, north)).toBeCloseTo(100, 0);
    expect(haversineMeters(origin, east)).toBeCloseTo(100, 0);
  });

  it('handles point-in-polygon for all 3 ZJU campus centers', () => {
    for (const campus of Object.values(CAMPUSES)) {
      expect(isPointInPolygon(campus.center, campus.boundary)).toBe(true);
    }
    expect(
      isPointInPolygon(CAMPUSES.huajiachi.center, CAMPUSES.zijingang.boundary),
    ).toBe(false);
  });

  it('normalizes angles and computes shortest signed delta across 0/360 wrap', () => {
    expect(normalizeDeg(-10)).toBe(350);
    expect(normalizeDeg(370)).toBe(10);
    expect(shortestAngleDelta(355, 5)).toBe(10);
    expect(shortestAngleDelta(5, 355)).toBe(-10);
  });
});

describe('80m station specification', () => {
  it('defines all 11 stations (0-9 plus MO)', () => {
    expect(STATIONS).toHaveLength(11);
    expect(STATIONS.find((s) => s.id === '1')?.callsign).toBe('MOE');
    expect(STATIONS.find((s) => s.id === '5')?.callsign).toBe('MO5');
    expect(STATIONS.find((s) => s.id === 'MO')?.morse).toBe('-- ---');
  });

  it('draws 6 unique targets including MO', () => {
    const draw = drawRandomSixTargets();
    expect(draw).toHaveLength(6);
    expect(new Set(draw).size).toBe(6);
    expect(draw).toContain('MO');
  });
});
