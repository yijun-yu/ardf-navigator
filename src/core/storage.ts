import type { AppSettings, RunSessionState } from './types';

const SETTINGS_KEY = 'ardf_nav_settings_v1';
const SESSION_KEY = 'ardf_nav_session_v1';

export const DEFAULT_SETTINGS: AppSettings = {
  amapKey: '',
  amapSecurityCode: '',
  compassOffsetDeg: 0,
  compassSmoothing: 0.25,
};

export const DEFAULT_SESSION: RunSessionState = {
  campusId: 'zijingang',
  targetStations: ['1', '2', '3', '4', '5', 'MO'],
  punchedStations: [],
  activeStation: '1',
  bearingMode: 'bidirectional',
  observations: [],
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage quota errors
  }
}

export function loadSession(): RunSessionState {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { ...DEFAULT_SESSION };
    const parsed = JSON.parse(raw) as Partial<RunSessionState>;
    const targets =
      Array.isArray(parsed.targetStations) && parsed.targetStations.length > 0
        ? parsed.targetStations
        : DEFAULT_SESSION.targetStations;
    const observations = Array.isArray(parsed.observations)
      ? parsed.observations.filter(
          (obs) =>
            obs &&
            typeof obs.id === 'string' &&
            typeof obs.stationId === 'string' &&
            obs.origin &&
            Number.isFinite(obs.origin.lng) &&
            Number.isFinite(obs.origin.lat) &&
            Number.isFinite(obs.bearingDeg),
        )
      : [];
    return {
      ...DEFAULT_SESSION,
      ...parsed,
      targetStations: targets,
      observations,
      activeStation:
        parsed.activeStation && targets.includes(parsed.activeStation)
          ? parsed.activeStation
          : targets[0],
    };
  } catch {
    return { ...DEFAULT_SESSION };
  }
}

export function saveSession(session: RunSessionState): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore
  }
}
