import { formatMorseDisplay, getStation } from '../core/stations';
import type { StationId } from '../core/types';
import { IconAlertOctagon } from './Icons';

interface NonTargetAlarmProps {
  stationId: StationId;
  confidence: number;
  targets: StationId[];
  onDismiss: () => void;
}

export function NonTargetAlarm({
  stationId,
  confidence,
  targets,
  onDismiss,
}: NonTargetAlarmProps) {
  const st = getStation(stationId);

  return (
    <div className="alarm-overlay" role="alertdialog" aria-modal="true">
      <div className="alarm-card">
        <div className="alarm-icon-wrap">
          <IconAlertOctagon size={52} />
        </div>
        <h2 className="alarm-title">非目标台 · 切勿打卡</h2>
        <div className="alarm-station-box">
          <span className="alarm-station-name">
            当前收到：{st.label}（{st.callsign}）
          </span>
          <span className="alarm-morse">{formatMorseDisplay(st.morse)}</span>
          <span className="alarm-conf">
            识别置信度 {Math.round(confidence * 100)}% · 错打罚时 +1 小时
          </span>
        </div>

        <div className="alarm-targets">
          本场 6 个目标台：{targets.join(' / ')}
        </div>

        <button
          type="button"
          className="alarm-dismiss-btn"
          onClick={onDismiss}
        >
          知道了，继续换台
        </button>
      </div>
    </div>
  );
}
