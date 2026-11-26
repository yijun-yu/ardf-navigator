export type StationId =
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '0'
  | 'MO';

export type CampusId = 'zijingang' | 'yuquan' | 'huajiachi';

/** Geographic coordinate in GCJ-02 (Amap datum). */
export interface LngLat {
  lng: number;
  lat: number;
}

/** Local East-North plane coordinates in meters relative to a reference origin. */
export interface LocalPoint {
  x: number; // East (+) / West (-) in meters
  y: number; // North (+) / South (-) in meters
}

export interface StationSpec {
  id: StationId;
  label: string;
  callsign: string;
  /** Morse pattern using '-' (dah), '.' (dit), and ' ' (letter space) */
  morse: string;
  /** Compact dit/dah sequence without spaces for rapid pattern matching */
  compactMorse: string;
  color: string;
  isBeacon?: boolean;
}

export interface CampusConfig {
  id: CampusId;
  name: string;
  shortName: string;
  center: LngLat;
  defaultZoom: number;
  /** Closed polygon (GCJ-02) enclosing the valid transmitter area of this campus */
  boundary: LngLat[];
}

export interface GpsFix {
  /** Corrected GCJ-02 coordinate for Amap */
  gcj: LngLat;
  /** Raw WGS-84 coordinate from browser geolocation */
  wgs: LngLat;
  /** Horizontal accuracy radius in meters */
  accuracy: number;
  /** Speed in m/s if available */
  speed: number | null;
  timestamp: number;
}

export interface CompassReading {
  /** Smoothed heading in degrees [0, 360), 0 = North, 90 = East */
  heading: number;
  /** Raw unsmoothed heading in degrees [0, 360) */
  rawHeading: number;
  /** Whether heading comes from absolute magnetic/true north source */
  absolute: boolean;
  /** Estimated compass accuracy in degrees if provided by device */
  accuracy: number | null;
  timestamp: number;
}

export type BearingMode = 'bidirectional' | 'unidirectional';

/** Bearing observation captured by the runner (used starting in Stage 2). */
export interface BearingObservation {
  id: string;
  stationId: StationId;
  origin: LngLat;
  /** Bearing in degrees [0, 360), clockwise from North */
  bearingDeg: number;
  mode: BearingMode;
  gpsAccuracy: number;
  timestamp: number;
}

export type TriangulationStatus =
  | 'none'
  | 'single_line'
  | 'poor_geometry'
  | 'coarse'
  | 'locked';

export interface ObservationDiagnostic {
  observationId: string;
  /** Absolute angular residual to estimated position in degrees */
  residualDeg: number;
  /** Robust IRLS weight in [0, 1] */
  weight: number;
  /** True if flagged as probable campus reflection / polarity outlier */
  isOutlier: boolean;
}

export interface StationEstimate {
  stationId: StationId;
  status: TriangulationStatus;
  /** Estimated transmitter coordinate (GCJ-02), null when not reliably locked */
  position: LngLat | null;
  /** 2D ~68% containment error radius in meters (null when position is null) */
  errorRadiusM: number | null;
  /** Confidence score in [0, 1] */
  confidence: number;
  /** Total observations recorded for this station */
  observationCount: number;
  /** Number of observations consistent with the estimate */
  inlierCount: number;
  /** Observation IDs flagged as suspected reflection/outlier rays */
  outlierIds: string[];
  /** Best acute intersection angle among inliers in degrees */
  maxIntersectionDeg: number;
  /** Per-observation diagnostic breakdown */
  diagnostics: ObservationDiagnostic[];
  /** Human-readable status hint for the runner */
  reason: string;
}

export interface AppSettings {
  amapKey: string;
  amapSecurityCode: string;
  /** Manual compass offset in degrees to compensate phone/hand holding bias */
  compassOffsetDeg: number;
  /** Smoothing factor alpha for compass EMA (0.05..1.0) */
  compassSmoothing: number;
}

export interface RunSessionState {
  campusId: CampusId;
  /** Exactly 6 target stations (5 from 0..9 + MO) by default, customizable */
  targetStations: StationId[];
  /** Stations already physically found & punched */
  punchedStations: StationId[];
  /** Currently selected station in runner dock */
  activeStation: StationId;
  /** Default bearing mode when recording */
  bearingMode: BearingMode;
  /** Recorded bearing observations persisted across reloads */
  observations: BearingObservation[];
}

/** Single narrowband audio analysis frame fed into Morse decoder & auto-bearing fitter. */
export interface AudioFrame {
  /** Monotonic timestamp in milliseconds */
  timestampMs: number;
  /** Narrowband CW tone amplitude around dominant frequency (linear, >= 0) */
  toneAmp: number;
  /** Estimated local broadband noise floor amplitude (linear, > 0) */
  noiseFloor: number;
  /** Instantaneous signal-to-noise ratio in dB */
  snrDb: number;
  /** Raw time-domain peak sample amplitude in [0, 1] */
  peakLevel: number;
  /** True if ADC/input is clipping (> ~0.94) */
  clipped: boolean;
  /** Locked dominant CW tone frequency in Hz */
  dominantHz: number;
}

export type AudioInputStatus =
  | 'idle'
  | 'mic_active'
  | 'sim_active'
  | 'error';

export type MorseLockStatus = 'idle' | 'listening' | 'identifying' | 'locked';

export interface MorseDecoderSnapshot {
  status: MorseLockStatus;
  /** Currently locked station ID (null until consensus confirmed) */
  lockedStation: StationId | null;
  /** Latest single-cycle best candidate (even before multi-cycle lock) */
  candidateStation: StationId | null;
  /** Match confidence in [0, 1] */
  confidence: number;
  /** Estimated transmitter speed in WPM (null if not yet estimated) */
  estimatedWpm: number | null;
  /** Visualized recent dit/dah symbols decoded from live audio */
  recentSymbols: string;
  /** True when live tone envelope is currently key-down */
  keyDown: boolean;
  /** Number of consecutive agreeing cycles for current lock */
  agreeCount: number;
}

export interface AutoBearingSnapshot {
  /** Number of angular bins [0..18] covered out of 18 (10° per bin over 180°) */
  coveredBins: number;
  totalBins: number;
  /** Unwrapped cumulative rotation span in degrees */
  sweptDeg: number;
  /** Fitted null bearing in [0, 180) (bidirectional line angle), null if not ready */
  bearingDeg: number | null;
  /** Overall fit quality score in [0, 1] */
  quality: number;
  /** Weighted R-squared of dipole harmonic fit */
  rSquared: number;
  /** Peak-to-null modulation contrast depth in [0, 1] */
  modDepth: number;
  /** Fraction of samples that clipped */
  clippedRatio: number;
  /** True when fit is good enough to record directly onto map */
  ready: boolean;
  /** Normalized key-down power [0..1] per 10° bin (null if bin not yet sampled) */
  binPowers: (number | null)[];
  /** Runner-facing status message */
  reason: string;
}

export type RouteDataSource = 'euclidean' | 'amap_walking' | 'amap_partial';

export interface RouteLeg {
  /** 'ORIGIN' for the first leg from runner, or previous StationId */
  fromId: 'ORIGIN' | StationId;
  toStationId: StationId;
  /** Polyline vertices in GCJ-02 */
  path: LngLat[];
  /** Distance in meters */
  distanceM: number;
  /** Estimated jogging/running time in seconds */
  durationSec: number;
  /** True if distance & path came from real Amap walking road network */
  isRealRoad: boolean;
}

export interface RoutePlan {
  origin: LngLat;
  /** Globally optimal visiting order of currently located unpunched target stations */
  orderedStations: StationId[];
  legs: RouteLeg[];
  totalDistanceM: number;
  totalRunSec: number;
  source: RouteDataSource;
  /** True while Amap walking queries are actively refining edges */
  refining: boolean;
}

export type VirtualFieldScope = 'nearby' | 'campus';

export interface VirtualTransmitter {
  stationId: StationId;
  position: LngLat;
  /** Virtual RF frequency in MHz (3.505 .. 3.595) */
  freqMHz: number;
  /** True if one of the 6 required target stations; false for non-target decoy */
  isTarget: boolean;
  /** Morse speed in WPM */
  wpm: number;
  /** Beat audio frequency in Hz */
  toneHz: number;
}

export interface VirtualFieldScenario {
  campusId: CampusId;
  scope: VirtualFieldScope;
  createdAt: number;
  transmitters: VirtualTransmitter[];
  /** Wrong-station punch mistake counter (+1h each in competition rules) */
  penaltyCount: number;
}
