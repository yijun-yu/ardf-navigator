import { formatDuration } from '../core/routePlanner';
import type {
  StationId,
  VirtualFieldScenario,
  VirtualFieldScope,
  VirtualTransmitter,
} from '../core/types';
import {
  IconCheck,
  IconClose,
  IconEye,
  IconRadio,
  IconRefresh,
  IconVolume,
  IconVolumeOff,
} from './Icons';

interface VirtualFieldBarProps {
  scenario: VirtualFieldScenario;
  elapsedSec: number;
  tunedFreqMHz: number;
  sMeter: number;
  audible: boolean;
  showTruth: boolean;
  hasRealGps: boolean;
  nearbyTx: { tx: VirtualTransmitter; distanceM: number } | null;
  punched: StationId[];
  onFreqChange: (freqMHz: number) => void;
  onScopeChange: (scope: VirtualFieldScope) => void;
  onRegenerate: () => void;
  onToggleAudible: () => void;
  onToggleShowTruth: () => void;
  onPunchNearby: () => void;
  onExit: () => void;
}

export function VirtualFieldBar({
  scenario,
  elapsedSec,
  tunedFreqMHz,
  sMeter,
  audible,
  showTruth,
  hasRealGps,
  nearbyTx,
  punched,
  onFreqChange,
  onScopeChange,
  onRegenerate,
  onToggleAudible,
  onToggleShowTruth,
  onPunchNearby,
  onExit,
}: VirtualFieldBarProps) {
  const sBars = Math.round(sMeter * 5);
  const stepFreq = (deltaKHz: number) => {
    const next = Math.max(
      3.5,
      Math.min(3.6, Math.round((tunedFreqMHz + deltaKHz / 1000) * 1000) / 1000),
    );
    onFreqChange(next);
  };

  const nearbyAlreadyPunched = nearbyTx
    ? punched.includes(nearbyTx.tx.stationId)
    : false;

  return (
    <div className="vf-bar" aria-label="校园虚拟电台实战演练条">
      {/* Row 1: Timer, scope switch, review toggle & exit */}
      <div className="vf-row-top">
        <div className="vf-meta">
          <span className="vf-tag">
            <IconRadio size={13} />
            <span>实战演练</span>
          </span>
          <span className="vf-timer">{formatDuration(elapsedSec)}</span>
          {scenario.penaltyCount > 0 && (
            <span className="vf-penalty">罚时 +{scenario.penaltyCount}h</span>
          )}
        </div>

        <div className="vf-controls">
          <button
            type="button"
            className={`vf-mini-btn ${scenario.scope === 'nearby' ? 'active' : ''}`}
            onClick={() =>
              onScopeChange(scenario.scope === 'nearby' ? 'campus' : 'nearby')
            }
            title="切换近距快测（85-340m）或全校区分布"
          >
            {scenario.scope === 'nearby' ? '近距' : '全校'}
          </button>
          <button
            type="button"
            className="vf-mini-btn"
            onClick={onRegenerate}
            title="重新随机藏台"
          >
            <IconRefresh size={13} />
            <span>重藏</span>
          </button>
          <button
            type="button"
            className={`vf-mini-btn ${showTruth ? 'active' : ''}`}
            onClick={onToggleShowTruth}
            title="在地图上显示隐藏电台真实位置用于复盘误差"
          >
            <IconEye size={13} />
            <span>{showTruth ? '藏真' : '真位'}</span>
          </button>
          <button
            type="button"
            className={`vf-mini-btn icon-only ${audible ? 'active' : ''}`}
            onClick={onToggleAudible}
            title="开关电码声音"
            aria-label="开关电码声音"
          >
            {audible ? <IconVolume size={14} /> : <IconVolumeOff size={14} />}
          </button>
          <button
            type="button"
            className="vf-mini-btn icon-only danger"
            onClick={onExit}
            title="退出实战演练"
            aria-label="退出实战演练"
          >
            <IconClose size={14} />
          </button>
        </div>
      </div>

      {/* Row 2: Virtual 3.500 - 3.600 MHz tuning knob + S-meter */}
      <div className="vf-tuner-row">
        <button
          type="button"
          className="vf-step-btn"
          onClick={() => stepFreq(-1)}
          aria-label="频率减 1 kHz"
        >
          −
        </button>
        <input
          type="range"
          className="vf-slider"
          min={3.5}
          max={3.6}
          step={0.001}
          value={tunedFreqMHz}
          onChange={(e) => onFreqChange(Number(e.target.value))}
          aria-label="虚拟测向机调频旋钮 3.50-3.60 MHz"
        />
        <button
          type="button"
          className="vf-step-btn"
          onClick={() => stepFreq(1)}
          aria-label="频率加 1 kHz"
        >
          +
        </button>

        <span className="vf-freq-readout">{tunedFreqMHz.toFixed(3)}</span>

        <div className="vf-smeter" title="接收场强 S 表">
          {[1, 2, 3, 4, 5].map((lvl) => (
            <span
              key={lvl}
              className={`vf-sbar ${sBars >= lvl ? 'lit' : ''}`}
              style={{ height: `${5 + lvl * 2.5}px` }}
            />
          ))}
        </div>
      </div>

      {/* Optional quick frequency helper chips when truth review mode is ON */}
      {showTruth && (
        <div className="vf-truth-chips">
          {scenario.transmitters.map((tx) => (
            <button
              key={tx.stationId}
              type="button"
              className={`vf-truth-chip ${tx.isTarget ? 'target' : 'decoy'} ${
                Math.abs(tx.freqMHz - tunedFreqMHz) < 0.002 ? 'tuned' : ''
              }`}
              onClick={() => onFreqChange(tx.freqMHz)}
            >
              {tx.isTarget ? tx.stationId : `扰${tx.stationId}`}{' '}
              {tx.freqMHz.toFixed(3)}
            </button>
          ))}
        </div>
      )}

      {/* Desktop hint when real GPS is absent */}
      {!hasRealGps && !nearbyTx && (
        <div className="vf-hint">
          调频寻找信号 · 点击地图可虚拟走动 · 使用下方「转半圈测向」定位
        </div>
      )}

      {/* Nearby hidden station punch banner (< 25m) */}
      {nearbyTx && (
        <div className="vf-nearby-banner">
          <span>
            距离隐藏电台约 <strong>{Math.round(nearbyTx.distanceM)}m</strong>
            {nearbyAlreadyPunched ? '（已打卡）' : ''}
          </span>
          {!nearbyAlreadyPunched && (
            <button
              type="button"
              className="vf-punch-btn"
              onClick={onPunchNearby}
            >
              <IconCheck size={14} />
              <span>模拟打卡</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
