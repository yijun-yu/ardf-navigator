/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    _AMapSecurityConfig?: {
      securityJsCode?: string;
    };
    AMap?: any;
  }
}

let loadedKey = '';
let loadedSecurity = '';
let pendingPromise: Promise<any> | null = null;

const SCRIPT_ID = 'amap-jsapi-2-script';

/**
 * Dynamically load Amap JS API 2.0 with user-configured key & securityJsCode.
 */
export function loadAmap(key: string, securityJsCode: string): Promise<any> {
  const trimmedKey = key.trim();
  const trimmedSec = securityJsCode.trim();

  if (!trimmedKey) {
    return Promise.reject(new Error('未填写高德地图 Web JS API Key'));
  }

  if (
    window.AMap &&
    loadedKey === trimmedKey &&
    loadedSecurity === trimmedSec
  ) {
    return Promise.resolve(window.AMap);
  }

  if (
    pendingPromise &&
    loadedKey === trimmedKey &&
    loadedSecurity === trimmedSec
  ) {
    return pendingPromise;
  }

  // Remove stale script if user updated keys
  const existing = document.getElementById(SCRIPT_ID);
  if (existing) {
    existing.remove();
    delete window.AMap;
  }

  loadedKey = trimmedKey;
  loadedSecurity = trimmedSec;

  window._AMapSecurityConfig = {
    securityJsCode: trimmedSec || undefined,
  };

  pendingPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.type = 'text/javascript';
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(
      trimmedKey,
    )}&plugin=AMap.Scale,AMap.Walking`;

    script.onload = () => {
      if (window.AMap) {
        resolve(window.AMap);
      } else {
        pendingPromise = null;
        reject(new Error('高德脚本已加载但 AMap 对象不可用，请检查 Key'));
      }
    };

    script.onerror = () => {
      pendingPromise = null;
      reject(new Error('高德地图脚本加载失败，请检查网络连接或 Key 是否有效'));
    };

    document.head.appendChild(script);
  });

  return pendingPromise;
}
