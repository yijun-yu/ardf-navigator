import type { StationId, StationSpec } from './types';

/**
 * Chinese 80m short-distance ARDF (3.50-3.60 MHz) station table.
 * Matches the user's official 80m band Morse signature specification:
 * 1: MOE (-- --- .)   2: MOI (-- --- ..)   3: MOS (-- --- ...)
 * 4: MOH (-- --- ....) 5: MO5 (-- --- .....)
 * 6: -....  7: --...  8: ---..  9: ----.  0: -----  MO: -- ---
 */
export const STATIONS: readonly StationSpec[] = [
  { id: '1', label: '1号台', callsign: 'MOE', morse: '-- --- .', compactMorse: '-----.', color: '#ef4444' },
  { id: '2', label: '2号台', callsign: 'MOI', morse: '-- --- ..', compactMorse: '-----..', color: '#f97316' },
  { id: '3', label: '3号台', callsign: 'MOS', morse: '-- --- ...', compactMorse: '-----...', color: '#eab308' },
  { id: '4', label: '4号台', callsign: 'MOH', morse: '-- --- ....', compactMorse: '-----....', color: '#22c55e' },
  { id: '5', label: '5号台', callsign: 'MO5', morse: '-- --- .....', compactMorse: '-----.....', color: '#14b8a6' },
  { id: '6', label: '6号台', callsign: '6', morse: '-....', compactMorse: '-....', color: '#06b6d4' },
  { id: '7', label: '7号台', callsign: '7', morse: '--...', compactMorse: '--...', color: '#3b82f6' },
  { id: '8', label: '8号台', callsign: '8', morse: '---..', compactMorse: '---..', color: '#6366f1' },
  { id: '9', label: '9号台', callsign: '9', morse: '----.', compactMorse: '----.', color: '#a855f7' },
  { id: '0', label: '0号台', callsign: '0', morse: '-----', compactMorse: '-----', color: '#ec4899' },
  { id: 'MO', label: 'MO台', callsign: 'MO', morse: '-- ---', compactMorse: '-----', color: '#f43f5e', isBeacon: true },
] as const;

export const NUMBER_STATION_IDS: readonly StationId[] = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
] as const;

export const STATION_MAP: Record<StationId, StationSpec> = STATIONS.reduce(
  (acc, spec) => {
    acc[spec.id] = spec;
    return acc;
  },
  {} as Record<StationId, StationSpec>,
);

export function getStation(id: StationId): StationSpec {
  return STATION_MAP[id];
}

/**
 * Randomly draw 5 distinct stations from 0~9 plus MO (total 6 targets),
 * matching the standard competition draw rule.
 */
export function drawRandomSixTargets(): StationId[] {
  const pool = [...NUMBER_STATION_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, 5).sort((a, b) => Number(a) - Number(b));
  return [...picked, 'MO'];
}

export function formatMorseDisplay(morse: string): string {
  return morse.replace(/-/g, '—').replace(/\./g, '·');
}
