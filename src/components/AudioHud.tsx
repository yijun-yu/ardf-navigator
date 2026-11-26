import { getStation } from '../core/stations';
import type {
  AudioFrame,
  AudioInputStatus,
  MorseDecoderSnapshot,
  StationId,
} from '../core/types';
import { IconClose, IconMic, IconVolume } from './Icons';

interface AudioHudProps {
  audioStatus: AudioInputStatus;
  latestFrame: AudioFrame | null;
  morse: MorseDecoderSnapshot;
  targets: StationId[];
  punched: StationId[];
  onOpenAudioPanel: () => void;
  onStopAudio: () => void;
}

export function AudioHud({
  audioStatus,
  latestFrame,
  morse,
  targets,
  punched,
  onOpenAudioPanel,
  onStopAudio,
}: AudioHudProps) {
  if (audioStatus === 'idle') return null;

  const peakPct = Math.min(100, Math.round((latestFrame?.peakLevel ?? 0) * 100));
  const snrDb = latestFrame ? Math.round(latestFrame.snrDb) : 0;
  const clipped = Boolean(latestFrame?.clipped);
  const weak = latestFrame !== null && latestFrame.peakLevel < 0.04 && snrDb < 4;

  const lockedSpec = morse.lockedStation
    ? getStation(morse.lockedStation)
    : null;
  const isTarget = morse.lockedStation
    ? targets.includes(morse.lockedStation)
    : false;
  const isPunched = morse.lockedStation
    ? punched.includes(morse.lockedStation)
    : false;

  let lockText = '正在监听电码…';
  let lockClass = 'muted';
  if (lockedSpec) {
    if (!isTarget) {
      lockText = `非目标台：${lockedSpec.label} (${lockedSpec.callsign})`;
      lockClass = 'danger';
    } else if (isPunched) {
      lockText = `${lockedSpec.label} 已打过卡，请换台`;
      lockClass = 'warn';
    } else {
      lockText = `锁定 ${lockedSpec.label} · ${lockedSpec.callsign} (${Math.round(morse.confidence * 100)}%)`;
      lockClass = 'ok';
    }
  } else if (morse.candidateStation) {
    const cand = getStation(morse.candidateStation);
    lockText = `校验 ${cand.label}…`;
    lockClass = 'identifying';
  }

  return (
    <div className={`audio-hud ${lockClass}`}>
      <div className="audio-hud-left">
        <span className={`key-led ${morse.keyDown ? 'on' : ''}`} />
        <button
          type="button"
          className="audio-src-chip"
          onClick={onOpenAudioPanel}
          title="打开音频设置与测试台"
        >
          {audioStatus === 'mic_active' ? (
            <>
              <IconMic size={13} />
              <span>实测</span>
            </>
          ) : (
            <>
              <IconVolume size={13} />
              <span>模拟音</span>
            </>
          )}
        </button>

        <span className={`audio-lock-text ${lockClass}`}>{lockText}</span>
        {morse.recentSymbols && (
          <span className="audio-symbols" title="最近解出的电码">
            {morse.recentSymbols}
          </span>
        )}
      </div>

      <div className="audio-hud-right">
        <div
          className="level-meter"
          title={`电平 ${peakPct}% · SNR ${snrDb}dB · ${latestFrame?.dominantHz ?? 0}Hz`}
        >
          <div
            className={`level-fill ${clipped ? 'clip' : weak ? 'weak' : 'ok'}`}
            style={{ width: `${Math.max(4, peakPct)}%` }}
          />
        </div>
        {clipped && <span className="audio-warn-tag">爆音</span>}
        {!clipped && latestFrame && (
          <span className="audio-hz">{latestFrame.dominantHz}Hz</span>
        )}
        <button
          type="button"
          className="audio-stop-btn"
          onClick={onStopAudio}
          title="关闭音频监听"
          aria-label="关闭音频监听"
        >
          <IconClose size={14} />
        </button>
      </div>
    </div>
  );
}
