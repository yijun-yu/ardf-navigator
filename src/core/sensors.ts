import { normalizeDeg, shortestAngleDelta, wgs84ToGcj02 } from './coords';
import type { CompassReading, GpsFix } from './types';

export interface GpsWatchCallbacks {
  onFix: (fix: GpsFix) => void;
  onError: (message: string) => void;
}

/**
 * Start high-accuracy browser GPS watcher and convert WGS-84 to GCJ-02.
 * Returns a cleanup function.
 */
export function startGpsWatch(callbacks: GpsWatchCallbacks): () => void {
  if (!('geolocation' in navigator)) {
    callbacks.onError('当前浏览器不支持定位（Geolocation）');
    return () => {};
  }

  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const wgs = {
        lng: pos.coords.longitude,
        lat: pos.coords.latitude,
      };
      const gcj = wgs84ToGcj02(wgs);
      callbacks.onFix({
        gcj,
        wgs,
        accuracy: Math.round(pos.coords.accuracy),
        speed: pos.coords.speed,
        timestamp: pos.timestamp,
      });
    },
    (err) => {
      const msgMap: Record<number, string> = {
        1: '定位权限被拒绝，请在浏览器设置中允许定位',
        2: '暂时无法获取 GPS 信号，请移至室外开阔处',
        3: 'GPS 获取超时，正在重试…',
      };
      callbacks.onError(msgMap[err.code] ?? `定位异常: ${err.message}`);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000,
    },
  );

  return () => navigator.geolocation.clearWatch(watchId);
}

interface CompassDeviceOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

export interface CompassWatchOptions {
  offsetDeg: number;
  smoothing: number;
  onReading: (reading: CompassReading) => void;
  onError: (message: string) => void;
}

/**
 * Request compass permission (required on iOS Safari; no-op on Android/HarmonyOS).
 */
export async function requestCompassPermission(): Promise<boolean> {
  const DevOrient = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  if (typeof DevOrient?.requestPermission === 'function') {
    try {
      const res = await DevOrient.requestPermission();
      return res === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Watch device magnetometer / orientation for compass heading (0=North, 90=East),
 * with circular exponential smoothing so runner hand jitter doesn't whip the bearing ray.
 */
export function startCompassWatch(options: CompassWatchOptions): () => void {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
    options.onError('当前设备不支持指南针传感器');
    return () => {};
  }

  let smoothedHeading: number | null = null;
  let receivedAbsolute = false;

  const handleEvent = (ev: Event, isAbsoluteEvent: boolean) => {
    const e = ev as CompassDeviceOrientationEvent;
    let rawHeading: number | null = null;
    let absolute = isAbsoluteEvent || Boolean(e.absolute);
    let accuracy: number | null = null;

    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
      rawHeading = normalizeDeg(e.webkitCompassHeading);
      absolute = true;
      accuracy =
        typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null;
    } else if (typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
      // Standard W3C: alpha increases counter-clockwise from North -> compass heading = 360 - alpha
      const screenAngle =
        typeof window.screen?.orientation?.angle === 'number'
          ? window.screen.orientation.angle
          : 0;
      rawHeading = normalizeDeg(360 - e.alpha + screenAngle);
    }

    if (rawHeading === null) return;

    // Prefer deviceorientationabsolute if available so relative events don't override it
    if (isAbsoluteEvent) {
      receivedAbsolute = true;
    } else if (receivedAbsolute) {
      return;
    }

    const adjusted = normalizeDeg(rawHeading + options.offsetDeg);
    const alpha = Math.max(0.05, Math.min(1, options.smoothing));

    if (smoothedHeading === null) {
      smoothedHeading = adjusted;
    } else {
      const delta = shortestAngleDelta(smoothedHeading, adjusted);
      smoothedHeading = normalizeDeg(smoothedHeading + alpha * delta);
    }

    options.onReading({
      heading: smoothedHeading,
      rawHeading: adjusted,
      absolute,
      accuracy,
      timestamp: Date.now(),
    });
  };

  const onAbsolute = (e: Event) => handleEvent(e, true);
  const onStandard = (e: Event) => handleEvent(e, false);

  window.addEventListener('deviceorientationabsolute', onAbsolute, true);
  window.addEventListener('deviceorientation', onStandard, true);

  return () => {
    window.removeEventListener('deviceorientationabsolute', onAbsolute, true);
    window.removeEventListener('deviceorientation', onStandard, true);
  };
}

/**
 * Keep phone screen awake while running so browser JS / sensors never sleep.
 */
export class ScreenWakeController {
  private sentinel: WakeLockSentinel | null = null;
  private active = false;
  private onChange?: (locked: boolean) => void;

  constructor(onChange?: (locked: boolean) => void) {
    this.onChange = onChange;
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  private handleVisibility = () => {
    if (document.visibilityState === 'visible' && this.active && !this.sentinel) {
      void this.acquire();
    }
  };

  async enable(): Promise<boolean> {
    this.active = true;
    return this.acquire();
  }

  private async acquire(): Promise<boolean> {
    if (!('wakeLock' in navigator)) {
      this.onChange?.(false);
      return false;
    }
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
        this.onChange?.(false);
      });
      this.onChange?.(true);
      return true;
    } catch {
      this.onChange?.(false);
      return false;
    }
  }

  async disable(): Promise<void> {
    this.active = false;
    if (this.sentinel) {
      try {
        await this.sentinel.release();
      } catch {
        // ignore
      }
      this.sentinel = null;
    }
    this.onChange?.(false);
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.handleVisibility);
    void this.disable();
  }
}
