/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bearingBetween,
  destinationPoint,
  haversineMeters,
  headingToCardinal,
  isPointInPolygon,
  lngLatToLocal,
  localToLngLat,
} from '../core/coords';
import { getStation } from '../core/stations';
import type {
  BearingMode,
  BearingObservation,
  CampusConfig,
  CompassReading,
  GpsFix,
  LngLat,
  RoutePlan,
  StationEstimate,
  StationId,
  VirtualTransmitter,
} from '../core/types';
import { loadAmap } from '../services/amapLoader';

interface MapViewProps {
  campus: CampusConfig;
  amapKey: string;
  amapSecurityCode: string;
  gps: GpsFix | null;
  compass: CompassReading | null;
  bearingMode: BearingMode;
  targets: StationId[];
  punched: StationId[];
  activeStation: StationId;
  observations: BearingObservation[];
  estimates: Record<StationId, StationEstimate>;
  routePlan: RoutePlan | null;
  showRoute: boolean;
  showAllRays: boolean;
  simMode: boolean;
  simOrigin: LngLat | null;
  virtualRunnerPos?: LngLat | null;
  virtualTruths?: VirtualTransmitter[];
  canClickToMoveVirtualRunner?: boolean;
  onMoveVirtualRunner?: (pos: LngLat) => void;
  onSelectStation: (id: StationId) => void;
  onToggleShowRoute: () => void;
  onToggleShowAllRays: () => void;
  onSimOriginChange: (origin: LngLat | null) => void;
  onSimPreviewDegChange: (deg: number | null) => void;
  onRecordSimulatedBearing: (origin: LngLat, bearingDeg: number) => void;
  onAmapReady?: (amap: any | null) => void;
  onOpenSettings: () => void;
}

type AmapStatus = 'no-key' | 'loading' | 'ready' | 'error';

const RAY_DISPLAY_METERS = 1300;
const OUTLIER_COLOR = '#94a3b8';

export function MapView({
  campus,
  amapKey,
  amapSecurityCode,
  gps,
  compass,
  bearingMode,
  targets,
  punched,
  activeStation,
  observations,
  estimates,
  routePlan,
  showRoute,
  showAllRays,
  simMode,
  simOrigin,
  virtualRunnerPos,
  virtualTruths,
  canClickToMoveVirtualRunner,
  onMoveVirtualRunner,
  onSelectStation,
  onToggleShowRoute,
  onToggleShowAllRays,
  onSimOriginChange,
  onSimPreviewDegChange,
  onRecordSimulatedBearing,
  onAmapReady,
  onOpenSettings,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<any>(null);
  const boundaryPolyRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const accCircleRef = useRef<any>(null);
  const headingLineRef = useRef<any>(null);
  const backLineRef = useRef<any>(null);

  const rayOverlaysRef = useRef<any[]>([]);
  const routeOverlaysRef = useRef<any[]>([]);
  const estimateOverlaysRef = useRef<any[]>([]);
  const simOverlaysRef = useRef<any[]>([]);
  const truthOverlaysRef = useRef<any[]>([]);
  const virtualRunnerMarkerRef = useRef<any>(null);

  const [status, setStatus] = useState<AmapStatus>(
    amapKey.trim() ? 'loading' : 'no-key',
  );
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [followUser, setFollowUser] = useState<boolean>(false);
  const [simAimPoint, setSimAimPoint] = useState<LngLat | null>(null);

  // Keep latest simulation callbacks in refs so Amap event listeners never go stale
  const simRef = useRef({
    simMode,
    simOrigin,
    canClickToMoveVirtualRunner,
    onMoveVirtualRunner,
    onSimOriginChange,
    onSimPreviewDegChange,
    onRecordSimulatedBearing,
  });
  simRef.current = {
    simMode,
    simOrigin,
    canClickToMoveVirtualRunner,
    onMoveVirtualRunner,
    onSimOriginChange,
    onSimPreviewDegChange,
    onRecordSimulatedBearing,
  };

  // Clear aim preview when leaving sim mode or resetting origin
  useEffect(() => {
    if (!simMode || !simOrigin) {
      setSimAimPoint(null);
      onSimPreviewDegChange(null);
    }
  }, [simMode, simOrigin, onSimPreviewDegChange]);

  // Load Amap JS API when key changes
  useEffect(() => {
    const trimmed = amapKey.trim();
    if (!trimmed) {
      if (mapRef.current) {
        mapRef.current.destroy();
        mapRef.current = null;
      }
      amapRef.current = null;
      onAmapReady?.(null);
      setStatus('no-key');
      setErrorMsg('');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    setErrorMsg('');

    loadAmap(trimmed, amapSecurityCode)
      .then((AMap) => {
        if (cancelled || !containerRef.current) return;
        amapRef.current = AMap;

        if (mapRef.current) {
          mapRef.current.destroy();
          mapRef.current = null;
        }

        const map = new AMap.Map(containerRef.current, {
          zoom: campus.defaultZoom,
          center: [campus.center.lng, campus.center.lat],
          viewMode: '2D',
          mapStyle: 'amap://styles/normal',
          showBuildingBlock: false,
        });

        if (AMap.Scale) {
          map.addControl(new AMap.Scale({ position: 'LB' }));
        }

        map.on('dragstart', () => setFollowUser(false));

        map.on('click', (e: any) => {
          const cur = simRef.current;
          if (!e?.lnglat) return;
          const pt: LngLat = {
            lng: e.lnglat.getLng(),
            lat: e.lnglat.getLat(),
          };
          if (cur.simMode) {
            if (!cur.simOrigin) {
              cur.onSimOriginChange(pt);
            } else {
              if (haversineMeters(cur.simOrigin, pt) < 3) return;
              const deg = bearingBetween(cur.simOrigin, pt);
              cur.onRecordSimulatedBearing(cur.simOrigin, deg);
            }
          } else if (cur.canClickToMoveVirtualRunner && cur.onMoveVirtualRunner) {
            cur.onMoveVirtualRunner(pt);
          }
        });

        map.on('mousemove', (e: any) => {
          const cur = simRef.current;
          if (!cur.simMode || !cur.simOrigin || !e?.lnglat) return;
          const pt: LngLat = {
            lng: e.lnglat.getLng(),
            lat: e.lnglat.getLat(),
          };
          if (haversineMeters(cur.simOrigin, pt) < 3) return;
          setSimAimPoint(pt);
          cur.onSimPreviewDegChange(bearingBetween(cur.simOrigin, pt));
        });

        mapRef.current = map;
        setStatus('ready');
        onAmapReady?.(AMap);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onAmapReady?.(null);
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : '高德地图加载失败');
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapKey, amapSecurityCode]);

  // Cleanup map on unmount
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.destroy();
        mapRef.current = null;
      }
    };
  }, []);

  // Update campus view & boundary polygon on Amap
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap || status !== 'ready') return;

    map.setZoomAndCenter(campus.defaultZoom, [
      campus.center.lng,
      campus.center.lat,
    ]);

    if (boundaryPolyRef.current) {
      map.remove(boundaryPolyRef.current);
    }

    const poly = new AMap.Polygon({
      path: campus.boundary.map((p) => [p.lng, p.lat]),
      strokeColor: '#38bdf8',
      strokeWeight: 2,
      strokeStyle: 'dashed',
      strokeOpacity: 0.85,
      fillColor: '#0ea5e9',
      fillOpacity: 0.05,
      bubble: true,
    });
    map.add(poly);
    boundaryPolyRef.current = poly;
  }, [campus, status]);

  // Update live GPS blue dot, accuracy circle, and live heading line on Amap
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap || status !== 'ready') return;

    const anchor: LngLat = gps?.gcj ?? campus.center;
    const hasRealGps = Boolean(gps);

    if (hasRealGps && gps) {
      if (!accCircleRef.current) {
        accCircleRef.current = new AMap.Circle({
          center: [anchor.lng, anchor.lat],
          radius: Math.max(4, gps.accuracy),
          strokeColor: '#38bdf8',
          strokeWeight: 1,
          strokeOpacity: 0.5,
          fillColor: '#38bdf8',
          fillOpacity: 0.14,
          bubble: true,
        });
        map.add(accCircleRef.current);
      } else {
        accCircleRef.current.setCenter([anchor.lng, anchor.lat]);
        accCircleRef.current.setRadius(Math.max(4, gps.accuracy));
      }

      const headingDeg = compass?.heading ?? 0;
      const dotHtml = `
        <div class="amap-runner-marker" style="transform: rotate(${headingDeg.toFixed(1)}deg)">
          <div class="amap-runner-cone"></div>
          <div class="amap-runner-dot"></div>
        </div>
      `;

      if (!userMarkerRef.current) {
        userMarkerRef.current = new AMap.Marker({
          position: [anchor.lng, anchor.lat],
          content: dotHtml,
          offset: new AMap.Pixel(-18, -18),
          zIndex: 120,
          bubble: true,
        });
        map.add(userMarkerRef.current);
      } else {
        userMarkerRef.current.setPosition([anchor.lng, anchor.lat]);
        userMarkerRef.current.setContent(dotHtml);
      }

      if (followUser) {
        map.setCenter([anchor.lng, anchor.lat]);
      }
    }

    if (compass) {
      const forwardEnd = destinationPoint(anchor, compass.heading, 450);
      const forwardPath = [
        [anchor.lng, anchor.lat],
        [forwardEnd.lng, forwardEnd.lat],
      ];

      if (!headingLineRef.current) {
        headingLineRef.current = new AMap.Polyline({
          path: forwardPath,
          strokeColor: '#f59e0b',
          strokeWeight: 2.5,
          strokeOpacity: 0.85,
          strokeStyle: 'solid',
          zIndex: 110,
          bubble: true,
        });
        map.add(headingLineRef.current);
      } else {
        headingLineRef.current.setPath(forwardPath);
      }

      if (bearingMode === 'bidirectional') {
        const backwardEnd = destinationPoint(anchor, compass.heading + 180, 450);
        const backwardPath = [
          [anchor.lng, anchor.lat],
          [backwardEnd.lng, backwardEnd.lat],
        ];
        if (!backLineRef.current) {
          backLineRef.current = new AMap.Polyline({
            path: backwardPath,
            strokeColor: '#f59e0b',
            strokeWeight: 2,
            strokeOpacity: 0.45,
            strokeStyle: 'dashed',
            zIndex: 109,
            bubble: true,
          });
          map.add(backLineRef.current);
        } else {
          backLineRef.current.setPath(backwardPath);
          backLineRef.current.show();
        }
      } else if (backLineRef.current) {
        backLineRef.current.hide();
      }
    }
  }, [gps, compass, bearingMode, campus.center, status, followUser]);

  // Build quick outlier lookup map
  const outlierSet = useMemo(() => {
    const set = new Set<string>();
    for (const est of Object.values(estimates)) {
      if (!est) continue;
      for (const id of est.outlierIds) {
        set.add(id);
      }
    }
    return set;
  }, [estimates]);

  // Visible bearing observations (only active station by default to keep map clean)
  const visibleObservations = useMemo(() => {
    if (showAllRays) {
      return observations.filter((o) => targets.includes(o.stationId));
    }
    return observations.filter((o) => o.stationId === activeStation);
  }, [observations, showAllRays, activeStation, targets]);

  // Render bearing rays on Amap
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap || status !== 'ready') return;

    if (rayOverlaysRef.current.length > 0) {
      map.remove(rayOverlaysRef.current);
      rayOverlaysRef.current = [];
    }

    const nextOverlays: any[] = [];

    for (const obs of visibleObservations) {
      const st = getStation(obs.stationId);
      const isActive = obs.stationId === activeStation;
      const isOutlier = outlierSet.has(obs.id);
      const strokeColor = isOutlier ? OUTLIER_COLOR : st.color;

      const fwdEnd = destinationPoint(
        obs.origin,
        obs.bearingDeg,
        RAY_DISPLAY_METERS,
      );
      const fwdLine = new AMap.Polyline({
        path: [
          [obs.origin.lng, obs.origin.lat],
          [fwdEnd.lng, fwdEnd.lat],
        ],
        strokeColor,
        strokeWeight: isOutlier ? 1.8 : isActive ? 2.5 : 1.7,
        strokeOpacity: isOutlier ? 0.55 : isActive ? 0.9 : 0.45,
        strokeStyle: isOutlier ? 'dashed' : 'solid',
        zIndex: isOutlier ? 80 : isActive ? 95 : 85,
        bubble: true,
      });
      nextOverlays.push(fwdLine);

      if (obs.mode === 'bidirectional') {
        const backEnd = destinationPoint(
          obs.origin,
          obs.bearingDeg + 180,
          RAY_DISPLAY_METERS,
        );
        const backLine = new AMap.Polyline({
          path: [
            [obs.origin.lng, obs.origin.lat],
            [backEnd.lng, backEnd.lat],
          ],
          strokeColor,
          strokeWeight: isOutlier ? 1.5 : isActive ? 1.8 : 1.3,
          strokeOpacity: isOutlier ? 0.4 : isActive ? 0.52 : 0.25,
          strokeStyle: 'dashed',
          zIndex: isOutlier ? 79 : isActive ? 94 : 84,
          bubble: true,
        });
        nextOverlays.push(backLine);
      }

      const originDot = new AMap.CircleMarker({
        center: [obs.origin.lng, obs.origin.lat],
        radius: isActive ? 4.5 : 3.5,
        strokeColor: '#ffffff',
        strokeWeight: 1.5,
        fillColor: strokeColor,
        fillOpacity: isOutlier ? 0.7 : 0.95,
        zIndex: isActive ? 105 : 92,
        bubble: true,
      });
      nextOverlays.push(originDot);
    }

    if (nextOverlays.length > 0) {
      map.add(nextOverlays);
      rayOverlaysRef.current = nextOverlays;
    }
  }, [visibleObservations, activeStation, outlierSet, status]);

  // Quick lookup from stationId -> 1-based optimal visit order
  const orderMap = useMemo(() => {
    const map = new Map<StationId, number>();
    if (routePlan) {
      routePlan.orderedStations.forEach((id, idx) => map.set(id, idx + 1));
    }
    return map;
  }, [routePlan]);

  // Render optimal walking / running route polylines on Amap
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap || status !== 'ready') return;

    if (routeOverlaysRef.current.length > 0) {
      map.remove(routeOverlaysRef.current);
      routeOverlaysRef.current = [];
    }

    if (!showRoute || !routePlan || routePlan.legs.length === 0) return;

    const nextOverlays: any[] = [];

    // Draw subsequent legs first (underneath active first leg)
    for (let i = routePlan.legs.length - 1; i >= 0; i--) {
      const leg = routePlan.legs[i];
      if (leg.path.length < 2) continue;
      const pathArr = leg.path.map((p) => [p.lng, p.lat]);
      const isFirst = i === 0;

      if (isFirst) {
        // Subtle outer glow for primary sprint leg
        nextOverlays.push(
          new AMap.Polyline({
            path: pathArr,
            strokeColor: '#0284c7',
            strokeWeight: 8,
            strokeOpacity: 0.3,
            lineJoin: 'round',
            lineCap: 'round',
            zIndex: 116,
            bubble: true,
          }),
        );
        nextOverlays.push(
          new AMap.Polyline({
            path: pathArr,
            strokeColor: '#22d3ee',
            strokeWeight: 4.5,
            strokeOpacity: 0.96,
            strokeStyle: leg.isRealRoad ? 'solid' : 'dashed',
            showDir: true,
            lineJoin: 'round',
            lineCap: 'round',
            zIndex: 118,
            bubble: true,
          }),
        );
      } else {
        nextOverlays.push(
          new AMap.Polyline({
            path: pathArr,
            strokeColor: '#38bdf8',
            strokeWeight: 3.2,
            strokeOpacity: 0.62,
            strokeStyle: leg.isRealRoad ? 'solid' : 'dashed',
            showDir: leg.isRealRoad,
            lineJoin: 'round',
            lineCap: 'round',
            zIndex: 112,
            bubble: true,
          }),
        );
      }
    }

    if (nextOverlays.length > 0) {
      map.add(nextOverlays);
      routeOverlaysRef.current = nextOverlays;
    }
  }, [routePlan, showRoute, status]);

  // Render all estimated station markers & error circles on Amap
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap || status !== 'ready') return;

    if (estimateOverlaysRef.current.length > 0) {
      map.remove(estimateOverlaysRef.current);
      estimateOverlaysRef.current = [];
    }

    const nextOverlays: any[] = [];

    for (const id of targets) {
      const est = estimates[id];
      if (!est?.position || est.errorRadiusM === null) continue;

      const st = getStation(id);
      const isActive = id === activeStation;
      const isPunched = punched.includes(id);
      const orderNum = !isPunched && showRoute ? orderMap.get(id) : undefined;
      const color = isPunched ? '#22c55e' : st.color;

      const errCircle = new AMap.Circle({
        center: [est.position.lng, est.position.lat],
        radius: est.errorRadiusM,
        strokeColor: color,
        strokeWeight: isActive ? 2.2 : 1.5,
        strokeOpacity: isPunched ? 0.45 : isActive ? 0.9 : 0.65,
        strokeStyle: est.status === 'coarse' ? 'dashed' : 'solid',
        fillColor: color,
        fillOpacity: isPunched ? 0.06 : isActive ? 0.16 : 0.1,
        zIndex: isActive ? 130 : 122,
        bubble: true,
      });
      nextOverlays.push(errCircle);

      const orderBadgeHtml = orderNum
        ? `<span class="amap-pin-order ${orderNum === 1 ? 'first' : ''}">${orderNum}</span>`
        : '';

      const pinHtml = `
        <div class="amap-station-pin ${isActive ? 'active' : ''} ${isPunched ? 'punched' : ''}">
          <div class="amap-pin-wrap">
            <div class="amap-pin-badge" style="background:${color}">
              ${isPunched ? '✓' : st.id}
            </div>
            ${orderBadgeHtml}
          </div>
          <div class="amap-pin-sub">${isPunched ? `${st.id}已打` : `±${est.errorRadiusM}m`}</div>
        </div>
      `;
      const pinMarker = new AMap.Marker({
        position: [est.position.lng, est.position.lat],
        content: pinHtml,
        offset: new AMap.Pixel(-20, -16),
        zIndex: orderNum === 1 ? 154 : isActive ? 150 : 138,
      });
      pinMarker.on('click', () => {
        if (!simRef.current.simMode) {
          onSelectStation(id);
        }
      });
      nextOverlays.push(pinMarker);
    }

    if (nextOverlays.length > 0) {
      map.add(nextOverlays);
      estimateOverlaysRef.current = nextOverlays;
    }
  }, [targets, estimates, activeStation, punched, showRoute, orderMap, status, onSelectStation]);

  // Render simulated standing point & aim preview line on Amap
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap || status !== 'ready') return;

    if (simOverlaysRef.current.length > 0) {
      map.remove(simOverlaysRef.current);
      simOverlaysRef.current = [];
    }

    if (!simMode || !simOrigin) return;

    const nextOverlays: any[] = [];
    const pinMarker = new AMap.Marker({
      position: [simOrigin.lng, simOrigin.lat],
      content: '<div class="amap-sim-origin"></div>',
      offset: new AMap.Pixel(-9, -9),
      zIndex: 160,
      bubble: true,
    });
    nextOverlays.push(pinMarker);

    if (simAimPoint) {
      const deg = bearingBetween(simOrigin, simAimPoint);
      const fwd = destinationPoint(simOrigin, deg, 600);
      nextOverlays.push(
        new AMap.Polyline({
          path: [
            [simOrigin.lng, simOrigin.lat],
            [fwd.lng, fwd.lat],
          ],
          strokeColor: '#fbbf24',
          strokeWeight: 2.5,
          strokeOpacity: 0.9,
          strokeStyle: 'solid',
          zIndex: 155,
          bubble: true,
        }),
      );
      if (bearingMode === 'bidirectional') {
        const back = destinationPoint(simOrigin, deg + 180, 600);
        nextOverlays.push(
          new AMap.Polyline({
            path: [
              [simOrigin.lng, simOrigin.lat],
              [back.lng, back.lat],
            ],
            strokeColor: '#fbbf24',
            strokeWeight: 2,
            strokeOpacity: 0.5,
            strokeStyle: 'dashed',
            zIndex: 154,
            bubble: true,
          }),
        );
      }
    }

    map.add(nextOverlays);
    simOverlaysRef.current = nextOverlays;
  }, [simMode, simOrigin, simAimPoint, bearingMode, status]);

  // Render optional virtual ground-truth markers (review mode) & desktop virtual runner dot on Amap
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap || status !== 'ready') return;

    if (truthOverlaysRef.current.length > 0) {
      map.remove(truthOverlaysRef.current);
      truthOverlaysRef.current = [];
    }

    if (virtualTruths && virtualTruths.length > 0) {
      const markers = virtualTruths.map(
        (tx) =>
          new AMap.Marker({
            position: [tx.position.lng, tx.position.lat],
            content: `<div class="amap-truth-pin ${tx.isTarget ? 'target' : 'decoy'}">${
              tx.isTarget ? `真${tx.stationId}` : `扰${tx.stationId}`
            }</div>`,
            offset: new AMap.Pixel(-18, -11),
            zIndex: 145,
            bubble: true,
          }),
      );
      map.add(markers);
      truthOverlaysRef.current = markers;
    }

    if (virtualRunnerMarkerRef.current) {
      map.remove(virtualRunnerMarkerRef.current);
      virtualRunnerMarkerRef.current = null;
    }
    if (virtualRunnerPos && !gps) {
      virtualRunnerMarkerRef.current = new AMap.Marker({
        position: [virtualRunnerPos.lng, virtualRunnerPos.lat],
        content: '<div class="amap-virtual-runner"></div>',
        offset: new AMap.Pixel(-10, -10),
        zIndex: 158,
        bubble: true,
      });
      map.add(virtualRunnerMarkerRef.current);
    }
  }, [virtualTruths, virtualRunnerPos, gps, status]);

  const handleRecenterMe = () => {
    if (!mapRef.current || !gps) return;
    setFollowUser(true);
    mapRef.current.setZoomAndCenter(17, [gps.gcj.lng, gps.gcj.lat]);
  };

  const handleRecenterCampus = () => {
    if (!mapRef.current) return;
    setFollowUser(false);
    mapRef.current.setZoomAndCenter(campus.defaultZoom, [
      campus.center.lng,
      campus.center.lat,
    ]);
  };

  const gpsInCampus = useMemo(() => {
    if (!gps) return null;
    return isPointInPolygon(gps.gcj, campus.boundary);
  }, [gps, campus.boundary]);

  const activeSpec = getStation(activeStation);
  const simPreviewDeg =
    simMode && simOrigin && simAimPoint
      ? Math.round(bearingBetween(simOrigin, simAimPoint))
      : null;

  return (
    <div className={`map-stage ${simMode ? 'sim-active' : ''}`}>
      {/* Real Amap container */}
      <div
        ref={containerRef}
        className={`amap-canvas ${status === 'ready' ? 'visible' : 'hidden'}`}
      />

      {/* Fallback local coordinate grid when Amap Key is not configured yet */}
      {status !== 'ready' && (
        <FallbackCampusRadar
          campus={campus}
          gps={gps}
          compass={compass}
          bearingMode={bearingMode}
          targets={targets}
          punched={punched}
          activeStation={activeStation}
          visibleObservations={visibleObservations}
          estimates={estimates}
          routePlan={routePlan}
          showRoute={showRoute}
          orderMap={orderMap}
          outlierSet={outlierSet}
          simMode={simMode}
          simOrigin={simOrigin}
          simAimPoint={simAimPoint}
          virtualRunnerPos={virtualRunnerPos}
          virtualTruths={virtualTruths}
          canClickToMoveVirtualRunner={canClickToMoveVirtualRunner}
          onMoveVirtualRunner={onMoveVirtualRunner}
          status={status}
          errorMsg={errorMsg}
          onSelectStation={onSelectStation}
          onSimOriginChange={onSimOriginChange}
          onSimAimPointChange={(pt) => {
            setSimAimPoint(pt);
            if (simOrigin && pt && haversineMeters(simOrigin, pt) >= 3) {
              onSimPreviewDegChange(bearingBetween(simOrigin, pt));
            } else {
              onSimPreviewDegChange(null);
            }
          }}
          onRecordSimulatedBearing={onRecordSimulatedBearing}
          onOpenSettings={onOpenSettings}
        />
      )}

      {/* Simulation guidance banner */}
      {simMode && (
        <div className="sim-guide-bar">
          <div className="sim-guide-text">
            <strong>🧪 模拟打点 · {activeSpec.label}</strong>
            <span>
              {!simOrigin
                ? '第 1 步：点击地图放置模拟站位'
                : `第 2 步：点击目标方向打出${bearingMode === 'bidirectional' ? '双向' : '单向'}线${
                    simPreviewDeg !== null ? `（${simPreviewDeg}°）` : ''
                  }`}
            </span>
          </div>
          {simOrigin && (
            <button
              type="button"
              className="btn-ghost-sm"
              onClick={() => onSimOriginChange(null)}
            >
              重选站位
            </button>
          )}
        </div>
      )}

      {/* Floating map controls (right side, thumb-accessible) */}
      <div className="map-fab-stack">
        <button
          type="button"
          className={`map-fab ${showRoute ? 'active' : ''}`}
          onClick={onToggleShowRoute}
          title={showRoute ? '隐藏推荐路线' : '显示最优跑步路线'}
        >
          路线
        </button>

        <button
          type="button"
          className={`map-fab ${showAllRays ? 'active' : ''}`}
          onClick={onToggleShowAllRays}
          title={showAllRays ? '仅看当前台射线' : '显示全部目标台射线'}
        >
          {showAllRays ? '全线' : '单台'}
        </button>

        {status === 'ready' && (
          <>
            <button
              type="button"
              className={`map-fab ${followUser ? 'active' : ''}`}
              onClick={handleRecenterMe}
              disabled={!gps}
              title="定位到我"
            >
              ◎
            </button>
            <button
              type="button"
              className="map-fab"
              onClick={handleRecenterCampus}
              title="回到校区全览"
            >
              校
            </button>
          </>
        )}
      </div>

      {/* Warning banner if GPS is outside currently selected campus */}
      {gpsInCampus === false && !simMode && (
        <div className="map-floating-pill warn">
          当前定位不在{campus.shortName}校区范围内（可顶部切换校区）
        </div>
      )}
    </div>
  );
}

interface FallbackProps {
  campus: CampusConfig;
  gps: GpsFix | null;
  compass: CompassReading | null;
  bearingMode: BearingMode;
  targets: StationId[];
  punched: StationId[];
  activeStation: StationId;
  visibleObservations: BearingObservation[];
  estimates: Record<StationId, StationEstimate>;
  routePlan: RoutePlan | null;
  showRoute: boolean;
  orderMap: Map<StationId, number>;
  outlierSet: Set<string>;
  simMode: boolean;
  simOrigin: LngLat | null;
  simAimPoint: LngLat | null;
  virtualRunnerPos?: LngLat | null;
  virtualTruths?: VirtualTransmitter[];
  canClickToMoveVirtualRunner?: boolean;
  onMoveVirtualRunner?: (pos: LngLat) => void;
  status: AmapStatus;
  errorMsg: string;
  onSelectStation: (id: StationId) => void;
  onSimOriginChange: (origin: LngLat | null) => void;
  onSimAimPointChange: (pt: LngLat | null) => void;
  onRecordSimulatedBearing: (origin: LngLat, bearingDeg: number) => void;
  onOpenSettings: () => void;
}

/**
 * Interactive local-meter SVG preview rendered when Amap Key is not yet set,
 * supporting full Stage 2 rays, error circles, outlier styling, Stage 4 routes, and click-to-simulate.
 */
function FallbackCampusRadar({
  campus,
  gps,
  compass,
  bearingMode,
  targets,
  punched,
  activeStation,
  visibleObservations,
  estimates,
  routePlan,
  showRoute,
  orderMap,
  outlierSet,
  simMode,
  simOrigin,
  simAimPoint,
  virtualRunnerPos,
  virtualTruths,
  canClickToMoveVirtualRunner,
  onMoveVirtualRunner,
  status,
  errorMsg,
  onSelectStation,
  onSimOriginChange,
  onSimAimPointChange,
  onRecordSimulatedBearing,
  onOpenSettings,
}: FallbackProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  const localBoundary = useMemo(
    () => campus.boundary.map((pt) => lngLatToLocal(pt, campus.center)),
    [campus],
  );

  const bounds = useMemo(() => {
    const xs = localBoundary.map((p) => p.x);
    const ys = localBoundary.map((p) => p.y);
    const maxSpan = Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
      800,
    );
    return { half: maxSpan * 0.62 };
  }, [localBoundary]);

  const scalePxPerMeter = 500 / (bounds.half * 2);

  const toSvg = (x: number, y: number) => ({
    sx: 250 + x * scalePxPerMeter,
    sy: 250 - y * scalePxPerMeter,
  });

  const lngLatToSvg = (pt: LngLat) => {
    const loc = lngLatToLocal(pt, campus.center);
    return toSvg(loc.x, loc.y);
  };

  const clientEventToLngLat = (
    e: React.MouseEvent<SVGSVGElement>,
  ): LngLat | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(ctm.inverse());
    const localX = (svgPt.x - 250) / scalePxPerMeter;
    const localY = (250 - svgPt.y) / scalePxPerMeter;
    return localToLngLat({ x: localX, y: localY }, campus.center);
  };

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const pt = clientEventToLngLat(e);
    if (!pt) return;
    if (simMode) {
      if (!simOrigin) {
        onSimOriginChange(pt);
      } else {
        if (haversineMeters(simOrigin, pt) < 3) return;
        const deg = bearingBetween(simOrigin, pt);
        onRecordSimulatedBearing(simOrigin, deg);
      }
    } else if (canClickToMoveVirtualRunner && onMoveVirtualRunner) {
      onMoveVirtualRunner(pt);
    }
  };

  const handleSvgMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!simMode || !simOrigin) return;
    const pt = clientEventToLngLat(e);
    if (!pt || haversineMeters(simOrigin, pt) < 3) return;
    onSimAimPointChange(pt);
  };

  const polyPoints = localBoundary
    .map((p) => {
      const { sx, sy } = toSvg(p.x, p.y);
      return `${sx.toFixed(1)},${sy.toFixed(1)}`;
    })
    .join(' ');

  const userLocal = gps
    ? lngLatToLocal(gps.gcj, campus.center)
    : { x: 0, y: 0 };
  const userSvg = toSvg(userLocal.x, userLocal.y);
  const clampedUser = {
    sx: Math.max(24, Math.min(476, userSvg.sx)),
    sy: Math.max(24, Math.min(476, userSvg.sy)),
  };

  const heading = compass?.heading ?? 0;
  const rad = (heading * Math.PI) / 180;
  const lineLen = 170;
  const fwdX = clampedUser.sx + Math.sin(rad) * lineLen;
  const fwdY = clampedUser.sy - Math.cos(rad) * lineLen;
  const backX = clampedUser.sx - Math.sin(rad) * lineLen;
  const backY = clampedUser.sy + Math.cos(rad) * lineLen;

  const simOriginSvg = simOrigin ? lngLatToSvg(simOrigin) : null;
  let simAimSvgFwd: { sx: number; sy: number } | null = null;
  let simAimSvgBack: { sx: number; sy: number } | null = null;
  if (simMode && simOrigin && simAimPoint && simOriginSvg) {
    const deg = bearingBetween(simOrigin, simAimPoint);
    simAimSvgFwd = lngLatToSvg(destinationPoint(simOrigin, deg, 1200));
    if (bearingMode === 'bidirectional') {
      simAimSvgBack = lngLatToSvg(destinationPoint(simOrigin, deg + 180, 1200));
    }
  }

  return (
    <div className="fallback-radar">
      <svg
        ref={svgRef}
        viewBox="0 0 500 500"
        className={`radar-svg ${simMode || canClickToMoveVirtualRunner ? 'crosshair' : ''}`}
        aria-label="本地校区预览"
        onClick={handleSvgClick}
        onMouseMove={handleSvgMove}
      >
        <defs>
          <clipPath id="radar-clip">
            <rect x="10" y="10" width="480" height="480" rx="8" />
          </clipPath>
        </defs>

        {/* Subtle coordinate grid */}
        {[100, 175, 250, 325, 400].map((v) => (
          <g key={v} stroke="rgba(148,163,184,0.12)" strokeWidth="1">
            <line x1={v} y1="20" x2={v} y2="480" />
            <line x1="20" y1={v} x2="480" y2={v} />
          </g>
        ))}

        {/* North indicator */}
        <text
          x="250"
          y="34"
          textAnchor="middle"
          fill="#38bdf8"
          fontSize="14"
          fontWeight="700"
        >
          N 北
        </text>

        <g clipPath="url(#radar-clip)">
          {/* Campus polygon */}
          <polygon
            points={polyPoints}
            fill="rgba(14, 165, 233, 0.10)"
            stroke="#38bdf8"
            strokeWidth="2"
            strokeDasharray="6 4"
          />

          {/* Campus center crosshair */}
          <circle cx="250" cy="250" r="3" fill="#64748b" />
          <text
            x="250"
            y="268"
            textAnchor="middle"
            fill="#64748b"
            fontSize="10"
          >
            {campus.shortName}中心
          </text>

          {/* Recorded bearing rays */}
          {visibleObservations.map((obs) => {
            const st = getStation(obs.stationId);
            const isActive = obs.stationId === activeStation;
            const isOutlier = outlierSet.has(obs.id);
            const strokeColor = isOutlier ? OUTLIER_COLOR : st.color;
            const oSvg = lngLatToSvg(obs.origin);
            const fSvg = lngLatToSvg(
              destinationPoint(obs.origin, obs.bearingDeg, RAY_DISPLAY_METERS),
            );
            const bSvg =
              obs.mode === 'bidirectional'
                ? lngLatToSvg(
                    destinationPoint(
                      obs.origin,
                      obs.bearingDeg + 180,
                      RAY_DISPLAY_METERS,
                    ),
                  )
                : null;

            return (
              <g key={obs.id}>
                <line
                  x1={oSvg.sx}
                  y1={oSvg.sy}
                  x2={fSvg.sx}
                  y2={fSvg.sy}
                  stroke={strokeColor}
                  strokeWidth={isOutlier ? 1.5 : isActive ? 2.2 : 1.4}
                  strokeDasharray={isOutlier ? '5 4' : undefined}
                  opacity={isOutlier ? 0.55 : isActive ? 0.9 : 0.45}
                />
                {bSvg && (
                  <line
                    x1={oSvg.sx}
                    y1={oSvg.sy}
                    x2={bSvg.sx}
                    y2={bSvg.sy}
                    stroke={strokeColor}
                    strokeWidth={isOutlier ? 1.3 : isActive ? 1.6 : 1.2}
                    strokeDasharray="5 4"
                    opacity={isOutlier ? 0.35 : isActive ? 0.5 : 0.25}
                  />
                )}
                <circle
                  cx={oSvg.sx}
                  cy={oSvg.sy}
                  r={isActive ? 4 : 3}
                  fill={strokeColor}
                  stroke="#ffffff"
                  strokeWidth="1.2"
                />
              </g>
            );
          })}

          {/* Optimal TSP running route polylines */}
          {showRoute && routePlan && routePlan.legs.length > 0 && (
            <g>
              {[...routePlan.legs].reverse().map((leg, revIdx) => {
                const idx = routePlan.legs.length - 1 - revIdx;
                const isFirst = idx === 0;
                const pts = leg.path
                  .map((p) => {
                    const s = lngLatToSvg(p);
                    return `${s.sx.toFixed(1)},${s.sy.toFixed(1)}`;
                  })
                  .join(' ');
                return (
                  <g key={`route-leg-${idx}`}>
                    {isFirst && (
                      <polyline
                        points={pts}
                        fill="none"
                        stroke="#0284c7"
                        strokeWidth="7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity="0.32"
                      />
                    )}
                    <polyline
                      points={pts}
                      fill="none"
                      stroke={isFirst ? '#22d3ee' : '#38bdf8'}
                      strokeWidth={isFirst ? 3.5 : 2.3}
                      strokeDasharray={isFirst ? undefined : '6 4'}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={isFirst ? 0.96 : 0.62}
                    />
                  </g>
                );
              })}
            </g>
          )}

          {/* Estimated station error circles & pins */}
          {targets.map((id) => {
            const est = estimates[id];
            if (!est?.position || est.errorRadiusM === null) return null;
            const st = getStation(id);
            const isActive = id === activeStation;
            const isPunched = punched.includes(id);
            const orderNum = !isPunched && showRoute ? orderMap.get(id) : undefined;
            const color = isPunched ? '#22c55e' : st.color;
            const posSvg = lngLatToSvg(est.position);
            const radiusPx = Math.max(4, est.errorRadiusM * scalePxPerMeter);

            return (
              <g
                key={`est-${id}`}
                style={{ cursor: simMode ? 'crosshair' : 'pointer' }}
                onClick={(ev) => {
                  if (!simMode) {
                    ev.stopPropagation();
                    onSelectStation(id);
                  }
                }}
              >
                <circle
                  cx={posSvg.sx}
                  cy={posSvg.sy}
                  r={radiusPx}
                  fill={color}
                  fillOpacity={isPunched ? 0.08 : isActive ? 0.18 : 0.11}
                  stroke={color}
                  strokeWidth={isActive ? 2 : 1.4}
                  strokeDasharray={est.status === 'coarse' ? '5 3' : undefined}
                  opacity={isPunched ? 0.55 : 0.95}
                />
                <circle
                  cx={posSvg.sx}
                  cy={posSvg.sy}
                  r={isActive ? 11 : 9}
                  fill={color}
                  stroke="#ffffff"
                  strokeWidth={isActive ? 2.2 : 1.6}
                />
                <text
                  x={posSvg.sx}
                  y={posSvg.sy + 3.5}
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize={st.id.length > 1 ? 8 : 10}
                  fontWeight="800"
                >
                  {isPunched ? '✓' : st.id}
                </text>
                {orderNum !== undefined && (
                  <g>
                    <circle
                      cx={posSvg.sx + 10}
                      cy={posSvg.sy - 10}
                      r="7.5"
                      fill={orderNum === 1 ? '#22d3ee' : '#0f172a'}
                      stroke={orderNum === 1 ? '#ffffff' : '#38bdf8'}
                      strokeWidth="1.4"
                    />
                    <text
                      x={posSvg.sx + 10}
                      y={posSvg.sy - 6.8}
                      textAnchor="middle"
                      fill={orderNum === 1 ? '#041322' : '#e0f2fe'}
                      fontSize="9.5"
                      fontWeight="900"
                    >
                      {orderNum}
                    </text>
                  </g>
                )}
                <text
                  x={posSvg.sx}
                  y={posSvg.sy + 22}
                  textAnchor="middle"
                  fill="#f8fafc"
                  fontSize="9.5"
                  fontWeight="700"
                  paintOrder="stroke"
                  stroke="#0b1220"
                  strokeWidth="3"
                >
                  {isPunched ? `${st.id}已打` : `±${est.errorRadiusM}m`}
                </text>
              </g>
            );
          })}

          {/* Simulated standing origin & live aim line */}
          {simMode && simOriginSvg && (
            <g>
              {simAimSvgFwd && (
                <line
                  x1={simOriginSvg.sx}
                  y1={simOriginSvg.sy}
                  x2={simAimSvgFwd.sx}
                  y2={simAimSvgFwd.sy}
                  stroke="#fbbf24"
                  strokeWidth="2.2"
                />
              )}
              {simAimSvgBack && (
                <line
                  x1={simOriginSvg.sx}
                  y1={simOriginSvg.sy}
                  x2={simAimSvgBack.sx}
                  y2={simAimSvgBack.sy}
                  stroke="#fbbf24"
                  strokeWidth="1.8"
                  strokeDasharray="6 4"
                  opacity="0.5"
                />
              )}
              <circle
                cx={simOriginSvg.sx}
                cy={simOriginSvg.sy}
                r="9"
                fill="rgba(251, 191, 36, 0.25)"
              />
              <circle
                cx={simOriginSvg.sx}
                cy={simOriginSvg.sy}
                r="5"
                fill="#fbbf24"
                stroke="#ffffff"
                strokeWidth="2"
              />
            </g>
          )}

          {/* Live compass sightline */}
          {compass && (
            <>
              <line
                x1={clampedUser.sx}
                y1={clampedUser.sy}
                x2={fwdX}
                y2={fwdY}
                stroke="#f59e0b"
                strokeWidth="2.5"
              />
              {bearingMode === 'bidirectional' && (
                <line
                  x1={clampedUser.sx}
                  y1={clampedUser.sy}
                  x2={backX}
                  y2={backY}
                  stroke="#f59e0b"
                  strokeWidth="2"
                  strokeDasharray="6 5"
                  opacity="0.55"
                />
              )}
            </>
          )}

          {/* Optional virtual ground-truth hidden transmitters (review mode) */}
          {virtualTruths &&
            virtualTruths.map((tx) => {
              const p = lngLatToSvg(tx.position);
              const fill = tx.isTarget ? '#c084fc' : '#64748b';
              return (
                <g key={`truth-${tx.stationId}`}>
                  <polygon
                    points={`${p.sx},${p.sy - 8} ${p.sx + 8},${p.sy} ${p.sx},${p.sy + 8} ${p.sx - 8},${p.sy}`}
                    fill={fill}
                    stroke="#ffffff"
                    strokeWidth="1.4"
                  />
                  <text
                    x={p.sx}
                    y={p.sy - 11}
                    textAnchor="middle"
                    fill={tx.isTarget ? '#e9d5ff' : '#cbd5e1'}
                    fontSize="9"
                    fontWeight="800"
                    paintOrder="stroke"
                    stroke="#0b1220"
                    strokeWidth="2.5"
                  >
                    {tx.isTarget ? `真${tx.stationId}` : `扰${tx.stationId}`}
                  </text>
                </g>
              );
            })}

          {/* Desktop virtual runner dot when no real GPS */}
          {virtualRunnerPos && !gps && (() => {
            const vp = lngLatToSvg(virtualRunnerPos);
            return (
              <g>
                <circle
                  cx={vp.sx}
                  cy={vp.sy}
                  r="11"
                  fill="rgba(167, 139, 250, 0.25)"
                />
                <circle
                  cx={vp.sx}
                  cy={vp.sy}
                  r="6"
                  fill="#a78bfa"
                  stroke="#ffffff"
                  strokeWidth="2"
                />
              </g>
            );
          })()}

          {/* User GPS dot */}
          {gps && (
            <>
              <circle
                cx={clampedUser.sx}
                cy={clampedUser.sy}
                r="12"
                fill="rgba(56,189,248,0.22)"
              />
              <circle
                cx={clampedUser.sx}
                cy={clampedUser.sy}
                r="6"
                fill="#38bdf8"
                stroke="#ffffff"
                strokeWidth="2"
              />
            </>
          )}
        </g>
      </svg>

      {!simMode && (
        <div className="fallback-banner">
          <div className="fallback-banner-text">
            {status === 'loading' && '正在加载高德地图…'}
            {status === 'no-key' && (
              <>
                <strong>本地坐标预览（可点右上角 🧪 直接点图模拟打点）</strong>
                <span>
                  填入高德 Web JS API Key 后显示{campus.shortName}真实校园道路
                </span>
              </>
            )}
            {status === 'error' && (
              <>
                <strong>高德地图加载失败</strong>
                <span>{errorMsg}</span>
              </>
            )}
          </div>
          <button
            type="button"
            className="btn-primary-sm"
            onClick={onOpenSettings}
          >
            高德 Key
          </button>
        </div>
      )}

      {compass && (
        <div className="radar-heading-chip">
          朝向 {Math.round(compass.heading)}° ({headingToCardinal(compass.heading)})
        </div>
      )}
    </div>
  );
}
