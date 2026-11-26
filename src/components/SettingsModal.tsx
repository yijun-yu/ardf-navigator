import { useState } from 'react';
import type { AppSettings, CompassReading, GpsFix } from '../core/types';
import { IconClose } from './Icons';

interface SettingsModalProps {
  settings: AppSettings;
  gps: GpsFix | null;
  compass: CompassReading | null;
  gpsError: string | null;
  compassError: string | null;
  wakeLocked: boolean;
  onSave: (next: AppSettings) => void;
  onClose: () => void;
}

export function SettingsModal({
  settings,
  gps,
  compass,
  gpsError,
  compassError,
  wakeLocked,
  onSave,
  onClose,
}: SettingsModalProps) {
  const [amapKey, setAmapKey] = useState(settings.amapKey);
  const [amapSecurityCode, setAmapSecurityCode] = useState(
    settings.amapSecurityCode,
  );
  const [compassOffsetDeg, setCompassOffsetDeg] = useState(
    settings.compassOffsetDeg,
  );
  const [compassSmoothing, setCompassSmoothing] = useState(
    settings.compassSmoothing,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      amapKey: amapKey.trim(),
      amapSecurityCode: amapSecurityCode.trim(),
      compassOffsetDeg,
      compassSmoothing,
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal-sheet" onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <h2>高德地图与传感器设置</h2>
            <p className="modal-sub">配置仅保存在本机浏览器 localStorage 中</p>
          </div>
          <button
            type="button"
            className="icon-close"
            onClick={onClose}
            aria-label="关闭"
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="settings-section">
          <label className="field-label">
            高德 Web 端 (JS API) Key
            <input
              type="text"
              className="text-input"
              placeholder="从 lbs.amap.com 申请的 Web 端 Key"
              value={amapKey}
              onChange={(e) => setAmapKey(e.target.value)}
            />
          </label>

          <label className="field-label">
            高德安全密钥（securityJsCode）
            <input
              type="text"
              className="text-input"
              placeholder="与上方 Key 配套的安全密钥"
              value={amapSecurityCode}
              onChange={(e) => setAmapSecurityCode(e.target.value)}
            />
          </label>
          <p className="hint-text">
            申请路径：高德开放平台 → 应用管理 → 创建应用 → 添加 Key（服务平台选
            <strong>「Web 端 (JS API)」</strong>），免费额度足够日常跑步与测试。
          </p>
        </div>

        <div className="settings-section">
          <label className="field-label">
            指南针偏角微调：<strong>{compassOffsetDeg > 0 ? `+${compassOffsetDeg}` : compassOffsetDeg}°</strong>
            <input
              type="range"
              min={-45}
              max={45}
              step={1}
              value={compassOffsetDeg}
              onChange={(e) => setCompassOffsetDeg(Number(e.target.value))}
            />
          </label>

          <label className="field-label">
            指南针防抖平滑度：<strong>{Math.round(compassSmoothing * 100)}%</strong>
            <span className="hint-inline">（越小越稳，越大响应越快）</span>
            <input
              type="range"
              min={0.1}
              max={0.8}
              step={0.05}
              value={compassSmoothing}
              onChange={(e) => setCompassSmoothing(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="diag-box">
          <div className="diag-title">本机传感器实时诊断</div>
          <div className="diag-row">
            <span>安全上下文 (HTTPS)</span>
            <strong className={window.isSecureContext ? 'ok' : 'bad'}>
              {window.isSecureContext ? '已开启' : '未开启（手机端需 HTTPS）'}
            </strong>
          </div>
          <div className="diag-row">
            <span>GPS (GCJ-02 纠偏)</span>
            <strong>
              {gps
                ? `${gps.gcj.lng.toFixed(5)}, ${gps.gcj.lat.toFixed(5)} (±${gps.accuracy}m)`
                : gpsError ?? '等待定位…'}
            </strong>
          </div>
          <div className="diag-row">
            <span>电子罗盘</span>
            <strong>
              {compass
                ? `${compass.heading.toFixed(1)}° (${compass.absolute ? '绝对地磁北' : '相对方向'})`
                : compassError ?? '等待转动手机…'}
            </strong>
          </div>
          <div className="diag-row">
            <span>防息屏常亮</span>
            <strong>{wakeLocked ? '已锁定常亮' : '未激活'}</strong>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn-primary">
            保存并生效
          </button>
        </div>
      </form>
    </div>
  );
}
