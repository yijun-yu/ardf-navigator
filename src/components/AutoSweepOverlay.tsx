import { headingToCardinal } from '../core/coords';
import { getStation } from '../core/stations';
import type {
  AudioFrame,
  AudioInputStatus,
  AutoBearingSnapshot,
  StationId,
} from '../core/types';

interface AutoSweepOverlayProps {
  activeStation: StationId;
  audioStatus: AudioInputStatus;
  snapshot: AutoBearingSnapshot;
  currentHeadingDeg: number | null;
  latestFrame: AudioFrame | null;
  hasRealCompass: boolean;
  virtualFieldActive: boolean;
  simNullDeg: number;
  simAutoSpinning: boolean;
  onSimNullDegChange: (deg: number) => void;
  onManualSimHeading: (deg: number) => void;
  onStartAutoSpinDemo: () => void;
  onConfirmBearing: (bearingDeg: number) => void;
  onRestart: () => void;
  onCancel: () => void;
}

export function AutoSweepOverlay({
  activeStation,
  audioStatus,
  snapshot,
  currentHeadingDeg,
  latestFrame,
  hasRealCompass,
  virtualFieldActive,
  simNullDeg,
  simAutoSpinning,
  onSimNullDegChange,
  onManualSimHeading,
  onStartAutoSpinDemo,
  onConfirmBearing,
  onRestart,
  onCancel,
}: AutoSweepOverlayProps) {
  const st = getStation(activeStation);
  const progressPct = Math.round(
    (snapshot.coveredBins / snapshot.totalBins) * 100,
  );
  const clipped = Boolean(latestFrame?.clipped);
  const showSimControls = !hasRealCompass || audioStatus === 'sim_active';

  // Build polar 18-bin wedges (mirrored across 180° for intuitive 360° dipole display)
  const cx = 110;
  const cy = 110;
  const maxR = 84;
  const minR = 16;

  const wedges: { key: string; d: string; fill: string; opacity: number }[] = [];
  for (let i = 0; i < 18; i++) {
    const val = snapshot.binPowers[i];
    const startDeg = i * 10;
    const endDeg = startDeg + 9.2;
    const r = val === null ? minR + 8 : minR + Math.min(1, val) * (maxR - minR);

    for (const offset of [0, 180]) {
      const a1 = ((startDeg + offset) * Math.PI) / 180;
      const a2 = ((endDeg + offset) * Math.PI) / 180;
      const x1 = cx + Math.sin(a1) * r;
      const y1 = cy - Math.cos(a1) * r;
      const x2 = cx + Math.sin(a2) * r;
      const y2 = cy - Math.cos(a2) * r;
      const d = `M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`;

      wedges.push({
        key: `${i}-${offset}`,
        d,
        fill: val === null ? '#334155' : val < 0.28 ? '#4ade80' : '#38bdf8',
        opacity: val === null ? 0.25 : 0.72,
      });
    }
  }

  // Fitted bidirectional null axis line
  let nullLine: { x1: number; y1: number; x2: number; y2: number } | null = null;
  if (snapshot.bearingDeg !== null) {
    const rad = (snapshot.bearingDeg * Math.PI) / 180;
    nullLine = {
      x1: cx + Math.sin(rad) * 96,
      y1: cy - Math.cos(rad) * 96,
      x2: cx - Math.sin(rad) * 96,
      y2: cy + Math.cos(rad) * 96,
    };
  }

  // Live heading needle
  let needleEnd: { x: number; y: number } | null = null;
  if (currentHeadingDeg !== null) {
    const rad = (currentHeadingDeg * Math.PI) / 180;
    needleEnd = {
      x: cx + Math.sin(rad) * 92,
      y: cy - Math.cos(rad) * 92,
    };
  }

  return (
    <div className="sweep-overlay" role="dialog" aria-label="转半圈自动测向">
      <div className="sweep-card">
        <div className="sweep-header">
          <div>
            <div className="sweep-title">
              🔄 转半圈自动测向 ·{' '}
              <span style={{ color: st.color }}>{st.label}</span>
            </div>
            <div className="sweep-sub">
              左手测向机、右手手机保持 30cm，身体慢慢转半圈（约 3 秒）
            </div>
          </div>
          <button type="button" className="icon-close" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="sweep-body">
          <svg viewBox="0 0 220 220" className="sweep-polar-svg">
            <circle
              cx={cx}
              cy={cy}
              r={maxR}
              fill="rgba(15,23,42,0.75)"
              stroke="rgba(148,163,184,0.25)"
              strokeWidth="1"
            />
            <circle
              cx={cx}
              cy={cy}
              r={(maxR + minR) * 0.5}
              fill="none"
              stroke="rgba(148,163,184,0.16)"
              strokeDasharray="3 3"
            />
            <text x={cx} y="16" textAnchor="middle" fill="#38bdf8" fontSize="11" fontWeight="700">
              N
            </text>
            <text x="208" y={cy + 4} textAnchor="middle" fill="#94a3b8" fontSize="10">
              E
            </text>
            <text x={cx} y="214" textAnchor="middle" fill="#94a3b8" fontSize="10">
              S
            </text>
            <text x="12" y={cy + 4} textAnchor="middle" fill="#94a3b8" fontSize="10">
              W
            </text>

            {wedges.map((w) => (
              <path key={w.key} d={w.d} fill={w.fill} opacity={w.opacity} />
            ))}

            {nullLine && (
              <line
                x1={nullLine.x1}
                y1={nullLine.y1}
                x2={nullLine.x2}
                y2={nullLine.y2}
                stroke="#4ade80"
                strokeWidth="3"
                strokeDasharray="6 3"
              />
            )}

            {needleEnd && (
              <line
                x1={cx}
                y1={cy}
                x2={needleEnd.x}
                y2={needleEnd.y}
                stroke="#fbbf24"
                strokeWidth="2.5"
              />
            )}

            <circle cx={cx} cy={cy} r="5" fill="#fbbf24" stroke="#fff" strokeWidth="1.5" />
          </svg>

          <div className="sweep-stats">
            <div className="sweep-progress-row">
              <span>覆盖进度</span>
              <strong>
                {snapshot.coveredBins * 10}° / 180° ({progressPct}%)
              </strong>
            </div>
            <div className="sweep-progress-bar">
              <div
                className={`sweep-progress-fill ${snapshot.ready ? 'ready' : ''}`}
                style={{ width: `${progressPct}%` }}
              />
            </div>

            <div className="sweep-readout">
              {snapshot.bearingDeg !== null ? (
                <>
                  <span className="sweep-deg">
                    {Math.round(snapshot.bearingDeg).toString().padStart(3, '0')}°
                    {' ↔ '}
                    {Math.round((snapshot.bearingDeg + 180) % 360)
                      .toString()
                      .padStart(3, '0')}
                    °
                  </span>
                  <span className="sweep-meta">
                    {headingToCardinal(snapshot.bearingDeg)} · 匹配度{' '}
                    {Math.round(snapshot.rSquared * 100)}%
                  </span>
                </>
              ) : (
                <span className="sweep-meta">
                  当前朝向：
                  {currentHeadingDeg !== null
                    ? `${Math.round(currentHeadingDeg)}°`
                    : '等待罗盘'}
                </span>
              )}
            </div>

            <div className={`sweep-reason ${clipped ? 'warn' : snapshot.ready ? 'ok' : ''}`}>
              {clipped ? '⚠ 音频爆音饱和，请调小测向机音量' : snapshot.reason}
            </div>
          </div>
        </div>

        {/* Built-in desktop / zero-hardware sweep simulator */}
        {showSimControls && (
          <div className="sweep-sim-box">
            <div className="sweep-sim-top">
              {virtualFieldActive ? (
                <span>🏃 演练模式：按当前调谐电台的真实方位模拟转身</span>
              ) : (
                <>
                  <span>🧪 无硬件模拟测试（设定隐藏真实方向：{simNullDeg}°）</span>
                  <button
                    type="button"
                    className="btn-ghost-sm"
                    onClick={() => onSimNullDegChange(Math.floor(Math.random() * 180))}
                  >
                    随机角度
                  </button>
                </>
              )}
            </div>
            <div className="sweep-sim-controls">
              <input
                type="range"
                min={0}
                max={360}
                value={Math.round(currentHeadingDeg ?? 0)}
                onChange={(e) => onManualSimHeading(Number(e.target.value))}
                aria-label="模拟手机旋转朝向"
              />
              <button
                type="button"
                className="btn-primary-sm"
                onClick={onStartAutoSpinDemo}
                disabled={simAutoSpinning}
              >
                {simAutoSpinning ? '正在自动转半圈…' : '▶ 模拟自动转半圈'}
              </button>
            </div>
          </div>
        )}

        <div className="sweep-footer">
          <button type="button" className="btn-secondary" onClick={onRestart}>
            重扫
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!snapshot.ready || snapshot.bearingDeg === null}
            onClick={() => {
              if (snapshot.bearingDeg !== null) {
                onConfirmBearing(snapshot.bearingDeg);
              }
            }}
          >
            {snapshot.ready && snapshot.bearingDeg !== null
              ? `✓ 采用 ${Math.round(snapshot.bearingDeg)}° 落线到地图`
              : '转满半圈后自动落线…'}
          </button>
        </div>
      </div>
    </div>
  );
}
