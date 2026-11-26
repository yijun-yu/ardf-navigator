import { useEffect, useState } from 'react';
import { headingToCardinal } from '../core/coords';
import { formatDistance, formatDuration } from '../core/routePlanner';
import { formatMorseDisplay, getStation } from '../core/stations';
import type {
  BearingMode,
  CompassReading,
  RoutePlan,
  StationEstimate,
  StationId,
} from '../core/types';

interface StationDockProps {
  targets: StationId[];
  punched: StationId[];
  activeStation: StationId;
  bearingMode: BearingMode;
  compass: CompassReading | null;
  canRecordLive: boolean;
  simMode: boolean;
  simPreviewDeg: number | null;
  sweepActive: boolean;
  estimates: Record<StationId, StationEstimate>;
  routePlan: RoutePlan | null;
  activeDistanceM: number | null;
  totalObservations: number;
  onSelectStation: (id: StationId) => void;
  onStartAutoSweep: () => void;
  onRecordBearing: () => void;
  onUndoStationBearing: () => void;
  onClearStationBearings: () => void;
  onClearAllBearings: () => void;
  onTogglePunch: (id: StationId) => void;
  onToggleBearingMode: () => void;
  onOpenTargetSetup: () => void;
  onResetPunches: () => void;
}

function getFixBadge(est: StationEstimate | undefined): {
  text: string;
  tone: 'locked' | 'coarse' | 'warn' | 'muted';
} {
  if (!est || est.status === 'none') {
    return { text: '尚未测向', tone: 'muted' };
  }
  if (est.status === 'single_line') {
    return { text: '仅 1 线 · 移动后再测', tone: 'muted' };
  }
  if (est.status === 'poor_geometry') {
    return { text: est.reason, tone: 'warn' };
  }
  if (est.status === 'locked') {
    return { text: `精准锁定 ±${est.errorRadiusM}m`, tone: 'locked' };
  }
  return { text: `粗略 ±${est.errorRadiusM}m · 建议跑近补线`, tone: 'coarse' };
}

export function StationDock({
  targets,
  punched,
  activeStation,
  bearingMode,
  compass,
  canRecordLive,
  simMode,
  simPreviewDeg,
  sweepActive,
  estimates,
  routePlan,
  activeDistanceM,
  totalObservations,
  onSelectStation,
  onStartAutoSweep,
  onRecordBearing,
  onUndoStationBearing,
  onClearStationBearings,
  onClearAllBearings,
  onTogglePunch,
  onToggleBearingMode,
  onOpenTargetSetup,
  onResetPunches,
}: StationDockProps) {
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [confirmResetPunches, setConfirmResetPunches] = useState(false);

  useEffect(() => {
    if (!confirmClearAll) return;
    const t = window.setTimeout(() => setConfirmClearAll(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmClearAll]);

  useEffect(() => {
    if (!confirmResetPunches) return;
    const t = window.setTimeout(() => setConfirmResetPunches(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmResetPunches]);

  const activeSpec = getStation(activeStation);
  const activeEst = estimates[activeStation];
  const activeObsCount = activeEst?.observationCount ?? 0;
  const activeOutlierCount = activeEst?.outlierIds.length ?? 0;
  const isPunched = punched.includes(activeStation);

  const lockedCount = targets.filter(
    (id) =>
      estimates[id]?.status === 'locked' || estimates[id]?.status === 'coarse',
  ).length;
  const fixBadge = getFixBadge(activeEst);

  const orderMap = new Map<StationId, number>();
  if (routePlan) {
    routePlan.orderedStations.forEach((id, idx) => orderMap.set(id, idx + 1));
  }
  const firstLeg = routePlan?.legs[0] ?? null;

  const displayHeading =
    simMode && simPreviewDeg !== null
      ? simPreviewDeg
      : compass
        ? compass.heading
        : null;

  return (
    <section className="runner-dock" aria-label="跑步单手操作区">
      {/* Row 0: Optimal TSP Running Route Strip (shown whenever >=1 unpunched station is located) */}
      {routePlan && routePlan.orderedStations.length > 0 && (
        <div className="route-strip">
          <div className="route-seq-list">
            {routePlan.orderedStations.map((id, idx) => (
              <span key={id} className="route-seq-item">
                {idx > 0 && <span className="route-arrow">→</span>}
                <button
                  type="button"
                  className={`route-node-pill ${idx === 0 ? 'next' : ''} ${
                    activeStation === id ? 'selected' : ''
                  }`}
                  onClick={() => onSelectStation(id)}
                >
                  <span className="route-num">{idx + 1}</span>
                  <span>{id}</span>
                </button>
              </span>
            ))}
          </div>
          <div className="route-meta">
            {firstLeg && (
              <span className="route-next-dist">
                下站 {formatDistance(firstLeg.distanceM)}
              </span>
            )}
            <span className="route-total">
              余 {formatDistance(routePlan.totalDistanceM)} · ~
              {formatDuration(routePlan.totalRunSec)}
            </span>
            <span
              className={`route-src-tag ${
                routePlan.source === 'amap_walking'
                  ? 'road'
                  : routePlan.refining
                    ? 'loading'
                    : 'euc'
              }`}
            >
              {routePlan.refining
                ? '算路中'
                : routePlan.source === 'amap_walking'
                  ? '高德路网'
                  : routePlan.source === 'amap_partial'
                    ? '部分路网'
                    : '直线'}
            </span>
          </div>
        </div>
      )}
      {/* Row 1: Active station Morse signature + heading readout */}
      <div className="dock-telemetry">
        <div className="active-station-info">
          <span
            className="active-pill"
            style={{ background: activeSpec.color }}
          >
            {activeSpec.label} · {activeSpec.callsign}
          </span>
          <span className="morse-code">
            {formatMorseDisplay(activeSpec.morse)}
          </span>
        </div>

        <div className="heading-box">
          <span className="heading-deg">
            {displayHeading !== null
              ? `${Math.round(displayHeading).toString().padStart(3, '0')}°`
              : '---°'}
          </span>
          <span className="heading-dir">
            {displayHeading !== null
              ? headingToCardinal(displayHeading)
              : simMode
                ? '模拟中'
                : '等待罗盘'}
          </span>
        </div>
      </div>

      {/* Row 1.5: Active station triangulation status bar */}
      <div className="fix-status-row">
        <div className="fix-status-left">
          <span className="obs-count-chip">
            {activeObsCount} 线
            {activeOutlierCount > 0 ? ` (${activeOutlierCount}异常)` : ''}
          </span>
          <span className={`fix-badge ${fixBadge.tone}`}>{fixBadge.text}</span>
        </div>
        {activeDistanceM !== null && (
          <span className="fix-dist-chip">直线约 {activeDistanceM}m</span>
        )}
      </div>

      {/* Row 2: 6 target station thumb buttons */}
      <div className="target-strip">
        {targets.map((id) => {
          const st = getStation(id);
          const est = estimates[id];
          const done = punched.includes(id);
          const selected = activeStation === id;
          const orderNum = !done ? orderMap.get(id) : undefined;

          let subText = st.callsign;
          let dotClass = '';
          if (done) {
            subText = '✓已打';
          } else if (est?.status === 'locked' && est.errorRadiusM !== null) {
            subText = `±${est.errorRadiusM}m`;
            dotClass = 'locked';
          } else if (est?.status === 'coarse' && est.errorRadiusM !== null) {
            subText = `~${est.errorRadiusM}m`;
            dotClass = 'coarse';
          } else if (est && est.observationCount > 0) {
            subText = `${est.observationCount}线`;
            dotClass = est.status === 'poor_geometry' ? 'warn' : 'pending';
          }

          return (
            <button
              key={id}
              type="button"
              className={`target-chip ${selected ? 'selected' : ''} ${done ? 'done' : ''}`}
              onClick={() => onSelectStation(id)}
              style={
                selected
                  ? { borderColor: st.color, background: `${st.color}26` }
                  : undefined
              }
            >
              {orderNum !== undefined && (
                <span className={`chip-order ${orderNum === 1 ? 'first' : ''}`}>
                  {orderNum}
                </span>
              )}
              {dotClass && <span className={`chip-dot ${dotClass}`} />}
              <span className="chip-id">{st.id}</span>
              <span className="chip-sub">{subText}</span>
            </button>
          );
        })}
      </div>

      {/* Row 3A: Primary thumb capture: Auto Half-Turn Sweep + Manual Record + Undo */}
      <div className="dock-actions-primary">
        <button
          type="button"
          className={`btn-sweep ${sweepActive ? 'active' : ''}`}
          onClick={onStartAutoSweep}
          title="免用耳朵听方向：转身半圈自动算出电波方向并落线"
        >
          🔄 转半圈测向
        </button>

        <button
          type="button"
          className={`btn-record ${canRecordLive ? 'ready' : 'idle'}`}
          onClick={onRecordBearing}
          title="手动直接记录当前指南针朝向"
        >
          🎯 手动记向
        </button>

        <button
          type="button"
          className="btn-undo"
          onClick={onUndoStationBearing}
          disabled={activeObsCount === 0}
          title="撤销当前台最后一条测向线"
        >
          ↩
        </button>
      </div>

      {/* Row 3B: Bearing mode + Punch */}
      <div className="dock-actions-secondary">
        <button
          type="button"
          className={`btn-mode ${bearingMode === 'bidirectional' ? 'bi' : 'uni'}`}
          onClick={onToggleBearingMode}
          title="切换双向哑点直线或单向射线"
        >
          {bearingMode === 'bidirectional' ? '↔ 双向哑点' : '→ 单向射线'}
        </button>

        <button
          type="button"
          className={`btn-punch ${isPunched ? 'punched' : ''}`}
          onClick={() => onTogglePunch(activeStation)}
        >
          {isPunched
            ? `✓ ${activeSpec.label} 已打卡（撤销）`
            : `标记 ${activeSpec.label} 已打卡`}
        </button>
      </div>

      {/* Row 4: Progress & quick cleanup footer */}
      <div className="dock-footer">
        <span>
          打卡 <strong>{punched.length}/{targets.length}</strong>
          {' · '}已定位 <strong>{lockedCount}/{targets.length}</strong>
        </span>
        <div className="dock-footer-links">
          <button type="button" className="link-btn" onClick={onOpenTargetSetup}>
            改6台
          </button>
          {activeObsCount > 0 && (
            <button
              type="button"
              className="link-btn danger"
              onClick={onClearStationBearings}
            >
              清本台线
            </button>
          )}
          {totalObservations > 0 && (
            <button
              type="button"
              className={`link-btn danger ${confirmClearAll ? 'confirming' : ''}`}
              onClick={() => {
                if (confirmClearAll) {
                  setConfirmClearAll(false);
                  onClearAllBearings();
                } else {
                  setConfirmClearAll(true);
                }
              }}
            >
              {confirmClearAll ? '确认清全线?' : '清全线'}
            </button>
          )}
          {punched.length > 0 && (
            <button
              type="button"
              className={`link-btn danger ${confirmResetPunches ? 'confirming' : ''}`}
              onClick={() => {
                if (confirmResetPunches) {
                  setConfirmResetPunches(false);
                  onResetPunches();
                } else {
                  setConfirmResetPunches(true);
                }
              }}
            >
              {confirmResetPunches ? '确认清打卡?' : '清打卡'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
