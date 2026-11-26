import type { CampusConfig, CampusId } from './types';

/**
 * Zhejiang University's three campuses in GCJ-02 (Amap coordinate system).
 * Boundaries slightly pad each campus perimeter so transmitters hidden near
 * gates or outer lawns remain inside the valid search polygon.
 */
export const CAMPUSES: Record<CampusId, CampusConfig> = {
  zijingang: {
    id: 'zijingang',
    name: '浙江大学 · 紫金港校区',
    shortName: '紫金港',
    center: { lng: 120.081964, lat: 30.302761 },
    defaultZoom: 15.5,
    boundary: [
      { lng: 120.0665, lat: 30.2942 },
      { lng: 120.0972, lat: 30.2942 },
      { lng: 120.0972, lat: 30.3125 },
      { lng: 120.0665, lat: 30.3125 },
    ],
  },
  yuquan: {
    id: 'yuquan',
    name: '浙江大学 · 玉泉校区',
    shortName: '玉泉',
    center: { lng: 120.122946, lat: 30.263776 },
    defaultZoom: 16,
    boundary: [
      { lng: 120.1140, lat: 30.2578 },
      { lng: 120.1302, lat: 30.2578 },
      { lng: 120.1302, lat: 30.2712 },
      { lng: 120.1140, lat: 30.2712 },
    ],
  },
  huajiachi: {
    id: 'huajiachi',
    name: '浙江大学 · 华家池校区',
    shortName: '华家池',
    center: { lng: 120.195460, lat: 30.269214 },
    defaultZoom: 16,
    boundary: [
      { lng: 120.1888, lat: 30.2638 },
      { lng: 120.2032, lat: 30.2638 },
      { lng: 120.2032, lat: 30.2752 },
      { lng: 120.1888, lat: 30.2752 },
    ],
  },
};

export const CAMPUS_LIST: CampusConfig[] = [
  CAMPUSES.zijingang,
  CAMPUSES.yuquan,
  CAMPUSES.huajiachi,
];
