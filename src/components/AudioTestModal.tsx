import { formatMorseDisplay, STATIONS } from '../core/stations';
import type {
  AudioFrame,
  AudioInputStatus,
  MorseDecoderSnapshot,
  StationId,
} from '../core/types';
import { IconClose, IconMic, IconPlay, IconStop } from './Icons';

interface AudioTestModalProps {
  audioStatus: AudioInputStatus;
  audioError: string | null;
  latestFrame: AudioFrame | null;
  morse: MorseDecoderSnapshot;
  targets: StationId[];
  simStation: StationId;
  simWpm: number;
  simSnrDb: number;
  simAudible: boolean;
  onSimStationChange: (id: StationId) => void;
  onSimWpmChange: (wpm: number) => void;
  onSimSnrChange: (snr: number) => void;
  onSimAudibleChange: (audible: boolean) => void;
  onStartMic: () => void;
  onStartSimTone: () => void;
  onStopAudio: () => void;
  onClose: () => void;
}

export function AudioTestModal({
  audioStatus,
  audioError,
  latestFrame,
  morse,
  targets,
  simStation,
  simWpm,
  simSnrDb,
  simAudible,
  onSimStationChange,
  onSimWpmChange,
  onSimSnrChange,
  onSimAudibleChange,
  onStartMic,
  onStartSimTone,
  onStopAudio,
  onClose,
}: AudioTestModalProps) {
  const isMic = audioStatus === 'mic_active';
  const isSim = audioStatus === 'sim_active';

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-sheet">
        <div className="modal-header">
          <div>
            <h2>音频识台与测试音</h2>
            <p className="modal-sub">
              自动解码 11 台摩尔斯电码、拦截非目标台，并驱动转半圈自动测向
            </p>
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

        {/* Section 1: Real hardware mic / USB-C capture */}
        <div className="diag-box">
          <div className="diag-title">实测音频：外接测向机声卡 / 麦克风</div>
          <p className="hint-text">
            已强制关闭浏览器降噪（NS）、回声消除（AEC）和自动增益（AGC），直接采集原始电码波形。
          </p>
          <div className="audio-btn-row">
            <button
              type="button"
              className={isMic ? 'btn-secondary' : 'btn-primary'}
              onClick={isMic ? onStopAudio : onStartMic}
            >
              {isMic ? <IconStop size={14} /> : <IconMic size={16} />}
              <span>{isMic ? '停止麦克风监听' : '开启麦克风 / 声卡监听'}</span>
            </button>
          </div>
          {audioError && <p className="audio-err-text">{audioError}</p>}

          {latestFrame && (
            <div className="audio-diag-grid">
              <span>
                主频 <strong>{latestFrame.dominantHz} Hz</strong>
              </span>
              <span>
                SNR <strong>{Math.round(latestFrame.snrDb)} dB</strong>
              </span>
              <span>
                电平{' '}
                <strong className={latestFrame.clipped ? 'bad' : 'ok'}>
                  {Math.round(latestFrame.peakLevel * 100)}%
                  {latestFrame.clipped ? '（爆音）' : ''}
                </strong>
              </span>
              <span>
                速度{' '}
                <strong>
                  {morse.estimatedWpm ? `${morse.estimatedWpm} WPM` : '--'}
                </strong>
              </span>
            </div>
          )}
        </div>

        {/* Section 2: Zero-hardware built-in 11-station simulator */}
        <div className="diag-box">
          <div className="diag-title">
            零硬件验证：内置 11 台测试音（选非目标台可测红屏报警）
          </div>

          <div className="sim-station-grid">
            {STATIONS.map((st) => {
              const isTarget = targets.includes(st.id);
              const selected = simStation === st.id;
              return (
                <button
                  key={st.id}
                  type="button"
                  className={`sim-st-btn ${selected ? 'selected' : ''} ${isTarget ? 'target' : 'non-target'}`}
                  onClick={() => onSimStationChange(st.id)}
                >
                  <span className="sim-st-top">
                    <strong>{st.id}</strong>
                    <span className="sim-st-tag">
                      {isTarget ? '目标' : '干扰'}
                    </span>
                  </span>
                  <span className="sim-st-morse">
                    {formatMorseDisplay(st.morse)}
                  </span>
                </button>
              );
            })}
          </div>

          <label className="field-label">
            发报速度：<strong>{simWpm} WPM</strong>
            <input
              type="range"
              min={8}
              max={20}
              step={1}
              value={simWpm}
              onChange={(e) => onSimWpmChange(Number(e.target.value))}
            />
          </label>

          <label className="field-label">
            信噪比（越低底噪越重）：<strong>{simSnrDb} dB</strong>
            <input
              type="range"
              min={8}
              max={24}
              step={1}
              value={simSnrDb}
              onChange={(e) => onSimSnrChange(Number(e.target.value))}
            />
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={simAudible}
              onChange={(e) => onSimAudibleChange(e.target.checked)}
            />
            <span>通过扬声器 / 耳机播放测试滴答声</span>
          </label>

          <div className="audio-btn-row">
            <button
              type="button"
              className={isSim ? 'btn-secondary' : 'btn-accent'}
              onClick={isSim ? onStopAudio : onStartSimTone}
            >
              {isSim ? <IconStop size={14} /> : <IconPlay size={14} />}
              <span>{isSim ? '停止测试音' : `启动 ${simStation} 号台测试音`}</span>
            </button>
          </div>
        </div>

        <button type="button" className="btn-secondary" onClick={onClose}>
          返回地图
        </button>
      </div>
    </div>
  );
}
