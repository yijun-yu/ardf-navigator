import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AutoBearingSweeper } from './core/autoBearing';
import { CAMPUS_LIST, CAMPUSES } from './core/campuses';
import { bearingBetween, haversineMeters, normalizeDeg } from './core/coords';
import { ArdfMorseDecoder } from './core/morseDecoder';
import {
  extractRoutableTargets,
  solveOptimalRoute,
} from './core/routePlanner';
import {
  requestCompassPermission,
  ScreenWakeController,
  startCompassWatch,
  startGpsWatch,
} from './core/sensors';
import { getStation } from './core/stations';
import {
  loadSession,
  loadSettings,
  saveSession,
  saveSettings,
} from './core/storage';
import { triangulateAllStations } from './core/triangulation';
import type {
  AppSettings,
  AudioFrame,
  AudioInputStatus,
  AutoBearingSnapshot,
  BearingMode,
  BearingObservation,
  CampusId,
  CompassReading,
  GpsFix,
  LngLat,
  MorseDecoderSnapshot,
  RunSessionState,
  StationId,
  VirtualFieldScenario,
  VirtualFieldScope,
} from './core/types';
import {
  evaluateVirtualFieldSignal,
  findNearbyVirtualTransmitter,
  generateVirtualScenario,
} from './core/virtualField';
import { sharedWalkingCache } from './services/amapWalking';
import { AudioInputController, playAlertBeep } from './services/audioInput';
import { AudioHud } from './components/AudioHud';
import { AudioTestModal } from './components/AudioTestModal';
import { AutoSweepOverlay } from './components/AutoSweepOverlay';
import {
  IconCampusFrame,
  IconCheck,
  IconCompass,
  IconLocate,
  IconMic,
  IconPinPlus,
  IconRadio,
  IconRays,
  IconRoute,
  IconSettings,
  IconSliders,
  IconSun,
} from './components/Icons';
import { MapView, type MapControlHandles } from './components/MapView';
import { NonTargetAlarm } from './components/NonTargetAlarm';
import { SettingsModal } from './components/SettingsModal';
import { StationDock } from './components/StationDock';
import { TargetSetupModal } from './components/TargetSetupModal';
import { VirtualFieldBar } from './components/VirtualFieldBar';

function makeObsId(): string {
  return `obs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

const INITIAL_MORSE: MorseDecoderSnapshot = {
  status: 'idle',
  lockedStation: null,
  candidateStation: null,
  confidence: 0,
  estimatedWpm: null,
  recentSymbols: '',
  keyDown: false,
  agreeCount: 0,
};

const INITIAL_SWEEP: AutoBearingSnapshot = {
  coveredBins: 0,
  totalBins: 18,
  sweptDeg: 0,
  bearingDeg: null,
  quality: 0,
  rSquared: 0,
  modDepth: 0,
  clippedRatio: 0,
  ready: false,
  binPowers: new Array(18).fill(null),
  reason: '请慢慢转身半圈（180°）',
};

export function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [session, setSession] = useState<RunSessionState>(() => loadSession());

  const [gps, setGps] = useState<GpsFix | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [compass, setCompass] = useState<CompassReading | null>(null);
  const [compassError, setCompassError] = useState<string | null>(null);
  const [compassEnabled, setCompassEnabled] = useState<boolean>(true);
  const [wakeLocked, setWakeLocked] = useState<boolean>(false);

  const [showAllRays, setShowAllRays] = useState<boolean>(false);
  const [showRoute, setShowRoute] = useState<boolean>(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [amapInstance, setAmapInstance] = useState<any>(null);
  const [routeCacheVersion, setRouteCacheVersion] = useState<number>(0);
  const [routeRefining, setRouteRefining] = useState<boolean>(false);
  const [routeQueryOrigin, setRouteQueryOrigin] = useState<LngLat | null>(null);

  const [simMode, setSimMode] = useState<boolean>(false);
  const [simOrigin, setSimOrigin] = useState<LngLat | null>(null);
  const [lastSimOrigin, setLastSimOrigin] = useState<LngLat | null>(null);
  const [simPreviewDeg, setSimPreviewDeg] = useState<number | null>(null);

  // Stage 3: Audio input, Morse decoder, non-target alarm, half-turn auto-sweep
  const [audioStatus, setAudioStatus] = useState<AudioInputStatus>('idle');
  const [audioError, setAudioError] = useState<string | null>(null);
  const [latestFrame, setLatestFrame] = useState<AudioFrame | null>(null);
  const [morse, setMorse] = useState<MorseDecoderSnapshot>(INITIAL_MORSE);
  const [alarmStation, setAlarmStation] = useState<StationId | null>(null);
  const [dismissedAlarmFor, setDismissedAlarmFor] = useState<StationId | null>(
    null,
  );

  // Built-in CW test synthesizer settings
  const [simStation, setSimStation] = useState<StationId>('8');
  const [simWpm, setSimWpm] = useState<number>(12);
  const [simSnrDb, setSimSnrDb] = useState<number>(16);
  const [simAudible, setSimAudible] = useState<boolean>(true);

  // Half-turn auto-bearing sweep state
  const [sweepActive, setSweepActive] = useState<boolean>(false);
  const [sweepSnapshot, setSweepSnapshot] =
    useState<AutoBearingSnapshot>(INITIAL_SWEEP);
  const [simSweepNullDeg, setSimSweepNullDeg] = useState<number>(65);
  const [simSweepHeading, setSimSweepHeading] = useState<number>(0);
  const [simAutoSpinning, setSimAutoSpinning] = useState<boolean>(false);

  // Stage 5: Virtual campus fox-hunt practice mode
  const [virtualScenario, setVirtualScenario] =
    useState<VirtualFieldScenario | null>(null);
  const [virtualScope, setVirtualScope] =
    useState<VirtualFieldScope>('nearby');
  const [virtualFreqMHz, setVirtualFreqMHz] = useState<number>(3.55);
  const [virtualAudible, setVirtualAudible] = useState<boolean>(true);
  const [showVirtualTruth, setShowVirtualTruth] = useState<boolean>(false);
  const [virtualPos, setVirtualPos] = useState<LngLat | null>(null);
  const [virtualSMeter, setVirtualSMeter] = useState<number>(0);
  const [virtualElapsedSec, setVirtualElapsedSec] = useState<number>(0);

  // Direction A UI chrome state (floating tools popover + collapsible sheet + map FAB handles)
  const [showToolsMenu, setShowToolsMenu] = useState<boolean>(false);
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [mapHandles, setMapHandles] = useState<MapControlHandles | null>(null);
  const [mapFollowUser, setMapFollowUser] = useState<boolean>(false);
  const [gpsOutsideCampus, setGpsOutsideCampus] = useState<boolean>(false);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const [showTargetsModal, setShowTargetsModal] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false);
  const [showAudioModal, setShowAudioModal] = useState<boolean>(false);

  const wakeCtrlRef = useRef<ScreenWakeController | null>(null);
  const audioCtrlRef = useRef<AudioInputController | null>(null);
  const decoderRef = useRef<ArdfMorseDecoder>(new ArdfMorseDecoder());
  const sweeperRef = useRef<AutoBearingSweeper>(new AutoBearingSweeper());
  const lastUiPaintRef = useRef<number>(0);
  const lastAutoSelectedRef = useRef<StationId | null>(null);
  const autoSpinTimerRef = useRef<number | null>(null);
  const sweepCompletedRef = useRef<boolean>(false);

  const liveStateRef = useRef({
    gps,
    compass,
    sweepActive,
    audioStatus,
    simSweepHeading,
    targets: session.targetStations,
    punched: session.punchedStations,
    activeStation: session.activeStation,
    virtualScenario,
    virtualFreqMHz,
    virtualAudible,
    virtualPos,
    campusCenter: CAMPUSES[session.campusId].center,
  });
  liveStateRef.current = {
    gps,
    compass,
    sweepActive,
    audioStatus,
    simSweepHeading,
    targets: session.targetStations,
    punched: session.punchedStations,
    activeStation: session.activeStation,
    virtualScenario,
    virtualFreqMHz,
    virtualAudible,
    virtualPos,
    campusCenter: CAMPUSES[session.campusId].center,
  };

  useEffect(() => {
    if (!virtualScenario) {
      setVirtualElapsedSec(0);
      return;
    }
    const id = window.setInterval(() => {
      setVirtualElapsedSec(
        Math.max(0, Math.floor((Date.now() - virtualScenario.createdAt) / 1000)),
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, [virtualScenario]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2600);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      if (autoSpinTimerRef.current !== null) {
        window.clearInterval(autoSpinTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    saveSession(session);
  }, [session]);

  useEffect(() => {
    const stopGps = startGpsWatch({
      onFix: (fix) => {
        setGps(fix);
        setGpsError(null);
      },
      onError: (msg) => setGpsError(msg),
    });
    return stopGps;
  }, []);

  useEffect(() => {
    if (!compassEnabled) return;
    const stopCompass = startCompassWatch({
      offsetDeg: settings.compassOffsetDeg,
      smoothing: settings.compassSmoothing,
      onReading: (reading) => {
        setCompass(reading);
        setCompassError(null);
      },
      onError: (msg) => setCompassError(msg),
    });
    return stopCompass;
  }, [compassEnabled, settings.compassOffsetDeg, settings.compassSmoothing]);

  useEffect(() => {
    const ctrl = new ScreenWakeController(setWakeLocked);
    wakeCtrlRef.current = ctrl;
    void ctrl.enable();
    return () => ctrl.dispose();
  }, []);

  const campus = CAMPUSES[session.campusId];

  const handleMapControlsChange = useCallback(
    (
      handles: MapControlHandles | null,
      follow: boolean,
      outside: boolean,
    ) => {
      setMapHandles(handles);
      setMapFollowUser(follow);
      setGpsOutsideCampus(outside);
    },
    [],
  );

  const appendObservation = useCallback(
    (
      stationId: StationId,
      origin: LngLat,
      bearingDeg: number,
      mode: BearingMode,
      gpsAccuracy: number,
      labelOverride?: string,
    ) => {
      const normalized = Math.round(normalizeDeg(bearingDeg) * 10) / 10;
      const obs: BearingObservation = {
        id: makeObsId(),
        stationId,
        origin,
        bearingDeg: normalized,
        mode,
        gpsAccuracy,
        timestamp: Date.now(),
      };
      setSession((prev) => ({
        ...prev,
        observations: [...prev.observations, obs],
      }));
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(35);
      }
      const st = getStation(stationId);
      showToast(
        labelOverride ??
          `已记录 ${st.label} ${mode === 'bidirectional' ? '双向' : '单向'} ${Math.round(normalized)}°`,
      );
    },
    [showToast],
  );

  const stopAutoSpinDemo = useCallback(() => {
    if (autoSpinTimerRef.current !== null) {
      window.clearInterval(autoSpinTimerRef.current);
      autoSpinTimerRef.current = null;
    }
    setSimAutoSpinning(false);
  }, []);

  const handleConfirmAutoSweep = useCallback(
    (bearingDeg: number) => {
      stopAutoSpinDemo();
      setSweepActive(false);
      if (audioCtrlRef.current) {
        audioCtrlRef.current.updateSimConfig({
          trueNullDeg: null,
          headingDeg: null,
        });
      }

      const origin =
        gps?.gcj ?? virtualPos ?? simOrigin ?? lastSimOrigin ?? campus.center;
      const accuracy = gps ? gps.accuracy : 5;
      const targetStation = session.activeStation;
      const st = getStation(targetStation);

      appendObservation(
        targetStation,
        origin,
        bearingDeg,
        'bidirectional',
        accuracy,
        `自动测向完成：${st.label} ${Math.round(bearingDeg)}° / ${Math.round((bearingDeg + 180) % 360)}°`,
      );
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([45, 60, 80]);
      }
      playAlertBeep('done');

      if (!gps && simOrigin) {
        setLastSimOrigin(simOrigin);
        setSimOrigin(null);
      }
    },
    [
      appendObservation,
      campus.center,
      gps,
      lastSimOrigin,
      session.activeStation,
      simOrigin,
      stopAutoSpinDemo,
      virtualPos,
    ],
  );

  const confirmSweepRef = useRef(handleConfirmAutoSweep);
  confirmSweepRef.current = handleConfirmAutoSweep;

  useEffect(() => {
    const ctrl = new AudioInputController({
      onFrame: (frame) => {
        const snap = decoderRef.current.feedFrame(frame);
        const live = liveStateRef.current;

        let nextSweep: AutoBearingSnapshot | null = null;
        if (live.sweepActive && !sweepCompletedRef.current) {
          const useRealCompass =
            live.compass !== null &&
            (live.audioStatus === 'mic_active' || live.virtualScenario !== null);
          const heading = useRealCompass
            ? live.compass!.heading
            : live.simSweepHeading;
          nextSweep = sweeperRef.current.addSample(frame, heading);

          if (
            nextSweep.ready &&
            nextSweep.bearingDeg !== null &&
            nextSweep.coveredBins >= 16 &&
            nextSweep.sweptDeg >= 165 &&
            nextSweep.quality >= 0.72
          ) {
            sweepCompletedRef.current = true;
            const finalDeg = nextSweep.bearingDeg;
            window.setTimeout(() => confirmSweepRef.current(finalDeg), 80);
          }
        }

        const now = performance.now();
        if (now - lastUiPaintRef.current >= 65) {
          lastUiPaintRef.current = now;
          setLatestFrame(frame);
          setMorse(snap);
          if (nextSweep) {
            setSweepSnapshot(nextSweep);
          }
        }
      },
      onError: (msg) => {
        setAudioError(msg);
        setAudioStatus('error');
      },
    });

    audioCtrlRef.current = ctrl;
    return () => {
      ctrl.stop();
      audioCtrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    const locked = morse.lockedStation;
    if (!locked) {
      setAlarmStation(null);
      setDismissedAlarmFor(null);
      lastAutoSelectedRef.current = null;
      return;
    }

    const isTarget = session.targetStations.includes(locked);
    if (!isTarget) {
      if (dismissedAlarmFor !== locked) {
        setAlarmStation(locked);
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate([200, 90, 200, 90, 320]);
        }
        playAlertBeep('alarm');
      }
      return;
    }

    setAlarmStation(null);
    if (lastAutoSelectedRef.current !== locked) {
      lastAutoSelectedRef.current = locked;
      setSession((prev) =>
        prev.activeStation === locked ? prev : { ...prev, activeStation: locked },
      );
      const st = getStation(locked);
      if (session.punchedStations.includes(locked)) {
        showToast(`已识别 ${st.label}，该台已打过卡`);
      } else {
        showToast(`锁定目标台：${st.label} (${st.callsign})`);
      }
    }
  }, [
    morse.lockedStation,
    session.targetStations,
    session.punchedStations,
    dismissedAlarmFor,
    showToast,
  ]);

  useEffect(() => {
    if (audioStatus === 'sim_active' && audioCtrlRef.current) {
      audioCtrlRef.current.updateSimConfig({
        stationId: simStation,
        wpm: simWpm,
        snrDb: simSnrDb,
        audible: simAudible,
        trueNullDeg: sweepActive ? simSweepNullDeg : null,
        headingDeg: sweepActive ? simSweepHeading : null,
      });
    }
  }, [
    audioStatus,
    simStation,
    simWpm,
    simSnrDb,
    simAudible,
    sweepActive,
    simSweepNullDeg,
    simSweepHeading,
  ]);

  const handleStartMic = async () => {
    if (!audioCtrlRef.current) return;
    decoderRef.current.reset();
    setMorse(INITIAL_MORSE);
    setAudioError(null);
    const ok = await audioCtrlRef.current.startMic();
    if (ok) {
      setAudioStatus('mic_active');
      showToast('麦克风监听已开启（已关闭降噪）');
    }
  };

  const handleStartSimTone = (overrideStation?: StationId) => {
    if (!audioCtrlRef.current) return;
    const targetSt = overrideStation ?? simStation;
    if (overrideStation) setSimStation(overrideStation);
    decoderRef.current.reset();
    setMorse(INITIAL_MORSE);
    setAudioError(null);
    audioCtrlRef.current.startSimTone({
      stationId: targetSt,
      wpm: simWpm,
      snrDb: simSnrDb,
      toneHz: 800,
      audible: simAudible,
      trueNullDeg: sweepActive ? simSweepNullDeg : null,
      headingDeg: sweepActive ? simSweepHeading : null,
    });
    setAudioStatus('sim_active');
  };

  const handleStopAudio = () => {
    stopAutoSpinDemo();
    audioCtrlRef.current?.stop();
    decoderRef.current.reset();
    setAudioStatus('idle');
    setLatestFrame(null);
    setMorse(INITIAL_MORSE);
    setAlarmStation(null);
    setDismissedAlarmFor(null);
    setVirtualSMeter(0);
    if (sweepActive) {
      setSweepActive(false);
    }
    if (virtualScenario) {
      setVirtualScenario(null);
      setShowVirtualTruth(false);
    }
  };

  const launchVirtualField = useCallback(
    (scope: VirtualFieldScope, targetCampus = campus) => {
      stopAutoSpinDemo();
      setSimMode(false);
      setSimOrigin(null);
      setSweepActive(false);
      setShowToolsMenu(false);
      decoderRef.current.reset();
      setMorse(INITIAL_MORSE);
      setAlarmStation(null);
      setDismissedAlarmFor(null);
      setShowVirtualTruth(false);

      const startAnchor = gps?.gcj ?? targetCampus.center;
      const scenario = generateVirtualScenario({
        campus: targetCampus,
        targetStations: session.targetStations,
        scope,
        anchor: startAnchor,
        decoyCount: 3,
      });

      setVirtualScope(scope);
      setVirtualScenario(scenario);
      setVirtualPos(startAnchor);
      setVirtualElapsedSec(0);
      setVirtualFreqMHz(3.55);

      setSession((prev) => ({
        ...prev,
        observations: [],
        punchedStations: [],
        activeStation: prev.targetStations[0],
      }));

      let lastMeterPaint = 0;
      audioCtrlRef.current?.startCustomStream((elapsedMs, nowMs) => {
        const live = liveStateRef.current;
        const sc = live.virtualScenario ?? scenario;
        const obsPos = live.gps?.gcj ?? live.virtualPos ?? live.campusCenter;

        let headingDeg: number;
        if (live.compass) {
          headingDeg = live.compass.heading;
        } else if (live.sweepActive) {
          headingDeg = live.simSweepHeading;
        } else {
          const probe = evaluateVirtualFieldSignal(
            sc,
            live.virtualFreqMHz,
            obsPos,
            0,
            elapsedMs,
            nowMs,
          );
          headingDeg =
            probe.strongestTx !== null
              ? normalizeDeg(
                  bearingBetween(obsPos, probe.strongestTx.position) + 90,
                )
              : 0;
        }

        const sig = evaluateVirtualFieldSignal(
          sc,
          live.virtualFreqMHz,
          obsPos,
          headingDeg,
          elapsedMs,
          nowMs,
        );

        if (nowMs - lastMeterPaint >= 80) {
          lastMeterPaint = nowMs;
          setVirtualSMeter(sig.sMeter);
        }

        return {
          frame: sig.frame,
          toneHz: sig.toneHz,
          audibleGain: sig.audibleGain,
          audible: live.virtualAudible,
        };
      });

      setAudioStatus('sim_active');
      showToast(
        `演练开始：已在${targetCampus.shortName}隐藏 ${session.targetStations.length} 目标 + 3 干扰台`,
      );
    },
    [campus, gps, session.targetStations, showToast, stopAutoSpinDemo],
  );

  const handleExitVirtualField = () => {
    handleStopAudio();
    setVirtualPos(null);
    showToast('已退出校园实战演练');
  };

  const handleVirtualFreqChange = (freq: number) => {
    setVirtualFreqMHz(freq);
    decoderRef.current.reset();
    setMorse(INITIAL_MORSE);
    setAlarmStation(null);
  };

  const handleStartAutoSweep = async () => {
    sweeperRef.current.reset();
    sweepCompletedRef.current = false;
    setSweepSnapshot(INITIAL_SWEEP);
    setShowToolsMenu(false);

    if (audioStatus === 'idle' || audioStatus === 'error') {
      if (compass) {
        const ok = await audioCtrlRef.current?.startMic();
        if (ok) {
          setAudioStatus('mic_active');
        } else {
          setSimStation(session.activeStation);
          audioCtrlRef.current?.startSimTone({
            stationId: session.activeStation,
            wpm: simWpm,
            snrDb: simSnrDb,
            toneHz: 800,
            audible: simAudible,
            trueNullDeg: simSweepNullDeg,
            headingDeg: simSweepHeading,
          });
          setAudioStatus('sim_active');
          showToast('未连麦克风，已切换为无硬件模拟测向');
        }
      } else {
        setSimStation(session.activeStation);
        audioCtrlRef.current?.startSimTone({
          stationId: session.activeStation,
          wpm: simWpm,
          snrDb: simSnrDb,
          toneHz: 800,
          audible: simAudible,
          trueNullDeg: simSweepNullDeg,
          headingDeg: 0,
        });
        setSimSweepHeading(0);
        setAudioStatus('sim_active');
      }
    }

    setSweepActive(true);
  };

  const handleRestartSweep = () => {
    stopAutoSpinDemo();
    sweeperRef.current.reset();
    sweepCompletedRef.current = false;
    setSweepSnapshot(INITIAL_SWEEP);
  };

  const handleCancelSweep = () => {
    stopAutoSpinDemo();
    setSweepActive(false);
    audioCtrlRef.current?.updateSimConfig({
      trueNullDeg: null,
      headingDeg: null,
    });
  };

  const handleStartAutoSpinDemo = () => {
    stopAutoSpinDemo();
    sweeperRef.current.reset();
    sweepCompletedRef.current = false;
    setSweepSnapshot(INITIAL_SWEEP);

    if (!virtualScenario && audioStatus !== 'sim_active') {
      setSimStation(session.activeStation);
      audioCtrlRef.current?.startSimTone({
        stationId: session.activeStation,
        wpm: simWpm,
        snrDb: simSnrDb,
        toneHz: 800,
        audible: simAudible,
        trueNullDeg: simSweepNullDeg,
        headingDeg: 0,
      });
      setAudioStatus('sim_active');
    }

    setSimAutoSpinning(true);
    const startAngle = Math.floor(Math.random() * 180);
    const totalDeg = 200;
    const durationMs = 3800;
    const t0 = performance.now();

    setSimSweepHeading(startAngle);
    autoSpinTimerRef.current = window.setInterval(() => {
      const elapsed = performance.now() - t0;
      const frac = Math.min(1, elapsed / durationMs);
      const nextHeading = (startAngle + frac * totalDeg) % 360;
      setSimSweepHeading(nextHeading);
      if (frac >= 1) {
        stopAutoSpinDemo();
      }
    }, 30);
  };

  const estimates = useMemo(
    () =>
      triangulateAllStations(
        session.observations,
        session.targetStations,
        campus,
      ),
    [session.observations, session.targetStations, campus],
  );

  const activeEstimate = estimates[session.activeStation];
  const referencePos =
    gps?.gcj ?? virtualPos ?? simOrigin ?? lastSimOrigin ?? null;
  const activeDistanceM =
    referencePos && activeEstimate?.position
      ? Math.round(haversineMeters(referencePos, activeEstimate.position))
      : null;

  const nearbyVirtualTx = useMemo(() => {
    if (!virtualScenario) return null;
    const pos = gps?.gcj ?? virtualPos ?? campus.center;
    return findNearbyVirtualTransmitter(virtualScenario, pos, 25);
  }, [virtualScenario, gps, virtualPos, campus.center]);

  const handlePunchNearbyVirtual = () => {
    if (!virtualScenario || !nearbyVirtualTx) return;
    const { tx } = nearbyVirtualTx;
    const st = getStation(tx.stationId);

    if (!tx.isTarget) {
      setVirtualScenario((prev) =>
        prev ? { ...prev, penaltyCount: prev.penaltyCount + 1 } : prev,
      );
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([220, 80, 220, 80, 350]);
      }
      playAlertBeep('alarm');
      showToast(`错打非目标台 ${st.label}，罚时 +1 小时`);
      return;
    }

    if (!session.punchedStations.includes(tx.stationId)) {
      const nextPunchedCount = session.punchedStations.length + 1;
      handleTogglePunch(tx.stationId);
      playAlertBeep('done');
      if (nextPunchedCount >= session.targetStations.length) {
        setShowVirtualTruth(true);
        showToast(
          `全部 ${session.targetStations.length} 台找齐，已显示真位置供复盘`,
        );
      } else {
        showToast(
          `打卡成功：${st.label}（${nextPunchedCount}/${session.targetStations.length}）`,
        );
      }
    }
  };

  const effectiveRouteOrigin = referencePos ?? campus.center;
  const routableTargets = useMemo(
    () =>
      extractRoutableTargets(
        session.targetStations,
        session.punchedStations,
        estimates,
      ),
    [session.targetStations, session.punchedStations, estimates],
  );

  useEffect(() => {
    setRouteQueryOrigin((prev) => {
      if (!prev) return effectiveRouteOrigin;
      if (haversineMeters(prev, effectiveRouteOrigin) >= 18) {
        return effectiveRouteOrigin;
      }
      return prev;
    });
  }, [effectiveRouteOrigin]);

  const activeRouteOrigin = routeQueryOrigin ?? effectiveRouteOrigin;

  const routableKey = useMemo(
    () =>
      routableTargets
        .map(
          (n) =>
            `${n.stationId}:${Math.round(n.position.lng / 0.00015)},${Math.round(
              n.position.lat / 0.00015,
            )}`,
        )
        .join('|'),
    [routableTargets],
  );

  useEffect(() => {
    if (!amapInstance || routableTargets.length === 0) {
      setRouteRefining(false);
      return;
    }

    const controller = new AbortController();
    setRouteRefining(true);

    void sharedWalkingCache
      .warmEdges(
        amapInstance,
        activeRouteOrigin,
        routableTargets,
        controller.signal,
        () => {
          if (!controller.signal.aborted) {
            setRouteCacheVersion((v) => v + 1);
          }
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) {
          setRouteRefining(false);
          setRouteCacheVersion((v) => v + 1);
        }
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amapInstance, activeRouteOrigin, routableKey]);

  const routePlan = useMemo(() => {
    void routeCacheVersion;
    if (routableTargets.length === 0) return null;
    return solveOptimalRoute(activeRouteOrigin, routableTargets, {
      distanceProvider: sharedWalkingCache.makeProvider(),
      refining: routeRefining,
    });
  }, [
    activeRouteOrigin,
    routableTargets,
    routeCacheVersion,
    routeRefining,
  ]);

  const handleRecordLiveBearing = () => {
    if (gps && compass) {
      appendObservation(
        session.activeStation,
        gps.gcj,
        compass.heading,
        session.bearingMode,
        gps.accuracy,
      );
      return;
    }

    if (!simMode) {
      showToast(
        !gps && !compass
          ? '未检测到 GPS / 罗盘，可在右上角工具箱开启模拟打点或演练'
          : !gps
            ? '正在等待 GPS 定位…'
            : '正在等待罗盘数据（可在右上角工具箱启用罗盘）',
      );
    } else {
      showToast('模拟模式已开启：直接点击地图放站位，再点方向落线');
    }
  };

  const handleRecordSimulatedBearing = useCallback(
    (origin: LngLat, bearingDeg: number) => {
      appendObservation(
        session.activeStation,
        origin,
        bearingDeg,
        session.bearingMode,
        5,
      );
      setLastSimOrigin(origin);
      setSimOrigin(null);
      setSimPreviewDeg(null);
    },
    [appendObservation, session.activeStation, session.bearingMode],
  );

  const handleUndoStationBearing = () => {
    setSession((prev) => {
      const idx = [...prev.observations]
        .reverse()
        .findIndex((o) => o.stationId === prev.activeStation);
      if (idx === -1) return prev;
      const removeAt = prev.observations.length - 1 - idx;
      const nextObs = prev.observations.filter((_, i) => i !== removeAt);
      return { ...prev, observations: nextObs };
    });
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(20);
    }
    showToast(`已撤销 ${getStation(session.activeStation).label} 上一条线`);
  };

  const handleClearStationBearings = () => {
    setSession((prev) => ({
      ...prev,
      observations: prev.observations.filter(
        (o) => o.stationId !== prev.activeStation,
      ),
    }));
    showToast(`已清空 ${getStation(session.activeStation).label} 全部测向线`);
  };

  const handleClearAllBearings = () => {
    setSession((prev) => ({ ...prev, observations: [] }));
    setSimOrigin(null);
    showToast('已清空全部测向线');
  };

  const handleToggleWakeLock = async () => {
    const ctrl = wakeCtrlRef.current;
    if (!ctrl) return;
    if (wakeLocked) {
      await ctrl.disable();
    } else {
      await ctrl.enable();
    }
  };

  const handleEnableCompassPermission = async () => {
    const granted = await requestCompassPermission();
    if (granted) {
      setCompassEnabled(true);
      setCompassError(null);
      showToast('已开启电子罗盘');
    } else {
      setCompassError('未授予方向传感器权限');
    }
  };

  const handleCampusChange = (campusId: CampusId) => {
    setSession((prev) => ({ ...prev, campusId }));
    setSimOrigin(null);
    setLastSimOrigin(null);
    setSimPreviewDeg(null);
    setRouteQueryOrigin(null);
    if (virtualScenario) {
      launchVirtualField(virtualScope, CAMPUSES[campusId]);
    }
  };

  const handleToggleSimMode = () => {
    setShowToolsMenu(false);
    setSimMode((prev) => {
      const next = !prev;
      if (!next) {
        setSimOrigin(null);
        setSimPreviewDeg(null);
      } else {
        showToast('点图模拟已开启：先点站位，再点方向');
      }
      return next;
    });
  };

  const handleTargetsConfirm = (targets: StationId[]) => {
    setSession((prev) => ({
      ...prev,
      targetStations: targets,
      punchedStations: prev.punchedStations.filter((id) => targets.includes(id)),
      activeStation: targets.includes(prev.activeStation)
        ? prev.activeStation
        : targets[0],
    }));
    setShowTargetsModal(false);
  };

  const handleTogglePunch = (id: StationId) => {
    setSession((prev) => {
      const exists = prev.punchedStations.includes(id);
      const nextPunched = exists
        ? prev.punchedStations.filter((p) => p !== id)
        : [...prev.punchedStations, id];

      let nextActive = prev.activeStation;
      if (!exists) {
        const nextInRoute = routePlan?.orderedStations.find(
          (t) => !nextPunched.includes(t),
        );
        const nextRemaining =
          nextInRoute ??
          prev.targetStations.find((t) => !nextPunched.includes(t));
        if (nextRemaining) nextActive = nextRemaining;
      }

      return {
        ...prev,
        punchedStations: nextPunched,
        activeStation: nextActive,
      };
    });
  };

  const handleToggleBearingMode = () => {
    setSession((prev) => ({
      ...prev,
      bearingMode:
        prev.bearingMode === 'bidirectional' ? 'unidirectional' : 'bidirectional',
    }));
  };

  const handleResetPunches = () => {
    setSession((prev) => ({
      ...prev,
      punchedStations: [],
      activeStation: prev.targetStations[0],
    }));
  };

  const activeSweepHeading =
    compass !== null &&
    (audioStatus === 'mic_active' || virtualScenario !== null)
      ? compass.heading
      : simSweepHeading;

  const activeSpec = getStation(session.activeStation);
  const hasActiveTool = Boolean(
    virtualScenario || simMode || audioStatus !== 'idle',
  );

  return (
    <div className="app-shell">
      {/* Full-bleed edge-to-edge map canvas (World-as-Interface) */}
      <main className="map-main">
        <MapView
          campus={campus}
          amapKey={settings.amapKey}
          amapSecurityCode={settings.amapSecurityCode}
          gps={gps}
          compass={compass}
          bearingMode={session.bearingMode}
          targets={session.targetStations}
          punched={session.punchedStations}
          activeStation={session.activeStation}
          observations={session.observations}
          estimates={estimates}
          routePlan={routePlan}
          showRoute={showRoute}
          showAllRays={showAllRays}
          simMode={simMode}
          simOrigin={simOrigin}
          virtualRunnerPos={virtualScenario ? virtualPos : null}
          virtualTruths={
            virtualScenario && showVirtualTruth
              ? virtualScenario.transmitters
              : undefined
          }
          canClickToMoveVirtualRunner={Boolean(
            virtualScenario && !gps && !simMode,
          )}
          onMoveVirtualRunner={(pos) => {
            setVirtualPos(pos);
            showToast('已更新虚拟站位，可继续转半圈测向');
          }}
          onSelectStation={(id) =>
            setSession((prev) => ({ ...prev, activeStation: id }))
          }
          onSimOriginChange={setSimOrigin}
          onSimPreviewDegChange={setSimPreviewDeg}
          onRecordSimulatedBearing={handleRecordSimulatedBearing}
          onAmapReady={setAmapInstance}
          onControlsChange={handleMapControlsChange}
          onOpenSettings={() => setShowSettingsModal(true)}
        />
      </main>

      {/* Floating minimalist daylight top HUD */}
      <header className="top-hud-stack">
        <div className="top-hud-row">
          {/* Left floating campus + GPS pill */}
          <div className="top-capsule-left">
            <div className="campus-tabs" role="tablist" aria-label="切换浙大校区">
              {CAMPUS_LIST.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={c.id === session.campusId}
                  className={`campus-tab ${c.id === session.campusId ? 'active' : ''}`}
                  onClick={() => handleCampusChange(c.id)}
                >
                  {c.shortName}
                </button>
              ))}
            </div>

            <span className="capsule-divider" />

            <span
              className={`gps-indicator ${gps ? 'ok' : gpsError ? 'bad' : 'wait'}`}
              title={gpsError ?? 'GPS 定位状态'}
            >
              <span className="gps-dot" />
              <span className="gps-val">{gps ? `±${gps.accuracy}m` : 'GPS'}</span>
            </span>
          </div>

          {/* Right floating icon controls (Tools Drawer + Settings) */}
          <div className="top-capsule-right">
            <button
              type="button"
              className={`hud-icon-btn ${showToolsMenu || hasActiveTool ? 'active' : ''}`}
              onClick={() => setShowToolsMenu((v) => !v)}
              title="工具箱（实战演练、音频监听、点图模拟、常亮）"
              aria-label="打开工具菜单"
            >
              <IconSliders size={18} />
              {hasActiveTool && <span className="hud-active-dot" />}
            </button>

            <button
              type="button"
              className="hud-icon-btn"
              onClick={() => {
                setShowToolsMenu(false);
                setShowSettingsModal(true);
              }}
              title="高德地图与传感器设置"
              aria-label="打开设置"
            >
              <IconSettings size={18} />
            </button>
          </div>
        </div>

        {/* Clean floating Tools Popover */}
        {showToolsMenu && (
          <>
            <div
              className="tools-backdrop"
              onClick={() => setShowToolsMenu(false)}
            />
            <div className="tools-popover" role="menu" aria-label="快捷工具">
              <button
                type="button"
                className={`tool-row ${virtualScenario ? 'active' : ''}`}
                onClick={() =>
                  virtualScenario
                    ? handleExitVirtualField()
                    : launchVirtualField(virtualScope)
                }
              >
                <IconRadio size={17} />
                <div className="tool-row-text">
                  <strong>{virtualScenario ? '退出校园演练' : '校园实战演练'}</strong>
                  <span>无硬件下楼实测 6 台搜寻</span>
                </div>
                <span className={`tool-state ${virtualScenario ? 'on' : ''}`}>
                  {virtualScenario ? '进行中' : '开启'}
                </span>
              </button>

              <button
                type="button"
                className={`tool-row ${audioStatus !== 'idle' ? 'active' : ''}`}
                onClick={() => {
                  setShowToolsMenu(false);
                  setShowAudioModal(true);
                }}
              >
                <IconMic size={17} />
                <div className="tool-row-text">
                  <strong>音频识台与测试音</strong>
                  <span>外接声卡监听 / 11 台模拟电码</span>
                </div>
                <span className={`tool-state ${audioStatus !== 'idle' ? 'on' : ''}`}>
                  {audioStatus === 'mic_active'
                    ? '监听中'
                    : audioStatus === 'sim_active'
                      ? '测试中'
                      : '打开'}
                </span>
              </button>

              <button
                type="button"
                className={`tool-row ${simMode ? 'active' : ''}`}
                onClick={handleToggleSimMode}
              >
                <IconPinPlus size={17} />
                <div className="tool-row-text">
                  <strong>点图模拟打点</strong>
                  <span>点击地图模拟站位与方向线</span>
                </div>
                <span className={`tool-state ${simMode ? 'on' : ''}`}>
                  {simMode ? '已开启' : '关闭'}
                </span>
              </button>

              <button
                type="button"
                className={`tool-row ${wakeLocked ? 'active' : ''}`}
                onClick={() => void handleToggleWakeLock()}
              >
                <IconSun size={17} />
                <div className="tool-row-text">
                  <strong>跑步屏幕常亮</strong>
                  <span>防止跑动中自动锁屏断流</span>
                </div>
                <span className={`tool-state ${wakeLocked ? 'on' : ''}`}>
                  {wakeLocked ? '已常亮' : '关闭'}
                </span>
              </button>

              {!compass && (
                <button
                  type="button"
                  className="tool-row"
                  onClick={() => {
                    setShowToolsMenu(false);
                    void handleEnableCompassPermission();
                  }}
                >
                  <IconCompass size={17} />
                  <div className="tool-row-text">
                    <strong>请求电子罗盘权限</strong>
                    <span>授权读取手机实时磁北朝向</span>
                  </div>
                  <span className="tool-state">启用</span>
                </button>
              )}

              <button
                type="button"
                className="tool-row"
                onClick={() => {
                  setShowToolsMenu(false);
                  setShowTargetsModal(true);
                }}
              >
                <IconCheck size={17} />
                <div className="tool-row-text">
                  <strong>设定本场 6 个目标台</strong>
                  <span>当前：{session.targetStations.join(' / ')}</span>
                </div>
                <span className="tool-state">修改</span>
              </button>
            </div>
          </>
        )}

        {/* Contextual floating strips (only visible when active) */}
        <AudioHud
          audioStatus={audioStatus}
          latestFrame={latestFrame}
          morse={morse}
          targets={session.targetStations}
          punched={session.punchedStations}
          onOpenAudioPanel={() => setShowAudioModal(true)}
          onStopAudio={handleStopAudio}
        />

        {virtualScenario && (
          <VirtualFieldBar
            scenario={virtualScenario}
            elapsedSec={virtualElapsedSec}
            tunedFreqMHz={virtualFreqMHz}
            sMeter={virtualSMeter}
            audible={virtualAudible}
            showTruth={showVirtualTruth}
            hasRealGps={Boolean(gps)}
            nearbyTx={nearbyVirtualTx}
            punched={session.punchedStations}
            onFreqChange={handleVirtualFreqChange}
            onScopeChange={(nextScope) => launchVirtualField(nextScope)}
            onRegenerate={() => launchVirtualField(virtualScope)}
            onToggleAudible={() => setVirtualAudible((v) => !v)}
            onToggleShowTruth={() => setShowVirtualTruth((v) => !v)}
            onPunchNearby={handlePunchNearbyVirtual}
            onExit={handleExitVirtualField}
          />
        )}

        {simMode && (
          <div className="sim-guide-bar">
            <div className="sim-guide-text">
              <strong>点图模拟 · {activeSpec.label}</strong>
              <span>
                {!simOrigin
                  ? '第 1 步：点地图放置站位'
                  : `第 2 步：点目标方向打出${
                      session.bearingMode === 'bidirectional' ? '双向' : '单向'
                    }线${
                      simPreviewDeg !== null
                        ? ` · ${Math.round(simPreviewDeg)}°`
                        : ''
                    }`}
              </span>
            </div>
            <div className="sim-guide-actions">
              {simOrigin && (
                <button
                  type="button"
                  className="sim-bar-btn"
                  onClick={() => setSimOrigin(null)}
                >
                  重选
                </button>
              )}
              <button
                type="button"
                className="sim-bar-btn"
                onClick={handleToggleSimMode}
              >
                退出
              </button>
            </div>
          </div>
        )}

        {gpsOutsideCampus && !simMode && !virtualScenario && (
          <div className="campus-warn-pill">
            当前定位不在{campus.shortName}范围内（可在左上切换校区）
          </div>
        )}
      </header>

      {/* Bottom floating stack: Map FABs + Toast + Collapsible Daylight Sheet */}
      <div className="bottom-hud-stack">
        <div className="map-overlay-row">
          <div className="toast-slot">
            {toast && <div className="map-toast">{toast}</div>}
          </div>

          <div className="map-fab-stack">
            <button
              type="button"
              className={`map-fab ${showRoute ? 'active' : ''}`}
              onClick={() => setShowRoute((v) => !v)}
              title={showRoute ? '隐藏推荐路线' : '显示最优跑步路线'}
              aria-label="切换路线显示"
            >
              <IconRoute size={18} />
            </button>

            <button
              type="button"
              className={`map-fab ${showAllRays ? 'active' : ''}`}
              onClick={() => setShowAllRays((v) => !v)}
              title={showAllRays ? '仅看当前台射线' : '显示全部目标台射线'}
              aria-label="切换全部或单台射线"
            >
              <IconRays size={18} />
            </button>

            {mapHandles && (
              <>
                <button
                  type="button"
                  className={`map-fab ${mapFollowUser ? 'active' : ''}`}
                  onClick={mapHandles.recenterMe}
                  disabled={!gps}
                  title="定位到我"
                  aria-label="定位到当前位置"
                >
                  <IconLocate size={18} />
                </button>
                <button
                  type="button"
                  className="map-fab"
                  onClick={mapHandles.recenterCampus}
                  title="回到校区全览"
                  aria-label="回到校区全览"
                >
                  <IconCampusFrame size={18} />
                </button>
              </>
            )}
          </div>
        </div>

        <StationDock
          targets={session.targetStations}
          punched={session.punchedStations}
          activeStation={session.activeStation}
          bearingMode={session.bearingMode}
          compass={compass}
          canRecordLive={Boolean(gps && compass)}
          simMode={simMode}
          simPreviewDeg={simPreviewDeg}
          sweepActive={sweepActive}
          collapsed={dockCollapsed}
          estimates={estimates}
          routePlan={routePlan}
          activeDistanceM={activeDistanceM}
          totalObservations={session.observations.length}
          onToggleCollapse={() => setDockCollapsed((v) => !v)}
          onSelectStation={(id) =>
            setSession((prev) => ({ ...prev, activeStation: id }))
          }
          onStartAutoSweep={() => void handleStartAutoSweep()}
          onRecordBearing={handleRecordLiveBearing}
          onUndoStationBearing={handleUndoStationBearing}
          onClearStationBearings={handleClearStationBearings}
          onClearAllBearings={handleClearAllBearings}
          onTogglePunch={handleTogglePunch}
          onToggleBearingMode={handleToggleBearingMode}
          onOpenTargetSetup={() => setShowTargetsModal(true)}
          onResetPunches={handleResetPunches}
        />
      </div>

      {/* Auto Half-Turn Bearing Sweep Overlay */}
      {sweepActive && (
        <AutoSweepOverlay
          activeStation={session.activeStation}
          audioStatus={audioStatus}
          snapshot={sweepSnapshot}
          currentHeadingDeg={activeSweepHeading}
          latestFrame={latestFrame}
          hasRealCompass={Boolean(compass)}
          virtualFieldActive={Boolean(virtualScenario)}
          simNullDeg={simSweepNullDeg}
          simAutoSpinning={simAutoSpinning}
          onSimNullDegChange={(deg) => {
            setSimSweepNullDeg(deg);
            handleRestartSweep();
          }}
          onManualSimHeading={(deg) => setSimSweepHeading(deg)}
          onStartAutoSpinDemo={handleStartAutoSpinDemo}
          onConfirmBearing={handleConfirmAutoSweep}
          onRestart={handleRestartSweep}
          onCancel={handleCancelSweep}
        />
      )}

      {/* Full-screen high-contrast crimson alarm when non-target station is locked */}
      {alarmStation && (
        <NonTargetAlarm
          stationId={alarmStation}
          confidence={morse.confidence}
          targets={session.targetStations}
          onDismiss={() => {
            setDismissedAlarmFor(alarmStation);
            setAlarmStation(null);
          }}
        />
      )}

      {showAudioModal && (
        <AudioTestModal
          audioStatus={audioStatus}
          audioError={audioError}
          latestFrame={latestFrame}
          morse={morse}
          targets={session.targetStations}
          simStation={simStation}
          simWpm={simWpm}
          simSnrDb={simSnrDb}
          simAudible={simAudible}
          onSimStationChange={(id) => {
            setSimStation(id);
            if (audioStatus === 'sim_active') {
              decoderRef.current.reset();
              setMorse(INITIAL_MORSE);
            }
          }}
          onSimWpmChange={setSimWpm}
          onSimSnrChange={setSimSnrDb}
          onSimAudibleChange={setSimAudible}
          onStartMic={() => void handleStartMic()}
          onStartSimTone={() => handleStartSimTone()}
          onStopAudio={handleStopAudio}
          onClose={() => setShowAudioModal(false)}
        />
      )}

      {showTargetsModal && (
        <TargetSetupModal
          initialTargets={session.targetStations}
          onClose={() => setShowTargetsModal(false)}
          onConfirm={handleTargetsConfirm}
        />
      )}

      {showSettingsModal && (
        <SettingsModal
          settings={settings}
          gps={gps}
          compass={compass}
          gpsError={gpsError}
          compassError={compassError}
          wakeLocked={wakeLocked}
          onSave={setSettings}
          onClose={() => setShowSettingsModal(false)}
        />
      )}
    </div>
  );
}

export default App;
