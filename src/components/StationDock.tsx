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
import {
  IconBidirectional,
  IconCheck,
  IconChevron,
  IconCrosshair,
  IconRadarSweep,
  IconUndo,
  IconUnidirectional,
} from './Icons';

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
  collapsed: boolean;
  estimates: Record<StationId, StationEstimate>;
  routePlan: RoutePlan | null;
  activeDistanceM: number | null;
  totalObservations: number;
  onToggleCollapse: () => void;
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
    return { text: '待测向', tone: 'muted' };
  }
  if (est.status === 'single_line') {
    return { text: '1 线 · 移动补测', tone: 'muted' };
  }
  if (est.status === 'poor_geometry') {
    return { text: est.reason, tone: 'warn' };
  }
  if (est.status === 'locked') {
    return { text: `精准 ±${est.errorRadiusM}m`, tone: 'locked' };
  }
  return { text: `粗略 ±${est.errorRadiusM}m`, tone: 'coarse' };
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
  collapsed,
  estimates,
  routePlan,
  activeDistanceM,
  totalObservations,
  onToggleCollapse,
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
  const nextRouteStation = routePlan?.orderedStations[0] ?? null;

  const displayHeading =
    simMode && simPreviewDeg !== null
      ? simPreviewDeg
      : compass
        ? compass.heading
        : null;

  // Collapsed sprint bar (maximizes map area while running between transmitters)
  if (collapsed) {
    const sprintTargetId = nextRouteStation ?? activeStation;
    const sprintSpec = getStation(sprintTargetId);
    const sprintPunched = punched.includes(sprintTargetId);

    return (
      <section className="runner-dock collapsed" aria-label="冲刺精简条">
        <button
          type="button"
          className="dock-handle-btn"
          onClick={onToggleCollapse}
          aria-label="展开操作面板"
        >
          <span className="dock-grab-pill" />
        </button>

        <div className="sprint-bar">
          <button
            type="button"
            className="sprint-info"
            onClick={onToggleCollapse}
          >
            <span className="sprint-badge">
              {nextRouteStation ? '1' : sprintSpec.id}
            </span>
            <div className="sprint-text">
              <div className="sprint-title">
                {nextRouteStation ? `下一站 ${sprintSpec.label}` : sprintSpec.label}
                {firstLeg ? ` · ${formatDistance(firstLeg.distanceM)}` : ''}
              </div>
              <div className="sprint-sub">
                进度 {punched.length}/{targets.length} · 已定位 {lockedCount}/
                {targets.length}
                {displayHeading !== null
                  ? ` · ${Math.round(displayHeading).toString().padStart(3, '0')}°`
                  : ''}
              </div>
            </div>
          </button>

          <div className="sprint-actions">
            <button
              type="button"
              className={`btn-sprint-punch ${sprintPunched ? 'punched' : ''}`}
              onClick={() => onTogglePunch(sprintTargetId)}
            >
              <IconCheck size={15} />
              <span>{sprintPunched ? '已打' : '打卡'}</span>
            </button>
            <button
              type="button"
              className="btn-expand-circle"
              onClick={onToggleCollapse}
              aria-label="展开完整面板"
            >
              <IconChevron size={18} up />
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="runner-dock" aria-label="跑步单手操作区">
      {/* Subtle drag handle to collapse sheet while running */}
      <button
        type="button"
        className="dock-handle-btn"
        onClick={onToggleCollapse}
        aria-label="收起操作面板以放大地图"
      >
        <span className="dock-grab-pill" />
      </button>

      {/* Route sequence strip (shown when >= 1 unpunched station is located) */}
      {routePlan && routePlan.orderedStations.length > 0 && (
        <div className="route-strip">
          <div className="route-seq-list">
            {routePlan.orderedStations.map((id, idx) => (
              <span key={id} className="route-seq-item">
                {idx > 0 && <span className="route-arrow">/</span>}
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
                {formatDistance(firstLeg.distanceM)}
              </span>
            )}
            <span className="route-total">
              余 {formatDistance(routePlan.totalDistanceM)} ·{' '}
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
                ? '算路'
                : routePlan.source === 'amap_walking'
                  ? '路网'
                  : routePlan.source === 'amap_partial'
                    ? '部分'
                    : '直线'}
            </span>
          </div>
        </div>
      )}

      {/* Row 1: Precision instrument telemetry header */}
      <div className="dock-telemetry">
        <div className="telemetry-left">
          <div className="active-station-row">
            <span className="active-station-badge">
              {activeSpec.label}
              <span className="active-callsign">{activeSpec.callsign}</span>
            </span>
            <span className="morse-code">
              {formatMorseDisplay(activeSpec.morse)}
            </span>
          </div>

          <div className="fix-status-line">
            <span className="obs-count-chip">
              {activeObsCount} 线
              {activeOutlierCount > 0 ? ` · ${activeOutlierCount}异常` : ''}
            </span>
            <span className={`fix-badge ${fixBadge.tone}`}>
              {fixBadge.text}
            </span>
            {activeDistanceM !== null && (
              <span className="fix-dist-chip">
                {formatDistance(activeDistanceM)}
              </span>
            )}
          </div>
        </div>

        <div className="heading-instrument">
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
                : '无罗盘'}
          </span>
        </div>
      </div>

      {/* Row 2: 6 target station crisp outdoor tiles */}
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
            subText = '已打卡';
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

      {/* Row 3A: Primary actions — Trail Vermilion Sweep + Ink-Outlined Manual + Undo */}
      <div className="dock-actions-primary">
        <button
          type="button"
          className={`btn-sweep ${sweepActive ? 'active' : ''}`}
          onClick={onStartAutoSweep}
          title="免用耳朵听方向：转身半圈自动算出电波方向并落线"
        >
          <IconRadarSweep size={18} />
          <span>转半圈测向</span>
        </button>

        <button
          type="button"
          className={`btn-record ${canRecordLive ? 'ready' : 'idle'}`}
          onClick={onRecordBearing}
          title="手动直接记录当前指南针朝向"
        >
          <IconCrosshair size={17} />
          <span>手动记向</span>
        </button>

        <button
          type="button"
          className="btn-undo"
          onClick={onUndoStationBearing}
          disabled={activeObsCount === 0}
          title="撤销当前台最后一条测向线"
          aria-label="撤销上一条线"
        >
          <IconUndo size={18} />
        </button>
      </div>

      {/* Row 3B: Bearing Mode Toggle + Deep Ink Punch */}
      <div className="dock-actions-secondary">
        <button
          type="button"
          className={`btn-mode ${bearingMode === 'bidirectional' ? 'bi' : 'uni'}`}
          onClick={onToggleBearingMode}
          title="切换双向哑点直线或单向射线"
        >
          {bearingMode === 'bidirectional' ? (
            <>
              <IconBidirectional size={15} />
              <span>双向哑点</span>
            </>
          ) : (
            <>
              <IconUnidirectional size={15} />
              <span>单向射线</span>
            </>
          )}
        </button>

        <button
          type="button"
          className={`btn-punch ${isPunched ? 'punched' : ''}`}
          onClick={() => onTogglePunch(activeStation)}
        >
          <IconCheck size={16} />
          <span>
            {isPunched
              ? `${activeSpec.label} 已打卡（点此撤销）`
              : `标记 ${activeSpec.label} 已打卡`}
          </span>
        </button>
      </div>

      {/* Row 4: Clean summary footer */}
      <div className="dock-footer">
        <span className="dock-progress">
          打卡 <strong>{punched.length}/{targets.length}</strong>
          <span className="footer-sep">·</span>
          定位 <strong>{lockedCount}/{targets.length}</strong>
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
              清本台
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
              {confirmClearAll ? '确认清全线' : '清全线'}
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
              {confirmResetPunches ? '确认清打卡' : '清打卡'}
            </button>
          )}
          <button
            type="button"
            className="link-btn muted"
            onClick={onToggleCollapse}
            title="收起底部卡片以放大地图"
          >
            收起
          </button>
        </div>
      </div>
    </section>
  );
}
