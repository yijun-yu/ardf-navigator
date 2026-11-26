import { useState } from 'react';
import {
  drawRandomSixTargets,
  formatMorseDisplay,
  NUMBER_STATION_IDS,
  STATIONS,
} from '../core/stations';
import type { StationId } from '../core/types';

interface TargetSetupModalProps {
  initialTargets: StationId[];
  onClose: () => void;
  onConfirm: (targets: StationId[]) => void;
}

export function TargetSetupModal({
  initialTargets,
  onClose,
  onConfirm,
}: TargetSetupModalProps) {
  const [selected, setSelected] = useState<StationId[]>(initialTargets);

  const toggleStation = (id: StationId) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      }
      if (prev.length >= 6) {
        return prev;
      }
      return [...prev, id];
    });
  };

  const handleRandomDraw = () => {
    setSelected(drawRandomSixTargets());
  };

  const numberCount = selected.filter((id) => NUMBER_STATION_IDS.includes(id)).length;
  const hasMo = selected.includes('MO');
  const isStandardSix = selected.length === 6 && numberCount === 5 && hasMo;

  const handleSave = () => {
    if (selected.length === 0) return;
    // Keep neat ordering: 1..9, 0, MO
    const order = STATIONS.map((s) => s.id);
    const sorted = [...selected].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    onConfirm(sorted);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-sheet">
        <div className="modal-header">
          <div>
            <h2>开跑前 · 设定目标电台</h2>
            <p className="modal-sub">
              标准规则：0~9 任选 5 个 + MO 台（共 6 台，认错或漏找 +1 小时）
            </p>
          </div>
          <button type="button" className="icon-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="target-status-bar">
          <span>
            已选 <strong>{selected.length}</strong> / 6 台
            {isStandardSix ? '（符合标准 5+MO）' : ''}
          </span>
          <button type="button" className="btn-ghost-sm" onClick={handleRandomDraw}>
            🎲 随机抽 5+MO
          </button>
        </div>

        <div className="station-grid">
          {STATIONS.map((st) => {
            const active = selected.includes(st.id);
            const disabled = !active && selected.length >= 6;
            return (
              <button
                key={st.id}
                type="button"
                className={`station-pick-card ${active ? 'active' : ''}`}
                disabled={disabled}
                onClick={() => toggleStation(st.id)}
                style={
                  active
                    ? { borderColor: st.color, boxShadow: `0 0 0 1px ${st.color} inset` }
                    : undefined
                }
              >
                <div className="pick-top">
                  <span className="pick-badge" style={{ background: st.color }}>
                    {st.id}
                  </span>
                  <span className="pick-call">{st.callsign}</span>
                </div>
                <div className="pick-morse">{formatMorseDisplay(st.morse)}</div>
              </button>
            );
          })}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={selected.length === 0}
            onClick={handleSave}
          >
            确认这 {selected.length} 个目标台
          </button>
        </div>
      </div>
    </div>
  );
}
